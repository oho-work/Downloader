// player/hls-loader.js
// hls.js 自定义 Loader：替换默认分片加载。
// manifest 经 SW（携带会话头）；segment 先读 IndexedDB 缓存，未命中则通知 SW 下载并轮询就绪。
import { getSegment, getMeta } from '../background/cache-store.js';
import { logger } from '../utils/logger.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class HlsCacheLoader {
  constructor(videoId) {
    this.videoId = videoId;
    this.destroyed = false;
    // hls.js 在调用 load() 之前会执行 frag.stats = loader.stats（读取 loader 实例的 stats 属性），
    // 因此 stats 必须在构造时初始化且保持非 null，否则 frag.stats 为 null 触发 _abandonRulesCheck 崩溃。
    this.stats = this._newStats();
  }

  _newStats() {
    const now = performance.now();
    return {
      aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bundleSize: 0,
      timeToFirst: 0, timeToLoad: 0,
      loading: { start: now, first: now, end: now },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, end: 0 },
    };
  }

  _resetStats() {
    const now = performance.now();
    Object.assign(this.stats, {
      aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bundleSize: 0,
      timeToFirst: 0, timeToLoad: 0,
    });
    this.stats.loading.start = this.stats.loading.first = this.stats.loading.end = now;
    this.stats.parsing.start = this.stats.parsing.end = 0;
    this.stats.buffering.start = this.stats.buffering.end = 0;
  }

  load(context, config, callbacks) {
    this._resetStats(); // 复用同一 stats 对象（hls.js 已把该引用绑定为 frag.stats），仅重置字段
    if (this.destroyed) { callbacks.onError({ code: 2, text: 'destroyed' }, this.stats, context); return; }
    if (context.type === 'manifest' || context.type === 'levelmanifest') {
      this._loadManifest(context, callbacks);
    } else {
      this._loadSegment(context, callbacks);
    }
  }

  async _loadManifest(context, callbacks) {
    logger.info('loader', 'GET_MANIFEST', context.url);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_MANIFEST', videoId: this.videoId, url: context.url });
      if (resp && resp.ok) {
        logger.info('loader', 'manifest ok len=' + resp.text.length);
        // hls.js 期望 stats.parsing/loading 结构完整（onSuccess 会写 t.parsing.start / t.loading.end）
        callbacks.onSuccess({ data: resp.text }, this.stats, context, undefined);
      } else {
        logger.error('loader', 'manifest failed:', resp && resp.error);
        callbacks.onError({ code: 1, text: 'manifest: ' + (resp && resp.error || 'failed') }, this.stats, context);
      }
    } catch (e) { logger.error('loader', 'manifest exception', e); callbacks.onError({ code: 1, text: String(e && e.message || e) }, this.stats, context); }
  }

  async _loadSegment(context, callbacks) {
    const url = context.url;
    let meta = await getMeta(this.videoId);
    let seg = meta && meta.segments.find(x => x.url === url);

    // 主清单/动态分片：追加注册
    if (!seg) {
      logger.info('loader', 'ADD_SEGMENTS url=' + url);
      await chrome.runtime.sendMessage({
        type: 'ADD_SEGMENTS', videoId: this.videoId,
        segments: [{ url, duration: (context.frag && context.frag.duration) || 0 }],
      });
      meta = await getMeta(this.videoId);
      seg = meta && meta.segments.find(x => x.url === url);
      if (!seg) { logger.error('loader', 'cannot register segment', url); callbacks.onError({ code: 1, text: 'cannot register segment' }); return; }
    }
    logger.info('loader', 'seg url-mapped idx=' + seg.idx + ' url=' + url.slice(0, 80));

    const deadline = Date.now() + 60000;
    let waited = 0;
    while (Date.now() < deadline) {
      if (this.destroyed) { callbacks.onError({ code: 2, text: 'aborted' }); return; }
      const blob = await getSegment(this.videoId, seg.idx);
      if (blob && blob.buffer) {
        logger.info('loader', 'seg cache hit idx=' + seg.idx + ' size=' + blob.buffer.byteLength + ' waitedMs=' + waited);
        this.stats.loaded = this.stats.total = blob.buffer.byteLength;
        this.stats.loading.end = performance.now();
        this.stats.chunkCount = 1;
        callbacks.onSuccess({ data: blob.buffer }, this.stats, context, undefined);
        return;
      }
      if (waited === 0) logger.info('loader', 'seg miss, scheduling idx=' + seg.idx);
      await chrome.runtime.sendMessage({ type: 'SCHEDULE_SEG', videoId: this.videoId, segIdx: seg.idx });
      await sleep(350);
      waited += 350;
    }
    logger.error('loader', 'seg timeout idx=' + seg.idx + ' url=' + url.slice(0, 80));
    callbacks.onError({ code: 3, text: 'segment timeout' }, this.stats, context);
  }

  abort() { this.destroyed = true; }
  destroy() { this.destroyed = true; }
}

// 供播放页生成绑定 videoId 的 Loader 类
export function loaderFor(videoId) {
  return class extends HlsCacheLoader { constructor(cfg) { super(videoId); } };
}
