# 第三方组件与发布须知

根目录的 `LICENSE` 仅覆盖项目自有代码及文档，**不覆盖** `lib/` 中随附的第三方文件。仓库没有锁文件或可复现的第三方构建脚本；下列版本经文件哈希与上游 npm 包核对，公开发布前仍需补齐第三方许可证、版权声明和源码提供方式。

2026-11-18 已收集上游许可原文和逐文件校验记录，见 [third-party-licenses](third-party-licenses/README.md)。核心发行提交、全部配方源码、构建脚本及已知限制见[源码审计](docs/third-party-sources.md)。许可文本已附入候选包，对应源码归档已在本地生成，提交商店前还需在同一发行位置提供公开下载。

| 文件 | 上游项目 | 已知许可/说明 |
| --- | --- | --- |
| `lib/hls.light.min.js` | [hls.js](https://github.com/video-dev/hls.js) `1.5.17` | Apache-2.0；应随分发保留许可证、版权及适用的 NOTICE。 |
| `lib/ffmpeg12/esm/` | [ffmpeg.wasm JavaScript 包装层](https://github.com/ffmpegwasm/ffmpeg.wasm) `@ffmpeg/ffmpeg@0.12.10` | MIT；应随分发保留对应许可证和版权声明。 |
| `lib/ffmpeg12-core/esm/ffmpeg-core.js` 与 `.wasm` | [ffmpeg.wasm core](https://github.com/ffmpegwasm/ffmpeg.wasm)，文件同时匹配 `@ffmpeg/core@0.12.9` 和 `@ffmpeg/core@0.12.10` | 这两个上游 npm 包标示 **GPL-2.0-or-later**；还需核对 FFmpeg 和编入库的各自许可证及对应源码义务。 |

对随附 Wasm 的字节检查发现构建配置含 `--enable-gpl`、`--enable-libx264` 和 `--enable-libx265`。本地 `ffmpeg-core.wasm` 的 SHA-256 为 `9F57947A5BD530D8F00C5B3F2CB2A3492FAA7E5D823315342D6A8656D0A6B7B7`，大小为 32,232,419 字节，与上游 `@ffmpeg/core@0.12.9` 及 `0.12.10` 的 ESM 文件均一致；因此仅凭文件不能判定确切补丁版本。它与包装层默认地址指向的 `0.12.6` 文件不一致。这些构建选项和上游许可证带来 GPL 及其他库的再分发要求；仅附带本项目 MIT `LICENSE` 不足以覆盖它们。

**公开发布前的许可证核查：**保存第三方包与本地文件的校验记录；保留 hls.js、FFmpeg 及所链接库的版权和许可证文本；按相应许可证提供完整对应源码、构建方式及必要的修改记录。若无法履行，请替换为再分发条件可满足的构建产物后再发布。此文档不是法律意见。
