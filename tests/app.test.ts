import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
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

test("process health stays independent from monitored components", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().service, "LH-Status");
  assert.equal(response.json().version, "0.2.0");
});

test("the status snapshot is public and cacheable during an upstream failure", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/status" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["cache-control"] ?? "", /stale-if-error=300/);
  assert.equal(response.json().overall, "operational");
  assert.deepEqual(response.json().events, []);
});
