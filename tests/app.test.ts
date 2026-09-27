import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { componentTargets } from "../src/server/config.js";
import { StatusMonitor } from "../src/server/status.js";

let app: FastifyInstance;

before(async () => {
  const monitor = new StatusMonitor({
    targets: [{ key: "api", name: "API", url: "https://api.example.test/health" }],
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 30_000,
    fetchImplementation: async () => new Response("ok", { status: 200 }),
  });
  await monitor.refresh();
  app = await buildApp(monitor);
});

after(async () => {
  await app.close();
});

test("public components contain only API, SSO, and Web Panel in display order", () => {
  assert.deepEqual(
    componentTargets.map(({ key, name }) => ({ key, name })),
    [
      { key: "api", name: "API" },
      { key: "sso", name: "SSO" },
      { key: "panel", name: "Web Panel" },
    ],
  );
});

test("process health stays independent from monitored components", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().service, "LH-Status");
  assert.equal(response.json().version, "0.6.1");
});

test("Web Push subscriptions require same-origin requests", async () => {
  const subscriptions: string[] = [];
  const pushApp = await buildApp(new StatusMonitor({
    targets: [],
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 30_000,
  }), {
    publicKey: "B".repeat(87),
    subscribe: async (subscription) => { subscriptions.push(subscription.endpoint); },
    unsubscribe: async (subscription) => {
      const index = subscriptions.indexOf(subscription.endpoint);
      if (index < 0) return false;
      subscriptions.splice(index, 1);
      return true;
    },
  });
  const payload = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-subscription",
    expirationTime: null,
    keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
  };
  try {
    const key = await pushApp.inject({
      method: "GET",
      url: "/api/v1/subscriptions/push/key",
    });
    assert.equal(key.statusCode, 200);
    assert.equal(key.json().data.publicKey, "B".repeat(87));

    const crossOrigin = await pushApp.inject({
      method: "POST",
      url: "/api/v1/subscriptions/push",
      headers: { origin: "https://attacker.example" },
      payload,
    });
    assert.equal(crossOrigin.statusCode, 403);

    const subscribed = await pushApp.inject({
      method: "POST",
      url: "/api/v1/subscriptions/push",
      headers: { origin: "https://status.legacyhosting.xyz" },
      payload,
    });
    assert.equal(subscribed.statusCode, 201, subscribed.body);
    assert.deepEqual(subscriptions, [payload.endpoint]);

    const unsubscribed = await pushApp.inject({
      method: "DELETE",
      url: "/api/v1/subscriptions/push",
      headers: { origin: "https://status.legacyhosting.xyz" },
      payload,
    });
    assert.equal(unsubscribed.statusCode, 204);
    assert.deepEqual(subscriptions, []);
  } finally {
    await pushApp.close();
  }
});

test("the status snapshot is public and cacheable during an upstream failure", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/status" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["cache-control"] ?? "", /stale-if-error=300/);
  assert.equal(response.json().overall, "operational");
  assert.deepEqual(response.json().events, []);
});

test("component history validates the public component and requested range", async () => {
  const historyApp = await buildApp(
    new StatusMonitor({
      targets: [],
      timeoutMs: 1_000,
      degradedAfterMs: 1_500,
      pollIntervalMs: 30_000,
    }),
    undefined,
    {
      query: (component, range) => component === "api"
        ? {
            component: { key: "api", name: "API" },
            range,
            startAt: "2026-09-27T17:00:00.000Z",
            endAt: "2026-09-27T18:00:00.000Z",
            bucketSeconds: 60,
            summary: {
              samples: 1,
              availabilityPercent: 100,
              averageLatencyMs: 80,
              operational: 1,
              degraded: 0,
              outage: 0,
            },
            points: [],
          }
        : null,
    },
  );
  try {
    const response = await historyApp.inject({
      method: "GET",
      url: "/api/v1/history/api?range=1h",
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().range, "1h");
    assert.match(response.headers["cache-control"] ?? "", /max-age=15/);
    assert.equal((await historyApp.inject({
      method: "GET",
      url: "/api/v1/history/private?range=90d",
    })).statusCode, 404);
    assert.equal((await historyApp.inject({
      method: "GET",
      url: "/api/v1/history/api?range=1y",
    })).statusCode, 400);
  } finally {
    await historyApp.close();
  }
});

test("the public Atom feed is cacheable and contains no probe target", async () => {
  const response = await app.inject({ method: "GET", url: "/feed.atom" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /application\/atom\+xml/);
  assert.match(response.headers["cache-control"] ?? "", /stale-if-error=600/);
  assert.match(response.body, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.doesNotMatch(response.body, /api\.example\.test/);
});
