const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const enabled = { downloadProxyEnabled: true, downloadProxyUrl: 'http://127.0.0.1:7890', downloadRelayUrl: 'http://127.0.0.1:17891' };
const remoteUrl = 'https://cdn.example.com/master.m3u8?token=private';

async function loadNetwork(options = {}) {
  const calls = [];
  let storageReads = 0;
  const context = vm.createContext({
    URL, Headers, Response,
    // Any use of the browser-wide proxy API must fail this suite.
    chrome: new Proxy({}, { get: () => assert.fail('network must not access chrome APIs') }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return options.fetch ? options.fetch(url, init) : new Response('segment', {
        headers: { 'X-HLS-Final-URL': 'https://edge.example.com/final/video.m3u8' },
      });
    },
  });
  const mod = new vm.SourceTextModule(readFileSync(path.join(__dirname, '..', 'background/network.js'), 'utf8'), { context });
  await mod.link(specifier => {
    assert.equal(specifier, './cache-store.js');
    return new vm.SyntheticModule(['getSettings'], function () {
      this.setExport('getSettings', async () => { storageReads++; return options.getSettings ? options.getSettings() : {}; });
    }, { context });
  });
  await mod.evaluate();
  return { ...mod.namespace, calls, storageReads: () => storageReads };
}

test('proxy validates supported addresses and only permits a local HTTP relay', async () => {
  const { normalizeProxySettings } = await loadNetwork();
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeProxySettings())), {
    downloadProxyEnabled: false, downloadProxyUrl: '', downloadRelayUrl: enabled.downloadRelayUrl,
  });
  for (const address of ['http://127.0.0.1:7890', 'https://proxy.example', 'socks4://proxy.example:1081', 'socks5://[::1]:1080']) {
    assert.equal(normalizeProxySettings({ ...enabled, downloadProxyUrl: ' ' + address + ' ' }).downloadProxyUrl, address);
  }
  for (const address of ['', '127.0.0.1:7890', 'ftp://localhost', 'http://user:private@localhost', 'http://localhost/path', 'http://localhost/?token=private', 'http://localhost:0']) {
    assert.throws(() => normalizeProxySettings({ ...enabled, downloadProxyUrl: address }), error => !error.message.includes('private'));
  }
  for (const downloadRelayUrl of ['https://127.0.0.1:17891', 'http://example.com:17891', 'http://localhost/path', 'http://user:private@localhost:17891', 'http://localhost:0']) {
    assert.throws(() => normalizeProxySettings({ ...enabled, downloadRelayUrl }), error => !error.message.includes('private'));
  }
});

test('direct mode preserves fetch options and never uses or changes browser proxy settings', async () => {
  const network = await loadNetwork();
  network.configureNetwork({ downloadProxyEnabled: false });
  const signal = new AbortController().signal;
  const options = { signal, headers: { Accept: '*/*' }, credentials: 'include' };
  await network.fetchResource(remoteUrl, options);
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].url, remoteUrl);
  assert.equal(network.calls[0].init, options);
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.permissions.includes('proxy'), false);
});

test('enabled requests only contact the relay and preserve streamed data and remote final URL', async () => {
  const network = await loadNetwork();
  network.configureNetwork(enabled);
  const signal = new AbortController().signal;
  const response = await network.fetchResource(remoteUrl, { signal, headers: { Referer: 'https://example.com/watch' } });
  const call = network.calls[0];
  assert.equal(call.url, enabled.downloadRelayUrl + '/fetch');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-HLS-Relay'], '1');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.signal, signal);
  assert.deepEqual(JSON.parse(call.init.body), { url: remoteUrl, proxyUrl: enabled.downloadProxyUrl, headers: { referer: 'https://example.com/watch' } });
  assert.equal(response.url, 'https://edge.example.com/final/video.m3u8');
  assert.equal(await response.text(), 'segment');
  network.configureNetwork({ downloadProxyEnabled: false });
  await network.fetchResource(remoteUrl);
  assert.equal(network.calls[1].url, remoteUrl);
});

test('startup waits for persisted settings instead of sending proxy requests direct', async () => {
  let finishRead;
  const settings = new Promise(resolve => { finishRead = resolve; });
  const network = await loadNetwork({ getSettings: () => settings });
  const first = network.fetchResource(remoteUrl);
  const second = network.fetchResource('https://cdn.example.com/enc.key');
  assert.equal(network.calls.length, 0);
  finishRead(enabled);
  await Promise.all([first, second]);
  assert.equal(network.storageReads(), 1);
  assert.ok(network.calls.every(call => call.url === enabled.downloadRelayUrl + '/fetch'));
});

test('relay failure never falls back to a direct resource request', async () => {
  for (const fetch of [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => new Response(JSON.stringify({ error: '上游代理连接失败' }), { status: 502, headers: { 'X-HLS-Relay-Error': '1' } }),
    async () => new Response('wrong service'),
  ]) {
    const network = await loadNetwork({ fetch });
    network.configureNetwork(enabled);
    await assert.rejects(network.fetchResource(remoteUrl), /本地|代理/);
    assert.equal(network.calls.length, 1);
    assert.equal(network.calls[0].url, enabled.downloadRelayUrl + '/fetch');
  }
});

test('request aborts propagate through the relay unchanged', async () => {
  const ctrl = new AbortController();
  const abort = new DOMException('aborted', 'AbortError');
  const network = await loadNetwork({ fetch: async () => { ctrl.abort(); throw abort; } });
  network.configureNetwork(enabled);
  await assert.rejects(network.fetchResource(remoteUrl, { signal: ctrl.signal }), error => error === abort);
  assert.equal(network.calls[0].init.signal, ctrl.signal);
});

test('per-request settings and configuration changes do not affect unrelated fetches', async () => {
  const network = await loadNetwork();
  network.configureNetwork(enabled);
  await network.fetchResource(remoteUrl, {}, { downloadProxyEnabled: false });
  await network.fetchResource(remoteUrl);
  assert.equal(network.calls[0].url, remoteUrl);
  assert.equal(network.calls[1].url, enabled.downloadRelayUrl + '/fetch');
});
