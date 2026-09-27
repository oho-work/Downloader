// background/session.js
// 请求上下文（Cookie/UA/Referer 等）捕获与按 tab 绑定
// Request headers stay in memory and expire after ten minutes.

import { extractQueryHeaders } from '../utils/id.js';

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
