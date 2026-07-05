const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const store = require('./store');
const contentPool = require('./content-pool');

const ROOT = path.resolve(__dirname, '..');
const cookiesPath = path.join(config.dataDir, 'yt-cookies.txt');
let running = false;
let lastRunAt = 0;

function startAutoDiscovery(queue) {
  if (!config.autoDiscoveryEnabled) return;
  setTimeout(() => {
    discoverAndQueue(config.defaultElderId, queue, { reason: 'startup auto discovery' }).catch((err) => {
      console.warn('[youtube-discovery] startup failed:', err.message);
    });
  }, 1800);
}

async function discoverAndQueue(elderId, queue, options = {}) {
  if (!config.autoDiscoveryEnabled && !options.force) return { skipped: true, reason: 'disabled' };
  if (running) return { skipped: true, reason: 'already running' };
  const now = Date.now();
  if (!options.force && now - lastRunAt < config.autoDiscoveryCooldownMs) {
    return { skipped: true, reason: 'cooldown' };
  }

  running = true;
  lastRunAt = now;
  try {
    const poolState = await contentPool.shouldDiscoverForElder(elderId, options);
    if (!options.force && !poolState.shouldDiscover) {
      return { added: 0, queued: 0, reason: 'content pool has enough unseen ready videos', poolState };
    }

    const videos = await store.getVideos();
    const pendingExternal = videos.filter((video) => video.sourceUrl && video.cacheState !== 'ready').length;
    const readyExternal = videos.filter((video) => video.sourceUrl && video.cacheState === 'ready' && video.url).length;
    const wanted = Math.max(0, Math.max(Number(options.limit || config.autoDiscoveryLimit), poolState.minUnseenReady - poolState.unseenReadyCount - poolState.pendingCount));
    if (!options.force && wanted <= 0) return { added: 0, queued: 0, reason: 'enough external videos' };

    const terms = await getSearchTerms(elderId);
    const discovered = [];
    for (const term of terms) {
      if (discovered.length >= Math.max(1, wanted || config.autoDiscoveryLimit)) break;
      const items = await searchYouTube(term, Math.min(8, config.autoDiscoveryLimit * 2));
      for (const item of items) {
        if (discovered.length >= Math.max(1, wanted || config.autoDiscoveryLimit)) break;
        const verified = await verifyShortsCandidate(item).catch(() => null);
        if (verified) discovered.push({ ...item, ...verified, searchTerm: term });
      }
    }

    const knownUrls = new Set(videos.map((video) => video.sourceUrl).filter(Boolean));
    const knownIds = new Set(videos.map((video) => video.id));
    const added = [];
    const queued = [];
    for (const item of discovered) {
      if (!item.sourceUrl || knownUrls.has(item.sourceUrl) || knownIds.has(item.id)) continue;
      const video = await store.upsertVideo({
        id: item.id,
        title: item.title || 'YouTube Shorts 推荐视频',
        description: item.description || `自动发现 Shorts：${item.searchTerm}`,
        sourceUrl: item.sourceUrl,
        url: null,
        thumb: item.thumb || '',
        tags: item.tags || [item.searchTerm],
        duration: item.duration || 0,
        author: item.author || 'YouTube',
        cacheState: 'new',
        cachedAt: null
      });
      added.push(video);
      const job = await queue.enqueueVideo(video.id, options.reason || `auto discovery: ${item.searchTerm}`);
      if (job) queued.push(job);
    }
    return { added: added.length, queued: queued.length, terms };
  } finally {
    running = false;
  }
}

