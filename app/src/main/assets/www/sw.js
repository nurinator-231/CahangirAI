/* sw.js — oflayn işləmə: bütün fayllar ilk açılışda keşlənir. */
const VERSION = 'cahangir-v3.0';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/nlp.js', 'js/store.js', 'js/brain.js', 'js/llm.js', 'js/native_bridge.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k.startsWith('cahangir-')).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !cdn) return;
  if (req.headers.has('range')) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then(res => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) cache.put(req, res.clone()).catch(() => { });
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') { const idx = await cache.match('index.html'); if (idx) return idx; }
    return new Response('Oflayn', { status: 503, statusText: 'Offline' });
  })());
});

self.addEventListener('notificationclick', e => {
  const n = e.notification; const id = n.data && n.data.id; const action = e.action || 'open';
  n.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length) {
      const c = list.find(x => x.visibilityState === 'visible') || list[0];
      try { await c.focus(); } catch (err) { /* */ }
      c.postMessage({ type: 'notif', action, id });
    } else if (id) {
      await self.clients.openWindow('./?ring=' + id + '&act=' + action);
    }
  })());
});
