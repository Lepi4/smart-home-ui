/* ALLHA-2D Service Worker вЂ” offline caching */
const CACHE = 'allha2d-v5.1.0-beta.40';
const PRECACHE = ['./', './app.js', './style.css', './config.js', './devices.js', './lovelace-source.js', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API, media Рё ingress вЂ” С‚РѕР»СЊРєРѕ СЃРµС‚СЊ, Р±РµР· РєСЌС€Р°
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/media/') ||
      url.pathname.includes('hassio_ingress')) {
    return;
  }
  // РЎС‚Р°С‚РёРєР° вЂ” СЃРµС‚СЊ РїРµСЂРІР°СЏ, РїСЂРё РѕС€РёР±РєРµ вЂ” РєСЌС€
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
