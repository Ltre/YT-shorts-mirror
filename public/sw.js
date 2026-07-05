const APP_CACHE = 'elder-app-shell-v2';
const RECENT_VIDEO_CACHE = 'elder-recent-videos-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('elder-app-shell-') && name !== APP_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  if (url.pathname === '/admin' || url.pathname === '/admin.html' || url.pathname === '/admin.js' || url.pathname === '/admin.css') {
    event.respondWith(fetch(req, { cache: 'no-store' }));
    return;
  }

  if (isVideoPath(url.pathname)) {
    event.respondWith(cacheFirstVideo(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html')));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || network;
}

async function cacheFirstVideo(req) {
  const cache = await caches.open(RECENT_VIDEO_CACHE);
  const urlNoRange = new Request(req.url, { method: 'GET' });
  const cached = await cache.match(urlNoRange);
  if (cached) {
    const range = req.headers.get('range');
    if (range) return rangeResponse(cached, range);
    return cached;
  }
  return fetch(req);
}

async function rangeResponse(response, rangeHeader) {
  const size = Number(response.headers.get('content-length')) || null;
  const contentType = response.headers.get('content-type') || 'video/mp4';
  const buffer = await response.arrayBuffer();
  const total = size || buffer.byteLength;
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return response;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }
  end = Math.min(end, total - 1);
  const chunk = buffer.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(chunk.byteLength),
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes'
    }
  });
}

function isVideoPath(pathname) {
  return pathname.startsWith('/media/') || pathname.startsWith('/cached/') || /\.(mp4|webm|mov)$/i.test(pathname);
}
