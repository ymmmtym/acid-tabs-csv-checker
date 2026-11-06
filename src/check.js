import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  BlockedTargetError,
  assertHttpUrl,
  resolvePublicAddresses
} from './ssrf.js';

const USER_AGENT = 'acid-tabs-checker (local, stateless)';
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// HEAD と GET で挙動が異なるサーバーがあるため、疑わしいステータスでは GET で確認する
const RETRY_WITH_GET_STATUSES = new Set([404, 405, 410, 501]);

/** HTTP ステータスを結果レベルに変換する。 */
export function classifyHttpStatus(status) {
  if (!Number.isFinite(status)) return 'error';
  if (status === 404 || status === 410) return 'dead';
  if (status >= 500) return 'error';
  if (status === 401 || status === 403 || status === 429) return 'warn';
  if (status >= 400) return 'warn';
  return 'ok';
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // 破棄できなくても結果には影響しない
  }
}

/**
 * リダイレクトを手動で追跡し、各ホップの接続先を検証する。
 * 検証に失敗した場合は BlockedTargetError を投げる。
 */
async function followRedirects(startUrl, method, context) {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = assertHttpUrl(currentUrl, { strictPorts: context.strictPorts });
    const targetHref = target.url.href;

    if (isIP(target.host) === 0) {
      await resolvePublicAddresses(target.host, context.lookup);
    }

    const response = await context.fetchImpl(targetHref, {
      method,
      redirect: 'manual',
      signal: context.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
      }
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      return { response, url: targetHref };
    }

    const location = headerValue(response, 'location');
    await discardBody(response);

    if (!location) return { response, url: targetHref };
    if (hop === MAX_REDIRECTS) {
      throw new BlockedTargetError('リダイレクト回数が上限を超えました');
    }

    currentUrl = new URL(location, targetHref).href;
  }

  throw new BlockedTargetError('リダイレクト回数が上限を超えました');
}

async function requestWithFallback(url, context) {
  const { response } = await followRedirects(url, 'HEAD', context);

  // HEAD を拒否・誤判定するサーバーには GET で再試行する
  if (RETRY_WITH_GET_STATUSES.has(response.status)) {
    const retried = await followRedirects(url, 'GET', context);
    return { response: retried.response, method: 'GET' };
  }

  return { response, method: 'HEAD' };
}

const ROOT_PROBE_TIMEOUT_MS = 3000;

function rootStatusNotice(status) {
  if (status === null) {
    return 'ドメインのトップページは確認できませんでした';
  }

  const level = classifyHttpStatus(status);
  if (level === 'dead') return `ドメインのトップページも${status}`;
  if (level === 'error') return `ドメインのトップページはサーバーエラー (HTTP ${status})`;
  if (level === 'warn') return `ドメインのトップページは応答あり (HTTP ${status})`;
  return 'ドメインのトップページは応答あり';
}

/**
 * パス付き URL が 404/410 のとき、同じドメインのトップページの状態を補足する。
 * 判定自体は変更せず、詳細メッセージ用の文字列だけを返す。
 */
async function describeDomainRoot(urlString, context, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }

  if (parsed.pathname === '/' || parsed.pathname === '') return null;

  let status = null;
  try {
    const { response } = await requestWithFallback(`${parsed.origin}/`, {
      ...context,
      signal: AbortSignal.timeout(Math.min(timeoutMs, ROOT_PROBE_TIMEOUT_MS))
    });
    status = response.status;
  } catch {
    // トップページの確認失敗はリンク切れ判定には影響させない
  }

  return rootStatusNotice(status);
}

function errorDetail(error, timeoutMs) {
  if (error instanceof BlockedTargetError) {
    return `ブロック: ${error.message}`;
  }

  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `タイムアウト (${timeoutMs}ms)`;
  }

  const code = error?.cause?.code || error?.code || error?.message || 'unknown';
  return `接続失敗 (${code})`;
}

