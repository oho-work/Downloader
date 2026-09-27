// background/sniffer.js
// m3u8 嗅探：webRequest 观察模式捕获 + 轻量校验 + 分级推荐 + 归档
import { parsePlaylist } from './m3u8-parser.js';
import { captureHeaders, getSession } from './session.js';
import { absolutize, domainOf } from '../utils/id.js';
import { logger } from '../utils/logger.js';

// tabId -> Map<url, stream>（内存缓存，快速读）
const tabStreams = new Map();

const STORE_PREFIX = 'streams:';

// ── 嗅探主通道：捕获 m3u8 请求 URL ──
function onRequest(details) {
  if (!details.url.includes('.m3u8')) return;
  const tabId = details.tabId;
  if (tabId < 0) return; // 非页面请求（如 SW 自身）忽略
  enqueue(tabId, details.url);
}

// ── 捕获请求头上下文（Cookie/UA/Referer）──
function onSendHeaders(details) {
  captureHeaders(details.tabId, details.requestId, details.requestHeaders);
}

function enqueue(tabId, url) {
  const list = tabStreams.get(tabId) || new Map();
  if (list.has(url)) return; // 去重
  const headers = getSession(tabId);
  const entry = { url, headers: headers || null, firstSeen: Date.now(), checked: false };
  list.set(url, entry);
  tabStreams.set(tabId, list);
  // 异步校验（不阻塞监听）
  verify(tabId, entry).then(() => persist(tabId));
}

// ── 轻量校验：GET 清单文本，解析判定有效性与流类型 ──
async function verify(tabId, entry) {
  try {
    const headers = entry.headers || {};
    const res = await fetch(entry.url, { method: 'GET', headers, cache: 'no-store' });
    if (!res.ok) { entry.valid = false; return; }
    const text = await res.text();
    if (!text.startsWith('#EXTM3U')) { entry.valid = false; return; }
    const p = parsePlaylist(text, entry.url);
    // 仅支持点播（VOD）：直播流不嗅探、不展示、不通知
    if (p.live) { entry.live = true; entry.valid = false; return; }
    entry.valid = true;
    entry.isMaster = p.isMaster;
    entry.live = p.live;
    entry.encrypted = p.encrypted;
    entry.segmentCount = p.segments.length;
    entry.totalDuration = p.totalDuration;
    entry.domain = domainOf(entry.url);
    // 推荐评分：分片非空优先
    entry.rank = 3 + (p.segments.length > 0 ? 1 : 0);
    entry.checked = true;
    logger.info('sniffer', `verified ${entry.url} live=${p.live} segs=${p.segments.length}`);
    // 通知内容脚本显示浮窗
    notifyContent(tabId, entry);
  } catch (e) {
    entry.valid = false;
    logger.warn('sniffer', 'verify failed', entry.url, e && e.message);
  }
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
async function persist(tabId) {
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
  await chrome.storage.local.set({ [key]: arr });
  // 去掉 headers（storage 里不存敏感 Cookie，播放会话时由 SW 内存提供）
  const publicArr = arr.map(({ headers, ...rest }) => rest);
  await chrome.storage.local.set({ [key + ':pub']: publicArr });
}

// ── 对外查询 ──
export async function listStreams(tabId) {
  const { [STORE_PREFIX + tabId + ':pub']: pub } = await chrome.storage.local.get([STORE_PREFIX + tabId + ':pub']);
  return pub || [];
}

export function registerSniffer() {
  chrome.webRequest.onBeforeRequest.addListener(onRequest, { urls: ['<all_urls>'] });
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onSendHeaders,
    { urls: ['<all_urls>'] },
    ['requestHeaders']
  );
  logger.info('sniffer', 'webRequest listeners registered');
}

export function clearTab(tabId) {
  tabStreams.delete(tabId);
}

// 内容脚本兜底嗅探上报入口
export function ingestContentStream(tabId, url) {
  if (!url || !url.includes('.m3u8') || tabId == null) return;
  enqueue(tabId, url);
}
