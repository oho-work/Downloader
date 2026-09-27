// background/service-worker.js
// 后台入口：嗅探 + 任务注册 + 分片调度 + 生命周期 + 心跳
import { registerSniffer, listStreams, clearTab, ingestContentStream, setSniffEnabled } from './sniffer.js';
import { getSession, clearSession, purgeExpired, bindSession } from './session.js';
import { parsePlaylist } from './m3u8-parser.js';
import { scheduler, dedupe } from './scheduler.js';
import { saveMeta, getMeta, delMeta, delAllSegments, listAllMeta, saveSettings, getSettings, SEG_STATE } from './cache-store.js';
import { videoIdFor, sanitizeTitle, domainOf, diagnosticUrl } from '../utils/id.js';
import { logger } from '../utils/logger.js';

const DEFAULTS = {
  sniffEnabled: true, maxConcurrent: 16, timeoutMs: 30000, maxRetry: 5,
};
const SETTINGS_KEYS = ['sniffEnabled', 'maxConcurrent', 'timeoutMs', 'maxRetry'];

// 播放任务注册表（videoId -> task），headers 只存 SW 内存
const taskCtx = new Map();
// 播放页 tab -> videoId，用于关标签兜底清理
const tabVideo = new Map();

function hasOtherPlayer(videoId, exceptTabId = null) {
  for (const [tabId, id] of tabVideo) {
    if (id === videoId && tabId !== exceptTabId) return true;
  }
  return false;
}

async function loadSettings() {
  const stored = await getSettings();
  const s = { ...DEFAULTS };
  for (const key of SETTINGS_KEYS) if (Object.prototype.hasOwnProperty.call(stored || {}, key)) s[key] = stored[key];
  scheduler.setConcurrency(s.maxConcurrent);
  setSniffEnabled(s.sniffEnabled);
  return s;
}

function normalizeSettings(input = {}) {
  const n = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const maxConcurrent = Math.min(64, Math.max(1, n(input.maxConcurrent, DEFAULTS.maxConcurrent)));
  const timeoutMs = Math.min(120000, Math.max(1000, n(input.timeoutMs, DEFAULTS.timeoutMs)));
  const maxRetry = Math.min(10, Math.max(0, n(input.maxRetry, DEFAULTS.maxRetry)));
  return {
    sniffEnabled: input.sniffEnabled !== false,
    maxConcurrent,
    timeoutMs,
    maxRetry,
  };
}

// ── 消息分派 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse).catch(e => {
    logger.error('sw', 'handle', msg && msg.type, e && e.message);
    sendResponse({ ok: false, error: String(e && e.message || e) });
  });
  return true;
});

