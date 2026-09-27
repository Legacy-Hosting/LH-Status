import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webPush, { type PushSubscription, type RequestOptions } from "web-push";
import { z } from "zod";
import type { StatusEvent } from "./events.js";

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const browserPushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2_048).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  }, "Push endpoint must be an HTTPS URL without credentials or fragments"),
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({
    p256dh: base64Url.min(43).max(200),
    auth: base64Url.min(16).max(100),
  }).strict(),
}).strict();

export type BrowserPushSubscription = z.infer<typeof browserPushSubscriptionSchema>;

const storedSubscriptionSchema = browserPushSubscriptionSchema.extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const deliverySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  subscriptionId: z.string().regex(/^[a-f0-9]{64}$/),
  eventId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  eventVersion: z.string().datetime(),
  payload: z.string().min(2).max(4_096),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  urgency: z.enum(["normal", "high"]),
  attempts: z.number().int().min(0).max(8),
  nextAttemptAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

const pushStateSchema = z.object({
  version: z.literal(1),
  initialized: z.boolean(),
  subscriptions: z.array(storedSubscriptionSchema).max(5_000),
  eventVersions: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    z.string().datetime(),
  ),
  deliveries: z.array(deliverySchema).max(25_000),
});

type PushState = z.infer<typeof pushStateSchema>;
type StoredSubscription = PushState["subscriptions"][number];
type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<unknown>;

export type PushSubscriptionApi = {
  publicKey: string;
  subscribe: (subscription: BrowserPushSubscription) => Promise<void>;
  unsubscribe: (subscription: BrowserPushSubscription) => Promise<boolean>;
};

const emptyState = (): PushState => ({
  version: 1,
  initialized: false,
  subscriptions: [],
  eventVersions: {},
  deliveries: [],
});

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function subscriptionId(subscription: BrowserPushSubscription) {
  return sha256(`${subscription.endpoint}\0${subscription.keys.p256dh}`);
}

function toWebPushSubscription(subscription: BrowserPushSubscription): PushSubscription {
  return {
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    ...(subscription.expirationTime === undefined
      ? {}
      : { expirationTime: subscription.expirationTime }),
  };
}