async function getSearchTerms(elderId) {
  const profile = await store.getProfile(elderId || config.defaultElderId);
  const searches = Array.isArray(profile.searches) ? profile.searches.slice(0, 3) : [];
  const topTags = Object.entries(profile.tagScores || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag);
  return [...new Set([...searches, ...topTags, ...config.autoDiscoverySearchTerms])]
    .filter(Boolean)
    .map((term) => /\bshorts?\b|#shorts/i.test(term) ? term : `${term} shorts`);
}

async function searchYouTube(term, limit) {
  const query = `ytsearch${limit}:${term} #shorts`;
  const stdout = await runYtDlp(['--dump-json', '--flat-playlist', '--cookies', cookiesPath, query]);
  return stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean)
    .map((item) => {
      const ytId = item.id || videoIdFromUrl(item.url || item.webpage_url || '');
      const sourceUrl = item.webpage_url || item.url || (ytId ? `https://www.youtube.com/watch?v=${ytId}` : '');
      return {
        id: ytId ? safeFileName(`yt_${ytId}`).slice(0, 80) : store.makeId('yt'),
        title: item.title || '',
        description: item.description || '',
        sourceUrl: normalizeShortsUrl(sourceUrl, ytId),
        thumb: item.thumbnail || '',
        author: item.uploader || item.channel || 'YouTube',
        duration: Number(item.duration || 0),
        tags: [term, 'Shorts']
      };
    })
    .filter((item) => !item.duration || item.duration <= config.autoDiscoveryMaxDurationSeconds)
    .filter((item) => /^https?:\/\//i.test(item.sourceUrl));
}

async function verifyShortsCandidate(item) {
  if (!item.sourceUrl) return null;
  const stdout = await runYtDlp(['--dump-single-json', '--skip-download', '--cookies', cookiesPath, item.sourceUrl]);
  const meta = JSON.parse(stdout);
  const duration = Number(meta.duration || item.duration || 0);
  if (duration > config.autoDiscoveryMaxDurationSeconds) return null;

  const webpageUrl = meta.webpage_url || item.sourceUrl;
  const originalUrl = meta.original_url || '';
  const title = meta.title || item.title || '';
  const description = meta.description || item.description || '';
  const urlLooksShorts = /\/shorts\//i.test(`${webpageUrl} ${originalUrl}`);
  const textLooksShorts = /#shorts?\b|\bshorts?\b/i.test(`${title} ${description}`);
  if (!urlLooksShorts && !textLooksShorts) return null;

  const ytId = meta.id || item.id.replace(/^yt_/, '');
  return {
    id: ytId ? safeFileName(`yt_${ytId}`).slice(0, 80) : item.id,
    title,
    description,
    sourceUrl: normalizeShortsUrl(webpageUrl || item.sourceUrl, ytId),
    thumb: meta.thumbnail || item.thumb || '',
    author: meta.uploader || meta.channel || item.author || 'YouTube',
    duration,
    tags: [...new Set([...(item.tags || []), 'Shorts'])]
  };
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const { command, args: finalArgs } = ytDlpCommand(args);
    const child = spawn(command, finalArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildYtDlpEnv()
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? '找不到 yt-dlp' : err.message)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp search exited ${code}`));
    });
  });
}

function ytDlpCommand(args) {
  const command = process.env.YT_DLP_BIN || 'yt-dlp';
  const prefixArgs = (process.env.YT_DLP_BIN_ARGS || '').split(/\s+/).filter(Boolean);
  const runtimeArgs = process.env.YT_DLP_DISABLE_EJS === '1'
    ? []
    : ['--js-runtimes', 'node', '--remote-components', 'ejs:github', '--no-cache-dir'];
  return { command, args: [...prefixArgs, ...runtimeArgs, ...args] };
}

function buildYtDlpEnv() {
  const env = { ...process.env };
  const proxy = env.YT_DLP_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || '';
  const allProxy = env.YT_DLP_ALL_PROXY || env.ALL_PROXY || proxy;
  if (proxy) {
    env.HTTP_PROXY = env.HTTP_PROXY || proxy;
    env.HTTPS_PROXY = env.HTTPS_PROXY || proxy;
    env.http_proxy = env.http_proxy || env.HTTP_PROXY;
    env.https_proxy = env.https_proxy || env.HTTPS_PROXY;
  }
  if (allProxy) {
    env.ALL_PROXY = env.ALL_PROXY || allProxy;
    env.all_proxy = env.all_proxy || env.ALL_PROXY;
  }
  return env;
}

function videoIdFromUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
  } catch (_) {
    return '';
  }
}

function normalizeShortsUrl(sourceUrl, ytId) {
  if (ytId) return `https://www.youtube.com/shorts/${ytId}`;
  return sourceUrl;
}

function safeFileName(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = { startAutoDiscovery, discoverAndQueue };
