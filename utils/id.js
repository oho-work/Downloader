// utils/id.js
// 标题清洗、URL 绝对化、域名提取、视频任务 ID 生成

// 剔除文件名字符：\ / : * ? " < > |
export function sanitizeTitle(raw) {
  const s = String(raw || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
  return s.slice(0, 120) || 'untitled';
}

// 把相对路径补全为绝对 URL（基于清单地址）
export function absolutize(ref, baseUrl) {
  try { return new URL(ref, baseUrl).href; } catch { return ref; }
}

export function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// 生成稳定的视频任务 ID：同一 m3u8 地址复用同一 ID，支持重开续缓存
export function videoIdFor(m3u8Url) {
  let h = 5381;
  const s = m3u8Url;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return 'v' + (h >>> 0).toString(36);
}

export function extractQueryHeaders(requestHeaders = []) {
  const pick = (name) => {
    const hit = requestHeaders.find(h => h.name.toLowerCase() === name);
    return hit ? hit.value : undefined;
  };
  const out = {};
  for (const k of ['Cookie', 'User-Agent', 'Referer', 'Origin', 'Accept', 'Accept-Language']) {
    const v = pick(k);
    if (v) out[k] = v;
  }
  return out;
}
