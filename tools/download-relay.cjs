#!/usr/bin/env node
'use strict';

// Local, extension-only bridge. Node opens a separate proxy tunnel for each
// resource; it never changes the browser or operating system proxy settings.
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { pipeline } = require('node:stream/promises');

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PROXY_PORTS = { 'http:': 80, 'https:': 443, 'socks4:': 1080, 'socks5:': 1080 };
const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']);
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'cookie2', 'x-api-key', 'x-auth-token']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class RelayError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function targetUrl(value) {
  if (typeof value !== 'string' || value.length > 32768 || /[\r\n]/.test(value)) throw new RelayError('目标地址无效', 400);
  let url;
  try { url = new URL(value); } catch { throw new RelayError('目标地址无效', 400); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new RelayError('目标地址只支持不含账号密码的 HTTP/HTTPS URL', 400);
  }
  url.hash = '';
  return url;
}

function parseProxyUrl(value) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) throw new RelayError('代理地址无效', 400);
  let url;
  try { url = new URL(value); } catch { throw new RelayError('代理地址无效', 400); }
  if (!Object.hasOwn(PROXY_PORTS, url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new RelayError('代理仅支持无账号密码的 HTTP、HTTPS、SOCKS4、SOCKS5 主机和端口', 400);
  }
  if (url.port && Number(url.port) < 1) throw new RelayError('代理端口必须在 1 至 65535 之间', 400);
  return url;
}

function hostOf(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
function portOf(url) { return Number(url.port || (url.protocol === 'https:' ? 443 : 80)); }

function safeHeaders(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new RelayError('请求头格式无效', 400);
  const headers = {};
  let size = 0;
  const connectionHeaders = new Set(String(raw.connection || raw.Connection || '').toLowerCase().split(',').map(name => name.trim()));
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new RelayError('请求头格式无效', 400);
    try { http.validateHeaderName(name); http.validateHeaderValue(name, value); }
    catch { throw new RelayError('请求头包含无效字符', 400); }
    size += name.length + value.length;
    if (size > 65536) throw new RelayError('请求头过大', 400);
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || connectionHeaders.has(lower) || ['host', 'content-length', 'expect', 'accept-encoding'].includes(lower)) continue;
    headers[lower] = value;
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function trackSocket(socket, signal) {
  // Keep connection failures handled even during the short handoff between
  // handshake completion and the HTTP client's installation of its listeners.
  socket.on('error', () => {});
  const cancel = () => socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  socket.once('close', () => signal.removeEventListener('abort', cancel));
  return socket;
}

function connectSocket(host, port, signal, secure = false) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const socket = trackSocket(secure
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host })
      : net.connect({ host, port }), signal);
    const ready = secure ? 'secureConnect' : 'connect';
    const failed = error => { socket.removeListener(ready, connected); reject(error); };
    const connected = () => { socket.removeListener('error', failed); resolve(socket); };
    socket.once('error', failed);
    socket.once(ready, connected);
  });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.failure = null;
    this.pending = null;
    this.onData = chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 65536) this.fail(new RelayError('代理握手响应过大'));
      this.drain();
    };
    this.onError = error => this.fail(error);
    this.onEnd = () => this.fail(new RelayError('代理提前关闭连接'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
  }
  fail(error) {
    this.failure = error;
    if (this.pending) { const { reject } = this.pending; this.pending = null; reject(error); }
  }
  drain() {
    if (!this.pending || this.buffer.length < this.pending.size) return;
    const { size, resolve } = this.pending;
    this.pending = null;
    const bytes = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    resolve(bytes);
  }
  read(size) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => { this.pending = { size, resolve, reject }; this.drain(); });
  }
  release() {
    this.socket.pause();
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('end', this.onEnd);
    this.socket.removeListener('close', this.onEnd);
    if (this.buffer.length) this.socket.unshift(this.buffer);
  }
}

function ipv6Bytes(host) {
  const [left, right] = host.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const words = right === undefined ? start : [...start, ...new Array(8 - start.length - end.length).fill('0'), ...end];
  const bytes = Buffer.alloc(16);
  words.forEach((word, i) => bytes.writeUInt16BE(parseInt(word, 16), i * 2));
  return bytes;
}

