import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { statusEventsSchema, type StatusEvent } from "../src/server/events.js";
import {
  classifyProbe,
  probeDirectOrigin,
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

test("origin FQDN targets use the direct probe and retain public grouping metadata", async () => {
  let directTarget = "";
  let fetchCalls = 0;
  const monitor = new StatusMonitor({
    targets: [{
      key: "api",
      name: "API",
      url: "https://api.legacyhosting.xyz/health",
      connectHostname: "ams3.api-01.legacyh.fyi",
      primary: true,
      datacenter: "Amsterdam 3",
      service: "API",
      number: "01",
      order: 0,
    }],
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 30_000,
    fetchImplementation: async () => {
      fetchCalls += 1;
      return new Response("unexpected", { status: 500 });
    },
    directProbe: async (target) => {
      directTarget = target.connectHostname ?? "";
      return true;
    },
  });
  const snapshot = await monitor.refresh();
  assert.equal(fetchCalls, 0);
  assert.equal(directTarget, "ams3.api-01.legacyh.fyi");
  assert.equal(snapshot.components[0]?.state, "operational");
  assert.equal(snapshot.components[0]?.datacenter, "Amsterdam 3");
  assert.equal(JSON.stringify(snapshot).includes("legacyh.fyi"), false);
});

test("direct HTTP probes connect to the origin IP while preserving the public Host header", async (context) => {
  let receivedHost = "";
  const server = createServer((request, response) => {
    receivedHost = request.headers.host ?? "";
    response.writeHead(200).end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const target = {
    key: "web-02", name: "Web 02", url: `http://public.example.test:${address.port}/health`,
    connectHostname: "localhost",
  };
  assert.equal(await probeDirectOrigin(target, 1_000), true);
  assert.equal(receivedHost, `public.example.test:${address.port}`);
});

test("remote target refresh changes monitored services without a restart", async () => {
  const monitor = new StatusMonitor({
    targets: [{ key: "api", name: "API", url: "https://api.example.test/health" }],
    targetReader: async () => [{
      key: "web-02",
      name: "Web 02",
      url: "https://web02.example.test/health",
      primary: false,
      datacenter: "Amsterdam 3",
      service: "Web",
      number: "02",
      order: 0,
    }],
    timeoutMs: 1_000,
    degradedAfterMs: 1_500,
    pollIntervalMs: 30_000,
    fetchImplementation: async () => new Response("ok", { status: 200 }),
  });
  const snapshot = await monitor.refresh();
  assert.deepEqual(snapshot.components.map(({ key, name }) => ({ key, name })), [{ key: "web-02", name: "Web 02" }]);
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
