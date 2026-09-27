import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const defaultComponents = JSON.stringify([
  { key: "panel", name: "Control panel", url: "https://panel.legacyhosting.xyz/" },
  { key: "api", name: "API", url: "https://api.legacyhosting.xyz/health" },
  { key: "identity", name: "Identity", url: "https://auth.legacyhosting.xyz/health" },
  { key: "hub", name: "Staff Hub", url: "https://hub.legacyhosting.xyz/health" },
]);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
    TRUST_PROXY: booleanFromString,
    STATUS_COMPONENTS: z.string().default(defaultComponents),
    STATUS_DATA_FILE: z.string().min(1).default("./var/status-snapshot.json"),
    STATUS_EVENTS_FILE: z.string().min(1).default("./var/status-events.json"),
    STATUS_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(300_000)
      .default(30_000),
    STATUS_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(15_000)
      .default(5_000),
    STATUS_DEGRADED_AFTER_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(1_500),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.HOST !== "127.0.0.1") {
      context.addIssue({
        code: "custom",
        path: ["HOST"],
        message: "LH-Status must listen on the local reverse-proxy interface",
      });
    }
  });

const componentSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(2).max(80),
  url: z.string().url(),
});

export type ComponentTarget = z.infer<typeof componentSchema>;
export const env = schema.parse(process.env);

function parseComponents(raw: string): ComponentTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STATUS_COMPONENTS must be valid JSON");
  }
  const components = z.array(componentSchema).min(1).max(30).parse(parsed);
  if (new Set(components.map((component) => component.key)).size !== components.length) {
    throw new Error("STATUS_COMPONENTS keys must be unique");
  }
  if (
    env.NODE_ENV === "production" &&
    components.some((component) => !component.url.startsWith("https://"))
  ) {
    throw new Error("Production status probes must use HTTPS");
  }
  return components;
}

export const componentTargets = parseComponents(env.STATUS_COMPONENTS);
export const statusDataFile = resolve(process.cwd(), env.STATUS_DATA_FILE);
export const statusEventsFile = resolve(process.cwd(), env.STATUS_EVENTS_FILE);
