import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 90 * DAY_MS;
const COMPACTION_INTERVAL_MS = 60 * 60 * 1_000;

const componentStateSchema = z.enum(["operational", "degraded", "outage", "unknown"]);
const storedSampleSchema = z.object({
  t: z.number().int().nonnegative(),
  c: z.record(
    z.string().regex(/^[a-z0-9-]{2,32}$/),
    z.tuple([componentStateSchema, z.number().int().nonnegative().nullable()]),
  ),
});

export const historyRangeSchema = z.enum(["5m", "15m", "1h", "24h", "7d", "30d", "90d"]);
export type HistoryRange = z.infer<typeof historyRangeSchema>;
type ComponentState = z.infer<typeof componentStateSchema>;
type StoredSample = z.infer<typeof storedSampleSchema>;

const rangeConfiguration: Record<HistoryRange, { durationMs: number; bucketMs: number }> = {
  "5m": { durationMs: 5 * 60_000, bucketMs: 30_000 },
  "15m": { durationMs: 15 * 60_000, bucketMs: 30_000 },
  "1h": { durationMs: 60 * 60_000, bucketMs: 60_000 },
  "24h": { durationMs: DAY_MS, bucketMs: 15 * 60_000 },
  "7d": { durationMs: 7 * DAY_MS, bucketMs: 2 * 60 * 60_000 },
  "30d": { durationMs: 30 * DAY_MS, bucketMs: 8 * 60 * 60_000 },
  "90d": { durationMs: RETENTION_MS, bucketMs: DAY_MS },
};

const stateRank: Record<ComponentState, number> = {
  operational: 0,
  unknown: 1,
  degraded: 2,
  outage: 3,
};

export type ProbeHistoryInput = {
  timestamp: string;
  components: Array<{
    key: string;
    state: ComponentState;
    latencyMs: number | null;
  }>;
};

export type HistoryQueryResult = {
  component: { key: string; name: string };
  range: HistoryRange;
  startAt: string;
  endAt: string;
  bucketSeconds: number;
  summary: {
    samples: number;
    availabilityPercent: number | null;
    averageLatencyMs: number | null;
    operational: number;
    degraded: number;
    outage: number;
  };
  points: Array<{
    at: string;
    state: ComponentState;
    samples: number;
    availabilityPercent: number | null;
    averageLatencyMs: number | null;
    minimumLatencyMs: number | null;
    maximumLatencyMs: number | null;
  }>;
};

type Bucket = {
  states: Record<ComponentState, number>;
  latencies: number[];
};

function emptyStates(): Record<ComponentState, number> {
  return { operational: 0, degraded: 0, outage: 0, unknown: 0 };
}

