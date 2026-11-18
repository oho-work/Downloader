# 第三方许可文本与出处记录

此目录保存 2026-11-18 从上游取回的许可、版权和专利声明原文。每个文件的源地址、上游引用、审计时解析的提交、字节数和 SHA-256 记录在 [provenance.json](provenance.json)。文本未作改写。

- `hls-js/`：hls.js 1.5.17 的版权与许可说明，以及 Apache License 2.0 全文。
- `eventemitter3/`、`url-toolkit/`：hls.js 构建所使用依赖的许可文本。
- `ffmpeg-wrapper/`：`@ffmpeg/ffmpeg@0.12.10` 对应提交的 MIT 许可。
- `ffmpeg-wasm/`：`@ffmpeg/core@0.12.10` 发行提交中绑定层代码的 MIT 许可。该 MIT 文本不覆盖链接后的 FFmpeg 核心及其 GPL 依赖。
- 其余目录：FFmpeg、构建配方声明的外部库、SDL2 及 Emscripten 的上游许可资料。FreeType 同时保留了其许可选择说明、FTL 和 GPLv2 文本；不能据此同时选择相互冲突的许可条件。

**这些文件不是完整对应源码包，也不代表已完成公开发行条件。** `x264` 的 `4-cores`、LAME 的 `master` 是上游构建配方使用的分支；此处记录的提交是审计时取得的值，不能替代原始构建记录。历史构建、完整源码及发布前还需完成的事项见 [第三方源码审计](../docs/third-party-sources.md)。

上游完整源码中可能含额外的逐文件版权、子目录许可和专利说明，发行源码时须原样保留。项目根目录的 MIT `LICENSE` 不替代这些条件。
