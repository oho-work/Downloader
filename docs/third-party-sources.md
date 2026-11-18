# 第三方源码与公开发行审计

审计日期：2026-11-18。已收集固定版本的完整上游源码、递归子模块及构建配方，生成本地源码候选归档；尚未执行核心重建，也未公开发布源码或二进制。

## 已完成的材料

[third-party-licenses](../third-party-licenses/README.md) 已保存上游许可、版权和专利声明原文；[provenance.json](../third-party-licenses/provenance.json) 逐文件记录来源 URL、提交、大小和 SHA-256，并记录当前主要运行文件的 SHA-256。hls.js 上游提交树中只有 LICENSE，没有独立 NOTICE。保留此版权说明，同时附 Apache License 2.0 全文；另外收录其打包依赖 eventemitter3 5.0.1 和 url-toolkit 2.2.5 的许可。

## FFmpeg 核心对应版本

本地 ffmpeg-core.wasm 为 32,232,419 字节，SHA-256 为 `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7`。本轮重新下载官方 npm `@ffmpeg/core@0.12.10`，验证了 registry 给出的 SHA-512 integrity，并确认本地 ESM `ffmpeg-core.js`、`ffmpeg-core.wasm` 与官方包逐字节匹配。仓库此前另有它同时匹配 0.12.9 的核对记录；本轮不依赖该旧记录作 0.12.10 对应判断。

不能把 Git 标签 `v0.12.10` 当成此 Wasm 的源码。该标签指向 2023-12-25 的包装层发行，其 packages/core/package.json 仍为 0.12.6、旧许可声明为 MIT。当前核心的 npm 0.12.9/0.12.10 在 2025-01 发行，对应源码仓库的发行提交分别为：

