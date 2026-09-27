import assert from "node:assert/strict";
import { test } from "node:test";
import { statusEventsSchema, type StatusEvent } from "../src/server/events.js";
import {
  classifyProbe,
  statusSnapshotSchema,
  StatusMonitor,
} from "../src/server/status.js";

const targets = [
  { key: "api", name: "API", url: "https://api.example.test/health" },
  { key: "panel", name: "Panel", url: "https://panel.example.test/" },
];

const incident: StatusEvent = {
  id: "api-latency-2026-09-27",
  type: "incident",
  status: "monitoring",
  title: "Elevated API latency",
  message: "Performance has recovered and monitoring continues.",
  impact: "minor",
  components: ["api"],
  startedAt: "2026-09-27T08:00:00.000Z",
  updatedAt: "2026-09-27T08:30:00.000Z",
  resolvedAt: null,
};

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
    eventReader: async () => [incident],
  });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.overall, "partial_outage");
  assert.deepEqual(snapshot.components.map((item) => item.state), [
    "operational",
    "outage",
  ]);
  assert.equal(JSON.stringify(snapshot).includes("example.test"), false);
  assert.deepEqual(snapshot.events, [incident]);
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

test("public event validation rejects internal details and invalid schedules", () => {
  assert.equal(statusEventsSchema.safeParse([incident]).success, true);
  assert.equal(statusEventsSchema.safeParse([{
    ...incident,
    message: "See https://ams3-api-01.legacyh.fyi for details",
  }]).success, false);
  assert.equal(statusEventsSchema.safeParse([{
    ...incident,
    id: "private-address",
    message: "The service at 10.110.0.8 is recovering.",
  }]).success, false);
  assert.equal(statusEventsSchema.safeParse([{
    ...incident,
    type: "maintenance",
    status: "scheduled",
    scheduledFor: "2026-09-28T10:00:00.000Z",
    scheduledUntil: "2026-09-28T09:00:00.000Z",
  }]).success, false);
});

test("stored version 1 snapshots migrate without losing component status", () => {
  const migrated = statusSnapshotSchema.parse({
    version: 1,
    overall: "operational",
    generatedAt: "2026-09-27T08:30:00.000Z",
    stale: false,
    components: [],
  });
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.events, []);
});
