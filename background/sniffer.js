// background/sniffer.js
// m3u8 嗅探：webRequest 观察模式捕获 + 轻量校验 + 分级推荐 + 归档
import { parsePlaylist } from './m3u8-parser.js';
import { captureHeaders, getSession } from './session.js';
import { domainOf } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { fetchResource } from './network.js';

// tabId -> Map<url, stream>（内存缓存，快速读）
const tabStreams = new Map();
const tabPages = new Map();
const storageWrites = new Map();
let sniffEnabled = true;

const STORE_PREFIX = 'streams:';
function queueStorage(tabId, operation) {
  const pending = (storageWrites.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
  storageWrites.set(tabId, pending);
  pending.catch(() => {});
  pending.finally(() => { if (storageWrites.get(tabId) === pending) storageWrites.delete(tabId); }).catch(() => {});
  return pending;
}
function pageKey(url) {
  if (!url) return '';
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url); }
}

// ── 嗅探主通道：捕获 m3u8 请求 URL ──
function onRequest(details) {
  captureRequest(details).catch(e => logger.warn('sniff-diag', 'request capture failed', e?.message));
}

async function captureRequest(details) {
  if (!sniffEnabled) return;
  if (!/\.m3u8(?:$|[?#])/i.test(details.url)) return;
  const tabId = details.tabId;
  if (tabId == null || tabId < 0) return; // 非页面请求（如 SW 自身）忽略
  let tabUrl = '';
  try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch {}
  const pageUrl = pageKey(tabUrl || tabPages.get(tabId) || details.documentUrl || details.initiator || '');
  const previous = tabPages.get(tabId);
  if (pageUrl) {
    if (previous && previous !== pageUrl) clearTab(tabId, 'request owner changed');
    tabPages.set(tabId, pageUrl);
  }
  enqueue(tabId, details.url, pageUrl);
}

// ── 捕获请求头上下文（Cookie/UA/Referer）──
function onSendHeaders(details) {
  // Do not let unrelated page requests overwrite the HLS session headers.
  if (!/\.(?:m3u8|ts|m4s|mp4|key)(?:$|[?#])/i.test(details.url)) return;
  captureHeaders(details.tabId, details.requestId, details.requestHeaders);
}

function enqueue(tabId, url, pageUrl = tabPages.get(tabId) || '') {
  const list = tabStreams.get(tabId) || new Map();
  const existing = list.get(url);
  if (existing && existing.valid !== false) return;
  const headers = getSession(tabId);
  const entry = { url, pageUrl, headers: headers || null, firstSeen: Date.now(), checked: false };
  list.set(url, entry);
  tabStreams.set(tabId, list);
  // 异步校验（不阻塞监听）
  verify(tabId, entry).then(() => persist(tabId, pageUrl));
}

// ── 轻量校验：GET 清单文本，解析判定有效性与流类型 ──
async function verify(tabId, entry) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const headers = entry.headers || {};
    let url = entry.url, p, isMaster = false;
    const seen = new Set();
    for (let depth = 0; depth < 5; depth++) {
      if (seen.has(url)) { entry.valid = false; return; }
      seen.add(url);
      const res = await fetchResource(url, { method: 'GET', headers, credentials: 'include', cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) { entry.valid = false; return; }
      const text = await res.text();
      if (!text.trimStart().startsWith('#EXTM3U')) { entry.valid = false; return; }
      p = parsePlaylist(text, res.url || url);
      if (!p.isMaster) break;
      isMaster = true;
      url = p.variants[0]?.url;
      if (!url) { entry.valid = false; return; }
    }
    if (!p || p.isMaster || !p.segments.length) { entry.valid = false; return; }
    // 仅支持点播（VOD）：直播流不嗅探、不展示、不通知
    if (p.live) { entry.live = true; entry.valid = false; return; }
    entry.valid = true;
    entry.isMaster = isMaster;
    entry.live = p.live;
    entry.encrypted = p.encrypted;
    entry.segmentCount = p.segments.length;
    entry.totalDuration = p.totalDuration;
    entry.domain = domainOf(entry.url);
    // 推荐评分：分片非空优先
    entry.rank = 3 + (p.segments.length > 0 ? 1 : 0);
    entry.checked = true;
    if (tabPages.get(tabId) !== entry.pageUrl || tabStreams.get(tabId)?.get(entry.url) !== entry) return;
    // 通知内容脚本显示浮窗
    notifyContent(tabId, entry);
  } catch {
    entry.valid = false;
  } finally { clearTimeout(timer); }
}

function notifyContent(tabId, entry) {
  if (!entry.valid) return;
  const summary = {
    url: entry.url,
    domain: entry.domain,
    live: entry.live,
    encrypted: entry.encrypted,
    totalDuration: entry.totalDuration,
    isMaster: entry.isMaster,
    rank: entry.rank,
  };
  try {
    chrome.tabs.sendMessage(tabId, { type: 'STREAM_DETECTED', stream: summary }).catch(() => {});
  } catch { /* 内容脚本未就绪忽略 */ }
}

// ── 归档到 storage.local，供 popup 读取 ──
async function persist(tabId, pageUrl = tabPages.get(tabId) || '') {
  if (pageUrl && tabPages.get(tabId) !== pageUrl) {
    return;
  }
  const list = tabStreams.get(tabId);
  if (!list) return;
  const arr = [...list.values()]
    .filter(e => e.valid)
    .sort((a, b) => (b.rank || 0) - (a.rank || 0))
    .map(e => ({
      url: e.url, domain: e.domain, live: e.live, encrypted: e.encrypted,
      totalDuration: e.totalDuration, isMaster: e.isMaster, rank: e.rank,
      headers: e.headers,
    }));
  const key = STORE_PREFIX + tabId;
  // Persist only public metadata. Request headers can contain cookies and must
  // remain in the in-memory session map.
  const publicArr = arr.map(({ headers, ...rest }) => rest);
  await queueStorage(tabId, () => chrome.storage.local.set({ [key + ':pub']: publicArr, [key + ':page']: pageUrl }));
}

// ── 对外查询 ──
export async function listStreams(tabId, currentPageUrl = '') {
  const currentPage = pageKey(currentPageUrl);
  const currentStreams = tabStreams.get(tabId);
  if (currentStreams && (!currentPage || tabPages.get(tabId) === currentPage)) {
    const valid = [...currentStreams.values()]
      .filter(e => e.valid)
      .sort((a, b) => (b.rank || 0) - (a.rank || 0))
      .map(({ url, domain, live, encrypted, totalDuration, isMaster, rank }) =>
        ({ url, domain, live, encrypted, totalDuration, isMaster, rank }));
    return valid;
  }
  const keys = [STORE_PREFIX + tabId + ':pub', STORE_PREFIX + tabId + ':page'];
  const { [keys[0]]: pub, [keys[1]]: storedPage } = await chrome.storage.local.get(keys);
  if (currentPage && storedPage !== currentPage) return [];
  return pub || [];
}

export function registerSniffer() {
  chrome.webRequest.onBeforeRequest.addListener(onRequest, { urls: ['<all_urls>'] });
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onSendHeaders,
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );
}

export function clearTab(tabId, reason = 'unspecified') {
  tabStreams.delete(tabId);
  tabPages.delete(tabId);
  return queueStorage(tabId, () => chrome.storage.local.remove([STORE_PREFIX + tabId, STORE_PREFIX + tabId + ':pub', STORE_PREFIX + tabId + ':page']));
}

export function setSniffEnabled(enabled) {
  sniffEnabled = enabled !== false;
  if (!sniffEnabled) for (const tabId of tabStreams.keys()) clearTab(tabId, 'sniff disabled');
}

// 内容脚本兜底嗅探上报入口
export function ingestContentStream(tabId, url, pageUrl = '') {
  if (!sniffEnabled || !url || !/\.m3u8(?:$|[?#])/i.test(url) || tabId == null) return;
  pageUrl = pageKey(pageUrl);
  if (pageUrl) {
    const previous = tabPages.get(tabId);
    if (previous && previous !== pageUrl) clearTab(tabId, 'content owner changed');
    tabPages.set(tabId, pageUrl);
  }
  enqueue(tabId, url, pageUrl);
}
