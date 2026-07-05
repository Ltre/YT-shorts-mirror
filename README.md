# YT-shorts-mirror

一个给自家长辈刷短视频用的 PWA 源码骨架：

- TikTok 风格竖屏沉浸式刷视频；
- 客户端记录观看、跳过、喜欢、不喜欢、收藏、输入搜索等行为；
- 服务端按老人偏好做轻量推荐；
- 服务端后台预取队列，预留下载/缓存 adapter；
- 浏览器端使用 PWA + Cache API 缓存“最近看过的视频”，支持过期删除；
- 零第三方 npm 依赖，Node.js 18+ 直接运行。

> 注意：项目默认不包含任何具体第三方平台下载逻辑。你只需要把自己的“合法授权内容下载/缓存逻辑”接到 `server/download-adapter.js`。

## 快速运行

```bash
cd elder-shorts-pwa
npm start
```

浏览器打开：

```text
http://localhost:8787
```

手机同一局域网访问时，把 `localhost` 换成电脑局域网 IP，例如：

```text
http://192.168.1.23:8787
```

PWA 安装、Service Worker、Cache API 在 `localhost` 或 HTTPS 下可用。手机真实部署建议放到 HTTPS 域名。

## 目录结构

```text
elder-shorts-pwa/
├─ server.js                       # Node.js HTTP 服务入口
├─ server/
│  ├─ config.js                    # 配置项
│  ├─ store.js                     # JSON 文件存储
│  ├─ recommender.js               # 偏好学习与推荐
│  ├─ prefetch-queue.js            # 服务端后台缓存队列
│  └─ download-adapter.js          # 你接入下载命令的地方，默认是 stub
├─ public/
│  ├─ index.html                   # PWA 页面
│  ├─ app.js                       # 前端交互、行为采集、浏览器视频缓存
│  ├─ styles.css                   # TikTok 风格 UI
│  ├─ sw.js                        # Service Worker，含视频 Range 缓存读取
│  ├─ manifest.json                # PWA manifest
│  ├─ icons/                       # PWA 图标
│  └─ media/                       # Demo 视频，可替换成自己的视频
├─ data/
│  ├─ videos.json                  # 视频元数据
│  ├─ profiles.json                # 老人偏好画像
│  └─ cache-jobs.json              # 服务端预取/缓存任务
└─ storage/cache/                  # 服务端缓存后的视频落地目录
```

## 你怎么接入自己的下载命令

只改一个文件：`server/download-adapter.js`。

项目里已经给你留好了这个函数：

```js
async function ensureCached(video, targetFilePath, context) {
  // 你把自己的命令行调用放这里
  // 成功后返回：
  return {
    ok: true,
    cachedUrl: `/cached/${video.id}.mp4`,
    bytes: 123456,
    note: 'downloaded by custom adapter'
  };
}
```

服务端预取队列会自动调用它。你只要保证：

1. 把最终视频文件写到 `targetFilePath`；
2. 下载完成后返回 `ok: true` 和 `cachedUrl`；
3. 失败时返回 `ok: false` 或直接抛出异常；
4. 不要阻塞主线程太久，建议使用子进程执行你的命令；
5. 只缓存你有权缓存和分发的内容。

`video` 对象来自 `data/videos.json`，你可以给每条视频加自己的字段，例如：

```json
{
  "id": "my-video-001",
  "title": "潮汕美食片段",
  "sourceUrl": "你自己的源地址或内部标识",
  "url": null,
  "tags": ["潮汕", "美食", "老人爱看"],
  "duration": 20
}
```

当 adapter 成功后，系统会把 `video.url` 更新成 `/cached/my-video-001.mp4`，前端下一次刷到就直接走服务端缓存文件。

## 添加视频

### 方法一：直接改 `data/videos.json`

添加视频元数据即可。若 `url` 是 `/media/xxx.mp4` 或 `/cached/xxx.mp4`，前端会直接播放。若没有 `url`，但有 `sourceUrl`，服务端预取队列会尝试调用 adapter。

### 方法二：调用接口添加

```bash
curl -X POST http://localhost:8787/api/videos \
  -H 'Content-Type: application/json' \
  -d '{
    "id":"custom-001",
    "title":"自家视频 001",
    "sourceUrl":"your-source-id-or-url",
    "tags":["潮汕","生活"],
    "duration":18
  }'
```

## 浏览器端“最近看过视频”缓存策略

在 `public/app.js` 里可配置：

```js
const RECENT_VIDEO_CACHE = {
  cacheName: 'elder-recent-videos-v1',
  maxItems: 12,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  watchedAfterMs: 1800,
  preloadAhead: 2
};
```

含义：

- `maxItems`: 最多保留最近看过的 12 个视频；
- `ttlMs`: 每个视频最多保留 3 天；
- `watchedAfterMs`: 视频播放超过 1.8 秒才算“看过”，再写入浏览器 Cache；
- `preloadAhead`: 当前视频之后预缓存 2 个候选视频。

删除策略：

1. 每次启动 PWA 时清理过期视频；
2. 每次成功缓存新视频后清理过期视频；
3. 超过 `maxItems` 时按 `lastWatchedAt` 删除最旧项；
4. Service Worker 支持读取 Cache API 中的视频，并处理 `Range` 请求，让 `<video>` 标签可以拖动/续播。

## 主要接口

### 获取推荐 Feed

```text
GET /api/feed?elderId=default&limit=8
```

### 上报行为

```text
POST /api/events
```

Body 示例：

```json
{
  "elderId": "default",
  "videoId": "demo-001",
  "type": "like",
  "value": 1,
  "extra": {}
}
```

行为类型：

- `impression`: 视频出现在屏幕；
- `play`: 开始播放；
- `watch`: 观看时长；
- `skip`: 很快划走；
- `like`: 喜欢；
- `dislike`: 不喜欢；
- `favorite`: 收藏；
- `search`: 搜索/输入关键词。

### 查看缓存任务

```text
GET /api/cache/jobs
```

### 手动触发预取

```text
POST /api/prefetch
```

Body 示例：

```json
{
  "elderId": "default",
  "limit": 5
}
```

## 部署建议

- 国内访问建议把 PWA、API、缓存文件都部署在同一个国内可访问域名下；
- 给 `/cached/` 设置合理的 HTTP 缓存头；
- 视频文件尽量转成移动端友好的 MP4/H.264/AAC；
- 如果给老人用，建议默认大字号、高对比、少按钮、尽量语音入口；
- 日志里不要保存过多个人隐私，偏好画像尽量只保留标签分数和必要行为。

## 安全与合规提醒

这个项目只是 PWA 与缓存队列框架。请确保你接入的视频来源、下载、缓存、展示、分发都符合对应平台规则、版权授权以及当地法律法规。
