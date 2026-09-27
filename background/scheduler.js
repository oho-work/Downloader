// background/scheduler.js
// 分片调度引擎：并发池 + 优先级抢占 + 单分片超时 + 指数退避重试 + 签名过期刷新
import { putSegment, updateSegState, getMeta, saveMeta, SEG_STATE } from './cache-store.js';
import { parsePlaylist } from './m3u8-parser.js';
import { logger } from '../utils/logger.js';

export const PRIO = { URGENT: 3, SEEK: 2, AHEAD: 1, FULL: 0 };

// 按 url 去重（DONE 优先）：m3u8 刷新会产生同内容不同签名的重复分片（不同 idx），
// 统计与下载必须只认一份，否则总数虚高、缓存完成后仍在反复拉取重复分片
export function dedupe(segs) {
  const map = new Map();
  for (const s of segs) {
    if (!s || !s.url) continue;
    const ex = map.get(s.url);
    if (!ex) map.set(s.url, s);
    else if (ex.state !== SEG_STATE.DONE && s.state === SEG_STATE.DONE) map.set(s.url, s);
  }
  return [...map.values()];
}

const FORBIDDEN = new Set(['cookie', 'origin', 'user-agent', 'host', 'content-length', 'accept-encoding']);

function cleanHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!FORBIDDEN.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function stateRank(state) {
  // DONE is terminal and must win over a stale snapshot. FAILED is only
  // preferred over PENDING; a retry can legitimately move it back to PENDING.
  if (state === SEG_STATE.DONE) return 4;
  if (state === SEG_STATE.DOWNLOADING) return 3;
  if (state === SEG_STATE.FAILED) return 2;
  return 1;
}

function mergeMeta(oldMeta, nextMeta) {
  if (!oldMeta) return nextMeta || { segments: [] };
  if (!nextMeta) return oldMeta;
  const byIdx = new Map((oldMeta.segments || []).map(s => [s.idx, s]));
  const byUrl = new Map((oldMeta.segments || []).filter(s => s.url).map(s => [s.url, s]));
  const segments = (nextMeta.segments || []).map(next => {
    const old = byIdx.get(next.idx) || (next.url && byUrl.get(next.url));
    if (!old) return next;
    const chosen = stateRank(old.state) >= stateRank(next.state) ? old : next;
    return { ...next, ...chosen, idx: next.idx, url: next.url || old.url };
  });
  // Keep dynamically discovered segments that are not in a refreshed snapshot.
  const seen = new Set(segments.map(s => s.url || `#${s.idx}`));
  for (const old of oldMeta.segments || []) {
    const key = old.url || `#${old.idx}`;
    if (!seen.has(key)) segments.push(old);
  }
  return { ...oldMeta, ...nextMeta, segments };
}

class Scheduler {
  constructor() {
    this.registry = new Map();   // videoId -> task {meta, headers, tabId, onProgress, done, failed, lastBroadcast}
    this.queue = [];
    this.running = new Map();    // `${videoId}:${segIdx}` -> {ctrl, prio}
    this.maxConcurrent = 16;
  }

  setConcurrency(n) { if (n >= 1 && n <= 64) this.maxConcurrent = n; }

  register(videoId, task) {
    const old = this.registry.get(videoId);
    if (old) {
      // Keep the same task object while downloads are running. Replacing it
      // loses counters/partials while run() still holds the old reference,
      // which is the source of the stalled 649/681 -> ALL_DONE jump.
      old.meta = mergeMeta(old.meta, task.meta);
      if (task.headers !== undefined) old.headers = task.headers;
      if (task.tabId != null) old.tabId = task.tabId;
      old.settings = { ...old.settings, ...(task.settings || {}) };
      old.doneUrls = new Set();
      old.done = 0;
      old.failed = 0;
      const unique = dedupe(old.meta.segments || []);
      for (const s of unique) {
        if (s.state === SEG_STATE.DONE) { old.done++; if (s.url) old.doneUrls.add(s.url); }
        else if (s.state === SEG_STATE.FAILED) old.failed++;
      }
      // A task may have previously emitted ALL_DONE and then receive newly
      // discovered segments or be cleared for another run. Allow a new
      // completion notification once work is pending again.
      if (!unique.length || unique.some(s => s.state !== SEG_STATE.DONE)) old.notifiedAll = false;
      this.registry.set(videoId, old);
      return old;
    }
    task.meta = task.meta || { segments: [] };
    task.doneUrls = new Set();
    task.done = 0;
    task.failed = 0;
    for (const s of dedupe(task.meta.segments || [])) {
      if (s.state === SEG_STATE.DONE) { task.done++; if (s.url) task.doneUrls.add(s.url); }
      else if (s.state === SEG_STATE.FAILED) task.failed++;
    }
    task.lastBroadcast = 0;
    task.notifiedAll = false;
    task.cachedBytes = task.cachedBytes || 0;
    this.registry.set(videoId, task);
    return task;
  }
  unregister(videoId) { this.registry.delete(videoId); }
  getTask(videoId) { return this.registry.get(videoId); }

