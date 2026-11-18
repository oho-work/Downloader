const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('popup loads, saves and resets download proxy settings, showing save failures', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', checked: false, textContent: '', dataset: {}, handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      async click() { await this.handlers.click?.(); },
    });
    return nodes.get(id);
  };
  const messages = [];
  let saveFails = false;
  vm.runInNewContext(readFileSync(path.join(__dirname, '..', 'popup/popup.js'), 'utf8'), {
    document: { getElementById: get, querySelectorAll: () => [] },
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/watch' }] },
      runtime: { getManifest: () => ({ version: '1.0.1' }), sendMessage: async msg => {
        messages.push(msg);
        if (msg.type === 'GET_SETTINGS') return { ok: true, settings: { downloadProxyEnabled: true, downloadProxyUrl: 'socks5://127.0.0.1:1080', downloadRelayUrl: 'http://127.0.0.1:17892' } };
        if (msg.type === 'SAVE_SETTINGS' && saveFails) return { ok: false, error: '代理地址格式无效' };
        return { ok: true, streams: [] };
      } },
    },
    setTimeout() {},
  });
  await get('settingsBtn').click();
  assert.equal(get('downloadProxyEnabled').checked, true);
  assert.equal(get('downloadProxyUrl').value, 'socks5://127.0.0.1:1080');
  assert.equal(get('downloadProxyUrl').disabled, false);
  assert.equal(get('relaySettings').hidden, false);
  assert.equal(get('downloadRelayUrl').value, 'http://127.0.0.1:17892');
  get('downloadProxyUrl').value = ' http://127.0.0.1:7890 ';
  get('downloadRelayUrl').value = ' http://127.0.0.1:17893 ';
  await get('saveSettings').click();
  const saved = messages.filter(msg => msg.type === 'SAVE_SETTINGS').at(-1).settings;
  assert.equal(saved.downloadProxyEnabled, true);
  assert.equal(saved.downloadProxyUrl, 'http://127.0.0.1:7890');
  assert.equal(saved.downloadRelayUrl, 'http://127.0.0.1:17893');
  saveFails = true;
  await get('saveSettings').click();
  assert.equal(get('settingsError').textContent, '代理地址格式无效');
  assert.equal(get('settingsError').hidden, false);
  assert.equal(get('saveSettings').disabled, false);
  saveFails = false;
  await get('resetSettings').click();
  assert.equal(get('downloadProxyEnabled').checked, false);
  assert.equal(get('downloadProxyUrl').value, '');
  assert.equal(get('downloadProxyUrl').disabled, true);
  assert.equal(get('relaySettings').hidden, true);
  assert.equal(get('downloadRelayUrl').value, 'http://127.0.0.1:17891');
});
