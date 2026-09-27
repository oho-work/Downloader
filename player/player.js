// player/player.js
// 独立播放页：取任务上下文 → hls.js(自定义Loader) 播放 → Seek 预加载 → 缓存进度 → 导出 MP4
import { loaderFor } from './hls-loader.js';
import { getMeta, getSegment, SEG_STATE } from '../background/cache-store.js';
import { sanitizeTitle, diagnosticUrl } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { runtimeAvailable, sendRuntimeMessage } from '../utils/runtime-message.js';
import { FFmpeg } from '../lib/ffmpeg12/esm/index.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
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
  logger.info('player', 'boot start videoId=' + videoId);
  const r = await sendRuntimeMessage({ type: 'GET_TASK_CTX', videoId });
  logger.info('player', 'GET_TASK_CTX', r ? (r.ok ? 'ok' : 'err:' + r.error) : 'null');
  if (!r || !r.ok || !r.ctx) { showError('找不到该视频任务，请从原网页重新打开'); return; }
  ctx = r.ctx;
  metaSegs = (ctx.segments || []).slice();
  logger.info('player', 'ctx segments=' + metaSegs.length + ' live=' + ctx.live + ' domain=' + ctx.domain);

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
  logger.info('audio-diag', `start video=${videoId} hls=${window.Hls?.version || '-'} mse=${!!(window.Hls && Hls.isSupported())}`);
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({
      loader: loaderFor(videoId),
      pLoader: loaderFor(videoId),
      maxBufferLength: 60, maxMaxBufferLength: 120,
    });
    hls.on(Hls.Events.ERROR, onHlsError);
    hls.on(Hls.Events.MANIFEST_PARSED, (e, d) => {
      logger.info('audio-diag', 'manifest levels=' + JSON.stringify((d.levels || []).map(level => ({ audioCodec: level.audioCodec, videoCodec: level.videoCodec, audioGroupId: level.audioGroupId }))));
      $('status').textContent = '就绪';
    });
    hls.on(Hls.Events.BUFFER_CODECS, (e, tracks) => logger.info('audio-diag', 'buffer codecs=' + JSON.stringify(summarizeCodecs(tracks))));
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (e, data) => logger.info('audio-diag', 'audio tracks=' + JSON.stringify((data.audioTracks || []).map(track => ({ id: track.id, codec: track.audioCodec, name: track.name, lang: track.lang, channels: track.channels })))));
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (e, data) => logger.info('audio-diag', `audio track switched id=${data.id} ${mediaSnapshot()}`));
    hls.on(Hls.Events.LEVEL_SWITCHED, (e, data) => logger.info('audio-diag', `level switched level=${data.level} ${mediaSnapshot()}`));
    let lastInitCodecs = '';
    hls.on(Hls.Events.FRAG_PARSING_INIT_SEGMENT, (e, data) => {
      const codecs = JSON.stringify(summarizeCodecs(data.tracks));
      if (codecs !== lastInitCodecs) {
        lastInitCodecs = codecs;
        logger.info('audio-diag', `init segment frag=${data.frag?.sn ?? '-'} codecs=${codecs} ${mediaSnapshot()}`);
      }
    });
    logger.debug('player', 'loadSource ' + ctx.m3u8Url);
    hls.loadSource(ctx.m3u8Url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = ctx.m3u8Url;
  } else {
    showError('当前浏览器不支持 HLS 播放'); return;
  }

  video.addEventListener('playing', () => { $('loading').style.display = 'none'; $('status').textContent = '播放中'; });
  video.addEventListener('waiting', () => $('status').textContent = '缓冲中');
  for (const event of ['loadedmetadata', 'playing', 'waiting', 'stalled', 'seeking', 'seeked', 'ratechange', 'error']) {
    video.addEventListener(event, () => logger.info('audio-diag', `media ${event} ${mediaSnapshot()}`));
  }
  setInterval(() => {
    if (!video.paused && !video.ended) logger.info('audio-diag', `playback sample ${mediaSnapshot()}`);
  }, 30000);
  video.addEventListener('loadeddata', () => {
    $('status').textContent = '已连接'; $('loading').style.display = 'none';
    // 默认有声自动播放；若被浏览器拦截，回退静音自动播放，用户点喇叭即可恢复声音
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  });
}

function summarizeCodecs(tracks = {}) {
  return Object.fromEntries(Object.entries(tracks || {}).map(([kind, track]) => [kind, {
    codec: track?.codec, levelCodec: track?.levelCodec, container: track?.container,
    sampleRate: track?.metadata?.sampleRate, channels: track?.metadata?.channelCount,
  }]));
}

