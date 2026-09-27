import { buildApp } from "./app.js";
import {
  componentTargets,
  env,
  pushNotificationConfig,
  statusDataFile,
  statusEventsFile,
  statusHistoryFile,
  statusPushStateFile,
} from "./config.js";
import { createRemoteComponentReader } from "./components.js";
import {
  combineEventReaders,
  createFileEventReader,
  createRemoteEventReader,
} from "./events.js";
import { PushNotificationService } from "./push.js";
import { FileStatusHistory } from "./history.js";
import { StatusMonitor } from "./status.js";
import { createFileSnapshotStore } from "./store.js";

let pushNotifications: PushNotificationService | undefined;
if (pushNotificationConfig) {
  const candidate = new PushNotificationService({
    ...pushNotificationConfig,
    stateFile: statusPushStateFile,
    onError: (message) => process.stderr.write(`${message}\n`),
  });
  try {
    await candidate.restore();
    pushNotifications = candidate;
  } catch {
    process.stderr.write("Web Push state could not be restored; subscriptions are disabled\n");
  }
}

const remoteComponentReader = createRemoteComponentReader({
  url: env.STATUS_COMPONENTS_URL,
  timeoutMs: env.STATUS_REQUEST_TIMEOUT_MS,
});
let activeTargets = componentTargets;
try {
  activeTargets = await remoteComponentReader();
} catch {
  process.stderr.write("Hub status component configuration is unavailable; using the last packaged configuration\n");
}

const history = new FileStatusHistory({
  path: statusHistoryFile,
  components: activeTargets,
});
await history.restore();

const readComponents = async () => {
  const components = await remoteComponentReader();
  activeTargets = components;
  history.setComponents(components);
  return components;
};

const monitor = new StatusMonitor({
  targets: activeTargets,
  targetReader: readComponents,
  timeoutMs: env.STATUS_REQUEST_TIMEOUT_MS,
  degradedAfterMs: env.STATUS_DEGRADED_AFTER_MS,
  pollIntervalMs: env.STATUS_POLL_INTERVAL_MS,
  store: createFileSnapshotStore(statusDataFile),
  eventReader: combineEventReaders(
    createFileEventReader(
      statusEventsFile,
      () => activeTargets.map((component) => component.key),
    ),
    createRemoteEventReader({
      url: env.STATUS_EVENTS_URL,
      allowedComponentKeys: () => activeTargets.map((component) => component.key),
      timeoutMs: env.STATUS_REQUEST_TIMEOUT_MS,
    }),
  ),
  onSnapshot: async (snapshot) => {
    if (snapshot.generatedAt) {
      try {
        history.setComponents(snapshot.components);
        await history.record({
          timestamp: snapshot.generatedAt,
          components: snapshot.components,
        });
      } catch {
        process.stderr.write("Status probe history could not be persisted\n");
      }
    }
    try {
      await pushNotifications?.publish(snapshot.events);
    } catch {
      process.stderr.write("Web Push event queue could not be persisted\n");
    }
  },
});
await monitor.restore();
const app = await buildApp(monitor, pushNotifications, history);
try {
  await monitor.refresh();
} catch (error) {
  app.log.warn({ error }, "Initial status refresh failed; serving the last snapshot");
}
monitor.start();
pushNotifications?.start();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Stopping LH-Status");
  monitor.stop();
  pushNotifications?.stop();
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
