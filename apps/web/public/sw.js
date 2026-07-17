const CACHE_NAME = 'relaydock-shell-v3';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL);
  const indexResponse = await cache.match('/');
  if (!indexResponse) return;
  const indexHtml = await indexResponse.text();
  const buildAssets = [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(
    (match) => match[1],
  );
  if (buildAssets.length > 0) await cache.addAll(buildAssets);
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? fresh;
    }),
  );
});

// Web Push: the server sends a JSON payload (see buildJobNotification on the
// server) that this turns into a visible notification. userVisibleOnly means we
// must always show one, so fall back to a generic message if parsing fails.
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'RelayDock', body: event.data.text() };
    }
  }
  const title = payload.title || 'RelayDock';
  const tag = payload.tag || undefined;
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // A per-job tag means a newer state (e.g. "completed") replaces the older
    // "waiting for input" notification for the same job instead of stacking;
    // renotify re-alerts so the replacement is still noticed.
    tag,
    renotify: Boolean(tag),
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Reuse an existing RelayDock tab if one is open, navigating it to the job.
      for (const client of windowClients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(targetUrl);
          } catch {
            // Navigation can be blocked cross-origin or mid-load; focus is enough.
          }
        }
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })(),
  );
});
