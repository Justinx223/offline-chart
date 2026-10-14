// Service Worker: speichert App und Kursdaten, damit der Chart auf dem iPad auch ohne Internet läuft.
// Bei Änderungen an der App die Versionsnummer erhöhen, dann holt sich das iPad die neue Version.
const VERSION = 'replay-app-202610141058';
const SHELL = [
  './', 'index.html', 'Replay.html', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'app/ta.js', 'app/data.js', 'app/engine.js', 'app/runner.js', 'app/chart.js', 'app/drawings.js', 'app/replay_page.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(f => c.add(f).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('replay-app-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Zuerst aus dem Speicher, sonst aus dem Netz (und dann speichern)
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(resp => {
    if (resp.ok) {
      const copy = resp.clone();
      caches.open(req.url.includes('/daten/') ? 'replay-daten' : VERSION).then(c => c.put(req, copy));
    }
    return resp;
  })));
});