async function handle(msg, sender) {
  // ── 自愈：SW 空闲被回收/重启后 registry 为空，但 IDB 仍有 meta 且播放端在活动 ──
  // 此时 SCHEDULE_BATCH/SCHEDULE_SEG 只调 enqueue（registry 空直接 return），卡死分片无人重下。
  // 任意播放消息进来时，若 registry 缺失且 IDB 有 meta → 从缓存恢复调度，杜绝"尾部卡死"。
  if (msg && msg.videoId && ['SCHEDULE_BATCH', 'SCHEDULE_SEG', 'PLAYER_READY', 'GET_TASK_CTX'].includes(msg.type) && !scheduler.getTask(msg.videoId)) {
    const meta = await getMeta(msg.videoId);
    if (meta) {
      const settings = await loadSettings();
      let t = taskCtx.get(msg.videoId);
      if (!t) { t = { m3u8Url: meta.m3u8Url, headers: undefined, live: meta.live, domain: meta.domain }; taskCtx.set(msg.videoId, t); }
      scheduler.register(msg.videoId, { meta, headers: t.headers, tabId: t.tabId, settings });
      await scheduler.recover(msg.videoId);   // 重置遗留 DOWNLOADING→PENDING（SW 重启后 running 为空，无正在下载，安全）
      await scheduler.refreshM3u8(msg.videoId);
      scheduler.enqueueFull(msg.videoId);
      logger.info('sw', `自愈恢复 ${msg.videoId}（SW 重启后 registry 为空，从 IDB 恢复调度）`);
    }
  }
  switch (msg && msg.type) {

    case 'LIST_STREAMS': {
      const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
      return { ok: true, streams: await listStreams(tabId, msg.pageUrl || '') };
    }

    case 'CONTENT_READY': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) return { ok: true, streams: [] };
      return { ok: true, streams: await listStreams(tabId, sender.url || sender.tab.url || '') };
    }

    case 'CLEAR_SNIFF': {
      if (!Number.isInteger(msg.tabId) || msg.tabId < 0) return { ok: false, error: 'invalid tab' };
      await clearTab(msg.tabId, 'popup clear');
      return { ok: true };
    }

    case 'SEND_STREAMS': {
      ingestContentStream(sender.tab && sender.tab.id, msg.url, sender.tab && sender.tab.url);
      return { ok: true };
    }

    case 'OPEN_PLAYER': {
      const stream = msg.stream;
      if (!stream || !stream.url) return { ok: false, error: 'no stream url' };
      const tabId = sender.tab && sender.tab.id;
      const headers = stream.headers || getSession(tabId) || undefined;
      let title = (msg.title || (sender.tab && sender.tab.title) || '').trim();
      title = sanitizeTitle(title);
      const settings = await loadSettings();

      const videoId = videoIdFor(stream.url);
      // 解析清单，构建 meta（主清单 segments 为空，由播放端动态补齐）
      let meta;
      try {
        const text = await fetchText(stream.url, headers);
        const p = parsePlaylist(text, stream.url);
        meta = {
          videoId, m3u8Url: stream.url, title, domain: domainOf(stream.url),
          live: p.live, isMaster: p.isMaster, encrypted: p.encrypted,
          totalDuration: p.totalDuration, status: 'playing',
          segments: p.segments.map(s => ({ idx: s.idx, url: s.url, duration: s.duration, start: s.start, state: SEG_STATE.PENDING, size: 0, key: s.key || null })),
        };
      } catch (e) {
        logger.warn('sw', 'parse m3u8 fail, fallback live meta', e && e.message);
        meta = { videoId, m3u8Url: stream.url, title, domain: domainOf(stream.url), live: true, isMaster: false, encrypted: false, totalDuration: 0, status: 'playing', segments: [] };
      }
      await saveMeta(meta);

      const url = chrome.runtime.getURL('player/player.html') + '?v=' + encodeURIComponent(videoId);
      const newTab = await chrome.tabs.create({ url });
      tabVideo.set(newTab.id, videoId);
      taskCtx.set(videoId, { m3u8Url: stream.url, headers, live: meta.live, domain: meta.domain });
      // 注册调度任务（tabId 指向新播放页，用于进度广播）
      scheduler.register(videoId, { meta, headers, tabId: newTab.id, settings });
      logger.info('sw', `open ${videoId} <- ${diagnosticUrl(stream.url)}`);
      return { ok: true, videoId, url };
    }

    case 'GET_TASK_CTX': {
      const meta = await getMeta(msg.videoId);
      if (!meta) return { ok: false, error: 'task not found' };
      let t = taskCtx.get(msg.videoId);
      if (!t) {
        // SW 内存任务丢失（重启/刷新）但 IDB 缓存仍在 → 从缓存恢复，支持离线续看/导出
        const settings = await loadSettings();
        t = { m3u8Url: meta.m3u8Url, headers: undefined, live: meta.live, domain: meta.domain };
        taskCtx.set(msg.videoId, t);
        scheduler.register(msg.videoId, { meta, headers: t.headers, tabId: undefined, settings });
        await scheduler.recover(msg.videoId);   // 重置遗留 DOWNLOADING→PENDING，避免卡死分片不被重下
        await scheduler.refreshM3u8(msg.videoId);
        scheduler.enqueueFull(msg.videoId);     // 补齐剩余（含刚重置的分片）
        if (sender.tab) tabVideo.set(sender.tab.id, msg.videoId); // 关标签时仍清理缓存
        logger.info('sw', `GET_TASK_CTX 从缓存恢复 ${msg.videoId}`);
      }
      return { ok: true, ctx: { videoId: msg.videoId, m3u8Url: t.m3u8Url, title: meta && meta.title, domain: t.domain, live: t.live, isMaster: meta && meta.isMaster, segments: meta && meta.segments } };
    }

    // 播放端 Loader 请求清单文本（经 SW 携带会话头）
    case 'GET_MANIFEST': {
      const t = taskCtx.get(msg.videoId);
      if (!t) return { ok: false, error: 'task not found' };
      const url = msg.url || t.m3u8Url;
      try { const text = await fetchText(url, t.headers); return { ok: true, text }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    // 加密流导出：代取解密 key（SW 请求带会话头、不受 CORS 限制；key 16 字节以数组返回）
    case 'GET_KEY': {
      const t = taskCtx.get(msg.videoId);
      if (!t || !msg.uri) return { ok: false, error: 'task or uri missing' };
      try {
        const res = await fetch(msg.uri, { headers: cleanH(t.headers), credentials: 'include', cache: 'no-store' });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        const buf = await res.arrayBuffer();
        return { ok: true, key: Array.from(new Uint8Array(buf)) };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }

    case 'PLAYER_READY': {
      const meta = await getMeta(msg.videoId);
      if (meta) {
        scheduler.register(msg.videoId, { meta, headers: taskCtx.get(msg.videoId)?.headers, tabId: sender.tab && sender.tab.id, settings: await loadSettings() });
        await scheduler.recover(msg.videoId);
        await scheduler.refreshM3u8(msg.videoId); // 先刷新签名，后台补齐用最新 URL
        scheduler.enqueueFull(msg.videoId);       // 后台补齐剩余分片
      }
      return { ok: true };
    }

    // 播放端请求下载单个分片（Loader 未命中缓存）
    case 'SCHEDULE_SEG': {
      scheduler.enqueue(msg.videoId, msg.segIdx, PRIO_URGENT());
      return { ok: true };
    }
    // 鼠标调整进度条：中断当前所有下载，目标区域(urgent+seek)最高优先，被中断的回低优先级等待继续缓存
    // timeupdate 预加载：仅把目标后方分片以低优先级(AHEAD)入队，不中断任何下载
    case 'SCHEDULE_BATCH': {
      if (msg.urgent != null) {
        scheduler.interruptAndPrioritize(msg.videoId, msg.urgent, msg.seek || []);
      } else {
        (msg.ahead || []).forEach(i => scheduler.enqueue(msg.videoId, i, PRIO_AHEAD()));
      }
      logger.debug('sw', `batch ${msg.videoId} urgent=${msg.urgent != null ? msg.urgent : '-'} seek=${(msg.seek || []).length} ahead=${(msg.ahead || []).length}`);
      return { ok: true };
    }

    // 重试失败分片
    case 'RETRY_FAILED': {
      const n = scheduler.retryFailed(msg.videoId);
      return { ok: true, retried: n || 0 };
    }
    // 本次会话参数覆盖（播放端设置面板）
    case 'SET_TASK_SETTINGS': {
      const t = scheduler.getTask(msg.videoId);
      if (t) Object.assign(t.settings, msg.patch || {});
      return { ok: true };
    }
    // 动态追加分片（主清单播放中遇到新 url）
    case 'ADD_SEGMENTS': {
      const meta = await getMeta(msg.videoId);
      if (meta) {
        let changed = false, dup = 0;
        for (const s of msg.segments || []) {
          if (!meta.segments.some(x => x.url === s.url)) {
            meta.segments.push({ idx: meta.segments.length, url: s.url, duration: s.duration || 0, start: s.start != null ? s.start : 0, state: SEG_STATE.PENDING, size: 0, key: s.key || null });
            changed = true;
          } else { dup++; }
        }
        logger.debug('sw', `add segments ${msg.videoId} 新增=${msg.segments ? msg.segments.length - dup : 0} 重复跳过=${dup} 当前总数=${meta.segments.length}`);
        if (changed) { await saveMeta(meta); scheduler.register(msg.videoId, { meta, headers: taskCtx.get(msg.videoId)?.headers, tabId: sender.tab && sender.tab.id, settings: await loadSettings() }); }
      }
      return { ok: true };
    }

    // 播放页卸载/刷新：只释放内存调度，保留 IDB 缓存。
    // 真正删除缓存仅发生在 tabs.onRemoved（用户关闭标签页）。
    case 'CLOSE_PLAYER': {
      const tabId = sender.tab && sender.tab.id;
      // 同一清单可能被多个播放器标签页打开。一个页面卸载时只能释放
      // 自己的调度引用，不能中断另一个仍在使用同一缓存的播放器。
      if (!hasOtherPlayer(msg.videoId, tabId)) {
        scheduler.cancelAll(msg.videoId);
        scheduler.unregister(msg.videoId);
        taskCtx.delete(msg.videoId);
      }
      // Keep the tab -> video mapping until tabs.onRemoved. pagehide also
      // fires on reload, and deleting it here prevents close-time cleanup.
      return { ok: true };
    }

    // 清空本次缓存：清分片并重置分片状态（保留任务，便于重载后继续缓存）
    case 'CLEAR_SESSION': {
      scheduler.cancelAll(msg.videoId);
      await delAllSegments(msg.videoId);
      const meta = await getMeta(msg.videoId);
      if (meta) {
        meta.segments.forEach(s => { s.state = SEG_STATE.PENDING; s.size = 0; });
        await saveMeta(meta);
        scheduler.register(msg.videoId, { meta, headers: taskCtx.get(msg.videoId)?.headers, tabId: sender.tab && sender.tab.id, settings: await loadSettings() });
      }
      return { ok: true };
    }

    case 'LIST_CACHED': {
      const metas = await listAllMeta();
      const list = metas.map(m => {
        const uniq = dedupe(m.segments);
        return {
          videoId: m.videoId, title: m.title, domain: m.domain, totalDuration: m.totalDuration,
          m3u8Url: m.m3u8Url, live: m.live,
          segmentCount: uniq.length,
          done: uniq.filter(s => s.state === SEG_STATE.DONE).length,
        };
      });
      return { ok: true, videos: list };
    }

    case 'CLEAR_CACHE': {
      const metas = await listAllMeta();
      for (const m of metas) await cleanupVideo(m.videoId);
      return { ok: true };
    }

    case 'DELETE_CACHE': {
      if (!msg.videoId) return { ok: false, error: 'missing videoId' };
      await cleanupVideo(msg.videoId);
      return { ok: true };
    }

    case 'GET_SETTINGS': return { ok: true, settings: await loadSettings() };
    case 'SAVE_SETTINGS': {
      const settings = normalizeSettings(msg.settings);
      await saveSettings(settings);
      scheduler.setConcurrency(settings.maxConcurrent);
      setSniffEnabled(settings.sniffEnabled);
      return { ok: true, settings };
    }

    default: return { ok: false, error: 'unknown type: ' + (msg && msg.type) };
  }
}

function PRIO_URGENT() { return 3; } function PRIO_SEEK() { return 2; } function PRIO_AHEAD() { return 1; } function PRIO_FULL() { return 0; }

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: cleanH(headers), credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
}
function cleanH(h) { const o = {}; if (h) for (const k of ['Referer', 'Accept', 'Accept-Language']) if (h[k]) o[k] = h[k]; return o; }

