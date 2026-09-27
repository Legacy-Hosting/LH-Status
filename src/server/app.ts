import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { env } from "./config.js";
import type { StatusMonitor } from "./status.js";

export async function buildApp(monitor: StatusMonitor) {
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
    version: "0.2.0",
  }));
  app.get("/api/v1/status", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=10, stale-if-error=300");
    return monitor.snapshot();
  });
  return app;
}
