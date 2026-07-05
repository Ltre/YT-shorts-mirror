const fs = require('fs/promises');
const path = require('path');
const config = require('./config');

const writeLocks = new Map();

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function dataPath(name) {
  return path.join(config.dataDir, name);
}

async function readJson(name, fallback) {
  await ensureDir(config.dataDir);
  try {
    const raw = await fs.readFile(dataPath(name), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await writeJson(name, fallback);
      return structuredCloneSafe(fallback);
    }
    if (err instanceof SyntaxError) {
      err.message = `Invalid JSON in data/${name}: ${err.message}`;
    }
    throw err;
  }
}

async function writeJson(name, value) {
  const previous = writeLocks.get(name) || Promise.resolve();
  const next = previous.then(() => writeJsonNow(name, value), () => writeJsonNow(name, value));
  writeLocks.set(name, next.catch(() => {}));
  try {
    return await next;
  } finally {
    if (writeLocks.get(name) === next) writeLocks.delete(name);
  }
}

async function writeJsonNow(name, value) {
  await ensureDir(config.dataDir);
  const file = dataPath(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await replaceFile(tmp, file);
}

async function replaceFile(tmp, file) {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(err.code) || attempt === maxAttempts) {
        if (['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
          await fs.copyFile(tmp, file);
          await fs.unlink(tmp).catch(() => {});
          return;
        }
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
      await sleep(30 * attempt);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

async function getVideos() {
  return readJson('videos.json', []);
}

async function saveVideos(videos) {
  await writeJson('videos.json', videos);
}

async function upsertVideo(video) {
  const videos = await getVideos();
  const now = new Date().toISOString();
  const normalized = {
    id: video.id || makeId('vid'),
    title: video.title || '未命名视频',
    description: video.description || '',
    url: video.url || null,
    sourceUrl: video.sourceUrl || null,
    thumb: video.thumb || '',
    tags: Array.isArray(video.tags) ? video.tags : [],
    duration: Number(video.duration || 0),
    author: video.author || '自家视频',
    cacheState: video.cacheState || (video.url ? 'ready' : 'new'),
    cachedAt: video.cachedAt || null,
    createdAt: video.createdAt || now,
    updatedAt: now
  };
  const index = videos.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    videos[index] = { ...videos[index], ...normalized, createdAt: videos[index].createdAt || normalized.createdAt };
  } else {
    videos.push(normalized);
  }
  await saveVideos(videos);
  return normalized;
}

async function updateVideo(id, patch) {
  const videos = await getVideos();
  const index = videos.findIndex((video) => video.id === id);
  if (index < 0) return null;
  videos[index] = { ...videos[index], ...patch, updatedAt: new Date().toISOString() };
  await saveVideos(videos);
  return videos[index];
}

async function getProfiles() {
  return readJson('profiles.json', {});
}

async function saveProfiles(profiles) {
  await writeJson('profiles.json', profiles);
}

async function getProfile(elderId) {
  const profiles = await getProfiles();
  if (!profiles[elderId]) {
    profiles[elderId] = createProfile(elderId);
    await saveProfiles(profiles);
  }
  return profiles[elderId];
}

async function saveProfile(profile) {
  const profiles = await getProfiles();
  profiles[profile.elderId] = profile;
  await saveProfiles(profiles);
}

function createProfile(elderId) {
  return {
    elderId,
    tagScores: {},
    authorScores: {},
    liked: [],
    disliked: [],
    favorites: [],
    watchHistory: [],
    searches: [],
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

async function getJobs() {
  return readJson('cache-jobs.json', []);
}

async function saveJobs(jobs) {
  await writeJson('cache-jobs.json', jobs);
}

async function upsertJob(job) {
  const jobs = await getJobs();
  const index = jobs.findIndex((item) => item.id === job.id);
  if (index >= 0) {
    jobs[index] = { ...jobs[index], ...job, updatedAt: new Date().toISOString() };
  } else {
    jobs.push({ ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  await saveJobs(jobs);
  return index >= 0 ? jobs[index] : jobs[jobs.length - 1];
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  getVideos,
  saveVideos,
  upsertVideo,
  updateVideo,
  getProfiles,
  saveProfiles,
  getProfile,
  saveProfile,
  getJobs,
  saveJobs,
  upsertJob,
  makeId
};
