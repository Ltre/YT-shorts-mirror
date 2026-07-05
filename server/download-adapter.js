const fs = require('fs/promises');
const path = require('path');

/**
 * 你接入下载/缓存命令的唯一位置。
 *
 * @param {object} video data/videos.json 里的视频元数据
 * @param {string} targetFilePath 希望你最终写入的视频文件路径，例如 storage/cache/demo-001.mp4
 * @param {object} context 可选工具：logger、updateProgress
 * @returns {Promise<{ok:boolean,cachedUrl?:string,bytes?:number,note?:string}>}
 */
async function ensureCached(video, targetFilePath, context = {}) {
  const logger = context.logger || console;

  // 已经是本服务内的静态视频，不需要下载。
  if (video.url && (video.url.startsWith('/media/') || video.url.startsWith('/cached/'))) {
    return {
      ok: true,
      cachedUrl: video.url,
      bytes: 0,
      note: 'already local'
    };
  }

  // 这里留给你接入自己的命令行下载逻辑。
  // 建议做法：
  // 1. 用 child_process.spawn 执行你自己的命令；
  // 2. 把输出文件写到 targetFilePath；
  // 3. 命令退出码为 0 且文件存在时，返回 ok: true；
  // 4. 失败时 throw Error 或返回 ok: false。
  //
  // 为了避免误用，本模板不内置任何第三方平台下载命令。

  logger.info?.(`[download-adapter] no adapter configured for video ${video.id}`);
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });

  return {
    ok: false,
    note: 'download adapter is not configured. Edit server/download-adapter.js to connect your own command.'
  };
}

module.exports = { ensureCached };
