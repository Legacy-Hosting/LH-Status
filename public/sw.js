self.addEventListener("push", (event) => {
  let notification = {};
  try {
    notification = event.data ? event.data.json() : {};
  } catch {
    notification = {};
  }
  const title = typeof notification.title === "string"
    ? notification.title
    : "Legacy Hosting status update";
  const body = typeof notification.body === "string"
    ? notification.body
    : "The public service status has changed.";
  const tag = typeof notification.tag === "string"
    ? notification.tag
    : "lh-status-update";
  const url = typeof notification.url === "string" && notification.url.startsWith("/")
    ? notification.url
    : "/";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    renotify: true,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requested = new URL(event.notification.data?.url || "/", self.location.origin);
  if (requested.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(requested.href);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(requested.href);
  })());
});
