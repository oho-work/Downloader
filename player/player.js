// player/player.js
// 独立播放页：取任务上下文 → hls.js(自定义Loader) 播放 → Seek 预加载 → 缓存进度 → 导出 MP4
import { loaderFor } from './hls-loader.js';
import { getMeta, getSegment, SEG_STATE } from '../background/cache-store.js';
import { sanitizeTitle } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { runtimeAvailable, sendRuntimeMessage } from '../utils/runtime-message.js';
import { FFmpeg } from '../lib/ffmpeg12/esm/index.js';
import { decryptHlsSegment } from './hls-crypto.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
video.muted = true;
const q = new URLSearchParams(location.search);
const videoId = q.get('v');

let hls = null, ctx = null;
let metaSegs = [];          // 本地分片索引（初始快照 + 动态追加）
let settings = { seekBefore: 3, seekAfter: 7, playAhead: 10, maxConcurrent: 16, timeoutMs: 30000, maxRetry: 5 };
let allDone = false;
let avgStart = 0; // 平均速度计时起点（首次出现已缓存字节时）
let avgFrozen = false;
let avgFinal = 0;

if (!videoId) {
  showError('缺少视频任务参数，请从原网页重新打开');
} else {
  boot().catch(e => { logger.error('player', 'boot failed', e); showError(String(e && e.message || e)); });
}

async function boot() {
  // 1) 任务上下文
  const r = await sendRuntimeMessage({ type: 'GET_TASK_CTX', videoId });
  if (!r || !r.ok || !r.ctx) { showError('找不到该视频任务，请从原网页重新打开'); return; }
  ctx = r.ctx;
  metaSegs = (ctx.segments || []).slice();

  // 2) 界面
  $('title').textContent = ctx.title || '未命名视频';
  $('domain').textContent = ctx.domain || '';
  $('srcHost').textContent = ctx.domain || '—';
  $('type').textContent = ctx.live ? '直播' : '点播';
  if (ctx.live) $('status').textContent = '直播中';
  const dur = metaSegs.reduce((a, s) => a + (s.duration || 0), 0);
  $('duration').textContent = fmt(dur);

  // 3) 设置（全局设置页管理，播放页不展示会话设置）
  const s = await sendRuntimeMessage({ type: 'GET_SETTINGS' });
  if (s && s.ok) settings = { ...settings, ...s.settings };
  $('exportBtn').textContent = '导出 MP4';

  // 4) 通知 SW 就绪
  await sendRuntimeMessage({ type: 'PLAYER_READY', videoId }).catch(() => {});

  // 5) 初始化播放
  initPlayer();
  bindEvents();
  listenProgress();
}

function initPlayer() {
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      loader: loaderFor(videoId),
      pLoader: loaderFor(videoId),
      maxBufferLength: 60, maxMaxBufferLength: 120,
    });
    hls.on(Hls.Events.ERROR, onHlsError);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { $('status').textContent = '就绪'; });
    hls.loadSource(ctx.m3u8Url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = ctx.m3u8Url;
  } else {
    showError('当前浏览器不支持 HLS 播放'); return;
  }

  video.addEventListener('playing', () => { $('loading').style.display = 'none'; $('status').textContent = '播放中'; });
  video.addEventListener('waiting', () => $('status').textContent = '缓冲中');
  video.addEventListener('loadeddata', () => {
    $('status').textContent = '已连接'; $('loading').style.display = 'none';
    // 静音自动播放；用户可通过原生播放器控件主动开启声音。
    video.play().catch(() => {});
  });
}

