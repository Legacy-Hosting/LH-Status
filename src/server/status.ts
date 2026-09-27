import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { z } from "zod";
import type { ComponentReader, ComponentTarget } from "./components.js";
import { statusEventSchema, type EventReader } from "./events.js";

const componentState = z.enum(["operational", "degraded", "outage", "unknown"]);
const overallState = z.enum([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "unknown",
]);

const snapshotFields = {
  overall: overallState,
  generatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  components: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      state: componentState,
      latencyMs: z.number().int().min(0).nullable(),
      checkedAt: z.string().datetime().nullable(),
      primary: z.boolean().optional(),
      datacenter: z.string().min(2).max(80).optional(),
      service: z.string().min(2).max(80).optional(),
      number: z.string().min(1).max(12).optional(),
      order: z.number().int().min(0).max(999).optional(),
    }),
  ),
};

const currentStatusSnapshotSchema = z.object({
  version: z.literal(2),
  ...snapshotFields,
  events: z.array(statusEventSchema).max(100),
});

const legacyStatusSnapshotSchema = z.object({
  version: z.literal(1),
  ...snapshotFields,
}).transform((snapshot) => ({
  ...snapshot,
  version: 2 as const,
  events: [],
}));

export const statusSnapshotSchema = z.union([
  currentStatusSnapshotSchema,
  legacyStatusSnapshotSchema,
]);

export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>;
export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type SnapshotStore = {
  load: () => Promise<StatusSnapshot | null>;
  save: (snapshot: StatusSnapshot) => Promise<void>;
};
export type DirectProbe = (target: ComponentTarget, timeoutMs: number) => Promise<boolean>;

async function requestDirectAddress(
  target: ComponentTarget,
  address: string,
  family: number,
  timeoutMs: number,
) {
  const publicUrl = new URL(target.url);
  return new Promise<boolean>((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: address,
      family,
      port: publicUrl.port ? Number(publicUrl.port) : 443,
      method: "GET",
      path: `${publicUrl.pathname}${publicUrl.search}`,
      servername: publicUrl.hostname,
      headers: {
        accept: "application/json,text/html;q=0.8",
        host: publicUrl.host,
        "user-agent": "LH-Status/0.6 direct-origin-probe",
      },
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Direct origin probe timed out")));
    request.once("error", reject);
    request.end();
  });
}

