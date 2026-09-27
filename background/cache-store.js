// background/cache-store.js
// IndexedDB 封装：video_meta / segments / settings
// 供 SW（调度器、生命周期）与播放页（Loader 读缓存）共同使用

let db = null;
// video_meta 写串行链：updateSegState/saveMeta 读-改-整份写 并发会互相覆盖（276 分片同时完成时丢状态），
// 全部排进同一条 promise 链，保证逐个执行、无竞态
let metaWriteChain = Promise.resolve();
function withMeta(fn) {
  const p = metaWriteChain.then(fn);
  metaWriteChain = p.catch(() => {}); // 失败不打断后续
  return p;
}

export const SEG_STATE = { PENDING: 0, DOWNLOADING: 1, DONE: 2, FAILED: 3 };

function open() {
  if (db) return Promise.resolve(db);
  return new Promise((res, rej) => {
    const req = indexedDB.open('hls-cache', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('video_meta')) d.createObjectStore('video_meta', { keyPath: 'videoId' });
      if (!d.objectStoreNames.contains('segments')) d.createObjectStore('segments', { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; res(db); };
    req.onerror = () => rej(req.error);
  });
}

function tx(store, mode) {
  return open().then(d => d.transaction(store, mode).objectStore(store));
}

// ── video_meta ──
export function saveMeta(meta) {
  return withMeta(() => open().then(d => new Promise((res, rej) => {
    const s = d.transaction('video_meta', 'readwrite').objectStore('video_meta');
    s.put(meta);
    s.transaction.oncomplete = res; s.transaction.onerror = () => rej(s.transaction.error);
  })));
}
export async function getMeta(videoId) {
  const s = await tx('video_meta', 'readonly');
  return new Promise((res, rej) => { const r = s.get(videoId); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
export function updateSegState(videoId, segIdx, state, extra = {}) {
  // 整个读-改-写排进串行链，避免并发覆盖。
  // 注意：这里直接执行事务写，绝不能再调 saveMeta（saveMeta 也走 withMeta 链，
  // 嵌套进自己所在的链会等自己完成 → 死锁，导致所有下载卡死）。
  return withMeta(async () => {
    const meta = await getMeta(videoId);
    if (!meta) return;
    const seg = meta.segments.find(x => x.idx === segIdx);
    if (seg) Object.assign(seg, { state }, extra);
    await open().then(d => new Promise((res, rej) => {
      const s = d.transaction('video_meta', 'readwrite').objectStore('video_meta');
      s.put(meta);
      s.transaction.oncomplete = res; s.transaction.onerror = () => rej(s.transaction.error);
    }));
  });
}
export async function delMeta(videoId) {
  const s = await tx('video_meta', 'readwrite');
  s.delete(videoId);
  return new Promise((res, rej) => { s.transaction.oncomplete = res; s.transaction.onerror = () => rej(s.transaction.error); });
}
export async function listAllMeta() {
  const s = await tx('video_meta', 'readonly');
  return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); });
}

// ── segments ──
export async function putSegment(videoId, segIdx, buffer) {
  const s = await tx('segments', 'readwrite');
  s.put({ id: `${videoId}:${segIdx}`, buffer, size: buffer.byteLength });
  return new Promise((res, rej) => { s.transaction.oncomplete = res; s.transaction.onerror = () => rej(s.transaction.error); });
}
export async function getSegment(videoId, segIdx) {
  const s = await tx('segments', 'readonly');
  return new Promise((res, rej) => {
    const r = s.get(`${videoId}:${segIdx}`);
    r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
  });
}
export async function delAllSegments(videoId) {
  const s = await tx('segments', 'readwrite');
  const store = s.index ? null : null;
  // 按前缀游标删除
  return new Promise((res, rej) => {
    const range = IDBKeyRange.bound(`${videoId}:`, `${videoId}:\uffff`);
    const req = s.openCursor(range);
    req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } else res(); };
    req.onerror = () => rej(req.error);
  });
}

// ── settings（独立库，避免与缓存一起被清理） ──
let setDb = null;
function openSet() {
  if (setDb) return Promise.resolve(setDb);
  return new Promise((res, rej) => {
    const req = indexedDB.open('hls-settings', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('settings')) req.result.createObjectStore('settings'); };
    req.onsuccess = () => { setDb = req.result; res(setDb); };
    req.onerror = () => rej(req.error);
  });
}
export async function saveSettings(obj) {
  const d = await openSet();
  return new Promise((res, rej) => {
    const t = d.transaction('settings', 'readwrite').objectStore('settings');
    t.put(obj, 'global');
    t.transaction.oncomplete = res; t.transaction.onerror = () => rej(t.transaction.error);
  });
}
export async function getSettings() {
  const d = await openSet();
  return new Promise((res, rej) => {
    const t = d.transaction('settings', 'readonly').objectStore('settings');
    const r = t.get('global');
    r.onsuccess = () => res(r.result || {}); r.onerror = () => rej(r.error);
  });
}
