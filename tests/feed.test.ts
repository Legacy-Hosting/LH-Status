import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAtomFeed } from "../src/server/feed.js";
import type { StatusSnapshot } from "../src/server/status.js";

test("Atom feed escapes public text and uses stable public identifiers", () => {
  const snapshot: StatusSnapshot = {
    version: 2,
    overall: "degraded",
    generatedAt: "2026-09-27T10:00:00.000Z",
    stale: false,
    components: [],
    events: [{
      id: "panel-maintenance-2026-09-27",
      type: "maintenance",
      status: "scheduled",
      title: "Panel & network maintenance",
      message: "Control panel updates <may> take longer than usual.",
      impact: "minor",
      components: ["panel"],
      startedAt: "2026-09-27T09:00:00.000Z",
      updatedAt: "2026-09-27T09:30:00.000Z",
      scheduledFor: "2026-09-28T01:00:00.000Z",
      scheduledUntil: "2026-09-28T02:00:00.000Z",
    }],
  };

  const feed = buildAtomFeed(snapshot, "https://status.legacyhosting.xyz/");
  assert.match(feed, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(feed, /Panel &amp; network maintenance/);
  assert.match(feed, /updates &lt;may&gt; take longer/);
  assert.match(feed, /urn:legacy-hosting:status:panel-maintenance-2026-09-27/);
  assert.match(feed, /https:\/\/status\.legacyhosting\.xyz\/#event-panel-maintenance/);
  assert.doesNotMatch(feed, /<may>/);
});

test("empty Atom feeds have a deterministic update timestamp", () => {
  const feed = buildAtomFeed({
    version: 2,
    overall: "unknown",
    generatedAt: null,
    stale: true,
    components: [],
    events: [],
  }, "https://status.legacyhosting.xyz");
  assert.match(feed, /<updated>1970-01-01T00:00:00\.000Z<\/updated>/);
  assert.doesNotMatch(feed, /<entry>/);
});
