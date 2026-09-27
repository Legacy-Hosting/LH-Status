import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteComponentReader } from "../src/server/components.js";

test("remote components require direct origin FQDNs and preserve Hub ordering", async () => {
  const payload = [
    {
      key: "panel",
      name: "Web Panel",
      url: "https://panel.legacyhosting.xyz/",
      connectHostname: "ams3.panel-01.legacyh.fyi",
      primary: true,
      datacenter: "Amsterdam 3",
      service: "Web Panel",
      number: "01",
      order: 0,
    },
    {
      key: "web-02",
      name: "Web 02",
      url: "https://web02.legacyhosting.xyz/health",
      connectHostname: "ams3.web-02.legacyh.fyi",
      primary: false,
      datacenter: "Amsterdam 3",
      service: "Web",
      number: "02",
      order: 0,
    },
  ];
  const reader = createRemoteComponentReader({
    url: "https://hub.legacyhosting.xyz/api/v1/public/status-components",
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json(payload),
  });
  assert.deepEqual((await reader()).map((component) => component.key), ["panel", "web-02"]);

  const invalid = createRemoteComponentReader({
    url: "https://hub.legacyhosting.xyz/api/v1/public/status-components",
    timeoutMs: 1_000,
    fetchImplementation: async () => Response.json([{ ...payload[0], connectHostname: "192.0.2.5" }]),
  });
  await assert.rejects(invalid());
});