// ── Seek 预加载（前3后7，可配置，防抖） ──
function idxAtTime(segs, t) {
  let lo = 0, hi = segs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].start <= t) lo = m; else hi = m - 1; }
  return lo;
}
let seekTimer = null;
function bindEvents() {
  video.addEventListener('seeking', () => {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      if (!runtimeAvailable()) return;
      if (!metaSegs.length) return;
      const target = idxAtTime(metaSegs, video.currentTime);
      if (target < 0) return;
      const seek = [];
      for (let i = Math.max(0, target - settings.seekBefore); i < target; i++) seek.push(i);
      for (let i = target + 1; i <= Math.min(metaSegs.length - 1, target + settings.seekAfter); i++) seek.push(i);
      sendRuntimeMessage({ type: 'SCHEDULE_BATCH', videoId, cancel: true, urgent: target, seek }).catch(() => {});
    }, 300);
  });

  // 正常播放向后预加载
  let lastAhead = 0;
  video.addEventListener('timeupdate', () => {
    if (!runtimeAvailable()) return;
    const now = Date.now();
    if (now - lastAhead < 3000) return;
    lastAhead = now;
    if (!metaSegs.length) return;
    const cur = idxAtTime(metaSegs, video.currentTime);
    if (cur < 0) return;
    const ahead = [];
    for (let i = cur + 1; i <= Math.min(metaSegs.length - 1, cur + settings.playAhead); i++) ahead.push(i);
    sendRuntimeMessage({ type: 'SCHEDULE_BATCH', videoId, cancel: false, ahead }).catch(() => {});
  });

  // 导出 / 清空 / 重试失败
  $('exportBtn').addEventListener('click', exportVideo);
  $('clearBtn').addEventListener('click', () => { sendRuntimeMessage({ type: 'CLEAR_SESSION', videoId }).catch(() => {}); toast('已清空本次缓存'); setTimeout(() => location.reload(), 600); });
  $('retryFailedBtn').addEventListener('click', async () => {
    allDone = false;
    avgFrozen = false;
    $('exportBtn').disabled = true;
    const r = await sendRuntimeMessage({ type: 'RETRY_FAILED', videoId }).catch(() => {});
    toast('已重新调度 ' + (r && r.retried ? r.retried : 0) + ' 个失败分片');
    updateCache();
  });

  // 关闭清理
  window.addEventListener('pagehide', () => sendRuntimeMessage({ type: 'CLOSE_PLAYER', videoId }).catch(() => {}));
}

