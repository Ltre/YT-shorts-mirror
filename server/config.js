const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT || 8787),
  rootDir: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  cacheDir: path.join(ROOT, 'storage', 'cache'),
  defaultElderId: 'default',
  recommendationPoolSize: 30,
  prefetchConcurrency: 1,
  serverPrefetchLimit: 6,
  autoDiscoveryEnabled: process.env.AUTO_DISCOVERY !== '0',
  autoDiscoveryLimit: Number(process.env.AUTO_DISCOVERY_LIMIT || 5),
  autoDiscoveryCooldownMs: 30 * 60 * 1000,
  autoDiscoveryMaxDurationSeconds: Number(process.env.AUTO_DISCOVERY_MAX_DURATION || 60),
  videoMaxDurationSeconds: Number(process.env.VIDEO_MAX_DURATION || 120),
  autoDiscoverySearchTerms: ['潮汕 美食 shorts', '老歌 经典 shorts', '养生 小知识 shorts', '广场舞 shorts', '家庭生活 shorts'],
  contentPoolMinUnseenReady: Number(process.env.CONTENT_POOL_MIN_UNSEEN_READY || 8),
  contentPoolExhaustedViewRatio: Number(process.env.CONTENT_POOL_EXHAUSTED_RATIO || 0.8),
  maxEventLogPerProfile: 400,
  staticMaxAgeSeconds: 60 * 60,
  cachedVideoMaxAgeSeconds: 60 * 60 * 24 * 14
};