// ── 心跳 / 生命周期 ──
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('heartbeat', { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'heartbeat') return;
  purgeExpired();
  recoverStuckSegments(); // 巡检遗留 DOWNLOADING 分片：重置重下，不依赖 SW 常驻 setInterval（MV3 SW 空闲会被回收）
});

// 每 0.5min 心跳巡检：①把【卡死遗留】的 DOWNLOADING 分片重置重下；②无条件补齐调度。
// 判定以 running 池 + startTs 为准（最可靠），不再依赖 startedAt 字段（会被反复入队刷新、可能永不 >90s），
// 也不依赖 SW 常驻 setInterval（MV3 SW 空闲会被回收，setInterval 看门狗失效）。
// 规则：在跑且 startTs<90s → 正常下载，绝不碰；在跑但 >90s 未完成，或根本不在跑（SW 重启/interval 停的遗留 DOWNLOADING）
// → 中断旧下载、重置 PENDING 重新入队。只动卡死分片，避免 v1.6.1 无差别重置致 cached 清零。
// ②无条件 register + 拉起 PENDING：SW 重启后 registry 为空、PENDING 分片无人入队（enqueueFull 无入口）时由心跳兜底，
// enqueue 自带 running/queue/DONE 去重，重复巡检无副作用；FAILED 分片不自动重试（保留手动"重试"语义）。
async function recoverStuckSegments() {
  let metas;
  try { metas = await listAllMeta(); } catch (e) { return; }
  const settings = await loadSettings();
  const now = Date.now();
  for (const m of metas || []) {
    const resetIdx = [];
    (m.segments || []).forEach(s => {
      if (s.state !== SEG_STATE.DOWNLOADING) return;
      const key = `${m.videoId}:${s.idx}`;
      const rm = scheduler.running.get(key);
      if (rm && now - (rm.startTs || 0) <= 90000) return; // 在跑且未超时：正常下载中
      // A freshly persisted DOWNLOADING state can briefly outlive the in-memory
      // running map during task registration or SW wake-up. Give it the same
      // grace period as an active request instead of resetting it immediately.
      if (!rm && s.startedAt && now - s.startedAt <= 90000) return;
      // Leave the running entry until run() handles the abort. Its giveUp flag
      // is how the scheduler distinguishes a watchdog timeout (FAILED) from a
      // user seek/cancel (PENDING); deleting it here would lose that signal.
      if (rm) rm.ctrl.abort();
      s.state = SEG_STATE.PENDING;
      resetIdx.push(s.idx);
    });
    if (resetIdx.length) { try { await saveMeta(m); } catch (e) { continue; } }
    let t = taskCtx.get(m.videoId);
    if (!t) { t = { m3u8Url: m.m3u8Url, headers: undefined, live: m.live, domain: m.domain }; taskCtx.set(m.videoId, t); }
    scheduler.register(m.videoId, { meta: m, headers: t.headers, tabId: t.tabId, settings });
    let n = 0;
    for (const s of m.segments) {
      if (s.state === SEG_STATE.PENDING) { scheduler.enqueue(m.videoId, s.idx, PRIO_FULL()); n++; }
    }
    if (resetIdx.length || n) logger.info('sw', `心跳巡检 ${m.videoId} 重置#${resetIdx.join(',')} 入队PENDING=${n}`);
  }
}
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId, 'tab removed'); clearSession(tabId);
  const videoId = tabVideo.get(tabId);
  if (videoId) {
    tabVideo.delete(tabId);
    // 只有最后一个播放器标签页关闭后才清理视频缓存。否则关闭其中一个
    // 标签会把另一个标签正在播放/导出的数据一起删掉。
    if (hasOtherPlayer(videoId)) return;
    cleanupVideo(videoId).catch(e => logger.warn('sw', 'cleanup video failed', e && e.message));
  }
});