// ── 进度接收 ──
function listenProgress() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.videoId !== videoId) return;
    if (msg.type === 'PROGRESS' || msg.type === 'ALL_DONE' || msg.type === 'SEG_FAILED') updateCache(msg);
  });
}
// 侧栏缓存区间条：已缓存分片按时间占比渲染为连续色块（145689 → 三块），与实际缓存区间一致
function renderSegBar(uniq) {
  const el = $('segBar');
  el.innerHTML = '';
  if (!uniq.length) { el.style.display = 'none'; return; }
  const dur = uniq.reduce((a, s) => a + (s.duration || 0), 0);
  if (!dur) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const frag = document.createDocumentFragment();
  let acc = 0;
  for (const s of uniq) {
    if (s.state === SEG_STATE.DONE) {
      const d = document.createElement('div');
      d.className = 'seg done';
      d.style.left = (acc / dur * 100) + '%';
      d.style.width = Math.max(0.3, (s.duration || 0) / dur * 100) + '%';
      frag.appendChild(d);
    }
    acc += (s.duration || 0);
  }
  el.appendChild(frag);
}
// 播放器进度条上的缓存区间色块：按顺序累计偏移渲染，相邻已缓存分片严格无缝连成块
function renderVideoCacheBar(uniq) {
  const el = $('videoCacheBar');
  el.innerHTML = '';
  if (!uniq.length) return;
  const dur = uniq.reduce((a, s) => a + (s.duration || 0), 0);
  if (!dur) return;
  let acc = 0;
  for (const s of uniq) {
    if (s.state === SEG_STATE.DONE) {
      const w = Math.max(0.15, (s.duration || 0) / dur * 100);
      const d = document.createElement('div');
      d.className = 'vseg';
      d.style.left = (acc / dur * 100) + '%';
      d.style.width = w + '%';
      el.appendChild(d);
    }
    acc += (s.duration || 0);
  }
}
async function updateCache(msg) {
  let m = null; try { m = await getMeta(videoId); } catch {}
  const segs = m ? m.segments : [];
  // 按 url 去重：m3u8 刷新/追加可能产生同内容不同签名的重复分片，合并计数避免虚高（DONE 优先）
  const map = new Map();
  for (const s of segs) {
    if (!s || !s.url) continue;
    const ex = map.get(s.url);
    if (!ex) map.set(s.url, s);
    else if (ex.state !== SEG_STATE.DONE && s.state === SEG_STATE.DONE) map.set(s.url, s);
  }
  const uniq = [...map.values()];
  renderSegBar(uniq);
  renderVideoCacheBar(uniq);
  const total = uniq.length;
  const done = uniq.filter(s => s.state === SEG_STATE.DONE).length;
  const failed = uniq.filter(s => s.state === SEG_STATE.FAILED).length;
  $('cacheCount').textContent = `${done} / ${total} 分片`;
  // 百分比向下取整：只有 done 真正等于 total 才显示 100%。round 会在 261/262=99.6% 时误显 100%，
  // 与"下载中 N"自相矛盾（用户以为全缓存完却还导不了）。floor 保证 99% 直到真完成。
  const pct = total ? Math.floor(done / total * 100) : 0;
  $('cachePct').textContent = pct + '%';
  $('cacheFailed').textContent = failed;
  // 正在下载的请求数量（真正拉取数据中）+ 已缓存总 MB + 上一秒下载速度
  const bytes = uniq.reduce((a, s) => a + (s.size || 0), 0);
  $('cacheMB').textContent = (bytes / 1048576).toFixed(1) + ' MB';
  // "剩余" = 仍在下载/待下载（PENDING+DOWNLOADING）= 总数 - 已完成 - 已失败；与"已完成/总数"互补，可直接看出还差几个。
  const remaining = total - done - failed;
  $('cacheActive').textContent = remaining > 0 ? remaining : 0;
  $('cacheSpeed').textContent = fmtSpeed(msg && msg.speed ? msg.speed : 0);
  // 平均速度 = 已缓存字节 / 自开始缓存以来的秒数（本次页面会话口径；下载完成后保持最终均值）
  if (avgFrozen) {
    $('cacheAvg').textContent = fmtSpeed(avgFinal);
  } else if (bytes > 0) {
    if (!avgStart) avgStart = Date.now();
    const elapsed = Math.max(0.001, (Date.now() - avgStart) / 1000);
    avgFinal = bytes / elapsed;
    if (remaining <= 0) avgFrozen = true;
    $('cacheAvg').textContent = fmtSpeed(avgFinal);
  } else {
    if (remaining <= 0) avgFrozen = true;
    avgFinal = 0;
    $('cacheAvg').textContent = '0 KB/s';
  }
  const btn = $('retryFailedBtn');
  if (btn) btn.style.display = failed > 0 ? 'inline-block' : 'none';
  // 全部已处理（无仍在下载/待下载）即解锁导出；failed>0 时允许跳过失效分片导出
  if (remaining <= 0 && !allDone) { allDone = true; enableExport(failed); }
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '0 KB/s';
  if (bps >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
}
function enableExport(skipN) {
  $('exportBtn').disabled = false;
  $('exportTip').textContent = skipN > 0 ? `${skipN} 个分片失效，导出将跳过这些片段` : '全部分片已缓存，可导出';
}

// ── 导出（ffmpeg 0.12：静态 worker + import core，规避 MV3 禁止的 blob） ──
// TS 合法性启发式：MPEG-TS 每个 188 字节包以同步字节 0x47 开头（密文/HTML 错误页/空数据不符合）
function isTsLike(b) {
  if (!b || b.byteLength < 1) return false;
  const u = new Uint8Array(b);
  if (u[0] === 0x47) return true;
  if (b.byteLength >= 188 && u[188] === 0x47) return true;
  if (b.byteLength >= 376 && u[376] === 0x47) return true;
  return false;
}
async function getExportKey(uri) {
  const r = await sendRuntimeMessage({ type: 'GET_KEY', videoId, uri }).catch(() => null);
  if (!r || !r.ok || !Array.isArray(r.key)) throw new Error('获取解密密钥失败: ' + ((r && r.error) || '后台无响应'));
  return new Uint8Array(r.key);
}
async function exportVideo() {
  const m = await getMeta(videoId);
  if (!m) return;
  // 按 url 去重（DONE 优先）：m3u8 刷新会产生同内容不同签名的重复分片，导出只取唯一的一份，
  // 否则 m3u8 引用到未缓存的分片会在 ffmpeg 虚拟文件系统报 ErrnoError: FS error
  const map = new Map();
  for (const s of m.segments) {
    if (!s || !s.url) continue;
    const ex = map.get(s.url);
    if (!ex) map.set(s.url, s);
    else if (ex.state !== SEG_STATE.DONE && s.state === SEG_STATE.DONE) map.set(s.url, s);
  }
  const uniq = [...map.values()];
  const notDone = uniq.filter(s => s.state !== SEG_STATE.DONE);
  // 仍在下/待下的分片 → 拒绝导出；仅剩 FAILED（失效/死链）分片 → 允许跳过导出
  const stillPending = notDone.filter(s => s.state === SEG_STATE.PENDING || s.state === SEG_STATE.DOWNLOADING);
  const skipped = notDone.filter(s => s.state === SEG_STATE.FAILED);
  let exportable = uniq.filter(s => s.state === SEG_STATE.DONE);
  if (stillPending.length) { toast('尚未缓存全部分片（仍在下载 ' + stillPending.length + ' 个）'); return; }
  // 预检每个 DONE 分片的数据：加密流先解密成明文 TS；非法（防盗链 HTML/截断/解密失败）分片剔除，
  // 避免 ffmpeg 读到首个坏分片就整包失败（ErrnoError: FS error / Invalid data）
  const bad = [];
  const good = [];
  const decCache = new Map(); // idx -> 解密后的明文 buffer，写入时直接复用，避免二次解密
  const keyCache = new Map();
  for (const s of exportable) {
    let b = null;
    try {
      const g = await getSegment(videoId, s.idx);
      b = (g && g.buffer) || null;
      if (b && s.key) {
        b = await decryptHlsSegment(s, b, m.m3u8Url, getExportKey, keyCache);
        decCache.set(s.idx, b);
      }
    } catch (e) {
      logger.error('player', `segment ${s.idx} decryption failed`, e && e.message);
      toast('解密分片失败：' + (e && e.message || e));
      return;
    }
    if (!b || !isTsLike(b)) bad.push(s.idx);
    else good.push(s);
  }
  if (bad.length) logger.warn('player', `export skipped ${bad.length} invalid segments`);
  if (!good.length) {
    toast('缓存分片全部不是有效 TS（解密失败或防盗链内容），无法导出');
    logger.error('player', 'export has no valid TS segments');
    return;
  }
  exportable = good;
  if (skipped.length) logger.warn('player', `export skipped ${skipped.length} failed segments`);
  const skipTotal = skipped.length + bad.length;
  $('exportBtn').disabled = true;
  toast(skipTotal ? `正在导出（跳过 ${skipTotal} 个失效分片）…` : '正在导出，请稍候…');
  const ffmpeg = new FFmpeg();
  try {
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('lib/ffmpeg12-core/esm/ffmpeg-core.js') });
    for (let i = 0; i < exportable.length; i++) {
      const s = exportable[i];
      const g = decCache.has(s.idx) ? { buffer: decCache.get(s.idx) } : await getSegment(videoId, s.idx);
      if (!g || !g.buffer) throw new Error('分片数据缺失 idx=' + s.idx);
      await ffmpeg.writeFile(`s${i}.ts`, new Uint8Array(g.buffer));
    }
    const maxDur = Math.max.apply(null, exportable.map(s => s.duration && s.duration > 0 ? s.duration : 2));
    let list = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.ceil(maxDur) + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    // 分片用绝对路径 /sN.ts；必须带 ENDLIST 标记成点播列表，否则 ffmpeg 当直播列表解析 → Invalid data
    exportable.forEach((s, i) => { const dur = s.duration && s.duration > 0 ? s.duration : 2; list += `#EXTINF:${dur.toFixed(3)},\n/s${i}.ts\n`; });
    list += '#EXT-X-ENDLIST\n';
    await ffmpeg.writeFile('local.m3u8', list);
    const output = 'out.mp4';
    await ffmpeg.exec(['-i', 'local.m3u8', '-c', 'copy', '-movflags', '+faststart', output]);
    const data = await ffmpeg.readFile(output);
    const blobUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const name = `${sanitizeTitle(ctx.title || 'video')}.mp4`;
    try {
      const downloadId = await chrome.downloads.download({ url: blobUrl, filename: name, saveAs: false });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        chrome.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(blobUrl);
      };
      const onChanged = change => {
        if (change.id !== downloadId || !change.state?.current) return;
        release();
      };
      chrome.downloads.onChanged.addListener(onChanged);
      // A tiny download can finish before the listener is installed.
      chrome.downloads.search({ id: downloadId }).then(([current]) => {
        if (current?.state === 'complete' || current?.state === 'interrupted') release();
      }).catch(() => {});
    } catch (e) {
      URL.revokeObjectURL(blobUrl);
      throw e;
    }
    // 导出成功不删除缓存：缓存只在本标签页真正关闭时清理（tabs.onRemoved）
    toast(skipTotal ? `已导出（跳过 ${skipTotal} 个失效分片，对应时间点会跳跃）` : '已导出到浏览器下载目录');
  } catch (e) {
    logger.error('player', 'export failed', e && e.message);
    toast('导出失败：' + (e && e.message || e));
    $('exportBtn').disabled = false;
  } finally {
    ffmpeg.terminate();
  }
}

// ── 工具 ──
function fmt(s) {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
}
function toast(t) {
  const el = $('toast');
  el.textContent = t; el.classList.add('show');
  clearTimeout(el.__t); el.__t = setTimeout(() => el.classList.remove('show'), 2400);
}
function onHlsError(evt, data) {
  if (data && data.fatal) {
    logger.error('player', 'HLS playback failed', data.type, data.details, data.error?.message);
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls && hls.startLoad(); }
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls && hls.recoverMediaError(); }
    else { showError('播放出错：' + (data.details || '未知')); hls && hls.destroy(); }
  }
}
function showError(msg) {
  $('errorMsg').textContent = msg; $('error').hidden = false; $('loading').style.display = 'none'; $('status').textContent = '出错';
}
$('retry').addEventListener('click', () => location.reload());
