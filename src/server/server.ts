import { buildApp } from "./app.js";
import { componentTargets, env, statusDataFile } from "./config.js";
import { StatusMonitor } from "./status.js";
import { createFileSnapshotStore } from "./store.js";

const monitor = new StatusMonitor({
  targets: componentTargets,
  timeoutMs: env.STATUS_REQUEST_TIMEOUT_MS,
  degradedAfterMs: env.STATUS_DEGRADED_AFTER_MS,
  pollIntervalMs: env.STATUS_POLL_INTERVAL_MS,
  store: createFileSnapshotStore(statusDataFile),
});
await monitor.restore();
const app = await buildApp(monitor);
try {
  await monitor.refresh();
} catch (error) {
  app.log.warn({ error }, "Initial status refresh failed; serving the last snapshot");
}
monitor.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Stopping LH-Status");
  monitor.stop();
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
