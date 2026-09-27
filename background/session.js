// background/session.js
// 请求上下文（Cookie/UA/Referer 等）捕获与按 tab 绑定
// Phase 1：内存暂存；Phase 2 起落 IndexedDB 以保证 SW 休眠后不丢。

import { extractQueryHeaders } from '../utils/id.js';
import { logger } from '../utils/logger.js';

// tabId -> { 最近一个请求的 headers, 更新时间 }
const sessionMap = new Map();

// 记录某次 m3u8/ts 请求的请求头，绑定到 tab
export function captureHeaders(tabId, requestId, requestHeaders) {
  if (tabId == null || tabId < 0) return;
  const headers = extractQueryHeaders(requestHeaders);
  if (!Object.keys(headers).length) return;
  // 用 tabId 聚合最新一组（同一会话通常共用同一套请求头）
  sessionMap.set(tabId, { headers, requestId, at: Date.now() });
}

export function getSession(tabId) {
  const s = sessionMap.get(tabId);
  return s ? s.headers : null;
}

export function bindSession(tabId, headers) {
  sessionMap.set(tabId, { headers, at: Date.now() });
}

// 清理失效会话（tab 关闭）
export function clearSession(tabId) {
  sessionMap.delete(tabId);
}

export function purgeExpired(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of sessionMap) {
    if (now - v.at > maxAgeMs) sessionMap.delete(k);
  }
}

export function sessionStats() {
  return sessionMap.size;
}
