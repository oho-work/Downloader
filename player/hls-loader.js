// player/hls-loader.js
// hls.js 自定义 Loader：替换默认分片加载。
// manifest 经 SW（携带会话头）；segment 先读 IndexedDB 缓存，未命中则通知 SW 下载并轮询就绪。
import { getSegment, getMeta } from '../background/cache-store.js';
import { logger } from '../utils/logger.js';
import { diagnosticUrl } from '../utils/id.js';
import { runtimeAvailable, sendRuntimeMessage } from '../utils/runtime-message.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class HlsCacheLoader {
  constructor(videoId) {
    this.videoId = videoId;
    this.destroyed = false;
    this.aborted = false;
    this.requestId = 0;
    this.context = null;
    this.callbacks = null;
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
    this.aborted = false;
    if (this.destroyed) { callbacks.onError({ code: 2, text: 'destroyed' }, this.stats, context); return; }
    const requestId = ++this.requestId;
    this.context = context;
    const activeCallbacks = {
      onSuccess: (...args) => { this.callbacks = null; callbacks.onSuccess(...args); },
      onError: (...args) => { this.callbacks = null; callbacks.onError(...args); },
      onAbort: callbacks.onAbort,
    };
    this.callbacks = activeCallbacks;
    if (context.type === 'manifest' || context.type === 'levelmanifest') {
      this._loadManifest(context, activeCallbacks, requestId);
    } else if (context.type === 'key') {
      this._loadKey(context, activeCallbacks, requestId);
    } else {
      this._loadSegment(context, activeCallbacks, requestId).catch(e => {
        if (this._isCurrent(requestId)) activeCallbacks.onError({ code: 1, text: String(e?.message || e) }, this.stats, context);
      });
    }
  }

  _isCurrent(requestId) {
    return requestId === this.requestId && !this.aborted && !this.destroyed && !!this.callbacks;
  }

  async _loadKey(context, callbacks, requestId) {
    // hls.js requests AES-128 keys with a separate `key` context. A key is
    // not a media segment and must never be added to the segment index.
    try {
      const resp = await sendRuntimeMessage({
        type: 'GET_KEY', videoId: this.videoId, uri: context.url,
      });
      if (!this._isCurrent(requestId)) return;
      if (!resp || !resp.ok || !Array.isArray(resp.key)) {
        callbacks.onError({ code: 1, text: 'key: ' + (resp && resp.error || 'failed') }, this.stats, context);
        return;
      }
      const data = new Uint8Array(resp.key).buffer;
      this.stats.loaded = this.stats.total = data.byteLength;
      this.stats.loading.end = performance.now();
      this.stats.chunkCount = 1;
      callbacks.onSuccess({ data }, this.stats, context, undefined);
    } catch (e) {
      if (this._isCurrent(requestId)) callbacks.onError({ code: 1, text: 'key: ' + String(e && e.message || e) }, this.stats, context);
    }
  }

  async _loadManifest(context, callbacks, requestId) {
    logger.info('loader', 'GET_MANIFEST', diagnosticUrl(context.url));
    try {
      const resp = await sendRuntimeMessage({ type: 'GET_MANIFEST', videoId: this.videoId, url: context.url });
      if (!this._isCurrent(requestId)) return;
      if (resp && resp.ok) {
        logger.info('loader', 'manifest ok len=' + resp.text.length);
        // hls.js 期望 stats.parsing/loading 结构完整（onSuccess 会写 t.parsing.start / t.loading.end）
        callbacks.onSuccess({ data: resp.text }, this.stats, context, undefined);
      } else {
        logger.error('loader', 'manifest failed:', resp && resp.error);
        callbacks.onError({ code: 1, text: 'manifest: ' + (resp && resp.error || 'failed') }, this.stats, context);
      }
    } catch (e) {
      if (this._isCurrent(requestId)) { logger.error('loader', 'manifest exception', e); callbacks.onError({ code: 1, text: String(e && e.message || e) }, this.stats, context); }
    }
  }

  async _loadSegment(context, callbacks, requestId) {
    if (!runtimeAvailable()) return;
    const url = context.url;
    let meta = await getMeta(this.videoId);
    if (!this._isCurrent(requestId)) return;
    let seg = meta && meta.segments.find(x => x.url === url);

    // 主清单/动态分片：追加注册
    if (!seg) {
      logger.debug('loader', 'ADD_SEGMENTS url=' + url);
      await sendRuntimeMessage({
        type: 'ADD_SEGMENTS', videoId: this.videoId,
        segments: [{ url, duration: (context.frag && context.frag.duration) || 0 }],
      });
      if (!this._isCurrent(requestId)) return;
      meta = await getMeta(this.videoId);
      if (!this._isCurrent(requestId)) return;
      seg = meta && meta.segments.find(x => x.url === url);
      if (!seg) { logger.error('loader', 'cannot register segment', diagnosticUrl(url)); callbacks.onError({ code: 1, text: 'cannot register segment' }); return; }
    }
    logger.debug('loader', 'seg url-mapped idx=' + seg.idx);

    const deadline = Date.now() + 60000;
    let waited = 0;
    while (Date.now() < deadline) {
      if (!runtimeAvailable() || !this._isCurrent(requestId)) return;
      const blob = await getSegment(this.videoId, seg.idx);
      if (!this._isCurrent(requestId)) return;
      if (blob && blob.buffer) {
        logger.debug('loader', 'seg cache hit idx=' + seg.idx + ' size=' + blob.buffer.byteLength + ' waitedMs=' + waited);
        this.stats.loaded = this.stats.total = blob.buffer.byteLength;
        this.stats.loading.end = performance.now();
        this.stats.chunkCount = 1;
        callbacks.onSuccess({ data: blob.buffer }, this.stats, context, undefined);
        return;
      }
      if (waited === 0) logger.debug('loader', 'seg miss, scheduling idx=' + seg.idx);
      await sendRuntimeMessage({ type: 'SCHEDULE_SEG', videoId: this.videoId, segIdx: seg.idx });
      if (!this._isCurrent(requestId)) return;
      await sleep(350);
      waited += 350;
    }
    if (!this._isCurrent(requestId)) return;
    logger.error('loader', 'seg timeout idx=' + seg.idx + ' url=' + diagnosticUrl(url));
    callbacks.onError({ code: 3, text: 'segment timeout' }, this.stats, context);
  }

  abort() {
    if (this.aborted || this.destroyed || !this.callbacks) return;
    this.aborted = true;
    this.stats.aborted = true;
    this.requestId++;
    const callbacks = this.callbacks;
    this.callbacks = null;
    callbacks?.onAbort?.(this.stats, this.context, undefined);
  }
  destroy() {
    if (this.callbacks) this.stats.aborted = true;
    this.destroyed = true;
    this.requestId++;
    this.callbacks = null;
  }
}

// 供播放页生成绑定 videoId 的 Loader 类
export function loaderFor(videoId) {
  return class extends HlsCacheLoader { constructor(cfg) { super(videoId); } };
}