- 0.12.9：[21b90a8d099719b8d91d9e5776314b236f2f5f80](https://github.com/ffmpegwasm/ffmpeg.wasm/commit/21b90a8d099719b8d91d9e5776314b236f2f5f80)，npm 发布时间 2025-01-06T22:53:00Z。
- 0.12.10：[71aa99d37c02a7b4c435275ca9ef50e612f6efa1](https://github.com/ffmpegwasm/ffmpeg.wasm/commit/71aa99d37c02a7b4c435275ca9ef50e612f6efa1)，标签 `v12.15`，npm 发布时间 2025-01-07T10:13:14Z。该发行提交的核心包明确标 GPL-2.0-or-later。npm 核心元数据没有 gitHead；这是根据上游发行提交、包版本和发布时间取得的源码映射，不是该二进制的构建证明。

包装层 `@ffmpeg/ffmpeg@0.12.10` 的 npm gitHead 是 `e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4`；hls.js 1.5.17 的 gitHead 是 `518ec40621c4affd27a4f385c1701d1662269e32`。

## 已验证的构建配方

核心源码提交 71aa99d3 的 Dockerfile 使用 `emscripten/emsdk:3.1.40`、FFmpeg `n5.1.4` 和下表外部依赖；Makefile 的生产单线程构建命令为 `make prd`，设置 `FFMPEG_ST=yes`、`-O3 -msimd128`。本地 Wasm 可读字符串中确认同样的优化、SIMD、禁用线程和库启用参数；编译器字符串为 Emscripten 3.1.40，提交 `5c27e79dd0a9c4e27ef2326841698cdd4f6b5784`。

构建明确启用 `--enable-gpl`、libx264、libx265、libvpx、libmp3lame、libtheora、libvorbis、libopus、zlib、libwebp、libfreetype、libfribidi、libass、libzimg；链接库还含 ogg、harfbuzz、sharpyuv 和 Emscripten SDL2。SDL2 版本不能凭印象推断：Emscripten 3.1.40 的 tools/ports/sdl2.py 明确使用 release-2.24.2，并提供源压缩包 SHA-512；该值已记录在 provenance.json。

| 组件 | 构建配方引用 | 审计时解析提交 | 上游源码 |
| --- | --- | --- | --- |
| emscripten | `3.1.40` | [`5c27e79dd0a9`](https://github.com/emscripten-core/emscripten/tree/5c27e79dd0a9c4e27ef2326841698cdd4f6b5784) | [源码归档](https://github.com/emscripten-core/emscripten/archive/5c27e79dd0a9c4e27ef2326841698cdd4f6b5784.tar.gz) |
| eventemitter3 | `5.0.1` | [`a650549176de`](https://github.com/primus/eventemitter3/tree/a650549176ded0d0dcc52e27b03ae5669d7dcd7c) | [源码归档](https://github.com/primus/eventemitter3/archive/a650549176ded0d0dcc52e27b03ae5669d7dcd7c.tar.gz) |
| ffmpeg | `n5.1.4` | [`4729204c17f7`](https://github.com/FFmpeg/FFmpeg/tree/4729204c17f756e186d622060088371d10b34f7e) | [源码归档](https://github.com/FFmpeg/FFmpeg/archive/4729204c17f756e186d622060088371d10b34f7e.tar.gz) |
| ffmpeg-wasm | `71aa99d37c02a7b4c435275ca9ef50e612f6efa1` | [`71aa99d37c02`](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1) | [源码归档](https://github.com/ffmpegwasm/ffmpeg.wasm/archive/71aa99d37c02a7b4c435275ca9ef50e612f6efa1.tar.gz) |
| ffmpeg-wrapper | `e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4` | [`e0d4c62a229b`](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4) | [源码归档](https://github.com/ffmpegwasm/ffmpeg.wasm/archive/e0d4c62a229ba58ea0c6e6b881e289f2fefe97c4.tar.gz) |
| freetype | `VER-2-10-4` | [`6a2b3e4007e7`](https://github.com/ffmpegwasm/freetype2/tree/6a2b3e4007e794bfc6c91030d0ed987f925164a8) | [源码归档](https://github.com/ffmpegwasm/freetype2/archive/6a2b3e4007e794bfc6c91030d0ed987f925164a8.tar.gz) |
| fribidi | `v1.0.9` | [`f9e8e71a6fbf`](https://github.com/fribidi/fribidi/tree/f9e8e71a6fbf4a4619481284c9f484d10e559995) | [源码归档](https://github.com/fribidi/fribidi/archive/f9e8e71a6fbf4a4619481284c9f484d10e559995.tar.gz) |
| harfbuzz | `5.2.0` | [`4a1d891c6317`](https://github.com/harfbuzz/harfbuzz/tree/4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde) | [源码归档](https://github.com/harfbuzz/harfbuzz/archive/4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde.tar.gz) |
| hls-js | `518ec40621c4affd27a4f385c1701d1662269e32` | [`518ec40621c4`](https://github.com/video-dev/hls.js/tree/518ec40621c4affd27a4f385c1701d1662269e32) | [源码归档](https://github.com/video-dev/hls.js/archive/518ec40621c4affd27a4f385c1701d1662269e32.tar.gz) |
| lame | `master` | [`2badea1974ae`](https://github.com/ffmpegwasm/lame/tree/2badea1974ae36cb8312afe99cff1e6b3b5decee) | [源码归档](https://github.com/ffmpegwasm/lame/archive/2badea1974ae36cb8312afe99cff1e6b3b5decee.tar.gz) |
| libass | `0.15.0` | [`d149636f502f`](https://github.com/libass/libass/tree/d149636f502f5774ae1a8fb4c554b122674393b2) | [源码归档](https://github.com/libass/libass/archive/d149636f502f5774ae1a8fb4c554b122674393b2.tar.gz) |
| libvpx | `v1.13.1` | [`10b9492dcf05`](https://github.com/ffmpegwasm/libvpx/tree/10b9492dcf05b652e2e4b370e205bd605d421972) | [源码归档](https://github.com/ffmpegwasm/libvpx/archive/10b9492dcf05b652e2e4b370e205bd605d421972.tar.gz) |
| libwebp | `v1.3.2` | [`ca332209cb55`](https://github.com/ffmpegwasm/libwebp/tree/ca332209cb5567c9b249c86788cb2dbf8847e760) | [源码归档](https://github.com/ffmpegwasm/libwebp/archive/ca332209cb5567c9b249c86788cb2dbf8847e760.tar.gz) |
| ogg | `v1.3.4` | [`bada45718453`](https://github.com/ffmpegwasm/Ogg/tree/bada45718453ac27b56773ae663f7e65112f6a6e) | [源码归档](https://github.com/ffmpegwasm/Ogg/archive/bada45718453ac27b56773ae663f7e65112f6a6e.tar.gz) |
| opus | `v1.3.1` | [`e85ed7726db5`](https://github.com/ffmpegwasm/opus/tree/e85ed7726db5d677c9c0677298ea0cb9c65bdd23) | [源码归档](https://github.com/ffmpegwasm/opus/archive/e85ed7726db5d677c9c0677298ea0cb9c65bdd23.tar.gz) |
| sdl2 | `release-2.24.2` | [`55b03c7493a7`](https://github.com/libsdl-org/SDL/tree/55b03c7493a7abed33cf803d1380a40fa8af903f) | [源码归档](https://github.com/libsdl-org/SDL/archive/55b03c7493a7abed33cf803d1380a40fa8af903f.tar.gz) |
| theora | `v1.1.1` | [`7ffd8b2ecfc2`](https://github.com/ffmpegwasm/theora/tree/7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf) | [源码归档](https://github.com/ffmpegwasm/theora/archive/7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf.tar.gz) |
| url-toolkit | `v2.2.5` | [`d02ff1368357`](https://github.com/tjenkinson/url-toolkit/tree/d02ff136835786a00c55c0e69e38dd7cc26d5acc) | [源码归档](https://github.com/tjenkinson/url-toolkit/archive/d02ff136835786a00c55c0e69e38dd7cc26d5acc.tar.gz) |
| vorbis | `v1.3.3` | [`779816404319`](https://github.com/ffmpegwasm/vorbis/tree/7798164043197d7e33f02de4353ce2aa5b248225) | [源码归档](https://github.com/ffmpegwasm/vorbis/archive/7798164043197d7e33f02de4353ce2aa5b248225.tar.gz) |
| x264 | `4-cores` | [`33cac6b77d5b`](https://github.com/ffmpegwasm/x264/tree/33cac6b77d5b9259c552156013a817ab23119612) | [源码归档](https://github.com/ffmpegwasm/x264/archive/33cac6b77d5b9259c552156013a817ab23119612.tar.gz) |
| x265 | `3.4` | [`2bb5520e9596`](https://github.com/ffmpegwasm/x265/tree/2bb5520e9596f361bf0ed81b3b8da0d7fd999069) | [源码归档](https://github.com/ffmpegwasm/x265/archive/2bb5520e9596f361bf0ed81b3b8da0d7fd999069.tar.gz) |
| zimg | `release-3.0.5` | [`e5b0de6bebbc`](https://github.com/sekrit-twc/zimg/tree/e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87) | [源码归档](https://github.com/sekrit-twc/zimg/archive/e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87.tar.gz) |
| zlib | `v1.2.11` | [`cacf7f1d4e3d`](https://github.com/ffmpegwasm/zlib/tree/cacf7f1d4e3d44d871b605da3b647f07d718623f) | [源码归档](https://github.com/ffmpegwasm/zlib/archive/cacf7f1d4e3d44d871b605da3b647f07d718623f.tar.gz) |

表中 x264 `4-cores` 与 LAME `master` 是浮动分支。已通过 GitHub 提交历史的 `until=2025-01-07T10:13:14Z` 查询确认，上游分支在核心发行时刻可达的最新提交分别为表中 33cac6b7、2badea19，与当前固定值一致，提交日期分别为 2022-08-22 和 2020-10-29。该历史查询记录保存在源码包 manifest.json；仍不能据此证明原始构建没有使用不同缓存或额外补丁。

## 本地源码包

运行 `node tools/collect-third-party-sources.cjs` 可在 `dist/source-bundle/` 生成材料，并输出 `dist/Downloader-1.0.1-third-party-sources.tar.gz` 及其 SHA-256 侧车 JSON。大型归档不进入 Git。收集器限制本次下载总量不超过 500 MiB，下载后保存每个原始归档的 SHA-256，并按确切提交解包。

材料含 23 个顶层上游源码树、Emscripten 与 zimg 的递归 Git 子模块、原始构建脚本和绑定源码、上游许可、官方核心 npm 包及与本地二进制的哈希匹配结果。ffmpeg.wasm 的媒体测试素材子模块不属于生产构建输入，因此新的收集运行跳过它；已有运行收集到的素材不参与构建。

`Dockerfile.local-sources` 保留原始 Dockerfile，另生成使用本地 COPY 源码的配方；SDL2 通过该版本 Emscripten 支持的 `EMCC_LOCAL_PORTS` 载入固定源码。它仍依赖 Emscripten 3.1.40 工具链镜像、Docker Buildx 和常规 Linux 构建工具，尚未进行实际构建验证。不是完全隔离网络的工具链镜像。

Windows 可能无法还原 WASI 测试夹具中的符号链接。源码包保留完整原始 tar 文件，并提供 `restore-sources.sh`，在 Linux 上执行后可恢复这些符号链接；不以 Windows 解包后的测试夹具替代原始归档。构建说明与剩余限制详见包内 `README-build.md`。

## 当前尚缺什么

1. 当前已确认官方 npm 二进制、发行源码提交、构建参数、全部配方声明的库，以及浮动分支的发行时历史。没有发现配方列出的库缺少源码；归档内完整保留源码树及构建脚本。原始上游构建是否曾使用额外补丁或不同 Docker 缓存，仍未得到独立证明，这是来源置信度的边界，不应表述为已经发现缺失组件。
2. 尚未执行固定输入配方或验证其产物，不能声称已实现字节完全一致的可复现构建。GPL 的完整对应源码要求不等于自动要求下游重建出逐字节相同二进制；实际重建或上游构建证明可以提高对应关系的可信度，不能将其虚构为许可证额外强制条件。当前配方已提供构建所需源码与控制脚本，工具链和系统构建工具的使用方式有明确说明。
3. 没有向扩展接收者提供源码的正式分发位置或发行包。若采用下载方式，应把对应源码放在与二进制同一发行位置并保持可得；若采用书面要约，须实际具备履行相应范围和期限的条件，不能只留一句“找上游下载”。商店审核通过不代替这些要求。

## 可执行的完成路径

**保留现有核心：**已从上述核心发行提交及全部配方依赖取得完整源码树、递归子模块、许可和构建说明，且官方核心包与本地二进制哈希匹配。将生成的源码归档与其 manifest/哈希作为对应版本的源码发行材料，与扩展二进制放在同一发行位置持续提供，并在扩展第三方声明中写入实际可用的源码链接；公开说明原始构建输入无法独立证明、未进行本地字节复现的边界。这样可以继续完成源码分发步骤，而非仅留下上游网址。后续可用固定输入重建或上游构建记录进一步验证，但不能把未经执行的构建称为已验证。根目录自有代码仍可保留 MIT，不能将包含该 GPL 核心的整个扩展描述为只有 MIT。

**缩减为封装用途的核心：**后续可从固定 FFmpeg/ffmpeg.wasm 源码与工具链重新构建只保留所需 MPEG-TS 输入、MP4 输出、解析器和必要 bitstream filter 的核心，去掉 x264/x265 等编码器与 `--enable-gpl` 以及无关外部库。这样可以减少体积和依赖数量；仍须验证最终许可证、提供对应源码与满足 LGPL 的修改/重新链接条件，并重新测试已支持的编解码格式。它是一次实际的核心替换，不能只修改 package.json 或许可文案。

本次没有替换运行库或重建 FFmpeg，也没有把任何材料上传商店或公开网站。
