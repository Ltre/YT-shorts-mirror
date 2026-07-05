const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const config = require('./server/config');
const store = require('./server/store');
const { learnFromEvent, recommend } = require('./server/recommender');
const queue = require('./server/prefetch-queue');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon'
};

async function main() {
  await fsp.mkdir(config.publicDir, { recursive: true });
  await fsp.mkdir(config.cacheDir, { recursive: true });
  queue.startQueue();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: 'internal_error', message: err.message });
    });
  });

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`Elder Shorts PWA running at http://localhost:${config.port}`);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }
  if (url.pathname.startsWith('/cached/')) {
    const filePath = path.join(config.cacheDir, safeRelative(url.pathname.replace('/cached/', '')));
    return sendFile(req, res, filePath, { maxAge: config.cachedVideoMaxAgeSeconds });
  }
  if (url.pathname.startsWith('/media/')) {
    const filePath = path.join(config.publicDir, safeRelative(url.pathname));
    return sendFile(req, res, filePath, { maxAge: config.staticMaxAgeSeconds });
  }
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(config.publicDir, safeRelative(requested));
  try {
    await fsp.access(filePath);
    return sendFile(req, res, filePath, { maxAge: config.staticMaxAgeSeconds });
  } catch (_) {
    return sendFile(req, res, path.join(config.publicDir, 'index.html'), { maxAge: 0 });
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, at: new Date().toISOString() });
  }

  if (req.method === 'GET' && url.pathname === '/api/feed') {
    const elderId = url.searchParams.get('elderId') || config.defaultElderId;
    const limit = Number(url.searchParams.get('limit') || 8);
    const videos = await store.getVideos();
    const profile = await store.getProfile(elderId);
    const items = recommend(videos, profile, { limit }).map(publicVideo);
    queue.enqueueRecommendations(elderId, Math.min(config.serverPrefetchLimit, limit)).catch(console.error);
    return sendJson(res, 200, { elderId, items, profileSummary: summarizeProfile(profile) });
  }

  if (req.method === 'GET' && url.pathname === '/api/videos') {
    const videos = await store.getVideos();
    return sendJson(res, 200, { items: videos.map(publicVideo) });
  }

  if (req.method === 'POST' && url.pathname === '/api/videos') {
    const body = await readJsonBody(req);
    const video = await store.upsertVideo(body);
    if (!video.url && video.sourceUrl) {
      await queue.enqueueVideo(video.id, 'new video');
    }
    return sendJson(res, 201, { item: publicVideo(video) });
  }

  if (req.method === 'POST' && url.pathname === '/api/events') {
    const body = await readJsonBody(req);
    const elderId = body.elderId || config.defaultElderId;
    const videos = await store.getVideos();
    const video = videos.find((item) => item.id === body.videoId) || null;
    const profile = await store.getProfile(elderId);
    learnFromEvent(profile, video, {
      type: body.type,
      value: body.value,
      videoId: body.videoId,
      extra: body.extra || {}
    });
    await store.saveProfile(profile);

    if (['play', 'watch', 'like', 'favorite', 'search'].includes(body.type)) {
      queue.enqueueRecommendations(elderId, config.serverPrefetchLimit).catch(console.error);
    }

    return sendJson(res, 200, { ok: true, profileSummary: summarizeProfile(profile) });
  }

  if (req.method === 'POST' && url.pathname === '/api/prefetch') {
    const body = await readJsonBody(req);
    const elderId = body.elderId || config.defaultElderId;
    const limit = Number(body.limit || config.serverPrefetchLimit);
    const jobs = await queue.enqueueRecommendations(elderId, limit);
    return sendJson(res, 200, { queued: jobs });
  }

  if (req.method === 'GET' && url.pathname === '/api/cache/jobs') {
    const jobs = await store.getJobs();
    return sendJson(res, 200, { items: jobs.slice().reverse().slice(0, 100) });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

function publicVideo(video) {
  return {
    id: video.id,
    title: video.title,
    description: video.description || '',
    url: video.url,
    thumb: video.thumb || '',
    tags: video.tags || [],
    duration: video.duration || 0,
    author: video.author || '自家视频',
    cacheState: video.cacheState || (video.url ? 'ready' : 'new'),
    cachedAt: video.cachedAt || null,
    score: video.score
  };
}

function summarizeProfile(profile) {
  const topTags = Object.entries(profile.tagScores || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, score]) => ({ tag, score: Number(score.toFixed(2)) }));
  return {
    elderId: profile.elderId,
    topTags,
    likedCount: profile.liked?.length || 0,
    favoritesCount: profile.favorites?.length || 0,
    watchCount: profile.watchHistory?.length || 0
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    const err = new Error('Invalid JSON body');
    err.status = 400;
    throw err;
  }
}

async function sendFile(req, res, filePath, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': `public, max-age=${Number(options.maxAge || 0)}`
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    const start = startRaw ? Number(startRaw) : 0;
    const end = endRaw ? Number(endRaw) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(filePath).pipe(res);
}

function safeRelative(urlPath) {
  const normalized = path.normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  if (normalized.includes('..')) return 'index.html';
  return normalized;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
