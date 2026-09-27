import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { env } from "./config.js";
import { buildAtomFeed } from "./feed.js";
import {
  browserPushSubscriptionSchema,
  type PushSubscriptionApi,
} from "./push.js";
import type { StatusMonitor } from "./status.js";

function validBrowserOrigin(origin: string | undefined) {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.STATUS_PUBLIC_ORIGIN).origin;
  } catch {
    return false;
  }
}

export async function buildApp(
  monitor: StatusMonitor,
  pushSubscriptions?: PushSubscriptionApi,
) {
  const app = Fastify({
    logger: env.NODE_ENV === "production",
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 64 * 1024,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.get("/health", async () => ({
    status: "ok",
    service: "LH-Status",
    version: "0.4.1",
  }));
  app.get("/api/v1/status", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=10, stale-if-error=300");
    return monitor.snapshot();
  });
  app.get("/feed.atom", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=60, stale-if-error=600");
    reply.type("application/atom+xml; charset=utf-8");
    return buildAtomFeed(monitor.snapshot(), env.STATUS_PUBLIC_ORIGIN);
  });
  app.get("/api/v1/subscriptions/push/key", async (_request, reply) => {
    if (!pushSubscriptions) {
      return reply.status(503).send({ error: "push_subscriptions_unavailable" });
    }
    reply.header("Cache-Control", "public, max-age=3600");
    return { data: { publicKey: pushSubscriptions.publicKey } };
  });
  app.post(
    "/api/v1/subscriptions/push",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!validBrowserOrigin(request.headers.origin)) {
        return reply.status(403).send({ error: "invalid_origin" });
      }
      if (!pushSubscriptions) {
        return reply.status(503).send({ error: "push_subscriptions_unavailable" });
      }
      const subscription = browserPushSubscriptionSchema.safeParse(request.body);
      if (!subscription.success) {
        return reply.status(400).send({ error: "invalid_push_subscription" });
      }
      try {
        await pushSubscriptions.subscribe(subscription.data);
        return reply.status(201).send({ data: { subscribed: true } });
      } catch (error) {
        if (error instanceof Error && error.message === "unsupported_push_endpoint") {
          return reply.status(400).send({ error: "unsupported_push_endpoint" });
        }
        if (error instanceof Error && error.message === "invalid_push_subscription") {
          return reply.status(400).send({ error: "invalid_push_subscription" });
        }
        if (error instanceof Error && error.message === "push_subscription_capacity_reached") {
          return reply.status(503).send({ error: "push_subscription_capacity_reached" });
        }
        throw error;
      }
    },
  );
  app.delete(
    "/api/v1/subscriptions/push",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!validBrowserOrigin(request.headers.origin)) {
        return reply.status(403).send({ error: "invalid_origin" });
      }
      if (!pushSubscriptions) {
        return reply.status(503).send({ error: "push_subscriptions_unavailable" });
      }
      const subscription = browserPushSubscriptionSchema.safeParse(request.body);
      if (!subscription.success) {
        return reply.status(400).send({ error: "invalid_push_subscription" });
      }
      await pushSubscriptions.unsubscribe(subscription.data);
      return reply.status(204).send();
    },
  );
  return app;
}
