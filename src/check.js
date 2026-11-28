import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isDeployed } from './config.js';
import { describeRdap, lookupRdap, registrableDomain } from './rdap.js';
import { combineSignals } from './signals.js';
import {
  BlockedTargetError,
  assertHttpUrl,
  resolvePublicAddresses
} from './ssrf.js';

const USER_AGENT = 'acid-tabs-checker (local, stateless)';

// 応答しないホストを待ち続けると、その分だけ関数の実行時間（＝課金対象）が延びる
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * DNS 解決の待ち時間の上限。
 * 実行全体の中断（クライアント切断・実行予算超過）でも待つのをやめ、
 * ワーカーが並列枠を解放できるようにする。
 */
function withDeadline(promise, ms, stopSignal) {
  // 打ち切り後に元の Promise が失敗しても未処理の拒否にしない
  promise.catch(() => {});

  let timer;
  let onStop;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' }));
    }, ms);

    if (stopSignal) {
      onStop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (stopSignal.aborted) onStop();
      else stopSignal.addEventListener('abort', onStop, { once: true });
    }
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    if (onStop) stopSignal.removeEventListener('abort', onStop);
  });
}

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
      // 名前解決が返らないホストでもリダイレクト追跡を止めない
      await withDeadline(
        resolvePublicAddresses(target.host, context.lookup),
        context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        combineSignals(context.signal, context.stopSignal)
      );
    }

    const response = await context.fetchImpl(targetHref, {
      method,
      redirect: 'manual',
      signal: combineSignals(context.signal, context.stopSignal),
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

/**
 * 同一の追加確認を 1 回の実行内で共有する。
 * 同じホストの URL が何件あっても、トップページや www の確認は 1 回で済む。
 */
function sharedProbe(cache, key, factory) {
  if (!cache) return factory();

  let promise = cache.get(key);
  if (!promise) {
    promise = factory();
    cache.set(key, promise);
  }
  return promise;
}

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

  const rootUrl = `${parsed.origin}/`;

  return sharedProbe(context.probeCache, `root ${rootUrl}`, async () => {
    let status = null;
    try {
      const { response } = await requestWithFallback(rootUrl, {
        ...context,
        signal: AbortSignal.timeout(Math.min(timeoutMs, ROOT_PROBE_TIMEOUT_MS))
      });
      status = response.status;
    } catch {
      // トップページの確認失敗はリンク切れ判定には影響させない
    }

    return rootStatusNotice(status);
  });
}

/**
 * DNS 解決に失敗したドメインだけ、登録情報（有効期限）を RDAP で確認する。
 * 同じ登録ドメインの URL が何件あっても問い合わせは 1 回に共有する。
 */
async function probeRdap(host, context) {
  if (context.stopSignal?.aborted) return null;

  const domain = registrableDomain(host);
  if (!domain) return null;

  return sharedProbe(context.probeCache, `rdap ${domain}`, () =>
    lookupRdap(domain, {
      fetchImpl: context.rdapFetchImpl,
      lookup: context.lookup,
      signal: context.stopSignal
    })
  );
}

/**
 * RDAP の確認結果を detail に追記する。
 * 登録情報は補足であり、URL 自体の到達性は変わらないため level は変更しない。
 */
function applyRdapNotice(result, probe) {
  if (!probe) return result;

  if (!probe.ok) {
    result.detail = `${result.detail} / ${probe.reason}`;
    return result;
  }

  result.detail = `${result.detail} / ${describeRdap(probe)}`;
  if (probe.expiration) result.expiration = probe.expiration;
  return result;
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
  // 中断済みなら追加の通信を始めない（待ち時間と課金対象を増やさない）
  if (context.stopSignal?.aborted) return null;

  const alternative = withWwwHost(urlString);
  if (!alternative) return null;

  return sharedProbe(context.probeCache, `www ${alternative}`, async () => {
    try {
      const probeTimeout = Math.min(timeoutMs, WWW_PROBE_TIMEOUT_MS);
      const { response } = await requestWithFallback(alternative, {
        ...context,
        // リダイレクト追跡内の DNS 待ちも 3 秒の上限に収める
        timeoutMs: probeTimeout,
        signal: AbortSignal.timeout(probeTimeout)
      });
      return { url: alternative, status: response.status };
    } catch {
      // www 付きの確認失敗は元 URL の判定には影響させない
      return { url: alternative, status: null };
    }
  });
}

/** www 付きの確認結果を、元 URL の判定を変えずに記録する。 */
function applyWwwProbe(result, probe) {
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

/**
 * 通信結果を共有してよい単位を表すキー。
 * entry.normalized は重複表示用にスキームとポートを落とすため、
 * 別々に確認すべき URL（http と https、ポート違い）まで同一視してしまう。
 */
function networkKey(entry) {
  try {
    const parsed = new URL(entry.url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return entry.normalized || entry.url;
  }
}

const STOPPED_DETAIL = '中断または時間切れのため未チェック（対象を絞って再実行してください）';

/** 中断で打ち切られた行を「未チェック」として記録する。 */
function markStopped(result) {
  result.dns = 'skipped';
  result.http = 'skipped';
  result.www = 'skipped';
  result.wwwStatus = null;
  result.wwwUrl = '';
  result.status = null;
  result.level = 'skipped';
  result.detail = STOPPED_DETAIL;
  return result;
}

/** 元 URL が失敗した結果に、www 付きの確認結果を記録する。 */
async function appendWwwNotice(result, context, timeoutMs) {
  return applyWwwProbe(result, await probeWwwAlternative(result.url, context, timeoutMs));
}

/** 1 件の URL に対して DNS / HTTP チェックを行う。 */
export async function checkOne(entry, options, deps) {
  const {
    dns,
    http,
    www = true,
    rdap = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    strictPorts = false
  } = options;
  const checkWww = www !== false;
  const checkRdap = rdap === true;

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
    expiration: null,
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
    rdapFetchImpl: deps.rdapFetchImpl,
    strictPorts,
    timeoutMs,
    probeCache: deps.probeCache,
    stopSignal: deps.stopSignal
  };

  // 接続先の検証は DNS チェックの有無にかかわらず必ず行う
  let addresses;
  try {
    addresses = await withDeadline(
      resolvePublicAddresses(entry.host, deps.lookup),
      timeoutMs,
      deps.stopSignal
    );
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      result.level = 'error';
      result.detail = `ブロック: ${error.message}`;
      return result;
    }

    // 中断による打ち切りは失敗ではないため、未着手の行と同じ扱いにする
    if (deps.stopSignal?.aborted) return markStopped(result);

    if (dns) result.dns = 'fail';
    result.level = 'error';
    result.detail = `DNS 解決失敗 (${error?.code || error?.message || 'unknown'})`;

    // 名前が引けないドメインだけ登録情報を補う（登録切れの切り分けに使う）
    const [withWww, rdapProbe] = await Promise.all([
      checkWww ? appendWwwNotice(result, probeContext, timeoutMs) : result,
      checkRdap ? probeRdap(entry.host, probeContext) : null
    ]);
    return applyRdapNotice(withWww, rdapProbe);
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
      timeoutMs,
      stopSignal: deps.stopSignal,
      signal: AbortSignal.timeout(timeoutMs)
    });

    result.http = 'ok';
    result.status = response.status;
    result.method = method;
    result.level = classifyHttpStatus(response.status);

    if (result.level === 'dead') {
      // トップページと www の確認は互いに独立しているため同時に走らせる
      const [rootNotice, wwwProbe] = await Promise.all([
        describeDomainRoot(entry.url, probeContext, timeoutMs),
        checkWww ? probeWwwAlternative(entry.url, probeContext, timeoutMs) : null
      ]);
      result.detail = rootNotice
        ? `HTTP ${response.status} (リンク切れ / ${rootNotice})`
        : `HTTP ${response.status} (リンク切れ)`;
      applyWwwProbe(result, wwwProbe);
    } else if (result.level === 'warn') {
      result.detail = `HTTP ${response.status} (アクセス制限またはサーバーエラー)`;
    } else if (result.level === 'error') {
      result.detail = `HTTP ${response.status} (サーバーエラー)`;
      if (checkWww) await appendWwwNotice(result, probeContext, timeoutMs);
    } else {
      result.detail = `HTTP ${response.status}`;
    }
  } catch (error) {
    if (deps.stopSignal?.aborted && !(error instanceof BlockedTargetError)) {
      return markStopped(result);
    }

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
// プロキシやプラットフォーム側の上限より手前で打ち切り、ストリームが途中で切れないようにする。
const DEFAULT_BUDGET_MS = 240000;
const STOP_POLL_INTERVAL_MS = 250;

export async function runChecks(entries, options = {}, hooks = {}) {
  const {
    dns = true,
    http = true,
    www = true,
    rdap = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = 30,
    budgetMs = DEFAULT_BUDGET_MS,
    strictPorts = isDeployed()
  } = options;

  const startedAt = Date.now();
  const outOfBudget = () => budgetMs > 0 && Date.now() - startedAt >= budgetMs;

  const baseLookup = hooks.lookup ?? ((host) => dnsLookup(host));

  // 1 回の実行内では解決結果を使い回す（DNS 問い合わせの削減と再解決の抑止）
  const cache = new Map();
  const lookup = (host, lookupOptions) => {
    const key = `${host}|${lookupOptions?.all ? 'all' : 'one'}`;
    if (!cache.has(key)) cache.set(key, baseLookup(host, lookupOptions));
    return cache.get(key);
  };

  // クライアントが切断したら、実行中の通信も打ち切って課金対象時間を延ばさない
  const stop = new AbortController();
  const deps = {
    lookup,
    fetchImpl: hooks.fetchImpl ?? globalThis.fetch,
    rdapFetchImpl: hooks.rdapFetchImpl ?? globalThis.fetch,
    // トップページ / www の追加確認を 1 回の実行で共有する
    probeCache: new Map(),
    stopSignal: stop.signal
  };

  const checkOptions = { dns, http, www, rdap, timeoutMs, strictPorts };

  // 同じ URL を指す行（表記ゆれ・重複）は 1 回だけ通信し、結果を複製する
  const shared = new Map();
  const checkShared = (entry) => {
    if (!entry.checkable) return checkOne(entry, checkOptions, deps);

    const key = networkKey(entry);

    let promise = shared.get(key);
    if (!promise) {
      promise = checkOne(entry, checkOptions, deps);
      shared.set(key, promise);
    }
    return promise;
  };

  const results = new Array(entries.length);
  let cursor = 0;
  let active = 0;
  let completed = 0;

  const targetConcurrency = Math.max(1, Math.min(concurrency, entries.length || 1));
  const step = Math.max(1, Math.min(CONCURRENCY_RAMP_STEP, targetConcurrency));
  let desiredConcurrency = Math.min(step, targetConcurrency);

  let watcher;

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

      if (hooks.shouldStop?.() || outOfBudget()) {
        stop.abort();
        if (active === 0) finish();
        return;
      }

      while (active < desiredConcurrency && cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        active += 1;

        checkShared(entries[index])
          .then(async (shared) => {
            // 共有した結果は行ごとに独立したコピーとして返す
            // （カテゴリや表記は行ごとに異なるため、識別情報は元の行から取り直す）
            const entry = entries[index];
            const result =
              shared.id === entry.id
                ? shared
                : {
                    ...shared,
                    id: entry.id,
                    raw: entry.raw,
                    host: entry.host,
                    url: entry.url,
                    type: entry.type,
                    category: entry.emoji
                  };
            results[index] = result;
            await hooks.onResult?.(result, index);
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
              (cursor >= entries.length || hooks.shouldStop?.() || outOfBudget())
            ) {
              finish();
            } else {
              pump();
            }
          });
      }

      if (active === 0 && (cursor >= entries.length || hooks.shouldStop?.() || outOfBudget())) {
        finish();
      }
    };

    // 実行中の通信がすべて固まっても中断できるよう、状態を定期的に見張る
    watcher = setInterval(() => {
      if (settled) return;
      if (hooks.shouldStop?.() || outOfBudget()) {
        stop.abort();
        if (active === 0) finish();
      }
    }, STOP_POLL_INTERVAL_MS);

    pump();
  }).finally(() => {
    clearInterval(watcher);
    // 失敗で打ち切る場合も実行中の通信を止める（完了済みなら対象がない）
    stop.abort();
  });

  // 時間切れで着手できなかった URL は「未チェック」として明示する
  // （new Array(n) は疎配列なので forEach では穴が飛ばされる）
  const unfinished = [];
  for (let index = 0; index < results.length; index += 1) {
    if (results[index]) continue;
    const entry = entries[index];
    const skipped = {
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
      detail: STOPPED_DETAIL
    };
    results[index] = skipped;
    unfinished.push([skipped, index]);
  }

  for (const [skipped, index] of unfinished) {
    await hooks.onResult?.(skipped, index);
  }

  return results;
}
