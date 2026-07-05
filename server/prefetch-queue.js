const path = require('path');
const fs = require('fs/promises');
const config = require('./config');
const store = require('./store');
const { recommend } = require('./recommender');
const { ensureCached } = require('./download-adapter');

let running = false;
let active = 0;
let timer = null;

async function enqueueVideo(videoId, reason = 'recommendation') {
  const videos = await store.getVideos();
  const video = videos.find((item) => item.id === videoId);
  if (!video) return null;
  if (video.url && video.cacheState === 'ready') return null;

  const jobs = await store.getJobs();
  const existing = jobs.find((job) => job.videoId === videoId && ['queued', 'running'].includes(job.status));
  if (existing) return existing;

  const job = {
    id: store.makeId('job'),
    videoId,
    status: 'queued',
    reason,
    attempts: 0,
    message: '',
    progress: 0
  };
  await store.upsertJob(job);
  scheduleDrain();
  return job;
}

async function enqueueRecommendations(elderId, limit = config.serverPrefetchLimit) {
  const videos = await store.getVideos();
  const profile = await store.getProfile(elderId || config.defaultElderId);
  const recs = recommend(videos, profile, { limit: Math.max(1, limit * 3) });
  const queued = [];
  for (const video of recs) {
    if (queued.length >= limit) break;
    if (video.url && video.cacheState === 'ready') continue;
    const job = await enqueueVideo(video.id, `prefetch for ${elderId}`);
    if (job) queued.push(job);
  }
  return queued;
}

function startQueue() {
  if (running) return;
  running = true;
  scheduleDrain();
}

function stopQueue() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleDrain(delay = 20) {
  if (!running) return;
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      await drain();
    } catch (err) {
      console.error('[prefetch-queue] drain failed', err);
    }
    if (running) scheduleDrain(1200);
  }, delay);
}

async function drain() {
  if (active >= config.prefetchConcurrency) return;
  const jobs = await store.getJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'running') {
      job.status = 'queued';
      job.message = 'requeued after server restart';
      job.progress = 0;
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await store.saveJobs(jobs);
  const next = jobs.find((job) => job.status === 'queued');
  if (!next) return;
  active += 1;
  processJob(next).finally(() => {
    active -= 1;
    scheduleDrain(20);
  });
}

async function processJob(job) {
  const videos = await store.getVideos();
  const video = videos.find((item) => item.id === job.videoId);
  if (!video) {
    await store.upsertJob({ ...job, status: 'failed', message: 'video not found' });
    return;
  }

  const targetFilePath = path.join(config.cacheDir, `${safeFileName(video.id)}.mp4`);
  await store.upsertJob({
    ...job,
    status: 'running',
    attempts: (job.attempts || 0) + 1,
    progress: 0,
    message: 'starting adapter'
  });
  await store.updateVideo(video.id, { cacheState: 'caching' });

  try {
    const result = await ensureCached(video, targetFilePath, {
      logger: console,
      updateProgress: async (progress, message = '') => {
        await store.upsertJob({ ...job, status: 'running', progress, message });
      }
    });

    if (!result || !result.ok) {
      const note = result?.note || 'adapter returned ok=false';
      await store.upsertJob({ ...job, status: 'failed', progress: 0, message: note });
      await store.updateVideo(video.id, { cacheState: 'failed', cacheError: note });
      return;
    }

    let bytes = result.bytes || 0;
    try {
      const stat = await fs.stat(targetFilePath);
      bytes = stat.size;
    } catch (_) {
      // 已经是 /media/ 本地视频时，可能没有 targetFilePath。
    }

    const cachedUrl = result.cachedUrl || `/cached/${safeFileName(video.id)}.mp4`;
    await store.updateVideo(video.id, {
      url: cachedUrl,
      cacheState: 'ready',
      cacheError: '',
      cachedAt: new Date().toISOString(),
      bytes
    });
    await store.upsertJob({ ...job, status: 'done', progress: 1, message: result.note || 'cached', bytes });
  } catch (err) {
    await store.upsertJob({ ...job, status: 'failed', progress: 0, message: err.message });
    await store.updateVideo(video.id, { cacheState: 'failed', cacheError: err.message });
  }
}

function safeFileName(input) {
  return String(input).replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = {
  startQueue,
  stopQueue,
  enqueueVideo,
  enqueueRecommendations
};
