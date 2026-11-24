# Edge 1.0.1 发布核对表

核对日期：2026-11-24。发布者 OHO，支持邮箱 oho_work@163.com，可见性 Hidden（仅通过商店链接安装）。

## 已完成

- [x] 修复标准 AES-128 播放、缓存和 MP4 导出；加入仅处理扩展请求的可选代理，默认静音。
- [x] 扩展版本 1.0.1；49 项回归测试通过，已验证实际资源播放、样本导出、代理隔离及缓存清理。
- [x] 第三方许可原文及出处随包保存；官方核心 npm 包与本地 JS/Wasm 哈希一致。
- [x] 收集全部发行配方源码、递归构建依赖和控制脚本，已公开在[源码发行页](https://github.com/oho-work/Downloader/releases/tag/V1.0.0)。附件对应扩展 1.0.1；源码哈希与下载信息见 [release-assets.json](release-assets.json)。
- [x] 提供构建说明，明确尚未本地重建或证明字节可复现；来源证据与限制见[源码审计](third-party-sources.md)。
- [x] [隐私政策](https://github.com/oho-work/Downloader/blob/codex/store-info/docs/privacy-policy.md)公开可读。
- [x] 实际界面截图三张，1280×800；画面为本地生成的原创测试图案。
- [x] 打包仅含运行文件和许可资料，不含测试私钥、浏览器数据、临时媒体或 Git 文件；代理辅助程序独立打包。

## 商店操作待完成

- [ ] 在 Partner Center 创建扩展，上传 `dist/hls-cache-player-edge-1.0.1.zip`。
- [ ] 填写[商店文案](store-listing.md)、隐私 URL、权限理由和数据披露，选择 Hidden。
- [ ] 上传图标和实际界面截图，补充审核测试信息，核对可选代理的获取方式。
- [ ] 提交审核并处理反馈；审核通过后验证商店链接安装、更新及实际播放导出。

商店提交包不等于已通过审核。后续再分发应保留各组件许可、来源及对应源码下载方式。
