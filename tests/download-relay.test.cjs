const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { test } = require('node:test');
const { createRelayServer } = require('../tools/download-relay.cjs');

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const settle = () => new Promise(resolve => setImmediate(resolve));

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function bridge(relay, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(relay + '/fetch', {
      method: options.method || 'POST',
      headers: {
        Origin: ORIGIN, 'Content-Type': 'application/json', 'X-HLS-Relay': '1',
        'Content-Length': Buffer.byteLength(data), ...options.headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(data);
  });
}

async function connectProxy(t) {
  const destinations = [];
  const server = http.createServer((request, response) => {
    destinations.push(request.url);
    const upstream = http.request(request.url, { headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    response.on('close', () => upstream.destroy());
    upstream.end();
  });
  server.on('connect', (request, client, head) => {
    destinations.push(request.url);
    const separator = request.url.lastIndexOf(':');
    const host = request.url.slice(0, separator).replace(/^\[|\]$/g, '');
    const upstream = net.connect(Number(request.url.slice(separator + 1)), host === 'localhost' ? '127.0.0.1' : host);
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  return { url: await listen(t, server), destinations };
}

async function socksProxy(t, version) {
  const destinations = [];
  const server = net.createServer(client => {
    let data = Buffer.alloc(0);
    let greeted = version === 4;
    const onData = chunk => {
      data = Buffer.concat([data, chunk]);
      if (!greeted) {
        if (data.length < 3) return;
        assert.equal(data[0], 5);
        const length = 2 + data[1];
        if (data.length < length) return;
        data = data.subarray(length);
        greeted = true;
        // Deliberately split the greeting to exercise incremental reads.
        client.write(Buffer.from([5]));
        setImmediate(() => client.write(Buffer.from([0])));
        if (!data.length) return;
      }
      let host, port, consumed;
      if (version === 5) {
        if (data.length < 4) return;
        assert.equal(data[0], 5);
        assert.equal(data[1], 1);
        if (data[3] === 1) {
          if (data.length < 10) return;
          host = [...data.subarray(4, 8)].join('.');
          port = data.readUInt16BE(8);
          consumed = 10;
        } else if (data[3] === 3) {
          if (data.length < 5 || data.length < 7 + data[4]) return;
          host = data.subarray(5, 5 + data[4]).toString();
          port = data.readUInt16BE(5 + data[4]);
          consumed = 7 + data[4];
        } else { client.destroy(); return; }
      } else {
        if (data.length < 9) return;
        assert.equal(data[0], 4);
        const userEnd = data.indexOf(0, 8);
        if (userEnd === -1) return;
        host = [...data.subarray(4, 8)].join('.');
        consumed = userEnd + 1;
        if (host === '0.0.0.1') {
          const domainEnd = data.indexOf(0, consumed);
          if (domainEnd === -1) return;
          host = data.subarray(consumed, domainEnd).toString();
          consumed = domainEnd + 1;
        }
        port = data.readUInt16BE(2);
      }
      destinations.push({ host, port });
      client.removeListener('data', onData);
      const extra = data.subarray(consumed);
      const upstream = net.connect({ host: host === 'localhost' ? '127.0.0.1' : host, port });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      upstream.once('connect', () => {
        client.write(version === 5 ? Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]) : Buffer.from([0, 90, 0, 0, 127, 0, 0, 1]));
        if (extra.length) upstream.write(extra);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on('data', onData);
  });
  const url = await listen(t, server);
  return { url: url.replace('http:', `socks${version}:`), destinations };
}

test('relay forwards original bytes and HTTP status through a standard HTTP proxy', async t => {
  const bytes = Buffer.from([0, 255, 71, 128, 1, 2]);
  let received;
  const origin = await listen(t, http.createServer((request, response) => {
    received = { url: request.url, headers: request.headers };
    response.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Length': bytes.length, 'X-Origin': 'yes' });
    response.end(bytes);
  }));
  const proxy = await connectProxy(t);
  const relay = await listen(t, createRelayServer());
  const result = await bridge(relay, { url: origin + '/segment.ts?token=private', proxyUrl: proxy.url, headers: { Referer: 'https://example.com/watch', 'Accept-Encoding': 'gzip' } });
  assert.equal(result.status, 206);
  assert.deepEqual(result.body, bytes);
  assert.equal(received.url, '/segment.ts?token=private');
  assert.equal(received.headers.referer, 'https://example.com/watch');
  assert.equal(received.headers['accept-encoding'], 'identity');
  assert.equal(result.headers['x-hls-final-url'], origin + '/segment.ts?token=private');
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  assert.match(result.headers['access-control-expose-headers'], /X-HLS-Final-URL/);
  assert.equal(result.headers['x-hls-relay-error'], undefined);
  assert.equal(proxy.destinations.length, 1);
  assert.equal(proxy.destinations[0], origin + '/segment.ts?token=private');
});

test('relay supports real SOCKS4a and SOCKS5 tunnels', async t => {
  const origin = await listen(t, http.createServer((_request, response) => response.end('encrypted segment bytes')));
  const relay = await listen(t, createRelayServer());
  for (const version of [4, 5]) {
    const proxy = await socksProxy(t, version);
    // localhost exercises domain-name forwarding rather than local DNS.
    const url = origin.replace('127.0.0.1', 'localhost') + '/enc.key';
    const result = await bridge(relay, { url, proxyUrl: proxy.url });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'encrypted segment bytes');
    assert.deepEqual(proxy.destinations, [{ host: 'localhost', port: Number(new URL(origin).port) }]);
  }
});

test('relative redirects preserve credentials on the same origin and strip them across origins', async t => {
  let sameOriginHeaders, finalHeaders;
  const final = await listen(t, http.createServer((request, response) => { finalHeaders = request.headers; response.end('done'); }));
  const origin = await listen(t, http.createServer((request, response) => {
    if (request.url === '/start') { response.writeHead(302, { Location: './next' }); response.end(); }
    else { sameOriginHeaders = request.headers; response.writeHead(307, { Location: final + '/media/index.m3u8' }); response.end(); }
  }));
  const relay = await listen(t, createRelayServer());
  const result = await bridge(relay, { url: origin + '/start', headers: { Authorization: 'Bearer private', Cookie: 'secret=1', Accept: '*/*' } });
  assert.equal(result.status, 200);
  assert.equal(sameOriginHeaders.authorization, 'Bearer private');
  assert.equal(sameOriginHeaders.cookie, 'secret=1');
  assert.equal(finalHeaders.authorization, undefined);
  assert.equal(finalHeaders.cookie, undefined);
  assert.equal(finalHeaders.accept, '*/*');
  assert.equal(result.headers['x-hls-final-url'], final + '/media/index.m3u8');
});

test('website origins, foreign hosts, missing markers, and invalid destinations are rejected', async t => {
  const relay = await listen(t, createRelayServer());
  for (const [body, headers, status] of [
    [{ url: 'http://127.0.0.1/' }, { Origin: 'https://attacker.example' }, 403],
    [{ url: 'http://127.0.0.1/' }, { Host: 'attacker.example' }, 403],
    [{ url: 'http://127.0.0.1/' }, { 'X-HLS-Relay': '' }, 403],
    [{ url: 'http://127.0.0.1/' }, { 'Content-Type': 'text/plain' }, 403],
    [{ url: 'file:///etc/passwd' }, {}, 400],
    [{ url: 'https://user:secret@example.com/' }, {}, 400],
    [{ url: 'http://example.com/\r\nInjected: value' }, {}, 400],
    [{ url: 'http://example.com/', proxyUrl: 'ftp://127.0.0.1:21' }, {}, 400],
    [{ url: 'http://example.com/', proxyUrl: 'socks5://127.0.0.1:0' }, {}, 400],
    [{ url: 'http://example.com/', proxyUrl: 'socks5://user:secret@127.0.0.1:1080' }, {}, 400],
    [{ url: 'http://example.com/', headers: { Referer: 'valid\r\nCookie: hidden' } }, {}, 400],
  ]) {
    const result = await bridge(relay, body, { headers });
    assert.equal(result.status, status);
    assert.equal(result.headers['x-hls-relay-error'], '1');
    assert.doesNotMatch(result.body.toString(), /user:secret|hidden|passwd/);
  }
});

test('only extension preflights receive the CORS grant', async t => {
  const relay = await listen(t, createRelayServer());
  const result = await bridge(relay, {}, {
    method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-hls-relay' },
  });
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-origin'], ORIGIN);
  const blocked = await bridge(relay, {}, {
    method: 'OPTIONS', headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers['access-control-allow-origin'], undefined);
});

test('upstream errors preserve HTTP status while bridge failures are marked and sanitized', async t => {
  const origin = await listen(t, http.createServer((_request, response) => {
    response.writeHead(403, { 'X-HLS-Relay-Error': 'spoofed' }); response.end('denied');
  }));
  const proxy = await connectProxy(t);
  const relay = await listen(t, createRelayServer());
  const denied = await bridge(relay, { url: origin + '/private?secret=value', proxyUrl: proxy.url });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.toString(), 'denied');
  assert.equal(denied.headers['x-hls-relay-error'], undefined);
  const broken = await bridge(relay, { url: origin + '/private?secret=value', proxyUrl: 'http://127.0.0.1:1' });
  assert.equal(broken.status, 502);
  assert.equal(broken.headers['x-hls-relay-error'], '1');
  assert.doesNotMatch(broken.body.toString(), /secret|127\.0\.0\.1|ECONNREFUSED/);
});

test('redirect loops and slow responses fail within bounded limits', async t => {
  const origin = await listen(t, http.createServer((request, response) => {
    if (request.url === '/loop') { response.writeHead(302, { Location: '/loop' }); response.end(); }
  }));
  const relay = await listen(t, createRelayServer({ timeoutMs: 200 }));
  const loop = await bridge(relay, { url: origin + '/loop' });
  assert.equal(loop.status, 502);
  assert.match(JSON.parse(loop.body).error, /重定向/);
  const slow = await bridge(relay, { url: origin + '/slow' });
  assert.equal(slow.status, 504);
  assert.equal(slow.headers['x-hls-relay-error'], '1');
});

test('cancelling the downstream response closes the active upstream request', async t => {
  let markClosed;
  const closed = new Promise(resolve => { markClosed = resolve; });
  const origin = await listen(t, http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'video/mp2t' });
    response.write('partial encrypted segment');
    response.once('close', markClosed);
  }));
  const proxy = await connectProxy(t);
  const relay = await listen(t, createRelayServer());
  const body = JSON.stringify({ url: origin + '/stream', proxyUrl: proxy.url });
  const request = http.request(relay + '/fetch', {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'X-HLS-Relay': '1', 'Content-Length': Buffer.byteLength(body) },
  });
  request.on('error', () => {});
  const responseReady = once(request, 'response');
  request.end(body);
  const [response] = await responseReady;
  await once(response, 'data');
  response.destroy();
  let timeout;
  await Promise.race([closed, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('upstream stayed open after cancellation')), 1500); })]).finally(() => clearTimeout(timeout));
  await settle();
});

