const config = require('./config');

function learnFromEvent(profile, video, event) {
  const now = new Date().toISOString();
  const type = event.type;
  const value = Number(event.value || 1);
  const tags = Array.isArray(video?.tags) ? video.tags : [];
  const author = video?.author || 'unknown';

  const deltaByType = {
    impression: 0.02,
    play: 0.05,
    watch: Math.min(0.8, Math.max(0.03, value / 30)),
    skip: -0.25,
    like: 1.2,
    dislike: -1.5,
    favorite: 2.0,
    search: 0.4
  };
  const delta = deltaByType[type] ?? 0.05;

  for (const tag of tags) {
    profile.tagScores[tag] = clamp((profile.tagScores[tag] || 0) + delta, -10, 10);
  }
  profile.authorScores[author] = clamp((profile.authorScores[author] || 0) + delta / 2, -10, 10);

  if (video?.id) {
    if (type === 'like') addUnique(profile.liked, video.id, 100);
    if (type === 'dislike') addUnique(profile.disliked, video.id, 100);
    if (type === 'favorite') addUnique(profile.favorites, video.id, 100);
    if (['play', 'watch', 'skip', 'like', 'favorite'].includes(type)) {
      addUnique(profile.watchHistory, video.id, 240);
    }
  }

  if (type === 'search' && typeof event.extra?.keyword === 'string') {
    const keyword = event.extra.keyword.trim();
    if (keyword) {
      addUnique(profile.searches, keyword, 80);
      profile.tagScores[keyword] = clamp((profile.tagScores[keyword] || 0) + 0.6, -10, 10);
    }
  }

  profile.events = profile.events || [];
  profile.events.push({
    videoId: video?.id || event.videoId || null,
    type,
    value,
    extra: event.extra || {},
    at: now
  });
  if (profile.events.length > config.maxEventLogPerProfile) {
    profile.events = profile.events.slice(-config.maxEventLogPerProfile);
  }
  profile.updatedAt = now;
  return profile;
}

function recommend(videos, profile, options = {}) {
  const limit = Number(options.limit || 10);
  const now = Date.now();
  const history = new Set(profile.watchHistory || []);
  const disliked = new Set(profile.disliked || []);

  const scored = videos
    .filter((video) => !disliked.has(video.id))
    .map((video) => ({ video, score: scoreVideo(video, profile, history, now) }))
    .sort((a, b) => b.score - a.score);

  const unseen = scored.filter(({ video }) => !history.has(video.id));
  const seenAgain = scored.filter(({ video }) => history.has(video.id));
  const merged = [...unseen, ...seenAgain];

  return merged.slice(0, limit).map(({ video, score }) => ({ ...video, score: Number(score.toFixed(4)) }));
}

function scoreVideo(video, profile, history, now) {
  let score = Math.random() * 0.15;
  const tags = Array.isArray(video.tags) ? video.tags : [];
  for (const tag of tags) {
    score += profile.tagScores?.[tag] || 0;
  }
  score += (profile.authorScores?.[video.author] || 0) * 0.4;

  if (profile.favorites?.includes(video.id)) score += 2.5;
  if (profile.liked?.includes(video.id)) score += 1.2;
  if (history.has(video.id)) score -= 2.0;
  if (video.cacheState === 'ready' || video.url) score += 0.4;

  const created = Date.parse(video.createdAt || 0);
  if (created) {
    const days = Math.max(0, (now - created) / 86400000);
    score += Math.max(0, 0.25 - days * 0.01);
  }

  // 给短视频轻微加权，老人刷起来更顺。
  const duration = Number(video.duration || 0);
  if (duration > 0 && duration <= 45) score += 0.2;
  if (duration > 120) score -= 0.5;

  return score;
}

function addUnique(list, value, maxLen) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  list.unshift(value);
  if (list.length > maxLen) list.length = maxLen;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = { learnFromEvent, recommend };
