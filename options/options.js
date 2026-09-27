// options/options.js
// 全局设置页：经 SW 消息读写 IndexedDB 设置（MV3 禁内联脚本，故独立文件）
const DEFAULTS = { sniffEnabled: true, maxConcurrent: 16, timeoutMs: 30000, maxRetry: 5, seekBefore: 3, seekAfter: 7, playAhead: 10, folderFromTitle: true, cleanAfter: true, format: 'mp4' };
const NUM = ['maxConcurrent', 'timeoutMs', 'maxRetry', 'seekBefore', 'seekAfter', 'playAhead'];
const BOOL = ['sniffEnabled', 'folderFromTitle', 'cleanAfter'];
const SEL = ['format'];
// timeoutMs 内部以毫秒存储，设置页按「秒」展示/输入
const MSEC = new Set(['timeoutMs']);

async function load() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const s = { ...DEFAULTS, ...((r && r.ok && r.settings) || {}) };
  BOOL.forEach(k => { document.getElementById(k).checked = !!s[k]; });
  NUM.forEach(k => { document.getElementById(k).value = MSEC.has(k) ? Math.round(s[k] / 1000) : s[k]; });
  SEL.forEach(k => { document.getElementById(k).value = s[k] || DEFAULTS[k]; });
}

function collect() {
  const out = {};
  BOOL.forEach(k => { out[k] = !!document.getElementById(k).checked; });
  NUM.forEach(k => { const v = Number(document.getElementById(k).value); out[k] = MSEC.has(k) ? v * 1000 : v; });
  SEL.forEach(k => { out[k] = document.getElementById(k).value; });
  return out;
}

function toast() {
  const t = document.getElementById('toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

document.getElementById('save').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: collect() });
  toast();
};
document.getElementById('reset').onclick = async () => {
  BOOL.forEach(k => { document.getElementById(k).checked = DEFAULTS[k]; });
  NUM.forEach(k => { document.getElementById(k).value = MSEC.has(k) ? Math.round(DEFAULTS[k] / 1000) : DEFAULTS[k]; });
  SEL.forEach(k => { document.getElementById(k).value = DEFAULTS[k]; });
  await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ...DEFAULTS } });
  toast();
};

load();
