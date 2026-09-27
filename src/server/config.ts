import "dotenv/config";
import { resolve } from "node:path";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const defaultComponents = JSON.stringify([
  { key: "api", name: "API", url: "https://api.legacyhosting.xyz/health" },
  { key: "sso", name: "SSO", url: "https://auth.legacyhosting.xyz/health" },
  { key: "panel", name: "Web Panel", url: "https://panel.legacyhosting.xyz/" },
]);
const defaultPushHosts = JSON.stringify([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "notify.windows.com",
]);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8082),
    TRUST_PROXY: booleanFromString,
    STATUS_PUBLIC_ORIGIN: z.string().url().default("https://status.legacyhosting.xyz"),
    STATUS_COMPONENTS: z.string().default(defaultComponents),
    STATUS_DATA_FILE: z.string().min(1).default("./var/status-snapshot.json"),
    STATUS_EVENTS_FILE: z.string().min(1).default("./var/status-events.json"),
    STATUS_PUSH_STATE_FILE: z.string().min(1).default("./var/push-state.json"),
    STATUS_PUSH_VAPID_SUBJECT: z.string().min(1).default("mailto:status@legacyhosting.xyz"),
    STATUS_PUSH_VAPID_PUBLIC_KEY: z.string().regex(/^[A-Za-z0-9_-]{80,120}$/).optional(),
    STATUS_PUSH_VAPID_PRIVATE_KEY: z.string().regex(/^[A-Za-z0-9_-]{40,100}$/).optional(),
    STATUS_PUSH_ALLOWED_HOSTS: z.string().default(defaultPushHosts),
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
    if (value.NODE_ENV === "production") {
      const origin = new URL(value.STATUS_PUBLIC_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== "https://status.legacyhosting.xyz" ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash ||
        origin.username ||
        origin.password
      ) {
        context.addIssue({
          code: "custom",
          path: ["STATUS_PUBLIC_ORIGIN"],
          message: "Production status origin must be https://status.legacyhosting.xyz",
        });
      }
      if (!value.STATUS_PUSH_VAPID_PUBLIC_KEY || !value.STATUS_PUSH_VAPID_PRIVATE_KEY) {
        context.addIssue({
          code: "custom",
          path: ["STATUS_PUSH_VAPID_PUBLIC_KEY"],
          message: "Production Status requires a complete Web Push VAPID key pair",
        });
      }
    }
    if (
      Boolean(value.STATUS_PUSH_VAPID_PUBLIC_KEY) !==
      Boolean(value.STATUS_PUSH_VAPID_PRIVATE_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["STATUS_PUSH_VAPID_PRIVATE_KEY"],
        message: "Both Web Push VAPID keys must be configured together",
      });
    }
    if (
      !value.STATUS_PUSH_VAPID_SUBJECT.startsWith("mailto:") &&
      !value.STATUS_PUSH_VAPID_SUBJECT.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["STATUS_PUSH_VAPID_SUBJECT"],
        message: "VAPID subject must use mailto: or https:",
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

function parsePushHosts(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("STATUS_PUSH_ALLOWED_HOSTS must be valid JSON");
  }
  return z.array(
    z.string().trim().toLowerCase().regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    ),
  ).min(1).max(20).parse(parsed);
}

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
export const statusPushStateFile = resolve(process.cwd(), env.STATUS_PUSH_STATE_FILE);
export const pushNotificationConfig =
  env.STATUS_PUSH_VAPID_PUBLIC_KEY && env.STATUS_PUSH_VAPID_PRIVATE_KEY
    ? {
        publicKey: env.STATUS_PUSH_VAPID_PUBLIC_KEY,
        privateKey: env.STATUS_PUSH_VAPID_PRIVATE_KEY,
        subject: env.STATUS_PUSH_VAPID_SUBJECT,
        allowedEndpointHosts: parsePushHosts(env.STATUS_PUSH_ALLOWED_HOSTS),
      }
    : undefined;