const WWW_PROBE_TIMEOUT_MS = 3000;

/**
 * 元 URL のホストに www. を付けた URL を返す。
 * IP リテラル、localhost、すでに www. で始まるホストは対象外。
 */
function withWwwHost(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }

  const hostname = parsed.hostname;
  if (!hostname) return null;
  if (isIP(hostname) !== 0) return null;
  if (hostname.startsWith('www.')) return null;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;

  parsed.hostname = `www.${hostname}`;
  return parsed.href;
}

/**
 * 元 URL が失敗したとき、www. 付きの URL が応答するか確認する。
 * 確認した場合は結果を返し、対象外なら null を返す。
 */
async function probeWwwAlternative(urlString, context, timeoutMs) {
  const alternative = withWwwHost(urlString);
  if (!alternative) return null;

  try {
    const { response } = await requestWithFallback(alternative, {
      ...context,
      signal: AbortSignal.timeout(Math.min(timeoutMs, WWW_PROBE_TIMEOUT_MS))
    });
    return { url: alternative, status: response.status };
  } catch {
    // www 付きの確認失敗は元 URL の判定には影響させない
    return { url: alternative, status: null };
  }
}

/** 元 URL が失敗した結果に、www 付きの確認結果を記録する。 */
async function appendWwwNotice(result, context, timeoutMs) {
  const probe = await probeWwwAlternative(result.url, context, timeoutMs);
  if (!probe) return result;

  const ok = classifyHttpStatus(probe.status) === 'ok';
  result.www = ok ? 'ok' : 'fail';
  result.wwwStatus = probe.status;
  result.wwwUrl = probe.url;

  if (ok) {
    const notice = `www 付きでは応答あり (HTTP ${probe.status})`;
    result.detail = result.detail ? `${result.detail} / ${notice}` : notice;
  }

  return result;
}

/** 1 件の URL に対して DNS / HTTP チェックを行う。 */
export async function checkOne(entry, options, deps) {
  const { dns, http, www = true, timeoutMs, strictPorts = false } = options;
  const checkWww = www !== false;

  const result = {
    id: entry.id,
    raw: entry.raw,
    host: entry.host,
    url: entry.url,
    type: entry.type,
    category: entry.emoji,
    dns: 'skipped',
    http: 'skipped',
    www: 'skipped',
    wwwStatus: null,
    wwwUrl: '',
    status: null,
    level: 'skipped',
    detail: ''
  };

  if (!entry.checkable) {
    result.detail = entry.reason || 'チェック対象外';
    return result;
  }

  const probeContext = {
    fetchImpl: deps.fetchImpl,
    lookup: deps.lookup,
    strictPorts
  };

  // 接続先の検証は DNS チェックの有無にかかわらず必ず行う
  let addresses;
  try {
    addresses = await resolvePublicAddresses(entry.host, deps.lookup);
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      result.level = 'error';
      result.detail = `ブロック: ${error.message}`;
      return result;
    }

    if (dns) result.dns = 'fail';
    result.level = 'error';
    result.detail = `DNS 解決失敗 (${error?.code || error?.message || 'unknown'})`;
    return checkWww
      ? appendWwwNotice(result, probeContext, timeoutMs)
      : result;
  }

  if (dns) {
    result.dns = 'ok';
    result.dnsAddress = addresses[0] ?? '';
  }

  if (!http) {
    result.level = 'ok';
    result.detail = `DNS OK${result.dnsAddress ? ` (${result.dnsAddress})` : ''}`;
    return result;
  }

  try {
    const { response, method } = await requestWithFallback(entry.url, {
      fetchImpl: deps.fetchImpl,
      lookup: deps.lookup,
      strictPorts,
      signal: AbortSignal.timeout(timeoutMs)
    });

    result.http = 'ok';
    result.status = response.status;
    result.method = method;
    result.level = classifyHttpStatus(response.status);

    if (result.level === 'dead') {
      const rootNotice = await describeDomainRoot(
        entry.url,
        {
          fetchImpl: deps.fetchImpl,
          lookup: deps.lookup,
          strictPorts
        },
        timeoutMs
      );
      result.detail = rootNotice
        ? `HTTP ${response.status} (リンク切れ / ${rootNotice})`
        : `HTTP ${response.status} (リンク切れ)`;
    } else if (result.level === 'warn') {
      result.detail = `HTTP ${response.status} (アクセス制限またはサーバーエラー)`;
    } else if (result.level === 'error') {
      result.detail = `HTTP ${response.status} (サーバーエラー)`;
    } else {
      result.detail = `HTTP ${response.status}`;
    }

    // 元 URL が失敗している場合だけ www. 付きの応答を補足する
    if (checkWww && (result.level === 'dead' || result.level === 'error')) {
      await appendWwwNotice(result, probeContext, timeoutMs);
    }
  } catch (error) {
    result.http = 'fail';
    result.level = 'error';
    result.detail = errorDetail(error, timeoutMs);

    if (checkWww && !(error instanceof BlockedTargetError)) {
      await appendWwwNotice(result, probeContext, timeoutMs);
    }
  }

  return result;
}

