const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = (file) => readFileSync(path.join(__dirname, '..', file), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.handlers = [];
    this.appended = [];
    this.children = new Map();
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
    };
  }
  addEventListener(type, handler) { if (type === 'click') this.handlers.push(handler); }
  async click() { for (const handler of this.handlers) await handler({ currentTarget: this, stopPropagation() {} }); }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  append(child) { this.appended.push(child); }
  attachShadow() { return new Element(); }
}

test('clear acts on the selected view without switching tabs or deleting the other data', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const sniffTab = new Element(); sniffTab.dataset.view = 'sniff';
  const cacheTab = new Element(); cacheTab.dataset.view = 'cache';
  const messages = [];
  vm.runInNewContext(source('popup/popup.js'), {
    document: {
      getElementById: get,
      querySelectorAll: selector => selector === '.tab[data-view]'
        ? [sniffTab, cacheTab] : [sniffTab, cacheTab, get('clearBtn')],
    },
    chrome: {
      tabs: { query: async () => [{ id: 7, url: 'https://example.com/watch' }] },
      runtime: { sendMessage: async msg => {
        messages.push(msg);
        return { ok: true, streams: [], videos: [] };
      } },
    },
    alert: error => assert.fail(error),
  });
  await settle();
  messages.length = 0;
  await get('clearBtn').click();
  assert.deepEqual(messages.map(m => m.type), ['CLEAR_SNIFF', 'LIST_STREAMS']);
  assert.equal(messages[0].tabId, 7);
  await cacheTab.click();
  await settle();
  messages.length = 0;
  await get('clearBtn').click();
  assert.deepEqual(messages.map(m => m.type), ['CLEAR_CACHE', 'LIST_CACHED']);
  await sniffTab.click();
  await settle();
  messages.length = 0;
  await get('clearBtn').click();
  assert.deepEqual(messages.map(m => m.type), ['CLEAR_SNIFF', 'LIST_STREAMS']);
});

test('deleting one cached item sends its id and refreshes only the cache view', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const sniffTab = new Element(); sniffTab.dataset.view = 'sniff';
  const cacheTab = new Element(); cacheTab.dataset.view = 'cache';
  const messages = [];
  const videos = [{ videoId: 'v-one', title: 'First', segmentCount: 2, done: 1 }];
  vm.runInNewContext(source('popup/popup.js'), {
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => [sniffTab, cacheTab],
    },
    chrome: {
      tabs: { query: async () => [{ id: 7, url: 'https://example.com/watch' }] },
      runtime: { sendMessage: async msg => {
        messages.push(msg);
        if (msg.type === 'LIST_CACHED') return { ok: true, videos };
        return { ok: true, streams: [] };
      } },
    },
    alert: error => assert.fail(error),
  });
  await settle();
  await cacheTab.click();
  await settle();
  messages.length = 0;
  const item = get('list').appended.at(-1);
  await item.querySelector('.delete-btn').click();
  assert.deepEqual(messages.map(m => m.type), ['DELETE_CACHE', 'LIST_CACHED']);
  assert.equal(messages[0].videoId, 'v-one');
});

async function loadSniffer(fetch, set = async () => {}) {
  const context = vm.createContext({
    URL, fetch,
    chrome: {
      storage: { local: { get: async () => ({}), set, remove: async () => {} } },
      tabs: { sendMessage: async () => {} },
    },
  });
  const mod = new vm.SourceTextModule(source('background/sniffer.js'), { context });
  const mocks = {
    './m3u8-parser.js': { parsePlaylist: () => ({ live: false, segments: [{}], totalDuration: 10 }) },
    './session.js': { captureHeaders() {}, getSession: () => ({ Referer: 'private' }) },
    '../utils/id.js': { absolutize() {}, domainOf: () => 'cdn.example.com', diagnosticUrl: value => value || '' },
    '../utils/logger.js': { logger: { info() {}, warn() {}, debug() {} } },
  };
  await mod.link(specifier => {
    const values = mocks[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  return mod.namespace;
}

test('reload can retrieve verified streams before storage finishes, scoped to the page', async () => {
  let finishWrite;
  const writing = new Promise(resolve => { finishWrite = resolve; });
  const sniffer = await loadSniffer(async () => ({ ok: true, text: async () => '#EXTM3U' }), () => writing);
  const page = 'https://example.com/watch';
  const url = 'https://cdn.example.com/video.m3u8';
  sniffer.ingestContentStream(7, url, page);
  await settle();
  const streams = await sniffer.listStreams(7, page + '#slide');
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, url);
  assert.equal('headers' in streams[0], false);
  assert.equal((await sniffer.listStreams(7, 'https://example.com/other')).length, 0);
  finishWrite();
  await sniffer.clearTab(7, 'test clear');
  assert.equal((await sniffer.listStreams(7, page)).length, 0);
});

test('a later request retries a playlist whose previous verification failed', async () => {
  let attempts = 0;
  const sniffer = await loadSniffer(async () => ({
    ok: ++attempts > 1, status: 503, text: async () => '#EXTM3U',
  }));
  const page = 'https://example.com/watch';
  const url = 'https://cdn.example.com/video.m3u8';
  sniffer.ingestContentStream(7, url, page);
  await settle();
  assert.equal((await sniffer.listStreams(7, page)).length, 0);
  sniffer.ingestContentStream(7, url, page);
  await settle();
  assert.equal((await sniffer.listStreams(7, page)).length, 1);
  assert.equal(attempts, 2);
});

test('a page navigation discards late verification from the previous page', async () => {
  let resolveOld;
  const oldFetch = new Promise(resolve => { resolveOld = resolve; });
  const sniffer = await loadSniffer(url => url.includes('old.m3u8')
    ? oldFetch
    : Promise.resolve({ ok: true, text: async () => '#EXTM3U' }));
  sniffer.ingestContentStream(7, 'https://cdn.example.com/old.m3u8', 'https://example.com/old');
  sniffer.ingestContentStream(7, 'https://cdn.example.com/new.m3u8', 'https://example.com/new');
  resolveOld({ ok: true, text: async () => '#EXTM3U' });
  await settle();
  assert.deepEqual(Array.from(await sniffer.listStreams(7, 'https://example.com/new'), s => s.url),
    ['https://cdn.example.com/new.m3u8']);
  assert.equal((await sniffer.listStreams(7, 'https://example.com/old')).length, 0);
});

test('a newly injected content script restores the detected-stream popup on reload', async () => {
  const cards = [];
  const messages = [];
  vm.runInNewContext(source('content/content.js'), {
    window: {},
    document: {
      documentElement: new Element(),
      createElement: () => { const el = new Element(); cards.push(el); return el; },
    },
    chrome: { runtime: {
      onMessage: { addListener() {} },
      sendMessage: async msg => {
        messages.push(msg.type);
        return { ok: true, streams: [{ url: 'https://cdn.example.com/video.m3u8' }] };
      },
    } },
    setTimeout: () => 1,
    clearTimeout() {},
  });
  await settle();
  assert.deepEqual(messages, ['CONTENT_READY']);
  const card = cards.find(el => el.className === 'card');
  assert.ok(card.classes.has('show'));
  assert.equal(card.__streamUrl, 'https://cdn.example.com/video.m3u8');
});
