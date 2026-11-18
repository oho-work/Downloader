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

test('parser keeps each media playlist key base and clears METHOD=NONE', async () => {
  const { parsePlaylist } = await load('background/m3u8-parser.js');
  const base = 'https://cdn.example.com/redirected/child/video.m3u8';
  const parsed = parsePlaylist([
    '#EXTM3U', '#EXT-X-DISCONTINUITY-SEQUENCE:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="../enc.key"', '#EXTINF:2,', 'a.ts',
    '#EXT-X-DISCONTINUITY', '#EXTINF:3,', 'b.ts',
    '#EXT-X-KEY:METHOD=NONE', '#EXTINF:1,', 'c.ts', '#EXT-X-ENDLIST   ',
  ].join('\n'), base);
  assert.equal(parsed.live, false);
  assert.equal(parsed.segments[0].keyBaseUrl, base);
  assert.equal(parsed.segments[0].url, 'https://cdn.example.com/redirected/child/a.ts');
  assert.deepEqual(Array.from(parsed.segments, s => s.discontinuity), [false, true, false]);
  assert.equal(parsed.segments[2].key, null);
  assert.equal(parsed.segments[2].keyBaseUrl, null);
});

test('master playlists are resolved before classifying live media', async () => {
  const { parsePlaylist } = await load('background/m3u8-parser.js');
  const base = 'https://example.com/master.m3u8';
  const master = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\nchild/video.m3u8\n', base);
  assert.equal(master.isMaster, true);
  assert.equal(master.live, false);
  assert.equal(master.variants[0].url, 'https://example.com/child/video.m3u8');
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n', base).live, true);
});

test('AES-128 accepts short explicit IV and resolves keys against the media playlist', async () => {
  const { decryptHlsSegment, segmentIV } = await load('player/hls-crypto.js');
  const key = webcrypto.getRandomValues(new Uint8Array(16));
  const plain = new TextEncoder().encode('media from a redirected child playlist');
  const encryptionKey = await webcrypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: segmentIV({}, 258) }, encryptionKey, plain);
  const segment = {
    key: '#EXT-X-KEY:METHOD=AES-128,URI="../enc.key?token=a,b",IV=0x102,KEYFORMAT="identity"',
    keyBaseUrl: 'https://cdn.example.com/path/child/video.m3u8',
  };
  const requested = [];
  const decrypted = await decryptHlsSegment(segment, encrypted, 'https://example.com/master.m3u8', uri => {
    requested.push(uri);
    return key;
  }, new Map());
  assert.deepEqual(new Uint8Array(decrypted), plain);
  assert.deepEqual(requested, ['https://cdn.example.com/path/enc.key?token=a,b']);
});

test('AES-128 rejects unsupported protection and invalid IVs before requesting a key', async () => {
  const { decryptHlsSegment } = await load('player/hls-crypto.js');
  const base = 'https://example.com/video.m3u8';
  const getKey = () => assert.fail('invalid encryption metadata must not fetch a key');
  for (const [key, error] of [
    ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="enc.key"', /加密方式/],
    ['#EXT-X-KEY:METHOD=AES-128,URI="enc.key",KEYFORMAT="com.apple.streamingkeydelivery"', /密钥格式/],
    ['#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x123456789012345678901234567890123', /IV/],
    ['#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=garbage', /IV/],
  ]) {
    await assert.rejects(() => decryptHlsSegment({ key, sequence: 0 }, new ArrayBuffer(16), base, getKey, new Map()), error);
  }
  const clear = new ArrayBuffer(16);
  assert.equal(await decryptHlsSegment({ key: '#EXT-X-KEY:METHOD=NONE' }, clear, base, getKey, new Map()), clear);
});

test('AES-128 zero-IV MPEG-TS encryption matches the sample resource format', async () => {
  const { decryptHlsSegment } = await load('player/hls-crypto.js');
  // Local fixture: TS sync bytes plus arbitrary payload, encrypted with normal
  // PKCS#7 padding. No live site URLs or key material are retained in tests.
  const plain = new Uint8Array(188 * 3);
  plain.set([0x47, 0x40, 0x11, 0x10], 0);
  plain[188] = plain[376] = 0x47;
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  const encryptionKey = await webcrypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, encryptionKey, plain);
  const decrypted = await decryptHlsSegment({
    key: '#EXT-X-KEY:METHOD=AES-128,URI="enc.key",IV=0x00000000000000000000000000000000',
  }, encrypted, 'https://example.com/play/id/index.m3u8', () => key, new Map());
  assert.deepEqual(new Uint8Array(decrypted), plain);
});
