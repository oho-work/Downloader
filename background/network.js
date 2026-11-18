// fetch 不支持为单次请求指定 HTTP/SOCKS 代理。仅将扩展请求转交本地服务，
// 由服务为该请求建立上游代理连接，不修改浏览器或系统的代理配置。
import { getSettings } from './cache-store.js';

export const DEFAULT_RELAY_URL = 'http://127.0.0.1:17891';
let currentSettings = null;
let loadingSettings = null;

function validateProxyAddress(address) {
  let url;
  try { url = new URL(address); }
  catch { throw new Error('代理地址格式无效，例如 http://127.0.0.1:7890'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw new Error('代理仅支持 http://、https://、socks4:// 或 socks5:// 地址');
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      (url.pathname && url.pathname !== '/') || url.port === '0') {
    throw new Error('代理地址只填写协议、主机和端口，不支持账号、密码或路径');
  }
}

function normalizeRelayUrl(address) {
  let url;
  try { url = new URL(address); } catch { throw new Error('本地转发服务地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port === '0') {
    throw new Error('转发服务必须是本机 HTTP 地址，例如 http://127.0.0.1:17891');
  }
  return url.origin;
}

export function normalizeProxySettings(input = {}) {
  const downloadProxyEnabled = input.downloadProxyEnabled === true;
  const downloadProxyUrl = typeof input.downloadProxyUrl === 'string' ? input.downloadProxyUrl.trim() : '';
  const relayAddress = typeof input.downloadRelayUrl === 'string' ? input.downloadRelayUrl.trim() : DEFAULT_RELAY_URL;
  const downloadRelayUrl = downloadProxyEnabled ? normalizeRelayUrl(relayAddress || DEFAULT_RELAY_URL) : relayAddress || DEFAULT_RELAY_URL;
  if (downloadProxyEnabled) validateProxyAddress(downloadProxyUrl);
  return { downloadProxyEnabled, downloadProxyUrl, downloadRelayUrl };
}

export function configureNetwork(input = {}) {
  currentSettings = normalizeProxySettings(input);
}

async function networkSettings() {
  if (currentSettings) return currentSettings;
  // A sniff request can arrive before the worker's startup settings read.
  // Wait for storage so enabled proxy requests never accidentally go direct.
  if (!loadingSettings) {
    loadingSettings = getSettings().then(settings => {
      if (!currentSettings) configureNetwork(settings);
      return currentSettings;
    }).finally(() => { loadingSettings = null; });
  }
  return loadingSettings;
}

export async function fetchResource(url, init = {}, settings) {
  const config = settings ? normalizeProxySettings(settings) : await networkSettings();
  if (!config.downloadProxyEnabled) return fetch(url, init);
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('下载资源必须是 HTTP 或 HTTPS 地址');
  }
  if (init.method && init.method.toUpperCase() !== 'GET') throw new Error('下载转发仅支持 GET 资源请求');
  let response;
  try {
    response = await fetch(config.downloadRelayUrl + '/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-HLS-Relay': '1' },
      body: JSON.stringify({ url: target.href, proxyUrl: config.downloadProxyUrl,
        headers: Object.fromEntries(new Headers(init.headers || {}).entries()) }),
      signal: init.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
  } catch (error) {
    if (init.signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error('无法连接本地下载转发服务，请先运行 node tools/download-relay.cjs');
  }
  if (response.headers.get('X-HLS-Relay-Error') === '1') {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || '下载转发失败，请检查本地服务和上游代理');
  }
  const finalUrl = response.headers.get('X-HLS-Final-URL');
  let validFinalUrl = false;
  try { validFinalUrl = !!finalUrl && /^https?:$/.test(new URL(finalUrl).protocol); } catch {}
  if (!validFinalUrl) {
    await response.body?.cancel();
    throw new Error('本地转发服务响应无效，请检查服务地址和版本');
  }
  // Keep the original streamed Response for progress/abort, while playlist
  // parsers resolve relative resources against the remote redirect target.
  Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}
