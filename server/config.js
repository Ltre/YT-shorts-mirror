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
  maxEventLogPerProfile: 400,
  staticMaxAgeSeconds: 60 * 60,
  cachedVideoMaxAgeSeconds: 60 * 60 * 24 * 14
};