async function socksTunnel(target, proxy, signal) {
  const socket = await connectSocket(hostOf(proxy), Number(proxy.port || PROXY_PORTS[proxy.protocol]), signal);
  const reader = new SocketReader(socket);
  try {
    const host = hostOf(target);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(portOf(target));
    if (proxy.protocol === 'socks5:') {
      socket.write(Buffer.from([5, 1, 0]));
      const greeting = await reader.read(2);
      if (greeting[0] !== 5 || greeting[1] !== 0) throw new RelayError('SOCKS5 代理不支持无认证连接');
      let address;
      if (net.isIP(host) === 4) address = Buffer.from([1, ...host.split('.').map(Number)]);
      else if (net.isIP(host) === 6) address = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
      else {
        const domain = Buffer.from(host);
        if (domain.length > 255) throw new RelayError('目标主机名过长', 400);
        address = Buffer.concat([Buffer.from([3, domain.length]), domain]);
      }
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));
      const reply = await reader.read(4);
      if (reply[0] !== 5 || reply[1] !== 0) throw new RelayError('SOCKS5 代理无法连接目标');
      if (reply[3] === 1) await reader.read(6);
      else if (reply[3] === 4) await reader.read(18);
      else if (reply[3] === 3) { const length = await reader.read(1); await reader.read(length[0] + 2); }
      else throw new RelayError('SOCKS5 代理返回无效地址');
    } else {
      if (net.isIP(host) === 6) throw new RelayError('SOCKS4 不支持 IPv6 目标，请使用 SOCKS5', 400);
      const address = net.isIP(host) === 4 ? Buffer.from(host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]);
      const domain = net.isIP(host) ? Buffer.alloc(0) : Buffer.concat([Buffer.from(host), Buffer.from([0])]);
      socket.write(Buffer.concat([Buffer.from([4, 1]), port, address, Buffer.from([0]), domain]));
      const reply = await reader.read(8);
      if (reply[0] !== 0 || reply[1] !== 90) throw new RelayError('SOCKS4 代理无法连接目标');
    }
    reader.release();
    return socket;
  } catch (error) { reader.release(); socket.destroy(); throw error; }
}

function httpTunnel(target, proxy, signal) {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === 'https:' ? https : http;
    const authority = `${target.hostname}:${portOf(target)}`;
    const request = client.request({
      hostname: hostOf(proxy), port: Number(proxy.port || PROXY_PORTS[proxy.protocol]),
      method: 'CONNECT', path: authority, headers: { Host: authority }, agent: false, signal,
    });
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new RelayError('HTTP 代理拒绝连接目标')); return; }
      trackSocket(socket, signal);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', reject);
    request.end();
  });
}

async function openDestinationSocket(target, proxy, signal) {
  let socket;
  if (!proxy) socket = await connectSocket(hostOf(target), portOf(target), signal);
  else if (proxy.protocol.startsWith('socks')) socket = await socksTunnel(target, proxy, signal);
  else socket = await httpTunnel(target, proxy, signal);
  if (target.protocol !== 'https:') return socket;
  return new Promise((resolve, reject) => {
    const host = hostOf(target);
    const secure = trackSocket(tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host }), signal);
    socket.resume();
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', reject);
  });
}

async function requestResource(target, proxy, headers, signal) {
  // HTTP forward proxies use absolute-form request targets for plain HTTP.
  // CONNECT is reserved for HTTPS, since many proxies only permit port 443.
  if (target.protocol === 'http:' && proxy && ['http:', 'https:'].includes(proxy.protocol)) {
    return new Promise((resolve, reject) => {
      const client = proxy.protocol === 'https:' ? https : http;
      const request = client.request({
        hostname: hostOf(proxy), port: Number(proxy.port || PROXY_PORTS[proxy.protocol]),
        method: 'GET', path: target.href, headers: { ...headers, host: target.host }, agent: false, signal,
      }, response => resolve({ response, dispose: () => { response.destroy(); request.destroy(); } }));
      request.once('error', reject);
      request.end();
    });
  }
  const socket = await openDestinationSocket(target, proxy, signal);
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const agent = new client.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const request = client.request(target, { method: 'GET', headers, agent, signal }, response => {
      resolve({ response, dispose: () => { response.destroy(); request.destroy(); agent.destroy(); } });
    });
    request.once('error', error => { agent.destroy(); socket.destroy(); reject(error); });
    request.once('socket', assigned => assigned.resume());
    request.end();
  });
}

async function followResource(url, proxy, initialHeaders, signal) {
  let target = url;
  let headers = { ...initialHeaders };
  for (let redirects = 0; redirects <= 10; redirects++) {
    const resource = await requestResource(target, proxy, headers, signal);
    const location = resource.response.headers.location;
    if (!REDIRECTS.has(resource.response.statusCode) || !location) return { ...resource, url: target.href };
    resource.dispose();
    if (redirects === 10) throw new RelayError('目标重定向次数过多');
    let next;
    try { next = targetUrl(new URL(location, target).href); }
    catch { throw new RelayError('目标返回无效重定向地址'); }
    if (next.origin !== target.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name)));
    }
    target = next;
  }
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'X-HLS-Final-URL, X-HLS-Relay-Error',
    'Vary': 'Origin',
  };
}

