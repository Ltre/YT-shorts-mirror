const ELDER_ID = localStorage.getItem('elderId') || 'default';
localStorage.setItem('elderId', ELDER_ID);

const RECENT_VIDEO_CACHE = {
  cacheName: 'elder-recent-videos-v1',
  dbName: 'elder-recent-video-meta',
  storeName: 'videos',
  maxItems: 12,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  watchedAfterMs: 1800,
  preloadAhead: 2
};

const state = {
  feed: [],
  visibleId: null,
  profileSummary: null,
  observer: null,
  watchTimers: new Map(),
  watchStartedAt: new Map(),
  installPrompt: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const feedEl = $('#feed');
const template = $('#videoTemplate');
const installBtn = $('#installBtn');
const statusBtn = $('#statusBtn');
const drawer = $('#drawer');
const closeDrawer = $('#closeDrawer');
const cacheInfo = $('#cacheInfo');
const profileInfo = $('#profileInfo');
const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  installBtn.classList.add('hidden');
});

statusBtn.addEventListener('click', openStatusDrawer);
closeDrawer.addEventListener('click', () => drawer.classList.add('hidden'));
drawer.addEventListener('click', (event) => {
  if (event.target === drawer) drawer.classList.add('hidden');
});
searchBtn.addEventListener('click', submitSearch);
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitSearch();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseAllVideos();
  else playVisibleVideo();
});

init().catch((err) => {
  console.error(err);
  toast('页面初始化失败');
});

async function init() {
  await registerServiceWorker();
  await recentCache.init();
  await recentCache.purge();
  await loadFeed();
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Service Worker register failed', err);
  }
}

async function loadFeed() {
  const res = await fetch(`/api/feed?elderId=${encodeURIComponent(ELDER_ID)}&limit=10`, { cache: 'no-store' });
  const data = await res.json();
  state.feed = data.items || [];
  state.profileSummary = data.profileSummary || null;
  renderFeed(state.feed);
  setupObserver();
  setTimeout(() => playVisibleVideo(), 250);
}

function renderFeed(items) {
  feedEl.innerHTML = '';
  for (const item of items) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.videoId = item.id;
    const video = $('video', node);
    const url = item.url;
    if (url) {
      video.src = url;
      video.dataset.src = url;
    } else {
      node.classList.add('no-video');
    }
    $('.author', node).textContent = `@${item.author || '自家视频'}`;
    $('.title', node).textContent = item.title || '未命名视频';
    $('.desc', node).textContent = item.description || '这个视频还没有简介';
    $('.tags', node).innerHTML = (item.tags || []).slice(0, 4).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('');
    $('.cache-badge', node).textContent = badgeText(item);

    $('.like', node).addEventListener('click', () => markAction(item, 'like', node));
    $('.dislike', node).addEventListener('click', () => markAction(item, 'dislike', node));
    $('.favorite', node).addEventListener('click', () => markAction(item, 'favorite', node));
    $('.replay', node).addEventListener('click', () => {
      video.currentTime = 0;
      video.play().catch(() => {});
    });
    $('.big-play', node).addEventListener('click', () => togglePlay(node));
    video.addEventListener('click', () => togglePlay(node));
    video.addEventListener('play', () => {
      node.classList.remove('paused');
      state.watchStartedAt.set(item.id, Date.now());
      postEvent('play', item.id, 1);
      scheduleWatchedCache(item);
    });
    video.addEventListener('pause', () => {
      node.classList.add('paused');
      flushWatch(item.id, video.currentTime || 0);
    });
    video.addEventListener('ended', () => flushWatch(item.id, video.duration || 0));

    feedEl.appendChild(node);
  }
}

function setupObserver() {
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const card = entry.target;
      const id = card.dataset.videoId;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.72) {
        state.visibleId = id;
        postEvent('impression', id, 1);
        pauseAllVideos(card);
        playCard(card);
        maybeLoadMore(card);
        prefetchAround(id).catch(console.warn);
      } else {
        const video = $('video', card);
        if (video && !video.paused) {
          const watched = Date.now() - (state.watchStartedAt.get(id) || Date.now());
          if (watched < 1100) postEvent('skip', id, 1);
          flushWatch(id, Math.round((video.currentTime || 0) * 10) / 10);
          video.pause();
        }
      }
    }
  }, { root: feedEl, threshold: [0, 0.3, 0.72, 1] });

  for (const card of feedEl.querySelectorAll('.video-card')) {
    state.observer.observe(card);
  }
}

function playVisibleVideo() {
  const current = [...feedEl.querySelectorAll('.video-card')].find((card) => card.dataset.videoId === state.visibleId)
    || feedEl.querySelector('.video-card');
  if (current) playCard(current);
}

function playCard(card) {
  if (document.hidden || card.classList.contains('no-video')) return;
  const video = $('video', card);
  if (!video || !video.src) return;
  video.muted = getMutedDefault();
  video.play().catch(() => {
    card.classList.add('paused');
  });
}

function pauseAllVideos(exceptCard = null) {
  for (const card of feedEl.querySelectorAll('.video-card')) {
    if (card === exceptCard) continue;
    const video = $('video', card);
    if (video && !video.paused) video.pause();
  }
}

