const config = require('./config');
const store = require('./store');

const WATCH_EVENT_TYPES = new Set(['play', 'watch', 'like', 'favorite']);

async function auditContentPool() {
  const [videos, profiles] = await Promise.all([store.getVideos(), store.getProfiles()]);
  const profileList = Object.values(profiles || {});
  const totalProfiles = Math.max(1, profileList.length);
  const watchedByVideo = buildWatchedByVideo(profileList);
  const now = new Date().toISOString();
  let changed = false;

  for (const video of videos) {
    const watchedBy = watchedByVideo.get(video.id) || new Set();
    const viewedByCount = watchedBy.size;
    const viewedRatio = viewedByCount / totalProfiles;
    const nextState = video.cacheState === 'ready' && viewedRatio >= config.contentPoolExhaustedViewRatio
      ? 'exhausted'
      : 'active';

    if (
      video.viewedByCount !== viewedByCount
      || Number(video.viewedRatio || 0) !== Number(viewedRatio.toFixed(4))
      || video.audienceState !== nextState
    ) {
      video.viewedByCount = viewedByCount;
      video.viewedRatio = Number(viewedRatio.toFixed(4));
      video.audienceState = nextState;
      video.lastAudienceAuditAt = now;
      video.updatedAt = now;
      changed = true;
    }
  }

  if (changed) await store.saveVideos(videos);
  return summarizePool(videos, profileList);
}

async function shouldDiscoverForElder(elderId, options = {}) {
  const [videos, profile] = await Promise.all([
    store.getVideos(),
    store.getProfile(elderId || config.defaultElderId)
  ]);
  const watched = new Set(profile.watchHistory || []);
  const ready = videos.filter((video) => video.url && video.cacheState === 'ready');
  const activeReady = ready.filter((video) => video.audienceState !== 'exhausted');
  const unseenReady = activeReady.filter((video) => !watched.has(video.id));
  const pending = videos.filter((video) => video.sourceUrl && ['new', 'queued', 'caching'].includes(video.cacheState));
  const minUnseenReady = Number(options.minUnseenReady || config.contentPoolMinUnseenReady);

  return {
    shouldDiscover: unseenReady.length + pending.length < minUnseenReady,
    minUnseenReady,
    readyCount: ready.length,
    activeReadyCount: activeReady.length,
    unseenReadyCount: unseenReady.length,
    pendingCount: pending.length,
    exhaustedCount: ready.length - activeReady.length
  };
}

function buildWatchedByVideo(profileList) {
  const watchedByVideo = new Map();
  for (const profile of profileList) {
    const elderId = profile.elderId || 'unknown';
    const watchedIds = new Set(profile.watchHistory || []);
    for (const event of profile.events || []) {
      if (event.videoId && WATCH_EVENT_TYPES.has(event.type)) watchedIds.add(event.videoId);
    }
    for (const videoId of watchedIds) {
      if (!watchedByVideo.has(videoId)) watchedByVideo.set(videoId, new Set());
      watchedByVideo.get(videoId).add(elderId);
    }
  }
  return watchedByVideo;
}

function summarizePool(videos, profileList) {
  return {
    profileCount: Math.max(1, profileList.length),
    total: videos.length,
    ready: videos.filter((video) => video.url && video.cacheState === 'ready').length,
    activeReady: videos.filter((video) => video.url && video.cacheState === 'ready' && video.audienceState !== 'exhausted').length,
    exhausted: videos.filter((video) => video.audienceState === 'exhausted').length,
    pending: videos.filter((video) => video.sourceUrl && ['new', 'queued', 'caching'].includes(video.cacheState)).length,
    failed: videos.filter((video) => video.cacheState === 'failed').length
  };
}

module.exports = {
  auditContentPool,
  shouldDiscoverForElder
};
