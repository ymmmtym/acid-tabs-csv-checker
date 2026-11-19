import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, gzip, createBrotliCompress, createGzip, constants } from 'node:zlib';
import { finished } from 'node:stream';
import { analyzeCsv } from './parse.js';
import { runChecks } from './check.js';

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// コンテナ / サーバーレス上では、より厳しい接続先制限を有効にする
const DEPLOYED =
  process.env.APP_ENV === 'deployed' || Boolean(process.env.VERCEL);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const CSP_REPORT_URI = process.env.CSP_REPORT_URI;

function buildContentSecurityPolicy() {
  const directives = [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ];

  // CSP 違反レポート: 本番等で送信先を設定する場合に有効化する。
  // 違反レポートにはブロックされた URI 等が含まれるが、CSV 本文や URL 一覧は
  // 含まれない想定のため、送信先は運用環境側で管理する。
  if (CSP_REPORT_URI) {
    directives.push(`report-uri ${CSP_REPORT_URI}`);
  }

  return directives.join('; ');
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': buildContentSecurityPolicy()
};

function cacheControlForStatic(relativePath) {
  if (relativePath === 'index.html') return 'no-store';
  // Only content hashes in the pathname make an asset immutable.
  if (/[.-][a-f0-9]{8,}\.(?:js|css|svg|ico)$/i.test(relativePath)) {
    return 'public, max-age=31536000, immutable';
  }
  if (['.js', '.css', '.svg', '.ico'].includes(extname(relativePath))) {
    return 'public, no-cache';
  }
  return 'no-store';
}

function selectEncoding(acceptEncoding = '', preferIdentity = false) {
  const weights = new Map();
  for (const part of acceptEncoding.split(',')) {
    const match = /^\s*([!#$%&'*+.^_`|~0-9a-z-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    if (!match) continue;
    const coding = match[1].toLowerCase();
    const weight = match[2] === undefined ? 1 : Number(match[2]);
    weights.set(coding, Math.max(weights.get(coding) ?? 0, weight));
  }
  const identityWeight = weights.get('identity') ?? (weights.get('*') === 0 ? 0 : 1);
  if (preferIdentity && identityWeight > 0 && !weights.has('identity')) return null;

  let encoding = null;
  let best = weights.get('identity') ?? 0;
  for (const coding of ['br', 'gzip']) {
    const weight = weights.get(coding) ?? weights.get('*') ?? 0;
    if (weight > best) {
      encoding = coding;
      best = weight;
    }
  }
  if (best > 0 || identityWeight > 0) return encoding;
  throw new HttpError(406, 'Not Acceptable');
}

async function compressBody(body, encoding) {
  if (encoding === 'br') return brotliCompressAsync(body);
  if (encoding === 'gzip') return gzipAsync(body);
  return body;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function sendJson(req, res, status, payload) {
  const json = JSON.stringify(payload);
  let body = Buffer.from(json);
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Accept-Encoding'
  };

  const encoding = selectEncoding(req.headers['accept-encoding'], body.length < 1024);
  if (encoding) {
    body = await compressBody(body, encoding);
    headers['content-encoding'] = encoding;
  }

  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) return;

      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 応答を返せるように読み取りは続けるが、データは保持しない
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'リクエストが大きすぎます (最大 4MB)'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'JSON の形式が不正です');
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeOptions(raw = {}) {
  const dns = raw.dns !== false;
  const http = raw.http !== false;
  const www = raw.www !== false;

  if (!dns && !http) {
    throw new HttpError(400, 'DNS か HTTP のどちらかを有効にしてください');
  }

  return {
    dns,
    http,
    www,
    timeoutMs: clampInt(raw.timeoutMs, 1000, 30000, 5000),
    concurrency: clampInt(raw.concurrency, 1, 30, 30),
    // 公開環境では 80/443 以外への接続を許可しない
    strictPorts: DEPLOYED
  };
}

function requireCsv(body) {
  if (typeof body?.csv !== 'string') {
    throw new HttpError(400, 'csv フィールドに CSV テキストを指定してください');
  }
  return body.csv;
}

async function handleAnalyze(req, res) {
  const body = await readJson(req);
  const analysis = analyzeCsv(requireCsv(body));
  await sendJson(req, res, 200, { analysis });
}

async function handleCspReport(req, res) {
  // ブラウザからの CSP 違反レポートを受け付ける。本文には CSV 内容や URL 一覧は
  // 含まれない想定だが、念のため内容は読み捨ててログにも出さない。
  await readBody(req).catch(() => {});
  res.writeHead(204, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store'
  });
  res.end();
}

