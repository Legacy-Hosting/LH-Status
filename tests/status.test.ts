import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyProbe, StatusMonitor } from "../src/server/status.js";

const targets = [
  { key: "api", name: "API", url: "https://api.example.test/health" },
  { key: "panel", name: "Panel", url: "https://panel.example.test/" },
];

test("probe responses distinguish slow services from outages", () => {
  assert.equal(classifyProbe(true, 100, 1_500), "operational");
  assert.equal(classifyProbe(true, 1_500, 1_500), "degraded");
  assert.equal(classifyProbe(false, 20, 1_500), "outage");
});

test("the public snapshot aggregates partial outages without exposing URLs", async () => {
  const monitor = new StatusMonitor({
    targets,
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 30_000,
    fetchImplementation: async (input) =>
      new Response("ok", { status: String(input).includes("api") ? 200 : 503 }),
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.overall, "partial_outage");
  assert.deepEqual(snapshot.components.map((item) => item.state), [
    "operational",
    "outage",
  ]);
  assert.equal(JSON.stringify(snapshot).includes("example.test"), false);
});

test("a restored or old snapshot is marked stale", async () => {
  const monitor = new StatusMonitor({
    targets,
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 10_000,
  });
  assert.equal(monitor.snapshot().stale, true);
});
