// Minimal service worker whose only job is Web Push delivery — no offline
// caching, so it never serves stale app code. It stays inert until a
// subscription exists (see lib/push-notifications.ts).

self.addEventListener("push", (event) => {
  let payload = { title: "Webmux", body: "" };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // Ignore malformed payloads rather than crashing the worker.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Webmux", {
      body: payload.body || "",
      icon: "/icon.svg",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if (client.url === url && "focus" in client) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