export const probeDirectOrigin: DirectProbe = async (target, timeoutMs) => {
  if (!target.connectHostname) throw new Error("Direct origin FQDN is missing");
  const publicUrl = new URL(target.url);
  if (publicUrl.protocol !== "https:") throw new Error("Direct origin probes require HTTPS");
  const addresses = await lookup(target.connectHostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("Direct origin FQDN did not resolve");
  let lastError: unknown;
  for (const resolved of addresses) {
    try {
      return await requestDirectAddress(target, resolved.address, resolved.family, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Direct origin probe failed");
};

export function classifyProbe(
  responseOk: boolean,
  latencyMs: number,
  degradedAfterMs: number,
) {
  if (!responseOk) return "outage" as const;
  return latencyMs >= degradedAfterMs ? ("degraded" as const) : ("operational" as const);
}

function overallFor(components: StatusSnapshot["components"]): StatusSnapshot["overall"] {
  if (components.length === 0 || components.every((item) => item.state === "unknown")) {
    return "unknown";
  }
  if (components.every((item) => item.state === "outage")) return "major_outage";
  if (components.some((item) => item.state === "outage")) return "partial_outage";
  if (components.some((item) => item.state === "degraded")) return "degraded";
  if (components.some((item) => item.state === "unknown")) return "degraded";
  return "operational";
}

export class StatusMonitor {
  #targets: ComponentTarget[];
  readonly #timeoutMs: number;
  readonly #degradedAfterMs: number;
  readonly #pollIntervalMs: number;
  readonly #fetch: FetchImplementation;
  readonly #directProbe: DirectProbe;
  readonly #targetReader: ComponentReader | undefined;
  readonly #store: SnapshotStore | undefined;
  readonly #eventReader: EventReader | undefined;
  readonly #onSnapshot: ((snapshot: StatusSnapshot) => Promise<void>) | undefined;
  #timer: NodeJS.Timeout | null = null;
  #refreshing: Promise<StatusSnapshot> | null = null;
  #snapshot: StatusSnapshot;

  constructor(options: {
    targets: ComponentTarget[];
    timeoutMs: number;
    degradedAfterMs: number;
    pollIntervalMs: number;
    fetchImplementation?: FetchImplementation;
    directProbe?: DirectProbe;
    targetReader?: ComponentReader;
    store?: SnapshotStore;
    eventReader?: EventReader;
    onSnapshot?: (snapshot: StatusSnapshot) => Promise<void>;
  }) {
    this.#targets = options.targets;
    this.#timeoutMs = options.timeoutMs;
    this.#degradedAfterMs = options.degradedAfterMs;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#directProbe = options.directProbe ?? probeDirectOrigin;
    this.#targetReader = options.targetReader;
    this.#store = options.store;
    this.#eventReader = options.eventReader;
    this.#onSnapshot = options.onSnapshot;
    this.#snapshot = {
      version: 2,
      overall: "unknown",
      generatedAt: null,
      stale: true,
      components: options.targets.map((target) => this.#componentResult(target, "unknown", null, null)),
      events: [],
    };
  }

  async restore() {
    const stored = await this.#store?.load();
    if (stored) this.#snapshot = { ...stored, stale: true };
  }

  snapshot(now = Date.now()): StatusSnapshot {
    const generatedAt = this.#snapshot.generatedAt
      ? Date.parse(this.#snapshot.generatedAt)
      : Number.NaN;
    const stale =
      !Number.isFinite(generatedAt) || now - generatedAt > this.#pollIntervalMs * 3;
    return { ...this.#snapshot, stale };
  }

  async refresh() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#runRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #runRefresh(): Promise<StatusSnapshot> {
    if (this.#targetReader) {
      try {
        const targets = await this.#targetReader();
        if (targets.length > 0) this.#targets = targets;
      } catch {
        // Retain the last validated component configuration when Hub is unavailable.
      }
    }
    const components = await Promise.all(
      this.#targets.map(async (target): Promise<StatusSnapshot["components"][number]> => {
        const startedAt = performance.now();
        try {
          const responseOk = target.connectHostname
            ? await this.#directProbe(target, this.#timeoutMs)
            : (await this.#fetch(target.url, {
                method: "GET",
                headers: { accept: "application/json,text/html;q=0.8" },
                redirect: "follow",
                signal: AbortSignal.timeout(this.#timeoutMs),
              })).ok;
          const latencyMs = Math.round(performance.now() - startedAt);
          return this.#componentResult(
            target,
            classifyProbe(responseOk, latencyMs, this.#degradedAfterMs),
            latencyMs,
            new Date().toISOString(),
          );
        } catch {
          return this.#componentResult(target, "outage", null, new Date().toISOString());
        }
      }),
    );
    let events = this.#snapshot.events;
    if (this.#eventReader) {
      try {
        events = await this.#eventReader();
      } catch {
        // Keep the last validated public event set when an operator file is invalid.
      }
    }
    this.#snapshot = {
      version: 2,
      overall: overallFor(components),
      generatedAt: new Date().toISOString(),
      stale: false,
      components,
      events,
    };
    await this.#store?.save(this.#snapshot);
    await this.#onSnapshot?.(this.#snapshot);
    return this.#snapshot;
  }

  #componentResult(
    target: ComponentTarget,
    state: z.infer<typeof componentState>,
    latencyMs: number | null,
    checkedAt: string | null,
  ): StatusSnapshot["components"][number] {
    return {
      key: target.key,
      name: target.name,
      state,
      latencyMs,
      checkedAt,
      ...(target.primary === undefined ? {} : { primary: target.primary }),
      ...(target.datacenter === undefined ? {} : { datacenter: target.datacenter }),
      ...(target.service === undefined ? {} : { service: target.service }),
      ...(target.number === undefined ? {} : { number: target.number }),
      ...(target.order === undefined ? {} : { order: target.order }),
    };
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.refresh(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
