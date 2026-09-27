import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStatusHistory } from "../src/server/history.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

test("probe history aggregates ranges and permanently excludes data older than 90 days", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-status-history-"));
  const path = join(directory, "history.ndjson");
  let now = Date.parse("2026-09-27T18:00:00.000Z");
  const history = new FileStatusHistory({
    path,
    components: [{ key: "api", name: "API" }],
    now: () => now,
  });
  try {
    await history.restore();
    await history.record({
      timestamp: new Date(now - 91 * DAY_MS).toISOString(),
      components: [{ key: "api", state: "outage", latencyMs: null }],
    });
    await history.record({
      timestamp: new Date(now - 90_000).toISOString(),
      components: [{ key: "api", state: "operational", latencyMs: 80 }],
    });
    await history.record({
      timestamp: new Date(now - 60_000).toISOString(),
      components: [{ key: "api", state: "degraded", latencyMs: 240 }],
    });
    await history.record({
      timestamp: new Date(now - 30_000).toISOString(),
      components: [{ key: "api", state: "outage", latencyMs: null }],
    });

    const result = history.query("api", "5m");
    assert.ok(result);
    assert.equal(result.summary.samples, 3);
    assert.equal(result.summary.averageLatencyMs, 160);
    assert.equal(result.summary.availabilityPercent, 66.667);
    assert.equal(result.summary.outage, 1);
    assert.equal(result.points.some((point) => point.state === "operational"), true);
    assert.equal(result.points.some((point) => point.state === "degraded"), true);
    assert.equal(result.points.some((point) => point.state === "outage"), true);
    assert.equal(history.query("private", "5m"), null);
    assert.equal((await readFile(path, "utf8")).trim().split(/\r?\n/).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restoring history drops expired and malformed records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-status-history-restore-"));
  const path = join(directory, "history.ndjson");
  const now = Date.parse("2026-09-27T18:00:00.000Z");
  const source = new FileStatusHistory({
    path,
    components: [{ key: "api", name: "API" }],
    now: () => now,
  });
  try {
    await source.restore();
    await source.record({
      timestamp: new Date(now - 30_000).toISOString(),
      components: [{ key: "api", state: "operational", latencyMs: 75 }],
    });
    const restored = new FileStatusHistory({
      path,
      components: [{ key: "api", name: "API" }],
      now: () => now,
    });
    await restored.restore();
    assert.equal(restored.query("api", "15m")?.summary.samples, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
