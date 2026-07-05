# 本地代理支持说明

## 设计

`download-adapter.js` 不再硬编码本机代理端口，只在启动 `yt-dlp` 子进程时读取环境变量并注入给 `yt-dlp`。

优先级：

1. `YT_DLP_PROXY`
2. `HTTPS_PROXY`
3. `HTTP_PROXY`
4. `ALL_PROXY`

如果需要单独指定 socks/all proxy，可设置 `YT_DLP_ALL_PROXY`。

## 默认开发启动

```bash
npm run dev
```

`package.json` 的 `dev` 脚本会默认注入：

```bash
YT_DLP_PROXY=http://127.0.0.1:58591
YT_DLP_ALL_PROXY=socks5://127.0.0.1:51837
```

如果临时不想走代理：

```bash
npm run dev:no-proxy
```

## 说明

- 代理只注入给 `yt-dlp` 下载进程，不强行影响整个 Node 服务。
- 换代理端口时不用改源码，只需要改启动服务前的环境变量。
- 如果机器本身已经设置了 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，也会被自动带给 `yt-dlp`。
