import { isIP } from 'node:net';
import { assertHttpUrl } from './ssrf.js';

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

/**
 * 登録可能ドメインの有効期限を RDAP で確認する。
 * 失敗しても例外は投げず、確認できなかった理由を返す。
 */
export async function lookupRdap(domain, { fetchImpl, timeoutMs = RDAP_TIMEOUT_MS } = {}) {
  const url = `${RDAP_ENDPOINT}${encodeURIComponent(domain)}`;

  // 問い合わせ先は固定だが、リダイレクト先も含めて SSRF の検証を通す
  const { url: safeUrl } = assertHttpUrl(url);

  try {
    const response = await (fetchImpl ?? globalThis.fetch)(safeUrl.href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/rdap+json, application/json',
        'user-agent': RDAP_USER_AGENT
      }
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
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, reason: 'RDAP がタイムアウトしました' };
    }
    return { ok: false, reason: `RDAP に接続できませんでした (${error?.message || 'unknown'})` };
  }
}
