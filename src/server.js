import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeCsv } from './parse.js';
import { runChecks } from './check.js';

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

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
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
    timeoutMs: clampInt(raw.timeoutMs, 1000, 30000, 10000),
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
  sendJson(res, 200, { analysis });
}

async function handleCheck(req, res) {
  const body = await readJson(req);
  const analysis = analyzeCsv(requireCsv(body));
  const options = sanitizeOptions(body.options);

  let connected = true;
  res.on('close', () => {
    connected = false;
  });

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store'
  });

  const send = (payload) => {
    if (!connected || res.writableEnded) return;
    res.write(`${JSON.stringify(payload)}\n`);
  };

  send({ type: 'analysis', analysis });
  send({
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
      send({
        type: 'result',
        result,
        progress: { completed, total: analysis.urls.length, counts }
      });
    }
  });

  send({
    type: 'done',
    progress: { completed, total: analysis.urls.length, counts },
    summary: { ...analysis.summary, ...counts }
  });

  if (!res.writableEnded) res.end();
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

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-length': data.length
  });

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
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, mode: DEPLOYED ? 'deployed' : 'local' });
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

      if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(req, res);
        return;
      }

      sendJson(res, 405, { error: 'Method Not Allowed' });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }

      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : 'サーバーエラーが発生しました';
      if (status === 500) console.error(error);
      sendJson(res, status, { error: message });
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
