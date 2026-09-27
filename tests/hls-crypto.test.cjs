const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

async function load(file, globals = {}) {
  const source = readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = vm.createContext({ URL, Uint8Array, BigInt, crypto: webcrypto, ...globals });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    if (specifier !== '../utils/id.js') throw new Error(`unexpected import: ${specifier}`);
    return new vm.SyntheticModule(['absolutize'], function () {
      this.setExport('absolutize', (ref, base) => new URL(ref, base).href);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('parser preserves the media sequence for implicit HLS IVs', async () => {
  const { parsePlaylist } = await load('background/m3u8-parser.js');
  const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:258\n#EXT-X-KEY:METHOD=AES-128,URI="a.key"\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST\n';
  const parsed = parsePlaylist(playlist, 'https://example.com/video.m3u8');
  assert.deepEqual(Array.from(parsed.segments, s => s.sequence), [258, 259]);
  assert.equal(parsed.segments[0].key, '#EXT-X-KEY:METHOD=AES-128,URI="a.key"');
});

test('AES-128 export uses per-segment sequence and rotating keys', async () => {
  const { decryptHlsSegment, segmentIV } = await load('player/hls-crypto.js');
  assert.deepEqual(Array.from(segmentIV({}, 258)), [...new Array(14).fill(0), 1, 2]);

  const plain = new TextEncoder().encode('MPEG transport stream payload');
  const keys = new Map([
    ['https://example.com/a.key', webcrypto.getRandomValues(new Uint8Array(16))],
    ['https://example.com/b.key', webcrypto.getRandomValues(new Uint8Array(16))],
  ]);
  const segments = [
    { sequence: 258, key: '#EXT-X-KEY:METHOD=AES-128,URI="a.key"' },
    { sequence: 259, key: '#EXT-X-KEY:METHOD=AES-128,URI="b.key"' },
  ];
  const keyCache = new Map();
  const requested = [];
  for (const segment of segments) {
    const url = new URL(segment.key.includes('a.key') ? 'a.key' : 'b.key', 'https://example.com/video.m3u8').href;
    const cryptoKey = await webcrypto.subtle.importKey('raw', keys.get(url), 'AES-CBC', false, ['encrypt']);
    const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: segmentIV({}, segment.sequence) }, cryptoKey, plain);
    const decrypted = await decryptHlsSegment(segment, encrypted, 'https://example.com/video.m3u8', uri => {
      requested.push(uri);
      return keys.get(uri);
    }, keyCache);
    assert.deepEqual(new Uint8Array(decrypted), plain);
  }
  assert.deepEqual(requested, [...keys.keys()]);
  await assert.rejects(() => decryptHlsSegment({ key: segments[0].key }, new ArrayBuffer(16), 'https://example.com/video.m3u8', () => keys.values().next().value, keyCache), /序号/);
});
