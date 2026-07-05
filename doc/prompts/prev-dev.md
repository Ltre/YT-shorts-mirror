写个PWA，由服务器辅助用yt-dlp缓存yt shorts的短视频，给处于国内的自家老人刷短视频，要有tiktok的体验
在客户端可以学习老人的习惯、偏好、喜好、输入等数据，在刷视频的同时，服务器在后台就开始缓存其它视频，方便下次就能快速刷视频





已做好并打包： 下载 Node.js PWA 源码包

包含内容：

Node.js 零依赖服务端：npm start 即可运行
PWA 前端：竖屏短视频刷流、安装到桌面、Service Worker
TikTok 风格体验：上下滑动、自动播放、点赞、不喜欢、收藏、重播
老人偏好学习：观看、跳过、点赞、收藏、搜索都会上报服务端
服务端推荐与后台预取队列
浏览器端最近视频缓存：
默认最多缓存 12 条
默认 3 天过期
启动时清理过期
新增缓存后清理过期和超量
Service Worker 支持视频 Range 请求
下载接口已留好，但没有写具体下载逻辑
运行：

cd elder-shorts-pwa
npm start
打开：

http://localhost:8787
你接入自己的 yt-dlp 命令时，只改这个文件：

server/download-adapter.js
里面的核心函数是：

async function ensureCached(video, targetFilePath, context) {
  // 你的命令写到 targetFilePath
  return {
    ok: true,
    cachedUrl: `/cached/${video.id}.mp4`
  };
}
我没有内置具体第三方平台下载命令；你把自己的命令接进去就行。