function togglePlay(card) {
  const video = $('video', card);
  if (!video || !video.src) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function flushWatch(videoId, seconds) {
  if (!videoId) return;
  const started = state.watchStartedAt.get(videoId);
  if (!started) return;
  const wallSeconds = Math.max(0, (Date.now() - started) / 1000);
  state.watchStartedAt.delete(videoId);
  postEvent('watch', videoId, Math.max(seconds || 0, wallSeconds));
}

function scheduleWatchedCache(item) {
  if (!item.url) return;
  if (state.watchTimers.has(item.id)) return;
  const timer = setTimeout(async () => {
    state.watchTimers.delete(item.id);
    try {
      await recentCache.cacheVideo(item.url, item.id);
      updateBadge(item.id, '浏览器已缓存');
    } catch (err) {
      console.warn('recent cache failed', err);
    }
  }, RECENT_VIDEO_CACHE.watchedAfterMs);
  state.watchTimers.set(item.id, timer);
}

async function prefetchAround(videoId) {
  const index = state.feed.findIndex((item) => item.id === videoId);
  if (index < 0) return;
  const next = state.feed.slice(index + 1, index + 1 + RECENT_VIDEO_CACHE.preloadAhead).filter((item) => item.url);
  await Promise.allSettled(next.map((item) => recentCache.cacheVideo(item.url, item.id, { preloaded: true })));
  fetch('/api/prefetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ elderId: ELDER_ID, limit: 5 })
  }).catch(() => {});
}

async function maybeLoadMore(card) {
  const cards = [...feedEl.querySelectorAll('.video-card')];
  const index = cards.indexOf(card);
  if (index >= cards.length - 3) {
    await appendMoreFeed();
  }
}

