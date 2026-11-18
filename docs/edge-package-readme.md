# HLS Cache Player 1.0.1

这是本地验证候选包。**第三方完整对应源码、构建材料和发布核对仍未完成，不应把此 ZIP 上传商店或公开分发。** 状态见 [发布核对表](docs/release-checklist.md)及[源码来源说明](docs/third-party-sources.md)。

## 本地安装

解压 ZIP，打开 `edge://extensions`，开启「开发人员模式」，点击「加载解压缩的扩展」，选择包含 `manifest.json` 的解压目录。需要 Microsoft Edge 或兼容的 Chromium 浏览器，内核版本至少 110。

打开有权处理的 HLS 点播网页，播放视频后从扩展嗅探结果打开独立播放页。缓存分片完成后可导出 MP4。播放页默认静音，可通过播放器控件自行开启声音。

## 可选下载代理

普通嗅探、播放、缓存及导出不需要外部程序。仅当启用下载代理时，需另行解压同版本的 `hls-cache-player-relay-1.0.1.zip` 辅助程序包，按照其中 README 安装 Node.js 18+ 并运行 `node tools/download-relay.cjs`。

辅助程序不包含在此扩展 ZIP 内。在扩展设置中填写现有 HTTP(S) 或 SOCKS4/5 代理及本地服务地址。代理只用于扩展请求，不修改浏览器或系统代理；暂不支持代理账号密码。

## 权限和许可

扩展在本机保存候选资源、设置、分片和任务信息；播放、缓存及资源校验会访问来源网站及 CDN。扩展没有开发者遥测、账号或上传服务。

本项目自有代码采用 MIT 许可；第三方组件许可及源码义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)和 `third-party-licenses/`。随附 FFmpeg Wasm 涉及 GPL 及其链接库的许可要求，不能把整个包概括为 MIT。

只处理你有权播放和保存的资源。本扩展不绕过授权、付费或 DRM 限制。
