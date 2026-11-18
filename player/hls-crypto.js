function parseKey(line, baseUrl) {
  if (!line) return null;
  const attributes = new Map();
  const list = String(line).replace(/^#EXT-X-KEY\s*:/i, '');
  const pattern = /(?:^|,)\s*([A-Z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/gi;
  let match;
  while ((match = pattern.exec(list))) attributes.set(match[1].toUpperCase(), (match[2] ?? match[3]).trim());
  const method = attributes.get('METHOD')?.toUpperCase();
  if (method === 'NONE') return null;
  if (method !== 'AES-128') throw new Error(`不支持的 HLS 加密方式: ${method || 'unknown'}`);
  if (attributes.has('KEYFORMAT') && attributes.get('KEYFORMAT') !== 'identity') {
    throw new Error('不支持的 HLS 密钥格式，仅支持 identity AES-128');
  }
  const ref = attributes.get('URI');
  if (!ref) throw new Error('清单缺少解密密钥地址');
  const rawIV = attributes.get('IV');
  // RFC 8216 hexadecimal-sequence values may use fewer than 32 digits.
  // The IV is always the resulting unsigned 128-bit big-endian integer.
  if (attributes.has('IV') && !/^0x[0-9a-f]{1,32}$/i.test(rawIV)) throw new Error('清单中的 IV 无效');
  const ivHex = rawIV?.slice(2).padStart(32, '0');
  return { uri: new URL(ref, baseUrl).href, ivHex };
}

export function segmentIV(key, sequence) {
  if (key.ivHex) return Uint8Array.from(key.ivHex.match(/../g), byte => parseInt(byte, 16));
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('缺少 HLS 分片序号，无法推导 IV');
  const iv = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let i = 15; i >= 0 && value > 0n; i--) {
    iv[i] = Number(value & 255n);
    value >>= 8n;
  }
  return iv;
}

export async function decryptHlsSegment(segment, buffer, baseUrl, getKey, keyCache) {
  const key = parseKey(segment.key, segment.keyBaseUrl || baseUrl);
  if (!key) return buffer;
  let cryptoKey = keyCache.get(key.uri);
  if (!cryptoKey) {
    const bytes = await getKey(key.uri);
    if (bytes.byteLength !== 16) throw new Error('解密密钥长度不是 16 字节');
    cryptoKey = await crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['decrypt']);
    keyCache.set(key.uri, cryptoKey);
  }
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: segmentIV(key, segment.sequence) }, cryptoKey, buffer);
}
