const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createCipheriv } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function boot({ sendMessage, getMeta, getSegment } = {}) {
  const messages = [];
  const cacheReads = [];
  const context = vm.createContext({ URL, Uint8Array, TextEncoder, performance, setTimeout });
  const imports = {
    '../background/cache-store.js': {
      getMeta: async id => {
        cacheReads.push(['meta', id]);
        return getMeta ? getMeta(id) : { segments: [] };
      },
      getSegment: async (id, idx) => {
        cacheReads.push(['segment', id, idx]);
        return getSegment ? getSegment(id, idx) : undefined;
      },
    },
    '../utils/logger.js': { logger: { error() {}, warn() {}, info() {} } },
    '../utils/id.js': { diagnosticUrl: url => url },
    '../utils/runtime-message.js': {
      runtimeAvailable: () => true,
      sendRuntimeMessage: async message => {
        messages.push(message);
        return sendMessage ? sendMessage(message) : { ok: false, error: 'unexpected request' };
      },
    },
  };
  const source = readFileSync(path.join(__dirname, '..', 'player/hls-loader.js'), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, `unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const loader = new module.namespace.HlsCacheLoader('video-one');
  const calls = { success: [], error: [], abort: [] };
  const callbacks = {
    onSuccess: (...args) => calls.success.push(args),
    onError: (...args) => calls.error.push(args),
    onAbort: (...args) => calls.abort.push(args),
  };
  return { loader, messages, cacheReads, calls, callbacks };
}

test('bundled hls.js keyInfo context fetches a key without registering a segment', async () => {
  const key = Array.from({ length: 16 }, (_, i) => i);
  const { loader, messages, cacheReads, calls, callbacks } = await boot({
    sendMessage: () => ({ ok: true, key }),
  });
  // The bundled KeyLoader does not provide a type field for AES keys.
  const context = {
    keyInfo: { decryptdata: { method: 'AES-128' } },
    frag: { sn: 0 }, responseType: 'arraybuffer', url: 'https://example.com/enc.key',
  };
  const originalStats = loader.stats;
  loader.load(context, {}, callbacks);
  await settle();
  assert.deepEqual(messages.map(message => message.type), ['GET_KEY']);
  assert.equal(messages[0].videoId, 'video-one');
  assert.equal(messages[0].uri, context.url);
  assert.deepEqual(cacheReads, []);
  assert.equal(calls.error.length, 0);
  assert.equal(calls.success.length, 1);
  const [response, stats, receivedContext] = calls.success[0];
  assert.equal(response.url, context.url);
  assert.deepEqual(Array.from(new Uint8Array(response.data)), key);
  assert.equal(stats, originalStats);
  assert.equal(stats.loaded, 16);
  assert.equal(stats.total, 16);
  assert.equal(receivedContext, context);
});

test('level and text contexts fetch manifests and preserve the final response URL', async () => {
  for (const shape of [{ type: 'level' }, { responseType: 'text' }]) {
    const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n';
    const finalUrl = 'https://cdn.example.com/redirected/child.m3u8';
    const { loader, messages, cacheReads, calls, callbacks } = await boot({
      sendMessage: () => ({ ok: true, text, url: finalUrl }),
    });
    const context = { ...shape, url: 'https://example.com/child.m3u8' };
    loader.load(context, {}, callbacks);
    await settle();
    assert.deepEqual(messages.map(message => message.type), ['GET_MANIFEST']);
    assert.deepEqual(cacheReads, []);
    assert.equal(calls.error.length, 0);
    assert.equal(calls.success.length, 1);
    const [response, stats, receivedContext] = calls.success[0];
    assert.equal(response.url, finalUrl);
    assert.equal(response.data, text);
    assert.equal(stats.loaded, new TextEncoder().encode(text).byteLength);
    assert.equal(receivedContext, context);
  }
});

test('key and playlist errors follow the bundled hls.js onError signature', async () => {
  for (const shape of [{ keyInfo: {}, responseType: 'arraybuffer' }, { type: 'level', responseType: 'text' }]) {
    const { loader, calls, callbacks } = await boot({ sendMessage: () => ({ ok: false, error: 'HTTP 403' }) });
    const context = { ...shape, url: 'https://example.com/resource' };
    loader.load(context, {}, callbacks);
    await settle();
    assert.equal(calls.success.length, 0);
    assert.equal(calls.error.length, 1);
    const [error, receivedContext, networkDetails, stats] = calls.error[0];
    assert.match(error.text, /HTTP 403/);
    assert.equal(receivedContext, context);
    assert.equal(networkDetails, undefined);
    assert.equal(stats, loader.stats);
  }
});

test('AES-128 keys with a non-16-byte body fail before playback', async () => {
  for (const length of [0, 15, 17]) {
    const { loader, messages, calls, callbacks } = await boot({
      sendMessage: () => ({ ok: true, key: new Array(length).fill(1) }),
    });
    const context = { keyInfo: {}, responseType: 'arraybuffer', url: 'https://example.com/enc.key' };
    loader.load(context, {}, callbacks);
    await settle();
    assert.deepEqual(messages.map(message => message.type), ['GET_KEY']);
    assert.equal(calls.success.length, 0);
    assert.equal(calls.error.length, 1);
    assert.match(calls.error[0][0].text, /16/);
    assert.equal(calls.error[0][1], context);
    assert.equal(calls.error[0][3], loader.stats);
  }
});

test('abort and destroy suppress late key or manifest responses', async () => {
  for (const action of ['abort', 'destroy']) {
    for (const shape of [{ keyInfo: {}, responseType: 'arraybuffer' }, { type: 'level', responseType: 'text' }]) {
      const response = deferred();
      const { loader, calls, callbacks } = await boot({ sendMessage: () => response.promise });
      const context = { ...shape, url: 'https://example.com/resource' };
      loader.load(context, {}, callbacks);
      loader[action]();
      response.resolve({ ok: true, key: new Array(16).fill(0), text: '#EXTM3U' });
      await settle();
      assert.equal(calls.success.length, 0);
      assert.equal(calls.error.length, 0);
      assert.equal(loader.stats.aborted, true);
      assert.equal(calls.abort.length, action === 'abort' ? 1 : 0);
      if (action === 'abort') {
        assert.equal(calls.abort[0][0], loader.stats);
        assert.equal(calls.abort[0][1], context);
      }
    }
  }
});

test('a destroyed loader reports the context and stats when asked to load again', async () => {
  const { loader, messages, calls, callbacks } = await boot();
  const context = { type: 'manifest', responseType: 'text', url: 'https://example.com/video.m3u8' };
  loader.destroy();
  loader.load(context, {}, callbacks);
  assert.deepEqual(messages, []);
  assert.equal(calls.error.length, 1);
  assert.equal(calls.error[0][1], context);
  assert.equal(calls.error[0][3], loader.stats);
});

test('cached encrypted media is returned intact for hls.js to decrypt exactly once', async () => {
  const plain = Buffer.alloc(188 * 3);
  plain[0] = plain[188] = plain[376] = 0x47;
  const cipher = createCipheriv('aes-128-cbc', Buffer.alloc(16, 7), Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const buffer = encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength);
  const url = 'https://example.com/segment0.ts';
  const { loader, messages, cacheReads, calls, callbacks } = await boot({
    getMeta: () => ({ segments: [{ idx: 9, url, key: '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"' }] }),
    getSegment: () => ({ buffer }),
  });
  const context = { responseType: 'arraybuffer', url, frag: { sn: 0 } };
  loader.load(context, {}, callbacks);
  await settle();
  assert.deepEqual(messages, []);
  assert.deepEqual(cacheReads, [['meta', 'video-one'], ['segment', 'video-one', 9]]);
  assert.equal(calls.error.length, 0);
  assert.equal(calls.success.length, 1);
  assert.equal(calls.success[0][0].data, buffer);
  assert.deepEqual(Buffer.from(calls.success[0][0].data), encrypted);
  assert.equal(calls.success[0][1].loaded, encrypted.byteLength);
  assert.equal(calls.success[0][2], context);
});

test('segment cache failures use the same onError argument order as network failures', async () => {
  const { loader, calls, callbacks } = await boot({ getMeta: () => { throw new Error('database unavailable'); } });
  const context = { responseType: 'arraybuffer', url: 'https://example.com/segment0.ts', frag: { sn: 0 } };
  loader.load(context, {}, callbacks);
  await settle();
  assert.equal(calls.success.length, 0);
  assert.equal(calls.error.length, 1);
  assert.match(calls.error[0][0].text, /database unavailable/);
  assert.equal(calls.error[0][1], context);
  assert.equal(calls.error[0][3], loader.stats);
});