  enqueue(videoId, segIdx, prio = PRIO.FULL) {
    const task = this.registry.get(videoId);
    if (!task) return;
    const seg = task.meta.segments.find(s => s.idx === segIdx);
    if (!seg) return;
    if (seg.state === SEG_STATE.DONE) return;              // 已成功
    if (this.running.has(`${videoId}:${segIdx}`)) return; // 正在下载
    if (this.queue.some(x => x.videoId === videoId && x.segIdx === segIdx)) return; // 已在队列（播放端高频轮询去重）
    // 同内容(url)分片已有 DONE / 正在下载 / 已排队：跳过，避免重复拉取
    if (seg.url) {
      for (const x of task.meta.segments) {
        if (x.url !== seg.url || x.idx === segIdx) continue;
        if (x.state === SEG_STATE.DONE) return;
        if (this.running.has(`${videoId}:${x.idx}`)) return;
        if (this.queue.some(q => q.videoId === videoId && q.segIdx === x.idx)) return;
      }
    }
    this.queue.push({ videoId, segIdx, prio, ts: Date.now() });
    this.sort();
    this.pump();
  }
  sort() { this.queue.sort((a, b) => (b.prio - a.prio) || (a.ts - b.ts)); }

  pump() {
    for (;;) {
      if (!this.queue.length) break;
      if (this.running.size < this.maxConcurrent) {
        const t = this.queue.shift();
        if (this.isDone(t.videoId, t.segIdx)) continue;
        this.run(t);
        continue;
      }
      // 并发已满：若队首是播放所需（URGENT/SEEK），抢占一个最低优先级后台槽
      const head = this.queue[0];
      if (head.prio >= PRIO.SEEK) {
        let low = null;
        for (const [key, m] of this.running) {
          if (m.prio < head.prio && (!low || m.prio < low.m.prio)) low = { key, m };
        }
        if (low) {
          const [vid, sidx] = low.key.split(':');
          // 被抢占的重新排回队列（原优先级），不丢弃
          if (!this.queue.some(x => x.videoId === vid && x.segIdx === Number(sidx))) {
            this.queue.push({ videoId: vid, segIdx: Number(sidx), prio: low.m.prio, ts: Date.now() });
          }
          this.sort();
          low.m.ctrl.abort();
          this.running.delete(low.key);
          continue;
        }
      }
      break;
    }
  }
  isDone(videoId, segIdx) {
    const task = this.registry.get(videoId);
    if (!task) return true;
    const seg = task.meta.segments.find(s => s.idx === segIdx);
    return !seg || seg.state === SEG_STATE.DONE;
  }

