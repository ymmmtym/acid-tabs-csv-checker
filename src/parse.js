const SPECIAL_SCHEMES = new Set([
  'chrome',
  'chrome-extension',
  'moz-extension',
  'edge',
  'about',
  'file',
  'view-source',
  'data',
  'javascript',
  'mailto',
  'tel'
]);

const PRIVATE_SUFFIXES = ['.local', '.localhost', '.home', '.lan', '.internal'];
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function invalid(reason) {
  return {
    type: 'invalid',
    host: null,
    url: null,
    checkable: false,
    normalized: '',
    reason
  };
}

function isPrivateIpv4(host) {
  const match = IPV4_RE.exec(host);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;

  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function buildUrl(token, scheme, rest) {
  return scheme ? token : `https://${rest}`;
}

function normalizedKey(token, type, url) {
  if (type === 'domain' || type === 'ip') {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
    } catch {
      // フォールバックして文字列ベースで正規化する
    }
  }

  return token
    .toLowerCase()
    .replace(/#.*$/, '')
    .replace(/\/+$/, '');
}

/**
 * URL パターン 1 件を分類する。
 * ネットワークチェックの対象になるのは domain / ip のみ。
 */
export function classifyToken(input) {
  const token = String(input ?? '').trim();
  if (!token) return invalid('空の URL です');

  if (token.includes('*')) {
    return {
      type: 'wildcard',
      host: null,
      url: null,
      checkable: false,
      normalized: token.toLowerCase().replace(/\/+$/, ''),
      reason: 'ワイルドカードのため自動チェック対象外'
    };
  }

  let scheme = null;
  let rest = token;

  const schemeWithSlashes = /^([a-z][a-z0-9+.-]*):\/\//i.exec(token);
  if (schemeWithSlashes) {
    scheme = schemeWithSlashes[1].toLowerCase();
    rest = token.slice(schemeWithSlashes[0].length);
  } else {
    const bareScheme = /^([a-z][a-z0-9+.-]*):/i.exec(token);
    if (bareScheme) {
      const candidate = bareScheme[1].toLowerCase();
      if (SPECIAL_SCHEMES.has(candidate)) {
        scheme = candidate;
      } else if (candidate === 'http' || candidate === 'https') {
        scheme = candidate;
        rest = token.slice(bareScheme[0].length);
      }
    }

    if (!scheme) rest = token.replace(/^\/\//, '');
  }

  if (scheme && scheme !== 'http' && scheme !== 'https') {
    return {
      type: 'special',
      host: null,
      url: null,
      checkable: false,
      normalized: token.toLowerCase(),
      reason: `${scheme}: スキームのため自動チェック対象外`
    };
  }

  let hostPart = rest.split(/[/?#]/)[0];
  const at = hostPart.lastIndexOf('@');
  if (at !== -1) hostPart = hostPart.slice(at + 1);

  let host;
  if (hostPart.startsWith('[')) {
    const end = hostPart.indexOf(']');
    host = end === -1 ? hostPart.slice(1) : hostPart.slice(1, end);
  } else {
    host = hostPart.split(':')[0];
  }
  host = host.replace(/\.$/, '').toLowerCase();

  if (!host) return invalid('ホスト名を抽出できません');

  if (host.includes(':')) {
    return {
      type: 'private',
      host,
      url: buildUrl(token, scheme, rest),
      checkable: false,
      normalized: token.toLowerCase(),
      reason: 'IPv6 / ローカルアドレスのため自動チェック対象外'
    };
  }

  if (isPrivateIpv4(host)) {
    return {
      type: 'private',
      host,
      url: buildUrl(token, scheme, rest),
      checkable: false,
      normalized: token.toLowerCase(),
      reason: 'プライベート IP のため自動チェック対象外'
    };
  }

  if (IPV4_RE.test(host)) {
    const valid = host.split('.').every((part) => Number(part) <= 255);
    if (!valid) return invalid('IPv4 アドレスが不正です');

    const url = buildUrl(token, scheme, rest);
    return {
      type: 'ip',
      host,
      url,
      checkable: true,
      normalized: normalizedKey(token, 'ip', url),
      reason: ''
    };
  }

  if (host === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return {
      type: 'private',
      host,
      url: buildUrl(token, scheme, rest),
      checkable: false,
      normalized: token.toLowerCase(),
      reason: 'ローカルホストのため自動チェック対象外'
    };
  }

  if (!host.includes('.')) return invalid('ドメイン名の形式ではありません');

  const url = buildUrl(token, scheme, rest);
  return {
    type: 'domain',
    host,
    url,
    checkable: true,
    normalized: normalizedKey(token, 'domain', url),
    reason: ''
  };
}

/**
 * Acid Tabs の CSV を解析する。ファイルには一切書き込まない。
 *
 * 形式: 絵文字, space-separated-urls, color
 */
export function analyzeCsv(text) {
  const source = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  const categories = [];
  const urls = [];
  const issues = [];
  let urlSeq = 0;

  const addIssue = (severity, code, message, line, sample = '') => {
    issues.push({ severity, code, message, line, sample });
  };

  source.split('\n').forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    const firstComma = line.indexOf(',');
    const lastComma = line.lastIndexOf(',');
    if (firstComma === -1 || firstComma === lastComma) {
      addIssue(
        'error',
        'malformed-row',
        '「絵文字, URL 群, 色」の 3 列になっていません',
        lineNo,
        trimmed
      );
      return;
    }

    const emoji = line.slice(0, firstComma).trim();
    const urlPart = line.slice(firstComma + 1, lastComma).trim();
    const color = line.slice(lastComma + 1).trim();

    if (!emoji) addIssue('error', 'missing-emoji', '絵文字が空です', lineNo, trimmed);
    if (!color) addIssue('error', 'missing-color', '色が空です', lineNo, trimmed);

    const tokens = urlPart.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      addIssue('warning', 'empty-urls', 'URL が 1 つもありません', lineNo, trimmed);
    }

    categories.push({ line: lineNo, emoji, color, urlCount: tokens.length });

    for (const token of tokens) {
      const parsed = classifyToken(token);
      urls.push({
        id: `u${++urlSeq}`,
        raw: token,
        type: parsed.type,
        host: parsed.host,
        url: parsed.url,
        checkable: parsed.checkable,
        normalized: parsed.normalized,
        reason: parsed.reason,
        line: lineNo,
        emoji,
        color,
        isDuplicate: false,
        duplicateOf: null
      });

      if (parsed.type === 'invalid') {
        addIssue(
          'warning',
          'invalid-url',
          `URL として解釈できません: ${token}`,
          lineNo,
          token
        );
      }
    }
  });

  const groups = new Map();
  for (const entry of urls) {
    if (!entry.normalized) continue;
    if (!groups.has(entry.normalized)) groups.set(entry.normalized, []);
    groups.get(entry.normalized).push(entry);
  }

  const duplicates = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;

    group.forEach((entry, index) => {
      if (index > 0) {
        entry.isDuplicate = true;
        entry.duplicateOf = group[0].id;
      }
    });

    duplicates.push({
      key,
      ids: group.map((entry) => entry.id),
      occurrences: group.map((entry) => ({
        id: entry.id,
        raw: entry.raw,
        line: entry.line,
        emoji: entry.emoji
      }))
    });
  }
  duplicates.sort((a, b) => a.key.localeCompare(b.key));

  const countByType = (type) => urls.filter((entry) => entry.type === type).length;

  return {
    categories,
    urls,
    issues,
    duplicates,
    summary: {
      categories: categories.length,
      urls: urls.length,
      checkable: urls.filter((entry) => entry.checkable).length,
      wildcards: countByType('wildcard'),
      special: countByType('special'),
      private: countByType('private'),
      ip: countByType('ip'),
      invalid: countByType('invalid'),
      duplicates: duplicates.length,
      duplicateUrls: urls.filter((entry) => entry.isDuplicate).length,
      issues: issues.length
    }
  };
}
