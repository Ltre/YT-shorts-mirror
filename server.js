const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');
const config = require('./server/config');
const store = require('./server/store');
const { learnFromEvent, recommend } = require('./server/recommender');
const queue = require('./server/prefetch-queue');

const YT_COOKIES_FILE = path.join(config.dataDir, 'yt-cookies.txt');

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
  if (url.pathname === '/admin') {
    return sendFile(req, res, path.join(config.publicDir, 'admin.html'), { maxAge: 0 });
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

  if (req.method === 'GET' && url.pathname === '/api/admin/cookies') {
    return sendJson(res, 200, { item: await getCookiesMeta() });
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/cookies') {
    const body = await readJsonBody(req);
    const cookies = String(body.cookies || '').trim();
    if (!cookies) return sendJson(res, 400, { error: 'empty_cookies', message: 'cookies 不能为空' });
    await fsp.mkdir(config.dataDir, { recursive: true });
    await fsp.writeFile(YT_COOKIES_FILE, `${cookies}\n`, 'utf8');
    return sendJson(res, 200, { ok: true, item: await getCookiesMeta() });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/cache/videos') {
    return sendJson(res, 200, await getAdminCacheVideos());
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/stream') {
    return streamAdminEvents(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/cache/videos') {
    const body = await readJsonBody(req);
    const sourceUrl = String(body.sourceUrl || '').trim();
    if (!/^https?:\/\//i.test(sourceUrl)) return sendJson(res, 400, { error: 'invalid_source_url', message: 'sourceUrl 必须是 http(s) 链接' });
    const video = await store.upsertVideo({
      id: body.id || makeVideoIdFromUrl(sourceUrl),
      title: body.title || '待缓存视频',
      description: body.description || '',
      sourceUrl,
      url: null,
      thumb: body.thumb || '',
      tags: Array.isArray(body.tags) ? body.tags : [],
      duration: Number(body.duration || 0),
      author: body.author || 'YouTube',
      cacheState: 'new',
      cachedAt: null
    });
    const job = await queue.enqueueVideo(video.id, 'admin add video');
    return sendJson(res, 201, { ok: true, item: publicVideo(video), job });
  }

  const cacheDeleteMatch = url.pathname.match(/^\/api\/admin\/cache\/videos\/([^/]+)$/);
  if (req.method === 'DELETE' && cacheDeleteMatch) {
    const videoId = decodeURIComponent(cacheDeleteMatch[1]);
    const result = await deleteCachedVideo(videoId);
    if (!result) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, { ok: true, item: result });
  }

  const cachePrefetchMatch = url.pathname.match(/^\/api\/admin\/cache\/videos\/([^/]+)\/prefetch$/);
  if (req.method === 'POST' && cachePrefetchMatch) {
    const videoId = decodeURIComponent(cachePrefetchMatch[1]);
    const job = await queue.enqueueVideo(videoId, 'admin manual cache');
    return sendJson(res, 200, { ok: true, job });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/history') {
    const elderId = url.searchParams.get('elderId') || config.defaultElderId;
    return sendJson(res, 200, await getAdminHistory(elderId));
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function getCookiesMeta() {
  try {
    const stat = await fsp.stat(YT_COOKIES_FILE);
    return {
      exists: true,
      fileName: path.basename(YT_COOKIES_FILE),
      relativePath: path.relative(config.rootDir, YT_COOKIES_FILE),
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString()
    };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return {
      exists: false,
      fileName: path.basename(YT_COOKIES_FILE),
      relativePath: path.relative(config.rootDir, YT_COOKIES_FILE),
      bytes: 0,
      updatedAt: null
    };
  }
}

async function getAdminCacheVideos() {
  const [videos, jobs] = await Promise.all([store.getVideos(), store.getJobs()]);
  const items = [];
  for (const video of videos) {
    const cacheFile = path.join(config.cacheDir, `${safeFileName(video.id)}.mp4`);
    let stat = null;
    try { stat = await fsp.stat(cacheFile); } catch (_) {}
    const latestJob = jobs.filter((job) => job.videoId === video.id).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
    items.push({
      id: video.id,
      title: video.title,
      sourceUrl: video.sourceUrl || '',
      url: video.url || '',
      cacheState: video.cacheState || (video.url ? 'ready' : 'new'),
      cachedAt: video.cachedAt || null,
      cacheError: video.cacheError || '',
      bytes: stat?.size || video.bytes || 0,
      fileExists: Boolean(stat),
      fileName: `${safeFileName(video.id)}.mp4`,
      latestJob
    });
  }
  return { items };
}

async function deleteCachedVideo(videoId) {
  const videos = await store.getVideos();
  const video = videos.find((item) => item.id === videoId);
  if (!video) return null;
  const cacheFile = path.join(config.cacheDir, `${safeFileName(video.id)}.mp4`);
  try { await fsp.unlink(cacheFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const patch = {
    url: video.sourceUrl ? null : video.url,
    cacheState: video.sourceUrl ? 'new' : (video.url ? 'ready' : 'new'),
    cachedAt: null,
    bytes: 0,
    cacheError: ''
  };
  return store.updateVideo(video.id, patch);
}

async function getAdminHistory(elderId) {
  const [profile, videos] = await Promise.all([store.getProfile(elderId), store.getVideos()]);
  const videoMap = new Map(videos.map((video) => [video.id, video]));
  const events = (profile.events || []).slice().reverse().slice(0, 300).map((event) => {
    const video = videoMap.get(event.videoId);
    return {
      ...event,
      title: video?.title || event.videoId || '(无视频)',
      author: video?.author || '',
      tags: video?.tags || []
    };
  });
  return {
    elderId,
    summary: summarizeProfile(profile),
    events,
    watchHistory: (profile.watchHistory || []).slice().reverse().map((videoId) => {
      const video = videoMap.get(videoId);
      return { videoId, title: video?.title || videoId, author: video?.author || '', tags: video?.tags || [] };
    })
  };
}

async function streamAdminEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');

  let closed = false;
  req.on('close', () => { closed = true; });

  const sendSnapshot = async () => {
    if (closed) return;
    try {
      const payload = await getAdminCacheVideos();
      res.write(`event: cache\n`);
      res.write(`data: ${JSON.stringify({ ...payload, at: new Date().toISOString() })}\n\n`);
    } catch (err) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: err.message })}\n\n`);
    }
  };

  await sendSnapshot();
  const timer = setInterval(sendSnapshot, 1200);
  req.on('close', () => clearInterval(timer));
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

function safeFileName(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function makeVideoIdFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const ytId = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
    if (ytId) return safeFileName(`yt_${ytId}`).slice(0, 80);
  } catch (_) {}
  return store.makeId('yt');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
