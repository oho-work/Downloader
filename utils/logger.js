// utils/logger.js
// 分级日志：控制台输出 + 内存环形缓冲（可后续落 IndexedDB）

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold = LEVELS.info; // Phase 6 改为可配置
const ring = [];
const RING_MAX = 500;

function log(level, tag, ...args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${tag}`;
  if (level === 'error') console.error(line, ...args);
  else if (level === 'warn') console.warn(line, ...args);
  else console.log(line, ...args);
  ring.push({ ts, level, tag, msg: args.map(a => typeof a === 'string' ? a : safeJson(a)).join(' ') });
  if (ring.length > RING_MAX) ring.shift();
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const logger = {
  debug: (tag, ...a) => log('debug', tag, ...a),
  info: (tag, ...a) => log('info', tag, ...a),
  warn: (tag, ...a) => log('warn', tag, ...a),
  error: (tag, ...a) => log('error', tag, ...a),
  dump: () => ring.slice(),
  setLevel: (l) => { if (LEVELS[l] !== undefined) threshold = LEVELS[l]; },
};
