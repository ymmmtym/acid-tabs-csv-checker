import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { combineSignals } from './signals.js';
import { BlockedTargetError, assertHttpUrl, resolvePublicAddresses } from './ssrf.js';

/**
 * 登録可能ドメイン（eTLD+1）の導出に使う 2 段階サフィックス。
 * public suffix list 全体は持たず、登録単位が 3 ラベル以上になるものだけを扱う。
 * ここに無いサフィックスは「最後の 2 ラベル」を登録単位とみなす。
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in',
  'com.tw', 'net.tw', 'org.tw', 'idv.tw',
  'co.za', 'org.za', 'net.za',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.my', 'com.ph', 'com.vn',
  'co.id', 'or.id', 'web.id', 'ac.id',
  'co.il', 'org.il', 'ac.il',
  'com.ua', 'com.pl', 'com.ru', 'com.es', 'com.pt'
]);

/**
 * ホスト名から RDAP に問い合わせる登録可能ドメインを返す。
 * IP リテラルやラベルが 1 つのホストは対象外として null を返す。
 */
export function registrableDomain(host) {
  if (!host) return null;
  if (isIP(String(host).replace(/^\[|\]$/g, '')) !== 0) return null;

  const labels = String(host).toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length < 2) return null;
  if (labels.some((label) => label === '')) return null;

  const lastTwo = labels.slice(-2).join('.');
  const take = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  if (labels.length < take) return null;

  return labels.slice(-take).join('.');
}

/** RDAP の events 配列から指定したアクションの日付を取り出す。 */
function eventDate(events, action) {
  const found = events?.find((event) => event?.eventAction === action);
  const value = found?.eventDate;
  if (typeof value !== 'string') return null;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** 有効期限までの残り日数。期限が取れない場合は null。 */
export function daysUntil(dateString, now = Date.now()) {
  if (!dateString) return null;
  const target = new Date(`${dateString}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - now) / 86400000);
}

/**
 * RDAP のレスポンスから表示に使う項目だけを取り出す。
 * 登録者名や連絡先は取り出さない（個人情報を画面に出さないため）。
 */
export function summarizeRdap(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (typeof payload.ldhName !== 'string' || payload.ldhName === '') return null;

  const events = Array.isArray(payload.events) ? payload.events : [];
  const expiration = eventDate(events, 'expiration');
  const registration = eventDate(events, 'registration');
  const statuses = Array.isArray(payload.status)
    ? payload.status.filter((status) => typeof status === 'string')
    : [];

  return {
    domain: payload.ldhName.toLowerCase(),
    expiration,
    registration,
    statuses
  };
}

/** RDAP の結果を、結果一覧の detail に足す 1 行にまとめる。 */
export function describeRdap(summary, now = Date.now()) {
  if (!summary?.domain) return '';

  const days = daysUntil(summary.expiration, now);
  if (days === null) {
    return `${summary.domain} の有効期限は取得できませんでした`;
  }

  const expired = days <= 0;
  const label = expired
    ? `${summary.domain} は有効期限を過ぎています (${summary.expiration})`
    : `${summary.domain} の有効期限まで ${days} 日 (${summary.expiration})`;

  // 30 日を切ったら更新忘れの可能性があるため、注意として扱う
  return days <= 30 ? `${label} — 期限切れ間近` : label;
}

const RDAP_ENDPOINT = 'https://rdap.org/domain/';
const RDAP_TIMEOUT_MS = 4000;
// rdap.org は User-Agent の無い要求を 403 で拒否する
const RDAP_USER_AGENT = 'acid-tabs-checker (stateless csv checker)';
const RDAP_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
 * RDAP のリダイレクトを手動で追跡する。
 * rdap.org はドメイン名を含む URL を登録機関の RDAP サーバーへ 302 で転送するため、
 * 各ホップでスキームと接続先を検証する（`redirect: 'follow'` では検証できない）。
 */
async function fetchRdap(url, context) {
  let currentUrl = url;

  for (let hop = 0; hop <= RDAP_MAX_REDIRECTS; hop += 1) {
    const target = assertHttpUrl(currentUrl);
    // 転送先にもドメイン名が渡るため、平文の http への降格は許可しない
    if (target.url.protocol !== 'https:') {
      throw new BlockedTargetError('RDAP の転送先が HTTPS ではありません');
    }

    if (isIP(target.host) === 0) {
      await resolvePublicAddresses(target.host, context.lookup);
    }

    const response = await context.fetchImpl(target.url.href, {
      redirect: 'manual',
      signal: context.signal,
      headers: {
        accept: 'application/rdap+json, application/json',
        'user-agent': RDAP_USER_AGENT
      }
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = headerValue(response, 'location');
    await discardBody(response);
    if (!location) return response;
    if (hop === RDAP_MAX_REDIRECTS) {
      throw new BlockedTargetError('RDAP のリダイレクト回数が上限を超えました');
    }

    currentUrl = new URL(location, target.url.href).href;
  }

  throw new BlockedTargetError('RDAP のリダイレクト回数が上限を超えました');
}

/**
 * 登録可能ドメインの有効期限を RDAP で確認する。
 * 失敗しても例外は投げず、確認できなかった理由を返す。
 */
export async function lookupRdap(
  domain,
  { fetchImpl, lookup, timeoutMs = RDAP_TIMEOUT_MS, signal } = {}
) {
  const url = `${RDAP_ENDPOINT}${encodeURIComponent(domain)}`;

  try {
    const response = await fetchRdap(url, {
      fetchImpl: fetchImpl ?? globalThis.fetch,
      // resolvePublicAddresses は { all: true } で全アドレスを検証するため、lookup をそのまま渡す
      lookup: lookup ?? dnsLookup,
      // 実行の中断（クライアント切断・予算超過）でも RDAP の待ち時間を残さない
      signal: combineSignals(signal, AbortSignal.timeout(timeoutMs))
    });

    if (response.status === 404) {
      // rdap.org は「TLD が RDAP 非対応」と「ドメインが未登録」をどちらも 404 で返す。
      // 前者だけが本文に説明を持つため、切り分けて表示する。
      const body = await response.json().catch(() => null);
      const title = typeof body?.title === 'string' ? body.title : '';
      return {
        ok: false,
        reason: /no rdap service/i.test(title)
          ? 'この TLD は RDAP に未対応です'
          : 'ドメインが登録されていません'
      };
    }
    if (!response.ok) {
      return { ok: false, reason: `RDAP が HTTP ${response.status} を返しました` };
    }

    const payload = await response.json();
    const summary = summarizeRdap(payload);
    if (!summary?.domain) {
      return { ok: false, reason: 'RDAP の応答を解釈できませんでした' };
    }

    return { ok: true, ...summary };
  } catch (error) {
    if (error instanceof BlockedTargetError) {
      return { ok: false, reason: `RDAP の接続先を拒否しました (${error.message})` };
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, reason: 'RDAP がタイムアウトしました' };
    }
    return { ok: false, reason: `RDAP に接続できませんでした (${error?.message || 'unknown'})` };
  }
}
