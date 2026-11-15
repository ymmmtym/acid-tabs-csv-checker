import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createGunzip, createBrotliDecompress, gunzipSync, brotliDecompressSync, Gzip, BrotliCompress } from 'node:zlib';
import { createApp } from '../src/server.js';

async function start(t) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return server.address().port;
}

function open(port, path, encoding, body) {
  const req = request({
    host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET',
    headers: { 'accept-encoding': encoding, 'content-type': 'application/json' }
  });
  const response = once(req, 'response').then(([res]) => res);
  req.end(body && JSON.stringify(body));
  return response;
}

async function collect(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (res.headers['content-encoding'] === 'gzip') return gunzipSync(data).toString();
  if (res.headers['content-encoding'] === 'br') return brotliDecompressSync(data).toString();
  return data.toString();
}

test('unversioned static assets require revalidation', async (t) => {
  const port = await start(t);
  for (const path of ['/app.js', '/styles.css', '/favicon.svg']) {
    const res = await open(port, path, 'identity');
    assert.equal(res.headers['cache-control'], 'public, no-cache');
    await collect(res);
  }
});

test('encoding weights, complete tokens, wildcard and exclusions apply across routes', async (t) => {
  const port = await start(t);
  const cases = [
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.2, gzip;q=0.8', 'gzip'],
    ['GZIP;q=0.4, BR;q=0.9', 'br'],
    ['x-br, gzip-extra', undefined],
    ['br;q=0, *;q=0.5', 'gzip'],
    ['*;q=0, gzip;q=1', 'gzip'],
    ['br;q=0, gzip;q=0', undefined],
    ['br;q=0.5, identity;q=1', undefined],
    ['gzip;q=1, identity;q=0.1', 'gzip'],
    ['gzip;q=0.1234', undefined],
    ['identity;q=0, br;q=0, gzip;q=0', undefined, 406],
    ['*;q=0', undefined, 406]
  ];
  for (const [header, encoding, status = 200] of cases) {
    for (const [path, body] of [
      ['/app.js'],
      ['/api/analyze', { csv: '⭐, http://localhost, yellow' }],
      ['/api/check', { csv: '⭐, http://localhost, yellow' }]
    ]) {
      const res = await open(port, path, header, body);
      assert.equal(res.statusCode, status, path + ': ' + header);
      // Small JSON responses may use acceptable identity instead of compression.
      if (path !== '/api/analyze' || status === 406) {
        assert.equal(res.headers['content-encoding'], encoding, path + ': ' + header);
      }
      const data = await collect(res);
      if (status === 200 && path === '/api/check') {
        assert.deepEqual(data.trim().split('\n').map(line => JSON.parse(line).type),
          ['analysis', 'start', 'result', 'done']);
      }
    }
  }
  const rejectedError = await open(port, '/missing', '*;q=0');
  assert.equal(rejectedError.statusCode, 406);
  await collect(rejectedError);
  const res = await open(port, '/api/health', 'identity;q=0, gzip');
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(await collect(res)).ok, true);
});

for (const encoding of ['gzip', 'br']) {
  test(encoding + ' streams records while checks are pending and tolerates cancellation', { timeout: 5000 }, async (t) => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    t.mock.method(dns, 'lookup', () => pending);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    t.after(() => release([{ address: '127.0.0.1', family: 4 }]));
    const Compressor = encoding === 'gzip' ? Gzip : BrotliCompress;
    const originalTransform = Compressor.prototype._transform;
    let compressor;
    t.mock.method(Compressor.prototype, '_transform', function (...args) {
      compressor = this;
      return originalTransform.apply(this, args);
    });
    const port = await start(t);
    const res = await open(port, '/api/check', encoding, {
      csv: '⭐, https://example.invalid, yellow', options: { www: false }
    });
    const decoder = encoding === 'gzip' ? createGunzip() : createBrotliDecompress();
    res.pipe(decoder);
    const [chunk] = await once(decoder, 'data');
    assert.match(chunk.toString(), /"type":"analysis"/);
    assert.doesNotMatch(chunk.toString(), /"type":"done"/);
    const closed = once(compressor, 'close');
    res.destroy();
    decoder.destroy();
    await closed;
    assert.equal(compressor.destroyed, true);
    release([{ address: '127.0.0.1', family: 4 }]);
    const health = await open(port, '/api/health', 'identity');
    assert.equal(JSON.parse(await collect(health)).ok, true);
  });
}

for (const Compressor of [Gzip, BrotliCompress]) {
  test(Compressor.name + ' compression errors close the response without crashing', { timeout: 5000 }, async (t) => {
    t.mock.method(Compressor.prototype, '_transform', function (_chunk, _encoding, callback) {
      callback(new Error('synthetic compression failure'));
    });
    const port = await start(t);
    const encoding = Compressor === Gzip ? 'gzip' : 'br';
    await assert.rejects(async () => {
      const res = await open(port, '/api/check', encoding, { csv: '⭐, http://localhost, yellow' });
      await collect(res);
    });
    const health = await open(port, '/api/health', 'identity');
    assert.equal(JSON.parse(await collect(health)).ok, true);
  });
}