function roundedPercentage(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function availability(states: Record<ComponentState, number>) {
  const known = states.operational + states.degraded + states.outage;
  if (known === 0) return null;
  return roundedPercentage(((states.operational + states.degraded) / known) * 100);
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function worstState(states: Record<ComponentState, number>): ComponentState {
  let selected: ComponentState | null = null;
  for (const state of componentStateSchema.options) {
    if (states[state] > 0 && (selected === null || stateRank[state] > stateRank[selected])) {
      selected = state;
    }
  }
  return selected ?? "unknown";
}

export class FileStatusHistory {
  readonly #path: string;
  readonly #components: Map<string, string>;
  readonly #now: () => number;
  #samples: StoredSample[] = [];
  #writeQueue = Promise.resolve();
  #lastCompactionAt = 0;

  constructor(options: {
    path: string;
    components: Array<{ key: string; name: string }>;
    now?: () => number;
  }) {
    this.#path = options.path;
    this.#components = new Map(options.components.map(({ key, name }) => [key, name]));
    this.#now = options.now ?? Date.now;
  }

  async restore() {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#lastCompactionAt = this.#now();
        return;
      }
      throw error;
    }
    const cutoff = this.#now() - RETENTION_MS;
    this.#samples = raw.split(/\r?\n/).flatMap((line) => {
      if (!line) return [];
      try {
        const parsed = storedSampleSchema.safeParse(JSON.parse(line));
        if (!parsed.success || parsed.data.t < cutoff) return [];
        const components = Object.fromEntries(
          Object.entries(parsed.data.c).filter(([key]) => this.#components.has(key)),
        );
        return Object.keys(components).length > 0 ? [{ ...parsed.data, c: components }] : [];
      } catch {
        return [];
      }
    }).sort((left, right) => left.t - right.t);
    this.#lastCompactionAt = this.#now();
    await this.#compact();
  }

  async record(input: ProbeHistoryInput) {
    const timestamp = Date.parse(input.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < this.#now() - RETENTION_MS ||
      timestamp > this.#now() + 5 * 60_000
    ) return;
    const components: StoredSample["c"] = Object.fromEntries(
      input.components
        .filter(({ key }) => this.#components.has(key))
        .map(({ key, state, latencyMs }) => [
          key,
          [state, latencyMs] as [ComponentState, number | null],
        ]),
    );
    if (Object.keys(components).length === 0) return;
    const sample: StoredSample = { t: timestamp, c: components };
    this.#samples.push(sample);
    this.#prune();
    this.#writeQueue = this.#writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o750 });
      await appendFile(this.#path, `${JSON.stringify(sample)}\n`, { encoding: "utf8", mode: 0o640 });
      if (this.#now() - this.#lastCompactionAt >= COMPACTION_INTERVAL_MS) {
        await this.#compact();
      }
    });
    await this.#writeQueue;
  }

  query(componentKey: string, range: HistoryRange): HistoryQueryResult | null {
    const componentName = this.#components.get(componentKey);
    if (!componentName) return null;
    const { durationMs, bucketMs } = rangeConfiguration[range];
    const end = this.#now();
    const start = end - durationMs;
    const bucketCount = Math.ceil(durationMs / bucketMs);
    const buckets: Bucket[] = Array.from({ length: bucketCount }, () => ({
      states: emptyStates(),
      latencies: [],
    }));
    const summaryStates = emptyStates();
    const summaryLatencies: number[] = [];

    for (const sample of this.#samples) {
      if (sample.t < start || sample.t > end) continue;
      const component = sample.c[componentKey];
      if (!component) continue;
      const index = Math.min(bucketCount - 1, Math.floor((sample.t - start) / bucketMs));
      const bucket = buckets[index];
      if (!bucket) continue;
      const [state, latency] = component;
      bucket.states[state] += 1;
      summaryStates[state] += 1;
      if (latency !== null) {
        bucket.latencies.push(latency);
        summaryLatencies.push(latency);
      }
    }

    const samples = Object.values(summaryStates).reduce((total, count) => total + count, 0);
    return {
      component: { key: componentKey, name: componentName },
      range,
      startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(),
      bucketSeconds: bucketMs / 1_000,
      summary: {
        samples,
        availabilityPercent: availability(summaryStates),
        averageLatencyMs: average(summaryLatencies),
        operational: summaryStates.operational,
        degraded: summaryStates.degraded,
        outage: summaryStates.outage,
      },
      points: buckets.map((bucket, index) => {
        const bucketSamples = Object.values(bucket.states).reduce(
          (total, count) => total + count,
          0,
        );
        return {
          at: new Date(start + index * bucketMs).toISOString(),
          state: worstState(bucket.states),
          samples: bucketSamples,
          availabilityPercent: availability(bucket.states),
          averageLatencyMs: average(bucket.latencies),
          minimumLatencyMs: bucket.latencies.length > 0 ? Math.min(...bucket.latencies) : null,
          maximumLatencyMs: bucket.latencies.length > 0 ? Math.max(...bucket.latencies) : null,
        };
      }),
    };
  }

  #prune() {
    const cutoff = this.#now() - RETENTION_MS;
    const firstRetained = this.#samples.findIndex((sample) => sample.t >= cutoff);
    if (firstRetained === -1) this.#samples = [];
    else if (firstRetained > 0) this.#samples.splice(0, firstRetained);
  }

  async #compact() {
    this.#prune();
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o750 });
    const temporaryPath = `${this.#path}.${process.pid}.tmp`;
    const body = this.#samples.map((sample) => JSON.stringify(sample)).join("\n");
    await writeFile(temporaryPath, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o640 });
    await rename(temporaryPath, this.#path);
    this.#lastCompactionAt = this.#now();
  }
}

