import { readFile } from "node:fs/promises";
import { z } from "zod";

const internalDetailPattern = /(?:https?:\/\/|legacyh\.fyi|(?:^|\D)10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\D|$)|(?:^|\D)192\.168\.\d{1,3}\.\d{1,3}(?:\D|$)|(?:^|\D)172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?:\D|$))/i;

function publicText(minimum: number, maximum: number) {
  return z.string().trim().min(minimum).max(maximum).refine(
    (value) => !internalDetailPattern.test(value),
    "Public status text must not contain URLs, internal domains, or private IP addresses",
  );
}

const eventBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  title: publicText(3, 120),
  message: publicText(3, 1_000),
  impact: z.enum(["none", "minor", "major", "critical"]),
  components: z.array(z.string().regex(/^[a-z0-9-]{2,32}$/)).max(30),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

const incidentSchema = z.object({
  ...eventBase,
  type: z.literal("incident"),
  status: z.enum(["investigating", "identified", "monitoring", "resolved"]),
  resolvedAt: z.string().datetime().nullable().default(null),
});

const maintenanceSchema = z.object({
  ...eventBase,
  type: z.literal("maintenance"),
  status: z.enum(["scheduled", "in_progress", "completed"]),
  scheduledFor: z.string().datetime(),
  scheduledUntil: z.string().datetime(),
});

export const statusEventSchema = z.discriminatedUnion("type", [
  incidentSchema,
  maintenanceSchema,
]);

export const statusEventsSchema = z.array(statusEventSchema).max(100).superRefine(
  (events, context) => {
    const ids = new Set<string>();
    for (const [index, event] of events.entries()) {
      if (ids.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Status event IDs must be unique",
        });
      }
      ids.add(event.id);
      if (Date.parse(event.updatedAt) < Date.parse(event.startedAt)) {
        context.addIssue({
          code: "custom",
          path: [index, "updatedAt"],
          message: "updatedAt cannot be before startedAt",
        });
      }
      if (
        event.type === "maintenance" &&
        Date.parse(event.scheduledUntil) <= Date.parse(event.scheduledFor)
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "scheduledUntil"],
          message: "scheduledUntil must be after scheduledFor",
        });
      }
      if (
        event.type === "incident" &&
        event.status === "resolved" &&
        !event.resolvedAt
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "resolvedAt"],
          message: "Resolved incidents require resolvedAt",
        });
      }
    }
  },
);

export type StatusEvent = z.infer<typeof statusEventSchema>;
export type EventReader = () => Promise<StatusEvent[]>;

function validatedEvents(parsed: unknown, allowedComponentKeys: readonly string[]) {
  const allowed = new Set(allowedComponentKeys);
  const events = statusEventsSchema.parse(parsed);
  for (const event of events) {
    if (event.components.some((component) => !allowed.has(component))) {
      throw new Error(`Unknown public component in status event ${event.id}`);
    }
  }
  return events.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export function createFileEventReader(
  path: string,
  allowedComponentKeys: readonly string[],
): EventReader {
  return async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      throw error;
    }
    return validatedEvents(parsed, allowedComponentKeys);
  };
}

export function createRemoteEventReader(options: {
  url: string;
  allowedComponentKeys: readonly string[];
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
}): EventReader {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async () => {
    const response = await fetchImplementation(options.url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Remote status events returned ${response.status}`);
    return validatedEvents(await response.json(), options.allowedComponentKeys);
  };
}

export function combineEventReaders(...readers: EventReader[]): EventReader {
  return async () => {
    const results = await Promise.allSettled(readers.map((reader) => reader()));
    const available = results.filter(
      (result): result is PromiseFulfilledResult<StatusEvent[]> => result.status === "fulfilled",
    );
    if (available.length === 0) throw new Error("No status event source is available");
    const events = new Map<string, StatusEvent>();
    for (const result of available) {
      for (const event of result.value) events.set(event.id, event);
    }
    return Array.from(events.values()).sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  };
}