async function handleCheck(req, res) {
  const body = await readJson(req);
  const analysis = analyzeCsv(requireCsv(body));
  const options = sanitizeOptions(body.options);

  const encoding = selectEncoding(req.headers['accept-encoding']);
  const headers = {
    ...SECURITY_HEADERS,
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Accept-Encoding'
  };

  let out = res;
  let compressor = null;
  let completion;
  let connected = true;
  const disconnected = new AbortController();
  let draining;
  res.on('close', () => {
    connected = false;
    disconnected.abort();
    if (!res.writableFinished) compressor?.destroy();
  });
  if (encoding) {
    compressor = encoding === 'br' ? createBrotliCompress() : createGzip();
    headers['content-encoding'] = encoding;
    res.writeHead(200, headers);
    completion = new Promise((resolvePromise) => {
      const cleanup = finished(compressor, (error) => {
        cleanup();
        if (error) {
          connected = false;
          res.destroy();
        }
        resolvePromise();
      });
    });
    compressor.pipe(res);
    out = compressor;
  } else {
    res.writeHead(200, headers);
  }

  const send = async (payload) => {
    if (!connected || res.writableEnded) return;
    if (!out.write(`${JSON.stringify(payload)}\n`)) {
      // Concurrent results share one drain listener while the writable is full.
      draining ??= once(out, 'drain', { signal: disconnected.signal })
        .finally(() => { draining = null; });
      await draining;
    }
    if (!connected || res.writableEnded) return;
    compressor?.flush(encoding === 'br' ? constants.BROTLI_OPERATION_FLUSH : constants.Z_SYNC_FLUSH);
  };

  try {
    await send({ type: 'analysis', analysis });
    await send({
      type: 'start',
      total: analysis.urls.length,
      checkable: analysis.summary.checkable
    });

    const counts = { ok: 0, warn: 0, dead: 0, error: 0, skipped: 0 };
    let completed = 0;

    await runChecks(analysis.urls, options, {
      shouldStop: () => !connected,
      onResult(result) {
        counts[result.level] = (counts[result.level] ?? 0) + 1;
        completed += 1;
        return send({
          type: 'result',
          result,
          progress: { completed, total: analysis.urls.length, counts }
        });
      }
    });

    await send({
      type: 'done',
      progress: { completed, total: analysis.urls.length, counts },
      summary: { ...analysis.summary, ...counts }
    });

    if (compressor) {
      if (!compressor.destroyed) compressor.end();
      await completion;
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    compressor?.destroy();
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, relative);

  if (!filePath.startsWith(resolve(PUBLIC_DIR) + sep)) {
    throw new HttpError(404, 'Not Found');
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    throw new HttpError(404, 'Not Found');
  }

  const headers = {
    ...SECURITY_HEADERS,
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': cacheControlForStatic(relative),
    vary: 'Accept-Encoding'
  };

  const encoding = selectEncoding(req.headers['accept-encoding'], data.length < 1024);
  if (encoding) {
    data = await compressBody(data, encoding);
    headers['content-encoding'] = encoding;
  }

  headers['content-length'] = data.length;
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(data);
}

export function createApp() {
  return createServer(async (req, res) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(key, value);
    }

    try {
      // Negotiate before routing so error responses also have an acceptable representation.
      selectEncoding(req.headers['accept-encoding']);
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/api/health') {
        await sendJson(req, res, 200, { ok: true, mode: DEPLOYED ? 'deployed' : 'local' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        await handleAnalyze(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/check') {
        await handleCheck(req, res);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/csp-report') {
        await handleCspReport(req, res);
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res);
        return;
      }

      await sendJson(req, res, 405, { error: 'Method Not Allowed' });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }

      if (error instanceof HttpError && error.status === 406) {
        res.writeHead(406, { 'cache-control': 'no-store', vary: 'Accept-Encoding' });
        res.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : 'サーバーエラーが発生しました';
      if (status === 500) console.error(error);
      await sendJson(req, res, status, { error: message });
    }
  });
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp();

  server.listen(port, host, () => {
    console.log(`Acid Tabs CSV Checker: http://${host}:${port}`);
    console.log('CSV は保存されません。終了するには Ctrl+C。');
  });

  // コンテナ / PaaS からの停止シグナルで処理中のリクエストを打ち切らないようにする
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} を受信しました。サーバーを停止します。`);

    const forceExit = setTimeout(() => process.exit(1), 10000);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });

    // keep-alive 接続が残っていても停止できるようにする
    server.closeIdleConnections?.();
    setTimeout(() => server.closeAllConnections?.(), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
