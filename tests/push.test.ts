import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import webPush from "web-push";
import type { StatusEvent } from "../src/server/events.js";
import {
  PushNotificationService,
  type BrowserPushSubscription,
} from "../src/server/push.js";

const { publicKey, privateKey } = webPush.generateVAPIDKeys();
const subscription: BrowserPushSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-subscription",
  expirationTime: null,
  keys: {
    p256dh: publicKey,
    auth: "b".repeat(22),
  },
};

const incident = (updatedAt: string, status: "investigating" | "monitoring"): StatusEvent => ({
  id: "api-latency-2026-09-27",
  type: "incident",
  status,
  title: "Elevated API latency",
  message: status === "monitoring"
    ? "Performance has recovered and monitoring continues."
    : "The API is responding more slowly than expected.",
  impact: "minor",
  components: ["api"],
  startedAt: "2026-09-27T08:00:00.000Z",
  updatedAt,
  resolvedAt: null,
});

test("Web Push baselines history and persists changed events before delivery", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lh-status-push-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "push-state.json");
  const sent: string[] = [];
  const service = new PushNotificationService({
    publicKey,
    privateKey,
    subject: "mailto:status@legacyhosting.xyz",
    stateFile,
    allowedEndpointHosts: ["fcm.googleapis.com"],
    sendImplementation: async (_target, payload) => {
      sent.push(payload);
    },
  });
  await service.restore();
  await service.subscribe(subscription);
  await service.publish([incident("2026-09-27T08:05:00.000Z", "investigating")]);
  await service.flush();
  assert.equal(sent.length, 0, "existing history must not be sent on first startup");

  await service.publish([incident("2026-09-27T08:30:00.000Z", "monitoring")]);
  await service.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(JSON.parse(sent[0] ?? "{}"), {
    title: "Incident: Elevated API latency",
    body: "Performance has recovered and monitoring continues.",
    url: "/#event-api-latency-2026-09-27",
    tag: "lh-status-api-latency-2026-09-27",
    type: "incident",
    status: "monitoring",
    impact: "minor",
  });
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.subscriptions.length, 1);
  assert.equal(state.deliveries.length, 0);
  if (process.platform !== "win32") {
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  }
});

test("transient Web Push failures remain queued with exponential retry", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lh-status-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T09:00:00.000Z");
  let attempts = 0;
  const service = new PushNotificationService({
    publicKey,
    privateKey,
    subject: "mailto:status@legacyhosting.xyz",
    stateFile: join(directory, "push-state.json"),
    allowedEndpointHosts: ["fcm.googleapis.com"],
    now: () => now,
    sendImplementation: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    },
  });
  await service.restore();
  await service.subscribe(subscription);
  await service.publish([incident("2026-09-27T08:05:00.000Z", "investigating")]);
  await service.publish([incident("2026-09-27T08:30:00.000Z", "monitoring")]);
  await service.flush();
  assert.equal(attempts, 1);
  now = new Date(now.getTime() + 30_000);
  const restarted = new PushNotificationService({
    publicKey,
    privateKey,
    subject: "mailto:status@legacyhosting.xyz",
    stateFile: join(directory, "push-state.json"),
    allowedEndpointHosts: ["fcm.googleapis.com"],
    now: () => now,
    sendImplementation: async () => { attempts += 1; },
  });
  await restarted.restore();
  await restarted.flush();
  assert.equal(attempts, 2);
  const state = JSON.parse(await readFile(join(directory, "push-state.json"), "utf8"));
  assert.equal(state.deliveries.length, 0);
});

test("expired subscriptions are pruned and arbitrary endpoints are rejected", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "lh-status-prune-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "push-state.json");
  const service = new PushNotificationService({
    publicKey,
    privateKey,
    subject: "mailto:status@legacyhosting.xyz",
    stateFile,
    allowedEndpointHosts: ["fcm.googleapis.com"],
    sendImplementation: async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    },
  });
  await service.restore();
  await assert.rejects(
    service.subscribe({
      ...subscription,
      endpoint: "https://internal.example.test/push",
    }),
    /unsupported_push_endpoint/,
  );
  await assert.rejects(
    service.subscribe({
      ...subscription,
      keys: { ...subscription.keys, p256dh: "a".repeat(87) },
    }),
    /invalid_push_subscription/,
  );
  await service.subscribe(subscription);
  await service.publish([incident("2026-09-27T08:05:00.000Z", "investigating")]);
  await service.publish([incident("2026-09-27T08:30:00.000Z", "monitoring")]);
  await service.flush();
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.deliveries.length, 0);
});