/**
 * 複数 URL を並列にチェックする。
 * 並列数は 6 から始めて、6 件完了するごとに 6 ずつ増やし、指定値（既定 30）で頭打ちにする。
 * hooks.onResult で完了ごとに結果を受け取れる（ストリーミング用）。
 */
const CONCURRENCY_RAMP_STEP = 6;

export async function runChecks(entries, options = {}, hooks = {}) {
  const {
    dns = true,
    http = true,
    www = true,
    timeoutMs = 10000,
    concurrency = 30,
    strictPorts = process.env.APP_ENV === 'deployed' || Boolean(process.env.VERCEL)
  } = options;

  const baseLookup = hooks.lookup ?? ((host) => dnsLookup(host));

  // 1 回の実行内では解決結果を使い回す（DNS 問い合わせの削減と再解決の抑止）
  const cache = new Map();
  const lookup = (host, lookupOptions) => {
    const key = `${host}|${lookupOptions?.all ? 'all' : 'one'}`;
    if (!cache.has(key)) cache.set(key, baseLookup(host, lookupOptions));
    return cache.get(key);
  };

  const deps = {
    lookup,
    fetchImpl: hooks.fetchImpl ?? globalThis.fetch
  };

  const checkOptions = { dns, http, www, timeoutMs, strictPorts };

  const results = new Array(entries.length);
  let cursor = 0;
  let active = 0;
  let completed = 0;

  const targetConcurrency = Math.max(1, Math.min(concurrency, entries.length || 1));
  const step = Math.max(1, Math.min(CONCURRENCY_RAMP_STEP, targetConcurrency));
  let desiredConcurrency = Math.min(step, targetConcurrency);

  await new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const pump = () => {
      if (settled) return;

      if (hooks.shouldStop?.()) {
        if (active === 0) finish();
        return;
      }

      while (active < desiredConcurrency && cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        active += 1;

        checkOne(entries[index], checkOptions, deps)
          .then((result) => {
            results[index] = result;
            hooks.onResult?.(result, index);
          })
          .catch(fail)
          .finally(() => {
            active -= 1;
            completed += 1;

            if (settled) return;

            if (completed % step === 0) {
              desiredConcurrency = Math.min(
                desiredConcurrency + step,
                targetConcurrency
              );
            }

            if (
              active === 0 &&
              (cursor >= entries.length || hooks.shouldStop?.())
            ) {
              finish();
            } else {
              pump();
            }
          });
      }

      if (active === 0 && (cursor >= entries.length || hooks.shouldStop?.())) {
        finish();
      }
    };

    pump();
  });

  return results;
}
