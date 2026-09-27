import { z } from "zod";
import type { ComponentTarget } from "./config.js";
import { statusEventSchema, type EventReader } from "./events.js";

const componentState = z.enum(["operational", "degraded", "outage", "unknown"]);
const overallState = z.enum([
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "unknown",
]);

const snapshotFields = {
  overall: overallState,
  generatedAt: z.string().datetime().nullable(),
  stale: z.boolean(),
  components: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      state: componentState,
      latencyMs: z.number().int().min(0).nullable(),
      checkedAt: z.string().datetime().nullable(),
    }),
  ),
};

const currentStatusSnapshotSchema = z.object({
  version: z.literal(2),
  ...snapshotFields,
  events: z.array(statusEventSchema).max(100),
});

const legacyStatusSnapshotSchema = z.object({
  version: z.literal(1),
  ...snapshotFields,
}).transform((snapshot) => ({
  ...snapshot,
  version: 2 as const,
  events: [],
}));

export const statusSnapshotSchema = z.union([
  currentStatusSnapshotSchema,
  legacyStatusSnapshotSchema,
]);

export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>;
export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export type SnapshotStore = {
  load: () => Promise<StatusSnapshot | null>;
  save: (snapshot: StatusSnapshot) => Promise<void>;
};

export function classifyProbe(
  responseOk: boolean,
  latencyMs: number,
  degradedAfterMs: number,
) {
  if (!responseOk) return "outage" as const;
  return latencyMs >= degradedAfterMs ? ("degraded" as const) : ("operational" as const);
}

function overallFor(components: StatusSnapshot["components"]): StatusSnapshot["overall"] {
  if (components.length === 0 || components.every((item) => item.state === "unknown")) {
    return "unknown";
  }
  if (components.every((item) => item.state === "outage")) return "major_outage";
  if (components.some((item) => item.state === "outage")) return "partial_outage";
  if (components.some((item) => item.state === "degraded")) return "degraded";
  if (components.some((item) => item.state === "unknown")) return "degraded";
  return "operational";
}

export class StatusMonitor {
  readonly #targets: ComponentTarget[];
  readonly #timeoutMs: number;
  readonly #degradedAfterMs: number;
  readonly #pollIntervalMs: number;
  readonly #fetch: FetchImplementation;
  readonly #store: SnapshotStore | undefined;
  readonly #eventReader: EventReader | undefined;
  readonly #onSnapshot: ((snapshot: StatusSnapshot) => Promise<void>) | undefined;
  #timer: NodeJS.Timeout | null = null;
  #refreshing: Promise<StatusSnapshot> | null = null;
  #snapshot: StatusSnapshot;

  constructor(options: {
    targets: ComponentTarget[];
    timeoutMs: number;
    degradedAfterMs: number;
    pollIntervalMs: number;
    fetchImplementation?: FetchImplementation;
    store?: SnapshotStore;
    eventReader?: EventReader;
    onSnapshot?: (snapshot: StatusSnapshot) => Promise<void>;
  }) {
    this.#targets = options.targets;
    this.#timeoutMs = options.timeoutMs;
    this.#degradedAfterMs = options.degradedAfterMs;
    this.#pollIntervalMs = options.pollIntervalMs;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#store = options.store;
    this.#eventReader = options.eventReader;
    this.#onSnapshot = options.onSnapshot;
    this.#snapshot = {
      version: 2,
      overall: "unknown",
      generatedAt: null,
      stale: true,
      components: options.targets.map((target) => ({
        key: target.key,
        name: target.name,
        state: "unknown",
        latencyMs: null,
        checkedAt: null,
      })),
      events: [],
    };
  }

  async restore() {
    const stored = await this.#store?.load();
    if (stored) this.#snapshot = { ...stored, stale: true };
  }

  snapshot(now = Date.now()): StatusSnapshot {
    const generatedAt = this.#snapshot.generatedAt
      ? Date.parse(this.#snapshot.generatedAt)
      : Number.NaN;
    const stale =
      !Number.isFinite(generatedAt) || now - generatedAt > this.#pollIntervalMs * 3;
    return { ...this.#snapshot, stale };
  }

  async refresh() {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#runRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #runRefresh(): Promise<StatusSnapshot> {
    const components = await Promise.all(
      this.#targets.map(async (target): Promise<StatusSnapshot["components"][number]> => {
        const startedAt = performance.now();
        try {
          const response = await this.#fetch(target.url, {
            method: "GET",
            headers: { accept: "application/json,text/html;q=0.8" },
            redirect: "follow",
            signal: AbortSignal.timeout(this.#timeoutMs),
          });
          const latencyMs = Math.round(performance.now() - startedAt);
          return {
            key: target.key,
            name: target.name,
            state: classifyProbe(response.ok, latencyMs, this.#degradedAfterMs),
            latencyMs,
            checkedAt: new Date().toISOString(),
          };
        } catch {
          return {
            key: target.key,
            name: target.name,
            state: "outage",
            latencyMs: null,
            checkedAt: new Date().toISOString(),
          };
        }
      }),
    );
    let events = this.#snapshot.events;
    if (this.#eventReader) {
      try {
        events = await this.#eventReader();
      } catch {
        // Keep the last validated public event set when an operator file is invalid.
      }
    }
    this.#snapshot = {
      version: 2,
      overall: overallFor(components),
      generatedAt: new Date().toISOString(),
      stale: false,
      components,
      events,
    };
    await this.#store?.save(this.#snapshot);
    await this.#onSnapshot?.(this.#snapshot);
    return this.#snapshot;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.refresh(), this.#pollIntervalMs);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
