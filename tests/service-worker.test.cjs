const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '..', 'background/service-worker.js'), 'utf8');
const DONE = 2;
const PENDING = 0;
const clone = value => structuredClone(value);
const settle = () => new Promise(resolve => setImmediate(resolve));

function makeState() {
  return { metas: new Map(), session: new Map(), tabs: new Map(), deletedSegments: [], nextTabId: 30, settings: {} };
}

async function boot(state, options = {}) {
  const listeners = {};
  const tasks = new Map();
  const events = [];
  const networkConfigurations = [];
  const scheduler = {
    registry: tasks,
    running: new Map(),
    getTask: id => tasks.get(id),
    register: (id, task) => tasks.set(id, task),
    unregister: id => tasks.delete(id),
    cancelAll() {},
    recover: async () => {},
    refreshM3u8: async () => {},
    enqueueFull() {},
    enqueue() {},
    setConcurrency() {},
    startWatchdog() {},
    startSpeedTicker() {},
  };
  const session = {
    get: async keys => {
      const names = keys == null ? [...state.session.keys()] :
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(names.filter(k => state.session.has(k)).map(k => [k, clone(state.session.get(k))]));
    },
    set: async values => {
      for (const [key, value] of Object.entries(values)) state.session.set(key, clone(value));
    },
    remove: async keys => {
      for (const key of Array.isArray(keys) ? keys : [keys]) state.session.delete(key);
    },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener: handler => { listeners.message = handler; } },
      onInstalled: { addListener() {} },
      getURL: file => 'chrome-extension://test/' + file,
    },
    tabs: {
      create: async ({ url }) => {
        const tab = { id: ++state.nextTabId, url };
        state.tabs.set(tab.id, tab);
        return tab;
      },
      query: async () => [...state.tabs.values()],
      onRemoved: { addListener: handler => { listeners.removed = handler; } },
      onUpdated: { addListener: handler => { listeners.updated = handler; } },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: { session },
  };
  const context = vm.createContext({
    chrome, URL, AbortController, setTimeout, clearTimeout,
    fetch: options.fetch || (async () => ({
      ok: true,
      text: async () => '#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n',
    })),
  });
  const networkModule = new vm.SourceTextModule(readFileSync(path.join(__dirname, '..', 'background/network.js'), 'utf8'), { context });
  await networkModule.link(specifier => {
    assert.equal(specifier, './cache-store.js');
    return new vm.SyntheticModule(['getSettings'], function () { this.setExport('getSettings', async () => clone(state.settings)); }, { context });
  });
  await networkModule.evaluate();
  const imports = {
    './sniffer.js': {
      registerSniffer() {}, listStreams: async () => [], clearTab: async () => {},
      ingestContentStream() {}, setSniffEnabled() {},
    },
    './session.js': { getSession: () => undefined, clearSession() {}, purgeExpired() {}, bindSession() {} },
    './network.js': {
      normalizeProxySettings: networkModule.namespace.normalizeProxySettings,
      DEFAULT_RELAY_URL: networkModule.namespace.DEFAULT_RELAY_URL,
      fetchResource: options.fetch || context.fetch,
      configureNetwork: settings => {
        events.push('configure');
        networkConfigurations.push(clone(settings));
      },
    },
    './scheduler.js': {
      scheduler, dedupe: segments => segments,
      PRIO: { URGENT: 3, SEEK: 2, AHEAD: 1, FULL: 0 },
    },
    './cache-store.js': {
      saveMeta: async meta => { state.metas.set(meta.videoId, clone(meta)); },
      getMeta: async id => clone(state.metas.get(id)),
      delMeta: async id => { state.metas.delete(id); },
      delAllSegments: async id => { state.deletedSegments.push(id); },
      listAllMeta: async () => [...state.metas.values()].map(clone),
      saveSettings: async settings => { events.push('persist'); await options.saveSettings?.(settings); state.settings = clone(settings); },
      getSettings: async () => clone(state.settings),
      SEG_STATE: { PENDING, DOWNLOADING: 1, DONE, FAILED: 3 },
    },
    '../utils/id.js': {
      videoIdFor: () => 'v1', sanitizeTitle: title => title,
      absolutize: (ref, base) => new URL(ref, base).href,
      domainOf: () => 'cdn.example.com', diagnosticUrl: url => url || '',
    },
    '../utils/logger.js': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  };
  const parser = new vm.SourceTextModule(readFileSync(path.join(__dirname, '..', 'background/m3u8-parser.js'), 'utf8'), { context });
  const importModule = specifier => {
    if (specifier === './m3u8-parser.js') return parser;
    const values = imports[specifier];
    assert.ok(values, `unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  };
  await parser.link(importModule);
  const module = new vm.SourceTextModule(source, { context });
  await module.link(importModule);
  await module.evaluate();
  await settle();
  return {
    events, networkConfigurations, tasks,
    request: (msg, sender = { tab: { id: 7, url: 'https://example.com/watch' } }) =>
      new Promise(resolve => listeners.message(msg, sender, resolve)),
    removeTab: tabId => {
      state.tabs.delete(tabId);
      return listeners.removed(tabId);
    },
  };
}

test('closing a player tab after a service worker restart removes its cache', async () => {
  const state = makeState();
  const firstWorker = await boot(state);
  const opened = await firstWorker.request({
    type: 'OPEN_PLAYER', stream: { url: 'https://cdn.example.com/video.m3u8' }, title: 'Video',
  });
  assert.equal(opened.ok, true);
  assert.equal(state.metas.has('v1'), true);
  const tabId = state.nextTabId;

  const restartedWorker = await boot(state);
  assert.equal(state.metas.has('v1'), true);
  await restartedWorker.removeTab(tabId);
  for (let i = 0; i < 10 && state.metas.has('v1'); i++) await settle();
  assert.equal(state.metas.has('v1'), false);
  assert.deepEqual(state.deletedSegments, ['v1']);
});

test('closing one of two player tabs keeps the shared cache until the last tab closes', async () => {
  const state = makeState();
  const worker = await boot(state);
  const stream = { url: 'https://cdn.example.com/video.m3u8' };
  assert.equal((await worker.request({ type: 'OPEN_PLAYER', stream, title: 'Video' })).ok, true);
  const firstTabId = state.nextTabId;
  assert.equal((await worker.request({ type: 'OPEN_PLAYER', stream, title: 'Video' })).ok, true);
  const secondTabId = state.nextTabId;

  await worker.removeTab(firstTabId);
  assert.equal(state.metas.has('v1'), true);
  assert.deepEqual(state.deletedSegments, []);
  await worker.removeTab(secondTabId);
  for (let i = 0; i < 10 && state.metas.has('v1'); i++) await settle();
  assert.equal(state.metas.has('v1'), false);
  assert.deepEqual(state.deletedSegments, ['v1']);
});

test('reopening the same playlist preserves completed segments', async () => {
  const state = makeState();
  state.metas.set('v1', {
    videoId: 'v1', m3u8Url: 'https://cdn.example.com/video.m3u8', title: 'Video',
    domain: 'cdn.example.com', live: false, isMaster: false, encrypted: false,
    totalDuration: 10, status: 'playing',
    segments: [{ idx: 0, url: 'https://cdn.example.com/0.ts', duration: 10, start: 0, state: DONE, size: 123 }],
  });
  state.tabs.set(30, { id: 30, url: 'chrome-extension://test/player/player.html?v=v1' });
  const worker = await boot(state);
  assert.equal(state.metas.has('v1'), true);
  const result = await worker.request({
    type: 'OPEN_PLAYER', stream: { url: 'https://cdn.example.com/video.m3u8' }, title: 'Video',
  });
  assert.equal(result.ok, true);
  assert.equal(state.metas.get('v1').segments[0].state, DONE);
  assert.equal(state.metas.get('v1').segments[0].size, 123);
});

test('saving proxy settings persists and configures only the extension network, including restart', async () => {
  const state = makeState();
  const worker = await boot(state);
  worker.events.length = 0;
  worker.tasks.set('active', { settings: { maxConcurrent: 16 } });
  const saved = await worker.request({
    type: 'SAVE_SETTINGS',
    settings: {
      maxConcurrent: 8, timeoutMs: 45000, maxRetry: 2, sniffEnabled: false,
      downloadProxyEnabled: true, downloadProxyUrl: '  socks5://127.0.0.1:1080  ',
      downloadRelayUrl: 'http://127.0.0.1:17892',
    },
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(worker.events, ['persist', 'configure']);
  assert.equal(state.settings.downloadProxyEnabled, true);
  assert.equal(state.settings.downloadProxyUrl, 'socks5://127.0.0.1:1080');
  assert.equal(worker.tasks.get('active').settings.maxConcurrent, 8);
  const restarted = await boot(state);
  const loaded = await restarted.request({ type: 'GET_SETTINGS' });
  assert.equal(loaded.settings.downloadProxyEnabled, true);
  assert.equal(loaded.settings.downloadProxyUrl, 'socks5://127.0.0.1:1080');
  assert.equal(loaded.settings.timeoutMs, 45000);
  assert.equal(loaded.settings.downloadRelayUrl, 'http://127.0.0.1:17892');
  assert.equal(restarted.networkConfigurations[0].downloadProxyEnabled, true);
});

test('invalid proxy settings and failed persistence do not change the active configuration', async () => {
  const state = makeState();
  state.settings = { downloadProxyEnabled: false, downloadProxyUrl: '', maxConcurrent: 12 };
  const before = clone(state.settings);
  const worker = await boot(state, {
    saveSettings: async () => { throw new Error('设置存储失败'); },
  });
  worker.events.length = 0;
  const invalid = await worker.request({
    type: 'SAVE_SETTINGS', settings: { downloadProxyEnabled: true, downloadProxyUrl: 'not a proxy address' },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /代理地址/);
  assert.deepEqual(worker.events, []);
  assert.deepEqual(state.settings, before);
  const failed = await worker.request({
    type: 'SAVE_SETTINGS', settings: { downloadProxyEnabled: true, downloadProxyUrl: 'http://127.0.0.1:7890' },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /存储失败/);
  assert.deepEqual(worker.events, ['persist']);
  assert.deepEqual(state.settings, before);
});

test('GET_KEY rejects invalid key lengths, retries failures and caches valid keys only in memory', async () => {
  const state = makeState();
  let keyRequests = 0;
  const key = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const worker = await boot(state, {
    fetch: async url => {
      if (url.endsWith('.key')) {
        keyRequests++;
        return { ok: true, arrayBuffer: async () => keyRequests === 1 ? new ArrayBuffer(32) : key.buffer.slice(0) };
      }
      return { ok: true, text: async () => '#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n' };
    },
  });
  assert.equal((await worker.request({ type: 'OPEN_PLAYER', stream: { url: 'https://cdn.example.com/video.m3u8' } })).ok, true);
  const request = { type: 'GET_KEY', videoId: 'v1', uri: 'https://cdn.example.com/media.key' };
  const invalid = await worker.request(request);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /16 字节/);
  const retried = await worker.request(request);
  assert.equal(retried.ok, true);
  assert.deepEqual(Array.from(retried.key), Array.from(key));
  assert.equal((await worker.request(request)).ok, true);
  assert.equal(keyRequests, 2);
  assert.equal(Object.hasOwn(state.metas.get('v1'), 'keys'), false);
  const restarted = await boot(state, {
    fetch: async () => { keyRequests++; return { ok: true, arrayBuffer: async () => key.buffer.slice(0) }; },
  });
  // Restore a task from persisted metadata; the raw key itself must be fetched again.
  assert.equal((await restarted.request({ type: 'GET_TASK_CTX', videoId: 'v1' })).ok, true);
  assert.equal((await restarted.request(request)).ok, true);
  assert.equal(keyRequests, 3);
});

test('concurrent GET_KEY requests share one in-flight fetch', async () => {
  const state = makeState();
  let keyRequests = 0;
  let finishKey;
  const pending = new Promise(resolve => { finishKey = resolve; });
  const worker = await boot(state, {
    fetch: async url => {
      if (url.endsWith('.key')) { keyRequests++; return pending; }
      return { ok: true, text: async () => '#EXTM3U\n#EXTINF:10,\n0.ts\n#EXT-X-ENDLIST\n' };
    },
  });
  await worker.request({ type: 'OPEN_PLAYER', stream: { url: 'https://cdn.example.com/video.m3u8' } });
  const message = { type: 'GET_KEY', videoId: 'v1', uri: 'https://cdn.example.com/media.key' };
  const first = worker.request(message);
  const second = worker.request(message);
  await settle();
  assert.equal(keyRequests, 1);
  finishKey({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
});

test('OPEN_PLAYER pins a redirected nested master variant and preserves media key bases', async () => {
  const state = makeState();
  const requested = [];
  const original = 'https://cdn.example.com/master.m3u8';
  const mediaUrl = 'https://segments.example.com/pinned/video.m3u8?token=ok';
  const routes = new Map([
    [original, {
      url: 'https://edge.example.com/redirect/master.m3u8',
      text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nnested/list.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1600000\nother.m3u8\n',
    }],
    ['https://edge.example.com/redirect/nested/list.m3u8', {
      url: 'https://media.example.com/redirected/level.m3u8',
      text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n../v1/index.m3u8\n',
    }],
    ['https://media.example.com/v1/index.m3u8', {
      url: mediaUrl,
      text: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:128\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/enc.key"\n#EXTINF:5,\n0.ts\n#EXTINF:5,\n1.ts\n#EXT-X-ENDLIST\n',
    }],
  ]);
  const worker = await boot(state, { fetch: async url => {
    requested.push(url);
    const route = routes.get(url);
    assert.ok(route, 'unexpected playlist request: ' + url);
    return { ok: true, url: route.url, text: async () => route.text };
  } });
  const opened = await worker.request({ type: 'OPEN_PLAYER', stream: { url: original }, title: 'Encrypted video' });
  assert.equal(opened.ok, true);
  assert.deepEqual(requested, [...routes.keys()]);
  const meta = state.metas.get('v1');
  assert.equal(meta.m3u8Url, original);
  assert.equal(meta.mediaUrl, mediaUrl);
  assert.equal(meta.isMaster, false);
  assert.equal(meta.encrypted, true);
  assert.deepEqual(meta.segments.map(segment => segment.sequence), [128, 129]);
  assert.deepEqual(meta.segments.map(segment => segment.keyBaseUrl), [mediaUrl, mediaUrl]);
  assert.equal(meta.segments[0].url, 'https://segments.example.com/pinned/0.ts');
  assert.equal(new URL('../keys/enc.key', meta.segments[0].keyBaseUrl).href, 'https://segments.example.com/keys/enc.key');
  const context = await worker.request({ type: 'GET_TASK_CTX', videoId: 'v1' });
  assert.equal(context.ctx.m3u8Url, mediaUrl);
});

test('invalid and cyclic manifests fail without creating an empty live task', async () => {
  for (const text of [
    '<html>upstream error</html>',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvideo.m3u8\n',
  ]) {
    const state = makeState();
    const worker = await boot(state, { fetch: async () => ({ ok: true, text: async () => text }) });
    const response = await worker.request({ type: 'OPEN_PLAYER', stream: { url: 'https://cdn.example.com/video.m3u8' } });
    assert.equal(response.ok, false);
    assert.equal(state.metas.size, 0);
    assert.equal(state.tabs.size, 0);
  }
});
