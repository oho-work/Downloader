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
    this.children = new Map();
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
    };
  }
  addEventListener(type, handler) { if (type === 'click') this.handlers.push(handler); }
  async click() { for (const handler of this.handlers) await handler({ currentTarget: this }); }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  append() {}
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
