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
  return { metas: new Map(), session: new Map(), tabs: new Map(), deletedSegments: [], nextTabId: 30 };
}

async function boot(state) {
  const listeners = {};
  const tasks = new Map();
  const scheduler = {
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
  const context = vm.createContext({ chrome, URL, fetch: async () => ({ ok: true, text: async () => '#EXTM3U' }) });
  const imports = {
    './sniffer.js': {
      registerSniffer() {}, listStreams: async () => [], clearTab: async () => {},
      ingestContentStream() {}, setSniffEnabled() {},
    },
    './session.js': { getSession: () => undefined, clearSession() {}, purgeExpired() {}, bindSession() {} },
    './m3u8-parser.js': { parsePlaylist: () => ({
      live: false, isMaster: false, encrypted: false, totalDuration: 10,
      segments: [{ idx: 0, url: 'https://cdn.example.com/0.ts', duration: 10, start: 0 }],
    }) },
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
      saveSettings: async () => {}, getSettings: async () => ({}),
      SEG_STATE: { PENDING, DOWNLOADING: 1, DONE, FAILED: 3 },
    },
    '../utils/id.js': {
      videoIdFor: () => 'v1', sanitizeTitle: title => title,
      domainOf: () => 'cdn.example.com', diagnosticUrl: url => url || '',
    },
    '../utils/logger.js': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  };
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, `unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  await settle();
  return {
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