test('HTTPS tunnels verify certificate trust and the actual destination hostname', async t => {
  // Test-only localhost certificate/key; never a site certificate or credential.
  const certPath = path.join(__dirname, 'fixtures/relay-test-cert.pem');
  const cert = readFileSync(certPath);
  const key = readFileSync(path.join(__dirname, 'fixtures/relay-test-key.pem'));
  const origin = (await listen(t, https.createServer({ cert, key }, (_request, response) => response.end('TLS bytes')))).replace('http:', 'https:');
  const proxy = await connectProxy(t);
  const relay = await listen(t, createRelayServer());
  const untrusted = await bridge(relay, { url: origin + '/segment.ts', proxyUrl: proxy.url });
  assert.equal(untrusted.status, 502);
  assert.equal(untrusted.headers['x-hls-relay-error'], '1');
  assert.match(proxy.destinations[0], /^127\.0\.0\.1:\d+$/);

  // A fresh Node process can trust the fixture via its supported CA mechanism.
  // It must still reject the IP URL because the SAN only names localhost.
  const source = `
    const { openDestinationSocket } = require(process.argv[1]);
    (async () => {
      const signal = new AbortController().signal;
      try {
        const socket = await openDestinationSocket(new URL(process.argv[2]), null, signal);
        socket.destroy(); process.stdout.write('connected');
      } catch (error) { process.stdout.write(error.code || 'failed'); }
    })();
  `;
  const modulePath = path.join(__dirname, '../tools/download-relay.cjs');
  const options = { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, timeout: 5000 };
  const mismatch = await promisify(execFile)(process.execPath, ['--dns-result-order=ipv4first', '-e', source, modulePath, origin], options);
  assert.equal(mismatch.stdout, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const trusted = await promisify(execFile)(process.execPath, ['--dns-result-order=ipv4first', '-e', source, modulePath, origin.replace('127.0.0.1', 'localhost')], options);
  assert.equal(trusted.stdout, 'connected');
});