let loadingMore = false;
async function appendMoreFeed() {
  if (loadingMore) return;
  loadingMore = true;
  try {
    const res = await fetch(`/api/feed?elderId=${encodeURIComponent(ELDER_ID)}&limit=8&t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    const existing = new Set(state.feed.map((item) => item.id));
    const fresh = (data.items || []).filter((item) => !existing.has(item.id));
    state.feed.push(...fresh);
    const oldCount = feedEl.children.length;
    for (const item of fresh) {
      const tmp = document.createElement('div');
      const prev = state.feed;
      renderOneAppend(item);
      state.feed = prev;
    }
    for (const card of [...feedEl.querySelectorAll('.video-card')].slice(oldCount)) {
      state.observer.observe(card);
    }
  } finally {
    loadingMore = false;
  }
}

function renderOneAppend(item) {
  const current = [...feedEl.children];
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.videoId = item.id;
  const video = $('video', node);
  if (item.url) {
    video.src = item.url;
    video.dataset.src = item.url;
  } else {
    node.classList.add('no-video');
  }
  $('.author', node).textContent = `@${item.author || '自家视频'}`;
  $('.title', node).textContent = item.title || '未命名视频';
  $('.desc', node).textContent = item.description || '这个视频还没有简介';
  $('.tags', node).innerHTML = (item.tags || []).slice(0, 4).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join('');
  $('.cache-badge', node).textContent = badgeText(item);
  $('.like', node).addEventListener('click', () => markAction(item, 'like', node));
  $('.dislike', node).addEventListener('click', () => markAction(item, 'dislike', node));
  $('.favorite', node).addEventListener('click', () => markAction(item, 'favorite', node));
  $('.replay', node).addEventListener('click', () => { video.currentTime = 0; video.play().catch(() => {}); });
  $('.big-play', node).addEventListener('click', () => togglePlay(node));
  video.addEventListener('click', () => togglePlay(node));
  video.addEventListener('play', () => {
    node.classList.remove('paused');
    state.watchStartedAt.set(item.id, Date.now());
    postEvent('play', item.id, 1);
    scheduleWatchedCache(item);
  });
  video.addEventListener('pause', () => {
    node.classList.add('paused');
    flushWatch(item.id, video.currentTime || 0);
  });
  feedEl.appendChild(node);
}

function markAction(item, type, card) {
  const btn = $(`.${type}`, card);
  btn?.classList.add('active');
  postEvent(type, item.id, 1);
  if (type === 'dislike') {
    toast('以后少推荐类似的');
    setTimeout(() => feedEl.scrollBy({ top: window.innerHeight, behavior: 'smooth' }), 250);
  } else if (type === 'like') {
    toast('记住了：喜欢这个');
  } else if (type === 'favorite') {
    toast('已收藏');
  }
}

async function submitSearch() {
  const keyword = searchInput.value.trim();
  if (!keyword) return;
  searchInput.blur();
  await postEvent('search', state.visibleId, 1, { keyword });
  toast(`多推荐：${keyword}`);
  await loadFeed();
}

async function postEvent(type, videoId, value = 1, extra = {}) {
  try {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elderId: ELDER_ID, videoId, type, value, extra })
    });
    const data = await res.json();
    if (data.profileSummary) state.profileSummary = data.profileSummary;
    return data;
  } catch (err) {
    console.warn('event failed', type, err);
    return null;
  }
}

async function openStatusDrawer() {
  drawer.classList.remove('hidden');
  const [local, jobs] = await Promise.allSettled([
    recentCache.stats(),
    fetch('/api/cache/jobs', { cache: 'no-store' }).then((r) => r.json())
  ]);
  const localValue = local.status === 'fulfilled' ? local.value : { count: 0, items: [] };
  const jobItems = jobs.status === 'fulfilled' ? jobs.value.items || [] : [];
  cacheInfo.innerHTML = `
    <p><b>浏览器最近视频缓存：</b><code>${localValue.count}</code> 个，最多 ${RECENT_VIDEO_CACHE.maxItems} 个，${Math.round(RECENT_VIDEO_CACHE.ttlMs / 86400000)} 天过期。</p>
    <p><b>最近服务端缓存任务：</b></p>
    <ul>${jobItems.slice(0, 8).map((job) => `<li><code>${escapeHtml(job.status)}</code> ${escapeHtml(job.videoId)} ${escapeHtml(job.message || '')}</li>`).join('') || '<li>暂无任务</li>'}</ul>
  `;
  const tags = state.profileSummary?.topTags || [];
  profileInfo.innerHTML = `
    <p><b>当前偏好标签：</b>${tags.length ? tags.map((item) => `<span class="tag">#${escapeHtml(item.tag)} ${item.score}</span>`).join(' ') : '还在学习中'}</p>
  `;
}

function badgeText(item) {
  if (!item.url) return item.cacheState === 'failed' ? '服务端缓存失败' : '等待服务端缓存';
  if (item.url.startsWith('/cached/')) return '服务端已缓存';
  if (item.url.startsWith('/media/')) return '本地视频';
  return '在线播放';
}

function updateBadge(videoId, text) {
  const card = feedEl.querySelector(`[data-video-id="${CSS.escape(videoId)}"]`);
  if (card) $('.cache-badge', card).textContent = text;
}

function getMutedDefault() {
  // 老人使用时通常希望打开就有声音；但移动端自动播放策略可能要求静音。
  // 首次播放失败时用户点一下大播放按钮即可。
  return false;
}

function toast(message) {
  const old = $('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

const recentCache = {
  db: null,

  async init() {
    if (!('caches' in window) || !('indexedDB' in window)) return;
    this.db = await openDb();
  },

  async cacheVideo(url, videoId, options = {}) {
    if (!url || !this.db || !('caches' in window)) return false;
    if (!url.startsWith(location.origin) && !url.startsWith('/')) return false;

    const absoluteUrl = new URL(url, location.origin).toString();
    const now = Date.now();
    const existing = await idbGet(this.db, absoluteUrl);
    if (existing && existing.expiresAt > now) {
      existing.lastWatchedAt = now;
      existing.preloaded = Boolean(options.preloaded || existing.preloaded);
      await idbPut(this.db, existing);
      return true;
    }

    const res = await fetch(absoluteUrl, { cache: 'no-store' });
    if (!res.ok) return false;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('video/')) return false;

    const cache = await caches.open(RECENT_VIDEO_CACHE.cacheName);
    await cache.put(new Request(absoluteUrl), res.clone());
    await idbPut(this.db, {
      url: absoluteUrl,
      videoId,
      cachedAt: now,
      lastWatchedAt: now,
      expiresAt: now + RECENT_VIDEO_CACHE.ttlMs,
      preloaded: Boolean(options.preloaded)
    });
    await this.purge();
    return true;
  },

  async purge() {
    if (!this.db || !('caches' in window)) return;
    const cache = await caches.open(RECENT_VIDEO_CACHE.cacheName);
    const all = await idbAll(this.db);
    const now = Date.now();
    const expired = all.filter((item) => item.expiresAt <= now);
    for (const item of expired) {
      await cache.delete(new Request(item.url));
      await idbDelete(this.db, item.url);
    }

    const remaining = (await idbAll(this.db)).sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    const overflow = remaining.slice(RECENT_VIDEO_CACHE.maxItems);
    for (const item of overflow) {
      await cache.delete(new Request(item.url));
      await idbDelete(this.db, item.url);
    }
  },

  async stats() {
    if (!this.db) return { count: 0, items: [] };
    await this.purge();
    const items = await idbAll(this.db);
    return { count: items.length, items };
  }
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECENT_VIDEO_CACHE.dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECENT_VIDEO_CACHE.storeName)) {
        const store = db.createObjectStore(RECENT_VIDEO_CACHE.storeName, { keyPath: 'url' });
        store.createIndex('lastWatchedAt', 'lastWatchedAt');
        store.createIndex('expiresAt', 'expiresAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(db, mode = 'readonly') {
  return db.transaction(RECENT_VIDEO_CACHE.storeName, mode).objectStore(RECENT_VIDEO_CACHE.storeName);
}
function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = idbTx(db).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, value) {
  return new Promise((resolve, reject) => {
    const req = idbTx(db, 'readwrite').put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const req = idbTx(db, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function idbAll(db) {
  return new Promise((resolve, reject) => {
    const req = idbTx(db).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
