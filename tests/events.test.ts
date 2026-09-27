import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combineEventReaders,
  createRemoteEventReader,
} from "../src/server/events.js";

const maintenance = {
  id: "maintenance-1234567890abcdef12345678",
  type: "maintenance",
  title: "API maintenance",
  message: "Deploying a database update.",
  impact: "none",
  status: "scheduled",
  components: ["api"],
  startedAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
  scheduledFor: "2026-09-28T10:00:00.000Z",
  scheduledUntil: "2026-09-28T11:00:00.000Z",
};

test("remote Hub maintenance is validated before it reaches public status", async () => {
  const reader = createRemoteEventReader({
    url: "https://hub.legacyhosting.xyz/api/v1/public/status-events",
    allowedComponentKeys: ["api", "sso", "panel"],
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json([maintenance]),
  });
  assert.equal((await reader())[0]?.id, maintenance.id);
});

test("combined event readers retain an available source", async () => {
  const reader = combineEventReaders(
    async () => { throw new Error("local unavailable"); },
    async () => [maintenance],
  );
  assert.deepEqual(await reader(), [maintenance]);
});
