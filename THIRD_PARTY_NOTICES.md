# 第三方组件与发布须知

根目录的 `LICENSE` 仅覆盖项目自有代码及文档，**不覆盖** `lib/` 中随附的第三方文件。下列版本经文件哈希与上游 npm 包核对；第三方许可和来源记录随扩展提供，完整源码树及构建脚本另行分发。尚未在本机执行核心重建，不宣称字节可复现。

2026-11-24 已验证[源码发行页](https://github.com/oho-work/Downloader/releases/tag/V1.0.0)的附件公开可下载。该发行页标签为 `V1.0.0`，附件文件名及来源清单对应扩展 **1.0.1**，无需按标签推断二进制版本。

- [完整第三方源码及构建说明](https://github.com/oho-work/Downloader/releases/download/V1.0.0/Downloader-1.0.1-third-party-sources.tar.gz)，278,257,678 字节。
- [校验文件](https://github.com/oho-work/Downloader/releases/download/V1.0.0/Downloader-1.0.1-third-party-sources.tar.gz.json)，源码归档 SHA-256：`c9651997acc13b0675ea66307f42954faac777de6ff9f9551531788e6486b318`。
- [许可原文与逐文件来源](third-party-licenses/README.md)；[发行提交、构建配方及已知限制](docs/third-party-sources.md)。源码包含 FFmpeg、绑定代码、配方所用库及递归构建依赖，原始归档、控制脚本和工具链说明均予保留。

| 文件 | 上游项目 | 已知许可/说明 |
| --- | --- | --- |
| `lib/hls.light.min.js` | [hls.js](https://github.com/video-dev/hls.js) `1.5.17` | Apache-2.0；应随分发保留许可证、版权及适用的 NOTICE。 |
| `lib/ffmpeg12/esm/` | [ffmpeg.wasm JavaScript 包装层](https://github.com/ffmpegwasm/ffmpeg.wasm) `@ffmpeg/ffmpeg@0.12.10` | MIT；应随分发保留对应许可证和版权声明。 |
| `lib/ffmpeg12-core/esm/ffmpeg-core.js` 与 `.wasm` | [ffmpeg.wasm core](https://github.com/ffmpegwasm/ffmpeg.wasm)，文件同时匹配 `@ffmpeg/core@0.12.9` 和 `@ffmpeg/core@0.12.10` | 这两个上游 npm 包标示 **GPL-2.0-or-later**；还需核对 FFmpeg 和编入库的各自许可证及对应源码义务。 |

对随附 Wasm 的字节检查发现构建配置含 `--enable-gpl`、`--enable-libx264` 和 `--enable-libx265`。本地 `ffmpeg-core.wasm` 的 SHA-256 为 `9F57947A5BD530D8F00C5B3F2CB2A3492FAA7E5D823315342D6A8656D0A6B7B7`，大小为 32,232,419 字节，与上游 `@ffmpeg/core@0.12.9` 及 `0.12.10` 的 ESM 文件均一致；因此仅凭文件不能判定确切补丁版本。它与包装层默认地址指向的 `0.12.6` 文件不一致。这些构建选项和上游许可证带来 GPL 及其他库的再分发要求；仅附带本项目 MIT `LICENSE` 不足以覆盖它们。

再分发时应保留许可证、版权及来源说明，并继续按适用许可提供对应源码与构建方式。商店审核不替代这些要求。此文档不是法律意见。
