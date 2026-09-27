function parseKey(line, baseUrl) {
  if (!line) return null;
  const method = /(?:^|[:,])METHOD=([^,]+)/i.exec(line)?.[1];
  if (method !== 'AES-128') throw new Error(`不支持的 HLS 加密方式: ${method || 'unknown'}`);
  const ref = /(?:^|[:,])URI="([^"]+)"/i.exec(line)?.[1];
  if (!ref) throw new Error('清单缺少解密密钥地址');
  const ivHex = /(?:^|[:,])IV=0x([0-9a-fA-F]{32})(?:,|$)/i.exec(line)?.[1];
  if (/\bIV=/.test(line) && !ivHex) throw new Error('清单中的 IV 无效');
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
  const key = parseKey(segment.key, baseUrl);
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
