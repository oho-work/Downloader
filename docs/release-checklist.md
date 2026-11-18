# 公开发布核对表

此仓库的源码可作为本地 V1 候选版验证。公开分发完整扩展前，先完成下列事项：

2026-11-18 准备进度：已补齐第三方许可原文与出处记录，生成并实测本地候选 ZIP、三张原创演示截图及代理辅助程序包，49 项回归测试通过。发布者为 OHO，分发方式为 Hidden。隐私政策已托管到[公开文档](https://github.com/oho-work/Downloader/blob/codex/store-info/docs/privacy-policy.md)。已收集上游发行配方的全部对应源码和构建脚本，官方 npm 核心与本地二进制哈希一致；尚未在本机重建，不能宣称字节可复现。详见[源码审计](third-party-sources.md)。提交商店前仍需在同一 GitHub Release 提供源码归档，并验证公开下载地址。

1. 保存 `@ffmpeg/core@0.12.9/0.12.10`、`@ffmpeg/ffmpeg@0.12.10` 和 `hls.js@1.5.17` 与本地文件的哈希核对记录；核实 FFmpeg 核心的准确版本、完整构建配置及源码。
2. 核对 FFmpeg、x264、x265、hls.js 和其他链接库的许可证及版权声明；补齐随附文本、完整对应源码与必要的构建说明。若无法履行，替换为来源与再分发条件明确的组件。
3. 运行 `node --experimental-vm-modules --test tests`，并在 Chrome 110+ 重新加载扩展，人工验证嗅探、刷新提示、播放、Seek、缓存删除、失败重试与 MP4 导出。
4. 检查 `manifest.json` 的版本、权限和描述，确认 README、架构文档及第三方声明与实际文件一致。
5. 检查 Git 提交中没有 Cookie、签名 URL、个人浏览器数据、下载的视频或临时文件。

完成前不要把含当前 FFmpeg Wasm 二进制的仓库作为正式公开发行版推送或上传扩展商店。
