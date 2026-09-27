# 架构与数据流

本项目是无需打包的 Chrome Manifest V3 扩展。`manifest.json` 注册后台 Service Worker、全站内容脚本和扩展弹窗。各模块通过 `chrome.runtime` 消息交互；播放页与后台共享扩展的 IndexedDB。

```text
网页请求 .m3u8
  -> background/sniffer.js (webRequest 捕获、校验、当前网址归属)
  -> content/content.js (页面浮窗) / popup/popup.js (候选流列表)
  -> background/service-worker.js (任务创建与消息分派)
  -> background/m3u8-parser.js (主清单、分片、时长和加密信息)
  -> background/scheduler.js (按优先级下载、重试和进度通知)
  -> background/cache-store.js (IndexedDB 元数据和分片)
  -> player/hls-loader.js + player/player.js (播放、读取缓存、MP4 导出)
```

## 模块职责

| 路径 | 职责 |
| --- | --- |
| `background/service-worker.js` | 消息入口、播放任务生命周期、设置加载、标签页关闭和导航时清理。 |
| `background/sniffer.js` | 捕获并校验 HLS 清单，按标签页及页面 URL 维护嗅探候选；公共候选信息持久化到 `chrome.storage.local`。 |
| `background/session.js` | 按标签页暂存请求头上下文，供资源站点的后续请求复用。 |
| `background/m3u8-parser.js` | 解析主清单、分片地址/时长、加密标记与点播/直播类型。 |
| `background/scheduler.js` | 分片优先级队列、并发限制、超时、重试、进度与 Service Worker 恢复后的续调度。 |
| `background/cache-store.js` | IndexedDB `hls-cache` 中的视频元数据和分片，以及独立 `hls-settings` 中的设置。 |
| `content/content.js` | 在网页的 Shadow DOM 浮窗提示资源，并以 PerformanceObserver 作为嗅探补充。 |
| `popup/` | 当前页嗅探结果、全局缓存列表、清空/删除和全局设置。 |
| `player/` | hls.js 自定义 Loader、播放及 Seek 缓存策略、缓存状态、AES-128 分片解密和 FFmpeg Wasm MP4 导出。 |
| `utils/` | URL/标题处理、运行时消息及日志辅助。 |
| `lib/` | 随附第三方 hls.js 与 FFmpeg Wasm 运行文件；许可见仓库根目录的 `THIRD_PARTY_NOTICES.md`。 |

## 状态与生命周期

- 嗅探结果按标签页和当前页面 URL 关联。当前页资源的公共元数据保存在 `chrome.storage.local`，所以内容脚本晚于资源请求启动或同一页面刷新后，仍可取得已验证候选。网页 URL 变化或标签页关闭时清理该标签页的嗅探结果及会话请求头。
- 视频任务以清单 URL 派生稳定 ID。下载分片和任务元数据保存在 IndexedDB；分片状态更新经过串行写入，以免并发请求互相覆盖。Service Worker 被浏览器回收后，会依据仍打开的播放标签页恢复任务映射，并从元数据恢复未完成下载。
- AES-128 导出按每个分片对应的密钥和媒体序号推导 IV；密钥只在导出期间保留在内存中。主清单动态发现的分片也保存对应加密信息。
- 播放页关闭会释放任务；最后一个使用同一视频任务的播放标签页关闭后，后台删除对应缓存。播放器刷新只释放运行中的调度引用，不立刻删除缓存。弹窗也可单条删除或清空全部缓存。
- 设置与视频缓存分库存放，清空视频缓存不会重置设置。导出的 MP4 由 `chrome.downloads` 写入浏览器下载目录，不属于扩展缓存。

## 设计边界

嗅探依据浏览器可见的 `.m3u8` 请求以及内容脚本看到的资源记录，无法保证覆盖所有播放器或私有协议。后台仅将有效点播流加入嗅探结果；直播和 DRM 不在当前目标范围。导出路径对 TS 分片做预检，并使用随附的 FFmpeg Wasm 将可用分片封装成 MP4；非 TS 流或编解码器不兼容时可能失败。