  async run({ videoId, segIdx, prio }) {
    const key = `${videoId}:${segIdx}`;
    const task = this.registry.get(videoId);
    if (!task) { this.pump(); return; }
    const seg = task.meta.segments.find(s => s.idx === segIdx);
    const ctrl = new AbortController();
    const slot = { ctrl, prio, startTs: Date.now(), giveUp: false };
    this.running.set(key, slot); // Reserve capacity before the first await.
    try {
      await updateSegState(videoId, segIdx, SEG_STATE.DOWNLOADING, { startedAt: Date.now() });
      seg.state = SEG_STATE.DOWNLOADING;
      const buffer = await this.fetchWithRetry(videoId, seg, ctrl);
      // A tab can close while fetch is resolving. Do not write a late response
      // back into a task that has already been unregistered/cancelled.
      if (ctrl.signal.aborted || this.registry.get(videoId) !== task) throw new Error('preempted');
      await putSegment(videoId, segIdx, buffer);
      await updateSegState(videoId, segIdx, SEG_STATE.DONE, { size: buffer.byteLength });
      seg.state = SEG_STATE.DONE; seg.size = buffer.byteLength; // 同步内存：否则内存恒 PENDING，已缓存分片被反复重下
      // done 按唯一 url 计：拼接/刷新清单会重复引用同一分片 url，若按 idx 计累加器会虚高超过 total，
      // 提前误触 ALL_DONE 把仍在下载的真实分片 abort，导致导出缺分片。仅对首次完成的 url 计数。
      if (!task.doneUrls) task.doneUrls = new Set();
      if (seg.url) { if (!task.doneUrls.has(seg.url)) { task.doneUrls.add(seg.url); task.done++; } } else { task.done++; }
      task.cachedBytes = (task.cachedBytes || 0) + buffer.byteLength;
      this.broadcast(videoId);
    } catch (e) {
      if (this.running.get(key) && this.running.get(key) !== slot) return;
      if (e && e.message === 'preempted') {
        // 看门狗判死的下载（giveUp）：直接记为失败，避免 abort 后回 PENDING 又被重新调度、再次卡死
        if (slot.giveUp) {
          task.failed++;
          await updateSegState(videoId, segIdx, SEG_STATE.FAILED, { failReason: 'watchdog 下载超时放弃' });
          seg.state = SEG_STATE.FAILED; // 同步内存
          this.broadcast(videoId);
          this.notifySegFailed(videoId, segIdx);
          return;
        }
        // 被更高优先级抢占/整体取消：回到待下载，不记为失败
        await updateSegState(videoId, segIdx, SEG_STATE.PENDING);
        seg.state = SEG_STATE.PENDING; // 同步内存
        return;
      }
      task.failed++;
      await updateSegState(videoId, segIdx, SEG_STATE.FAILED, { failReason: String(e && e.message || e) });
      seg.state = SEG_STATE.FAILED; // 同步内存
      logger.warn('scheduler', `seg ${segIdx} failed`, e && e.message);
      this.broadcast(videoId);
      this.notifySegFailed(videoId, segIdx);
    } finally {
      if (this.running.get(key) === slot) this.running.delete(key);
      this.pump();
      // The completion path runs before finally removes the last running
      // entry. Re-broadcast after removal so ALL_DONE sees active=0.
      this.broadcast(videoId, true);
    }
  }

  // 单分片请求：超时 + 指数退避 + 403/超时刷新 m3u8（换最新签名 URL）后重试
  async fetchWithRetry(videoId, seg, outerCtrl) {
    const task = this.registry.get(videoId);
    const headers = cleanHeaders(task.headers);
    const { timeoutMs = 30000, maxRetry = 5 } = task.settings;
    let attempt = 0;
    let refreshRetries = 0; // 同一分片连续"403→刷新url更新→再403"的次数；超过上限即判失败，避免动态/拼接清单里永不完成的分片死循环占用下载槽
    for (;;) {
      const attemptCtrl = new AbortController();
      const signal = anySignal(outerCtrl.signal, attemptCtrl.signal);
      const timer = setTimeout(() => attemptCtrl.abort(), timeoutMs);
      let fail = null;
      try {
        const res = await fetch(seg.url, { headers, signal, credentials: 'include', cache: 'no-store' });
        if (res.status === 403 || res.status === 401 || res.status === 429) {
          // 防盗链兜底：403 且未带 Referer 时，用清单 url 作为 Referer 重试一次（部分 CDN 校验 Referer 须为清单所在域）
          if (res.status === 403 && !headers.Referer) {
            try {
              const r2 = await fetch(seg.url, { headers: { ...headers, Referer: task.meta.m3u8Url }, signal, credentials: 'include', cache: 'no-store' });
              if (r2.ok) return await r2.arrayBuffer();
            } catch (e) { /* 忽略，走刷新逻辑 */ }
          }
          // 签名过期：刷新后换新 URL 立即重试（无退避）；若刷新未生效（url 未变）则按失败处理，避免无限循环卡进度
          await this.refreshM3u8(videoId);
          const s2 = task.meta.segments.find(x => x.idx === seg.idx);
          const updated = s2 && s2.url && s2.url !== seg.url;
          if (updated) {
            refreshRetries++;
            seg.url = s2.url;
            if (refreshRetries > maxRetry) {
              throw new Error(`HTTP 403 持续（刷新${refreshRetries}次仍未解决）`);
            }
          } else {
            // A refresh that keeps the same URL cannot resolve an expired signature.
            throw new Error(`签名过期 HTTP ${res.status}（刷新后URL未变，无法续期）`);
          }
        } else if (!res.ok) {
          fail = new Error(`HTTP ${res.status}`);
        } else {
          return await this._readBody(videoId, seg, res);
        }
      } catch (e) {
        fail = e;
      } finally {
        clearTimeout(timer);
      }
      if (!fail) continue; // 403/429 已刷新，直接下一轮重试
      if (outerCtrl.signal.aborted) throw new Error('preempted'); // 抢占/取消：立即放弃
      const isTimeout = fail && fail.name === 'AbortError';
      if (attempt >= maxRetry) throw isTimeout ? new Error('timeout') : fail;
      if (isTimeout) {
        // 签名可能过期（服务端 hang）：刷新后换新 URL 重试
        try {
          await this.refreshM3u8(videoId);
          const s2 = task.meta.segments.find(x => x.idx === seg.idx);
          if (s2 && s2.url && s2.url !== seg.url) seg.url = s2.url;
        } catch {}
      }
      attempt++;
      const delay = Math.min(8000, 500 * Math.pow(2, attempt - 1));
      await sleep(delay); // 退避等待不计入 inflight
    }
  }