function mediaSnapshot() {
  const quality = video.getVideoPlaybackQuality?.();
  let buffered = '-';
  try {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
        buffered = `${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}`;
        break;
      }
    }
  } catch { buffered = '[unavailable]'; }
  return `time=${video.currentTime.toFixed(1)} rate=${video.playbackRate} muted=${video.muted} volume=${video.volume} ready=${video.readyState} network=${video.networkState} buffered=${buffered} audioTrack=${hls?.audioTrack ?? '-'} level=${hls?.currentLevel ?? '-'} dropped=${quality?.droppedVideoFrames ?? '-'} mediaError=${video.error?.code ?? '-'}`;
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
function hex16(b) {
  const u = new Uint8Array(b.slice(0, 16));
  return Array.from(u).map(x => x.toString(16).padStart(2, '0')).join(' ');
}
// ── AES-128 解密（HLS 加密流导出）──
// 缓存的是密文（hls.js 在 demux 阶段才用 key 解密，loader 拿到的是原始密文），导出前须先解密成明文 TS。
// key 由 SW 代取（带会话头、不受 CORS 限制）。解密用 WebCrypto AES-CBC（HLS 标准 PKCS7 填充）。
function hexToBytes(h) {
  const s = String(h || '').replace(/^0x/i, '');
  if (!s || s.length % 2) return new Uint8Array(16);
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
  return b;
}
function parseKeyLine(line, base) {
  const out = { uri: null, iv: null };
  if (!line) return out;
  const m = line.match(/METHOD=([^,]+)/); if (m) out.method = m[1];
  const u = line.match(/URI="([^"]*)"/);
  if (u) { const uri = u[1]; out.uri = /^https?:/i.test(uri) ? uri : new URL(uri, base).href; }
  const iv = line.match(/IV=0x([0-9a-fA-F]{32})/); if (iv) out.iv = hexToBytes('0x' + iv[1]);
  return out;
}
async function ensureDecKey(m) {
  if (m._decKeyReady) return;
  const keyLine = (m.segments || []).map(s => s && s.key).find(Boolean) || '';
  const { uri, iv } = parseKeyLine(keyLine, m.m3u8Url);
  if (!uri) throw new Error('清单无 #EXT-X-KEY 解密地址');
  const r = await sendRuntimeMessage({ type: 'GET_KEY', videoId, uri }).catch(() => null);
  if (!r || !r.ok || !r.key) throw new Error('获取解密密钥失败: ' + ((r && r.error) || 'SW 无响应'));
  const keyBytes = new Uint8Array(r.key);
  if (keyBytes.length !== 16) throw new Error('解密密钥长度异常: ' + keyBytes.length);
  m._decKey = {
    iv: iv || new Uint8Array(16),
    cryptoKey: await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']),
  };
  m._decKeyReady = true;
}
async function decryptSegment(m, buf) {
  await ensureDecKey(m);
  return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: m._decKey.iv }, m._decKey.cryptoKey, buf);
}
async function exportVideo() {
  const m = await getMeta(videoId);
  if (!m) return;
  const needDecrypt = !!m.encrypted;
  // AES-128 加密流：导出前先加载解密 key；key 失败则明确报错（避免盲目执行又 Invalid data）
  if (needDecrypt) {
    const keyLine = (m.segments || []).map(s => s && s.key).find(Boolean) || '';
    logger.info('player', `export 加密流 encrypted=true key=${keyLine}`);
    try { await ensureDecKey(m); }
    catch (e) { logger.error('player', 'export 解密 key 加载失败: ' + (e && e.message || e)); toast('无法获取解密密钥：' + (e && e.message || e)); return; }
  }
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
  logger.info('player', `export 原始分片=${m.segments.length} 去重后=${uniq.length} 未完成=${notDone.length} 仍待下=${stillPending.length} 跳过=${skipped.length} 可导=${exportable.length}`);
  if (stillPending.length) { toast('尚未缓存全部分片（仍在下载 ' + stillPending.length + ' 个）'); return; }
  // 预检每个 DONE 分片的数据：加密流先解密成明文 TS；非法（防盗链 HTML/截断/解密失败）分片剔除，
  // 避免 ffmpeg 读到首个坏分片就整包失败（ErrnoError: FS error / Invalid data）
  const bad = [];
  const good = [];
  const decCache = new Map(); // idx -> 解密后的明文 buffer，写入时直接复用，避免二次解密
  for (const s of exportable) {
    let b = null;
    try {
      const g = await getSegment(videoId, s.idx);
      b = (g && g.buffer) || null;
      if (b && needDecrypt) { b = await decryptSegment(m, b); decCache.set(s.idx, b); }
    } catch (e) {
      b = null;
      logger.warn('player', `export 分片#${s.idx} 处理失败(${e && e.message || e}) 跳过`);
    }
    if (!b || !isTsLike(b)) bad.push({ idx: s.idx, url: s.url, size: b ? b.byteLength : 0, head: b ? hex16(b) : '' });
    else good.push(s);
  }
  if (bad.length) {
    logger.warn('player', `export 剔除 ${bad.length} 个非 TS 分片: ${bad.map(x => `#${x.idx} size=${x.size} head=${x.head}`).join(' | ')}`);
  }
  if (!good.length) {
    toast('缓存分片全部不是有效 TS（解密失败或防盗链内容），无法导出');
    logger.error('player', 'export 无可导出分片（全部非 TS） encrypted=' + m.encrypted);
    return;
  }
  exportable = good;
  if (skipped.length) logger.warn('player', `export 将跳过 ${skipped.length} 个失效分片: #${skipped.map(s => s.idx).join(',')}`);
  const skipTotal = skipped.length + bad.length;
  $('exportBtn').disabled = true;
  toast(skipTotal ? `正在导出（跳过 ${skipTotal} 个失效分片）…` : '正在导出，请稍候…');
  const ffmpeg = new FFmpeg();
  const ffLogs = [];
  ffmpeg.on('log', ({ message }) => ffLogs.push(message));
  try {
    logger.info('player', 'export ffmpeg.load 开始');
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('lib/ffmpeg12-core/esm/ffmpeg-core.js') });
    logger.info('player', 'export ffmpeg.load 完成');
    let totalBytes = 0;
    for (let i = 0; i < exportable.length; i++) {
      const s = exportable[i];
      const g = decCache.has(s.idx) ? { buffer: decCache.get(s.idx) } : await getSegment(videoId, s.idx);
      if (!g || !g.buffer) { logger.error('player', `export 分片缺失 idx=${s.idx} url=${diagnosticUrl(s.url)}`); throw new Error('分片数据缺失 idx=' + s.idx); }
      totalBytes += g.buffer.byteLength;
      await ffmpeg.writeFile(`s${i}.ts`, new Uint8Array(g.buffer));
      if (i % 50 === 0 || i === exportable.length - 1) logger.info('player', `export 已写入 ${i + 1}/${exportable.length} 累计 ${(totalBytes / 1048576).toFixed(1)}MB`);
    }
    const maxDur = Math.max.apply(null, exportable.map(s => s.duration && s.duration > 0 ? s.duration : 2));
    let list = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + Math.ceil(maxDur) + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n';
    // 分片用绝对路径 /sN.ts；必须带 ENDLIST 标记成点播列表，否则 ffmpeg 当直播列表解析 → Invalid data
    exportable.forEach((s, i) => { const dur = s.duration && s.duration > 0 ? s.duration : 2; list += `#EXTINF:${dur.toFixed(3)},\n/s${i}.ts\n`; });
    list += '#EXT-X-ENDLIST\n';
    await ffmpeg.writeFile('local.m3u8', list);
    logger.info('player', `export m3u8 写入 ${exportable.length} 条`);
    const output = 'out.mp4';
    await ffmpeg.exec(['-i', 'local.m3u8', '-c', 'copy', '-movflags', '+faststart', output]);
    const data = await ffmpeg.readFile(output);
    logger.info('player', `export ${output} ${data.length} bytes`);
    const blobUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const name = `${sanitizeTitle(ctx.title || 'video')}.mp4`;
    await chrome.downloads.download({ url: blobUrl, filename: name, saveAs: false });
    // 导出成功不删除缓存：缓存只在本标签页真正关闭时清理（tabs.onRemoved）
    toast(skipTotal ? `已导出（跳过 ${skipTotal} 个失效分片，对应时间点会跳跃）` : '已导出到浏览器下载目录');
  } catch (e) {
    let fsInfo = '';
    try { const names = await ffmpeg.listDir('/').catch(() => null); fsInfo = ' MEMFS根目录=' + JSON.stringify(names).slice(0, 500); } catch {}
    logger.error('player', 'export 失败: ' + (e && e.message || e) + fsInfo + ' ffLogs=' + JSON.stringify(ffLogs).slice(-1500));
    toast('导出失败：' + (e && e.message || e));
    $('exportBtn').disabled = false;
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
  logger.error('audio-diag', 'hls error type=' + (data && data.type) + ' details=' + (data && data.details) + ' fatal=' + (data && data.fatal) + ' frag=' + (data && data.frag && data.frag.sn) + ' error=' + (data && data.error?.message) + ' ' + mediaSnapshot());
  if (data && data.fatal) {
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls && hls.startLoad(); }
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls && hls.recoverMediaError(); }
    else { showError('播放出错：' + (data.details || '未知')); hls && hls.destroy(); }
  }
}
function showError(msg) {
  $('errorMsg').textContent = msg; $('error').hidden = false; $('loading').style.display = 'none'; $('status').textContent = '出错';
}
$('retry').addEventListener('click', () => location.reload());
