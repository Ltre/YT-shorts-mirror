const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

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

  const sourceUrl = video.sourceUrl || video.url;
  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) throw new Error(`video ${video.id} 没有有效的 sourceUrl`);
  const configuredCookies = video.cookiesPath || video.cookieFile || process.env.YT_DLP_COOKIES;
  const cookiesPath = configuredCookies ? path.resolve(ROOT, configuredCookies) : path.join(ROOT, 'data', 'yt-cookies.txt');
  try { await fs.access(cookiesPath); } catch (_) { throw new Error(`cookies 文件不存在: ${cookiesPath}`); }

  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
  await context.updateProgress?.(0.05, '正在获取可用码率');
  const formatList = await runYtDlp(['-F', sourceUrl, '--cookies', cookiesPath], logger, true);
  const format = select720pFormat(formatList);
  logger.info?.(`[download-adapter] selected format ${format} for video ${video.id}`);
  await context.updateProgress?.(0.15, `开始下载（格式 ${format}）`);
  await fs.rm(targetFilePath, { force: true }).catch(() => {});
  await runYtDlp(['-f', format, sourceUrl, '--cookies', cookiesPath, '--no-part', '--newline',
    '--merge-output-format', 'mp4', '-o', targetFilePath], logger, false, context.updateProgress);
  let stat;
  try { stat = await fs.stat(targetFilePath); } catch (_) { throw new Error(`yt-dlp 已退出，但没有生成目标文件: ${targetFilePath}`); }
  if (!stat.isFile() || stat.size === 0) throw new Error('yt-dlp 生成了空文件');
  await context.updateProgress?.(1, '下载完成');
  return {
    ok: true,
    cachedUrl: `/cached/${path.basename(targetFilePath)}`,
    bytes: stat.size,
    note: `downloaded by yt-dlp (${format})`
  };
}

function select720pFormat(output) {
  const formats = output.split(/\r?\n/).map(parseFormatLine).filter(Boolean);
  const videos = formats.filter((item) => item.height > 0 && item.height <= 720)
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  if (!videos.length) throw new Error('yt-dlp 没有找到不超过 720P 的视频格式');
  if (!videos[0].videoOnly) return videos[0].id;
  const audios = formats.filter((item) => item.audioOnly).sort((a, b) => b.bitrate - a.bitrate);
  if (!audios.length) throw new Error(`格式 ${videos[0].id} 是纯视频，但没有找到可用音频格式`);
  return `${videos[0].id}+${audios[0].id}`;
}

function parseFormatLine(line) {
  const match = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
  if (!match || ['ID', '--'].includes(match[1])) return null;
  const details = match[3];
  const resolution = details.match(/(?:^|\s)(\d{2,5})x(\d{2,5})(?:\s|$)/);
  const bitrates = [...details.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)k(?:\s|$)/g)];
  return { id: match[1], height: resolution ? Number(resolution[2]) : 0,
    bitrate: bitrates.length ? Number(bitrates.at(-1)[1]) : 0,
    videoOnly: /video only/i.test(details), audioOnly: /audio only/i.test(details) };
}

function runYtDlp(args, logger, captureStdout, updateProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.YT_DLP_BIN || 'yt-dlp', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildYtDlpEnv()
    });
    let stdout = '';
    let stderr = '';
    let lastProgressAt = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (captureStdout) stdout += chunk;
      else {
        logger.info?.(`[yt-dlp] ${chunk.trimEnd()}`);
        const match = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (match) {
          const now = Date.now();
          const percent = Number(match[1]);
          if (now - lastProgressAt >= 1000 || percent >= 100) {
            lastProgressAt = now;
            safeUpdateProgress(updateProgress, 0.15 + percent * 0.008, '正在下载', logger);
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => reject(new Error(err.code === 'ENOENT' ? '找不到 yt-dlp，请先安装并加入 PATH' : err.message)));
    child.on('close', (code) => code === 0 ? resolve(stdout)
      : reject(new Error(`yt-dlp 执行失败（退出码 ${code}）: ${stderr.trim() || stdout.trim()}`)));
  });
}

function safeUpdateProgress(updateProgress, progress, message, logger) {
  if (!updateProgress) return;
  Promise.resolve(updateProgress(progress, message)).catch((err) => {
    logger.warn?.(`[download-adapter] progress update failed: ${err.message}`);
  });
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

module.exports = { ensureCached };