  // 流式读取分片响应体：逐 chunk 累加字节并实时上报，让"下载速度"在下载进行中真正每秒更新，
  // 而非只在分片完成那一刻刷新（否则下载一停速度就永久定格在最后一个值，误导用户）。
  // 中止时 reader.read() 抛 AbortError，由 fetchWithRetry 外层按失败/重试处理。
  async _readBody(videoId, seg, res) {
    const task = this.registry.get(videoId);
    if (!res.body || !task) return await res.arrayBuffer();
    const reader = res.body.getReader();
    const key = `${videoId}:${seg.idx}`;
    if (!task._partials) task._partials = new Map();
    task._partials.set(key, 0);
    const chunks = [];
    let acc = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) { chunks.push(value); acc += value.byteLength; }
        task._partials.set(key, acc);
        this.broadcast(videoId); // 有 250ms 节流，高频 chunk 不会刷爆消息
      }
    } finally {
      task._partials.delete(key);
    }
    const buf = new Uint8Array(acc);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return buf.buffer;
  }

  // 403/超时后刷新整份 m3u8，更新分片地址（含动态追加段）
  async refreshM3u8(videoId) {
    const task = this.registry.get(videoId);
    if (!task || task.refreshing) return;
    task.refreshing = true;
    const _ctrl = new AbortController();
    const _timer = setTimeout(() => _ctrl.abort(), 15000); // 清单请求加 15s 超时：源 CDN 挂起/不响应时不再永久阻塞分片（此前 active=4 卡死、failed=0、done 不动的根因）
    try {
      const headers = cleanHeaders(task.headers);
      const res = await fetch(task.meta.m3u8Url, { headers, credentials: 'include', cache: 'no-store', signal: _ctrl.signal });
      if (!res.ok) { logger.warn('scheduler', `refresh m3u8 ${videoId} HTTP ${res.status}（签名可能已过期）`); return; }
      const text = await res.text();
      const p = parsePlaylist(text, task.meta.m3u8Url);
      const meta = await getMeta(videoId);
      if (meta && p.segments.length) {
        // A refreshed VOD playlist normally keeps the same segment indexes,
        // but signed URLs can change and live/dynamic playlists may append or
        // slide. Update existing indexes in place so cached segment records
        // keep their state, append genuinely new entries, and always replace
        // the key (including METHOD=NONE) instead of leaving a stale key.
        const byIdx = new Map((meta.segments || []).map(s => [s.idx, s]));
        for (const ns of p.segments) {
          const old = byIdx.get(ns.idx);
          if (old) {
            old.url = ns.url;
            old.duration = ns.duration;
            old.start = ns.start;
            old.sequence = ns.sequence;
            old.key = ns.key || null;
          } else {
            meta.segments.push({
              idx: ns.idx, sequence: ns.sequence, url: ns.url, duration: ns.duration, start: ns.start,
              state: SEG_STATE.PENDING, size: 0, key: ns.key || null,
            });
          }
        }
        await saveMeta(meta);
        task.meta = meta;
      } else {
        logger.warn('scheduler', `refresh m3u8 ${videoId} 解析失败或分片为空 segs=${p.segments.length}`);
      }
    } catch (e) { logger.warn('scheduler', 'refresh m3u8 failed' + (e && e.name === 'AbortError' ? '（清单请求15s超时）' : ''), e && e.message); }
    finally { clearTimeout(_timer); task.refreshing = false; }
  }

  // 取消低优先级任务（Seek 用）
  cancelBelow(prio) {
    this.queue = this.queue.filter(t => t.prio >= prio);
    this.sort();
    for (const [key, m] of this.running) {
      if (m.prio < prio) { m.ctrl.abort(); this.running.delete(key); }
    }
  }

  cancelAll(videoId) {
    this.queue = this.queue.filter(t => t.videoId !== videoId);
    for (const [key, m] of this.running) {
      if (key.startsWith(videoId + ':')) { m.ctrl.abort(); this.running.delete(key); }
    }
  }

  // 后台全量补齐（恢复/预下载），按 url 去重：同内容不同签名分片不重复拉取
  enqueueFull(videoId) {
    const task = this.registry.get(videoId);
    if (!task) return;
    const seen = new Set();
    task.meta.segments.forEach(s => {
      if (s.url) { if (seen.has(s.url)) return; seen.add(s.url); }
      if (s.state === SEG_STATE.PENDING || s.state === SEG_STATE.FAILED) this.enqueue(videoId, s.idx, PRIO.FULL);
    });
  }

  // 重试失败分片：重置为 PENDING 并重新入队
  retryFailed(videoId) {
    const task = this.registry.get(videoId);
    if (!task) return;
    let n = 0;
    task.meta.segments.forEach(s => { if (s.state === SEG_STATE.FAILED) { s.state = SEG_STATE.PENDING; n++; } });
    if (!n) return;
    task.notifiedAll = false;
    saveMeta(task.meta).then(() => this.enqueueFull(videoId));
    return n;
  }

  // 鼠标调整进度条：中断当前所有正在下载的分片，目标区域(urgent+seek)最高优先下载，
  // 被中断的分片以低优先级(FULL)回队列等待，之后继续后台缓存
  interruptAndPrioritize(videoId, urgentIdx, seekIdxList = []) {
    const task = this.registry.get(videoId);
    if (!task) return;
    const seekSet = new Set(seekIdxList);
    // 1) 中断当前所有正在下载的分片
    const stopped = [];
    for (const [key, m] of this.running) {
      if (!key.startsWith(videoId + ':')) continue;
      stopped.push(Number(key.split(':')[1]));
      m.ctrl.abort();
      this.running.delete(key);
    }
    // 2) 被中断的、且不属于目标区域的分片：以低优先级回队列等待
    for (const idx of stopped) {
      if (idx === urgentIdx || seekSet.has(idx)) continue;
      if (this.queue.some(t => t.videoId === videoId && t.segIdx === idx)) continue;
      this.queue.push({ videoId, segIdx: idx, prio: PRIO.FULL, ts: Date.now() });
    }
    // 3) 队列中所有非目标分片降为低优先级，保证目标区域绝对优先
    for (const t of this.queue) {
      if (t.videoId === videoId && t.segIdx !== urgentIdx && !seekSet.has(t.segIdx)) t.prio = PRIO.FULL;
    }
    // 4) 目标分片若已在队列则先移除，再以最高优先级入队
    this.queue = this.queue.filter(t => !(t.videoId === videoId && (t.segIdx === urgentIdx || seekSet.has(t.segIdx))));
    this.enqueue(videoId, urgentIdx, PRIO.URGENT);
    seekIdxList.forEach(i => this.enqueue(videoId, i, PRIO.SEEK));
    this.sort();
    this.pump();
  }

  broadcast(videoId, force = false) {
    const task = this.registry.get(videoId);
    if (!task) return;
    const now = Date.now();
    if (!force && now - task.lastBroadcast < 250) return;
    task.lastBroadcast = now;
    const unique = dedupe(task.meta.segments);
    const total = unique.length;
    const done = unique.filter(s => s.state === SEG_STATE.DONE).length;
    const failed = unique.filter(s => s.state === SEG_STATE.FAILED).length;
    task.done = done;
    task.failed = failed;
    // 实际并发执行中的请求数（running 池大小，≤ maxConcurrent）
    let active = 0;
    for (const key of this.running.keys()) if (key.startsWith(videoId + ':')) active++;
    // 实时下载速度：总字节 = 已完成(putSegment 后的 cachedBytes) + 正在下载的流式 partial。
    // 下载进行中 partial 增长 → speed 每秒更新；下载停止（无 partial、cachedBytes 不变）→ speed 归零。
    let inflight = 0;
    if (task._partials) for (const v of task._partials.values()) inflight += v;
    const totalBytes = (task.cachedBytes || 0) + inflight;
    const dt = (now - (task.lastBytesAt || now)) / 1000;
    let speed = 0;
    if (task.lastBytesAt != null && task.lastBytes != null && dt > 0) {
      speed = Math.max(0, (totalBytes - task.lastBytes) / dt);
    }
    task.lastBytes = totalBytes;
    task.lastBytesAt = now;
    const msg = {
      type: 'PROGRESS', videoId, done, total, failed,
      active, bytes: task.cachedBytes || 0, speed,
    };
    if (task.tabId != null) chrome.runtime.sendMessage(msg).catch(() => {});
    // ALL_DONE 以去重后全部 state DONE 为准（而非累加器 done>=total）：重复 url 会让累加器虚高，
    // 提前触发会把仍在下载的真实分片 abort，导致导出缺数据
    const queueForVideo = this.queue.some(x => x.videoId === videoId);
    const allRealDone = total > 0 && done === total
      && active === 0 && !queueForVideo;
    if (allRealDone && !task.notifiedAll) {
      task.notifiedAll = true;
      // 全部缓存完成：彻底清空本视频的任何残留排队/下载，确保后台停止、UI 归零
      this.queue = this.queue.filter(t => t.videoId !== videoId);
      for (const [key, m] of this.running) {
        if (key.startsWith(videoId + ':')) { m.ctrl.abort(); this.running.delete(key); }
      }
      chrome.runtime.sendMessage({ type: 'ALL_DONE', videoId }).catch(() => {});
    }
  }

  // Detect requests that outlive normal retries even if the fetch never settles.
  startWatchdog() {
    if (this._watchdogTimer) return;
    this._watchdogTimer = setInterval(() => {
      // 看门狗：任何分片下载超过阈值(90s)仍未完成 → 判失败，杜绝"active 卡死、done 不动、failed 恒 0"的假死
      const _now = Date.now();
      for (const [key, m] of this.running) {
        if (!m.giveUp && _now - m.startTs > 90000) {
          m.giveUp = true;
          logger.warn('scheduler', `watchdog ${key} 下载超 ${((_now - m.startTs) / 1000).toFixed(0)}s 未完成，判失败`);
          m.ctrl.abort();
        }
      }
    }, 5000);
  }

  // 每 1s 兜底广播：下载进行中让速度每秒更新；下载停止后（没有分片完成触发 broadcast）1s 内把速度归零，
  // 避免"下载速度 4.11 MB/s 定格几分钟"的误导（broadcast 只在分片完成时触发，无活动时不会自动归零）。
  startSpeedTicker() {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => {
      for (const videoId of this.registry.keys()) this.broadcast(videoId);
    }, 1000);
  }

  notifySegFailed(videoId, segIdx) {
    const task = this.registry.get(videoId);
    if (task) chrome.runtime.sendMessage({ type: 'SEG_FAILED', videoId, segIdx }).catch(() => {});
  }

  // 启动恢复：把卡在下载中的分片重置
  async recover(videoId) {
    const task = this.registry.get(videoId);
    if (!task) return;
    task.meta.segments.forEach(s => { if (s.state === SEG_STATE.DOWNLOADING) s.state = SEG_STATE.PENDING; });
    await saveMeta(task.meta);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 组合信号：任一触发即中止（兼容无 AbortSignal.any 的低版本）
function anySignal(...sigs) {
  const c = new AbortController();
  const on = () => c.abort();
  for (const s of sigs) { if (s && s.aborted) on(); else if (s) s.addEventListener('abort', on, { once: true }); }
  return c.signal;
}

export const scheduler = new Scheduler();