function endpointAllowed(endpoint: string, allowedHosts: readonly string[]) {
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return allowedHosts.some((allowed) =>
    hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function notificationFor(event: StatusEvent) {
  const titlePrefix = event.type === "incident" ? "Incident" : "Maintenance";
  return JSON.stringify({
    title: `${titlePrefix}: ${event.title}`,
    body: event.message,
    url: `/#event-${event.id}`,
    tag: `lh-status-${event.id}`,
    type: event.type,
    status: event.status,
    impact: event.impact,
  });
}

function topicFor(eventId: string) {
  return createHash("sha256").update(eventId, "utf8").digest("base64url").slice(0, 32);
}

function errorStatus(error: unknown) {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

export class PushNotificationService implements PushSubscriptionApi {
  readonly publicKey: string;
  readonly #privateKey: string;
  readonly #subject: string;
  readonly #stateFile: string;
  readonly #allowedHosts: readonly string[];
  readonly #send: PushSender;
  readonly #now: () => Date;
  readonly #onError: ((message: string) => void) | undefined;
  #state = emptyState();
  #loaded = false;
  #operation: Promise<void> = Promise.resolve();
  #flushPromise: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: {
    publicKey: string;
    privateKey: string;
    subject: string;
    stateFile: string;
    allowedEndpointHosts: readonly string[];
    sendImplementation?: PushSender;
    now?: () => Date;
    onError?: (message: string) => void;
  }) {
    this.publicKey = options.publicKey;
    this.#privateKey = options.privateKey;
    this.#subject = options.subject;
    this.#stateFile = options.stateFile;
    this.#allowedHosts = options.allowedEndpointHosts.map((host) => host.toLowerCase());
    this.#send = options.sendImplementation ?? ((subscription, payload, requestOptions) =>
      webPush.sendNotification(subscription, payload, requestOptions));
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    webPush.getVapidHeaders(
      "https://fcm.googleapis.com",
      this.#subject,
      this.publicKey,
      this.#privateKey,
      "aes128gcm",
    );
  }

  async restore() {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#stateFile, "utf8"));
      this.#state = pushStateSchema.parse(parsed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  async subscribe(input: BrowserPushSubscription) {
    const subscription = browserPushSubscriptionSchema.parse(input);
    if (!endpointAllowed(subscription.endpoint, this.#allowedHosts)) {
      throw new Error("unsupported_push_endpoint");
    }
    try {
      webPush.generateRequestDetails(toWebPushSubscription(subscription), "{}", {
        vapidDetails: {
          subject: this.#subject,
          publicKey: this.publicKey,
          privateKey: this.#privateKey,
        },
      });
    } catch {
      throw new Error("invalid_push_subscription");
    }
    await this.#mutate(async () => {
      const id = subscriptionId(subscription);
      const existing = this.#state.subscriptions.find((entry) => entry.id === id);
      if (!existing && this.#state.subscriptions.length >= 5_000) {
        throw new Error("push_subscription_capacity_reached");
      }
      const timestamp = this.#now().toISOString();
      const record: StoredSubscription = {
        ...subscription,
        id,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      this.#state.subscriptions = [
        ...this.#state.subscriptions.filter((entry) => entry.id !== id),
        record,
      ];
      await this.#save();
    });
  }

  async unsubscribe(input: BrowserPushSubscription) {
    const subscription = browserPushSubscriptionSchema.parse(input);
    return this.#mutate(async () => {
      const id = subscriptionId(subscription);
      const before = this.#state.subscriptions.length;
      this.#removeSubscription(id);
      if (this.#state.subscriptions.length !== before) await this.#save();
      return this.#state.subscriptions.length !== before;
    });
  }

  async publish(events: readonly StatusEvent[]) {
    await this.#mutate(async () => {
      const nextVersions = Object.fromEntries(
        events.map((event) => [event.id, event.updatedAt]),
      );
      if (!this.#state.initialized) {
        this.#state.initialized = true;
        this.#state.eventVersions = nextVersions;
        await this.#save();
        return;
      }

      const previousIds = Object.keys(this.#state.eventVersions);
      const versionsChanged = previousIds.length !== events.length || events.some(
        (event) => this.#state.eventVersions[event.id] !== event.updatedAt,
      );
      if (!versionsChanged) return;

      const queued = new Set(this.#state.deliveries.map((delivery) => delivery.id));
      const now = this.#now().toISOString();
      for (const event of events) {
        if (this.#state.eventVersions[event.id] === event.updatedAt) continue;
        const payload = notificationFor(event);
        const topic = topicFor(event.id);
        const urgency = event.impact === "major" || event.impact === "critical"
          ? "high" as const
          : "normal" as const;
        for (const subscription of this.#state.subscriptions) {
          const id = sha256(`${subscription.id}\0${event.id}\0${event.updatedAt}`);
          if (queued.has(id)) continue;
          if (this.#state.deliveries.length >= 25_000) {
            this.#onError?.("Web Push queue capacity reached; notification was not queued");
            break;
          }
          this.#state.deliveries.push({
            id,
            subscriptionId: subscription.id,
            eventId: event.id,
            eventVersion: event.updatedAt,
            payload,
            topic,
            urgency,
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
          });
          queued.add(id);
        }
      }
      this.#state.eventVersions = nextVersions;
      await this.#save();
    });
    void this.flush().catch(() => {
      this.#onError?.("Web Push queue flush failed");
    });
  }

  async flush() {
    if (this.#flushPromise) return this.#flushPromise;
    this.#flushPromise = this.#runFlush().finally(() => {
      this.#flushPromise = null;
    });
    return this.#flushPromise;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.flush().catch(() => {
        this.#onError?.("Web Push queue flush failed");
      });
    }, 30_000);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #runFlush() {
    const due = await this.#read(() => {
      const now = this.#now().getTime();
      return this.#state.deliveries
        .filter((delivery) => Date.parse(delivery.nextAttemptAt) <= now)
        .slice(0, 100)
        .map((delivery) => ({
          delivery: { ...delivery },
          subscription: this.#state.subscriptions.find(
            (entry) => entry.id === delivery.subscriptionId,
          ),
        }));
    });
    if (due.length === 0) return;

    const outcomes = await Promise.all(due.map(async ({ delivery, subscription }) => {
      if (!subscription) return { delivery, result: "gone" as const };
      try {
        const webPushSubscription = toWebPushSubscription(subscription);
        await this.#send(webPushSubscription, delivery.payload, {
          vapidDetails: {
            subject: this.#subject,
            publicKey: this.publicKey,
            privateKey: this.#privateKey,
          },
          TTL: 86_400,
          urgency: delivery.urgency,
          topic: delivery.topic,
          timeout: 10_000,
        });
        return { delivery, result: "sent" as const };
      } catch (error) {
        const status = errorStatus(error);
        return {
          delivery,
          result: status === 404 || status === 410 ? "gone" as const : "retry" as const,
          status,
        };
      }
    }));

    await this.#mutate(async () => {
      let changed = false;
      for (const outcome of outcomes) {
        const current = this.#state.deliveries.find(
          (delivery) => delivery.id === outcome.delivery.id,
        );
        if (!current) continue;
        changed = true;
        if (outcome.result === "sent") {
          this.#state.deliveries = this.#state.deliveries.filter(
            (delivery) => delivery.id !== current.id,
          );
          continue;
        }
        if (outcome.result === "gone") {
          this.#removeSubscription(current.subscriptionId);
          continue;
        }
        current.attempts += 1;
        if (current.attempts >= 8) {
          this.#state.deliveries = this.#state.deliveries.filter(
            (delivery) => delivery.id !== current.id,
          );
          this.#onError?.("Web Push delivery exhausted its retry budget");
          continue;
        }
        const delayMs = Math.min(3_600_000, 30_000 * (2 ** (current.attempts - 1)));
        current.nextAttemptAt = new Date(this.#now().getTime() + delayMs).toISOString();
        this.#onError?.(
          `Web Push delivery failed${outcome.status ? ` with status ${outcome.status}` : ""}; retry scheduled`,
        );
      }
      if (changed) await this.#save();
    });
  }

  #removeSubscription(id: string) {
    this.#state.subscriptions = this.#state.subscriptions.filter((entry) => entry.id !== id);
    this.#state.deliveries = this.#state.deliveries.filter(
      (delivery) => delivery.subscriptionId !== id,
    );
  }

  async #save() {
    pushStateSchema.parse(this.#state);
    await mkdir(dirname(this.#stateFile), { recursive: true, mode: 0o750 });
    const temporary = `${this.#stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#stateFile);
  }

  #ensureLoaded() {
    if (!this.#loaded) throw new Error("push_state_not_restored");
  }

  #mutate<T>(operation: () => Promise<T>) {
    const run = this.#operation.then(async () => {
      this.#ensureLoaded();
      return operation();
    });
    this.#operation = run.then(() => undefined, () => undefined);
    return run;
  }

  #read<T>(operation: () => T) {
    return this.#mutate(async () => operation());
  }
}