async function cleanupVideo(videoId) {
  scheduler.cancelAll(videoId);
  scheduler.unregister(videoId);
  taskCtx.delete(videoId);
  await delAllSegments(videoId);
  await delMeta(videoId);
}

// 页面导航会触发 onRemoved 之前的 pagehide，不能依赖标签页关闭事件才清理。
// 同时清掉该标签页的嗅探候选和会话请求头，避免新网址继承旧页面状态。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo && (changeInfo.url || changeInfo.status === 'loading')) {
    logger.info('sniff-diag', `tab update tab=${tabId} status=${changeInfo.status || '-'} changedUrl=${diagnosticUrl(changeInfo.url)} tabUrl=${diagnosticUrl(tab && tab.url)} clear=${!!changeInfo.url}`);
  }
  if (!changeInfo || !changeInfo.url) return;
  clearTab(tabId, 'tab URL changed');
  clearSession(tabId);
  const videoId = tabVideo.get(tabId);
  if (!videoId) return;
  let samePlayer = false;
  try {
    const u = new URL(changeInfo.url);
    samePlayer = u.href.startsWith(chrome.runtime.getURL('player/player.html')) && u.searchParams.get('v') === videoId;
  } catch {}
  if (samePlayer) return;
  tabVideo.delete(tabId);
  if (!hasOtherPlayer(videoId)) cleanupVideo(videoId).catch(() => {});
});

registerSniffer();
scheduler.startStatsLog();
scheduler.startSpeedTicker();
loadSettings().then(() => logger.info('sw', 'HLS Cache Player full build ready'));
