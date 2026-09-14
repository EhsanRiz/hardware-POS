/**
 * What the service worker does when a push arrives.
 *
 * Pulled into the generated worker by workbox (vite.config.ts,
 * workbox.importScripts) rather than by switching the whole PWA to a
 * hand-written service worker: the update prompt, the app-shell precache and
 * the image caching are all working and all generated, and swapping the
 * strategy to add two listeners would put every one of them at risk.
 *
 * The payload is written by supabase/functions/push and is deliberately thin
 * — a title, a line, and a tag — because it arrives on a lock screen anybody
 * can read over a shoulder. No money, no customer, no invoice number.
 */
self.addEventListener("push", (event) => {
  let said = {};
  try {
    said = event.data ? event.data.json() : {};
  } catch {
    said = {};
  }
  // Every push must put something on the screen; a browser that sees one that
  // does not will take the permission away. So even a payload we cannot read
  // says something true.
  const body = said.body || "Something at the shop needs you.";
  event.waitUntil(
    self.registration.showNotification(said.title || "InnovaPOS", {
      body,
      // The same tag every time, so the second one replaces the first rather
      // than stacking up three that say almost the same thing.
      tag: said.tag || "innovapos-needs-you",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: said.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((open) => {
        // The app is usually already open somewhere behind the lock screen;
        // bringing that window forward keeps whatever was on it.
        for (const client of open) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow(url);
      })
  );
});