function sendError(response, origin, error, signal) {
  if (response.destroyed || response.headersSent) { response.destroy(); return; }
  const timedOut = signal?.aborted && signal.reason?.code === 'RELAY_TIMEOUT';
  const status = timedOut ? 504 : error instanceof RelayError ? error.status : 502;
  const message = timedOut ? '代理资源请求超时' : error instanceof RelayError ? error.message : '代理或目标连接失败，请检查代理地址和网络';
  response.writeHead(status, { ...(origin ? cors(origin) : {}), 'X-HLS-Relay-Error': '1', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

async function readJson(request, signal) {
  const chunks = [];
  let size = 0;
  const aborted = () => request.destroy();
  signal.addEventListener('abort', aborted, { once: true });
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 131072) throw new RelayError('请求内容过大', 413);
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new RelayError('请求内容不是有效 JSON', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RelayError('请求内容格式无效', 400);
    return body;
  } finally { signal.removeEventListener('abort', aborted); }
}

function createRelayServer({ timeoutMs = 120000 } = {}) {
  const deadline = Number.isFinite(timeoutMs) ? Math.min(120000, Math.max(1, timeoutMs)) : 120000;
  const server = http.createServer(async (request, response) => {
    const origin = typeof request.headers.origin === 'string' && EXTENSION_ORIGIN.test(request.headers.origin) ? request.headers.origin : null;
    const loopbackHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(request.headers.host || '');
    if (!origin || !loopbackHost) { sendError(response, null, new RelayError('仅允许本机浏览器扩展访问', 403)); return; }
    if (request.url !== '/fetch') { sendError(response, origin, new RelayError('接口不存在', 404)); return; }
    if (request.method === 'OPTIONS') {
      const names = String(request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean);
      if (request.headers['access-control-request-method'] !== 'POST' || names.some(name => !['content-type', 'x-hls-relay'].includes(name))) {
        sendError(response, origin, new RelayError('预检请求无效', 403)); return;
      }
      response.writeHead(204, { ...cors(origin), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, X-HLS-Relay', 'Access-Control-Max-Age': '600' });
      response.end();
      return;
    }
    if (request.method !== 'POST') { sendError(response, origin, new RelayError('仅支持 POST 请求', 405)); return; }
    if (request.headers['x-hls-relay'] !== '1' || !/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || '')) {
      sendError(response, origin, new RelayError('缺少扩展请求标记或 JSON 请求类型', 403)); return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('client disconnected'));
    request.once('aborted', cancel);
    response.once('close', () => { if (!response.writableEnded) cancel(); });
    const timer = setTimeout(() => {
      const error = new Error('relay timeout');
      error.code = 'RELAY_TIMEOUT';
      controller.abort(error);
    }, deadline);
    let resource;
    try {
      const body = await readJson(request, controller.signal);
      const target = targetUrl(body.url);
      const proxy = parseProxyUrl(body.proxyUrl);
      const headers = safeHeaders(body.headers);
      resource = await followResource(target, proxy, headers, controller.signal);
      const upstream = resource.response;
      const outgoing = {};
      const connectionHeaders = new Set(String(upstream.headers.connection || '').toLowerCase().split(',').map(name => name.trim()));
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && !HOP_HEADERS.has(name) && !connectionHeaders.has(name) && !name.startsWith('access-control-') && !['set-cookie', 'x-hls-relay-error', 'x-hls-final-url'].includes(name)) outgoing[name] = value;
      }
      response.writeHead(upstream.statusCode, { ...outgoing, ...cors(origin), 'X-HLS-Final-URL': resource.url, 'Cache-Control': 'no-store' });
      await pipeline(upstream, response);
    } catch (error) { sendError(response, origin, error, controller.signal); }
    finally { clearTimeout(timer); request.removeListener('aborted', cancel); resource?.dispose(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = args.length === 0 ? 17891 : args.length === 2 && args[0] === '--port' ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write('用法：node tools/download-relay.cjs [--port 17891]\n');
    process.exitCode = 1;
  } else {
    const server = createRelayServer();
    server.once('error', () => { process.stderr.write('下载代理桥启动失败，请检查本机端口是否已占用。\n'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write(`下载代理桥已启动：http://127.0.0.1:${port}\n仅处理扩展请求，不修改浏览器或系统代理。按 Ctrl+C 停止。\n`);
    });
    const shutdown = () => { server.close(); server.closeAllConnections(); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}

module.exports = { createRelayServer, openDestinationSocket, parseProxyUrl };
