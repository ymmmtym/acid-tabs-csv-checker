import { isIP } from 'node:net';

/**
 * 許可しない接続先を表すエラー。
 * チェック結果では「ブロック」として扱う。
 */
export class BlockedTargetError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BlockedTargetError';
    this.code = 'EBLOCKEDTARGET';
  }
}

function parseIPv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

/** プライベート / 予約済み / ループバックの IPv4 かどうか。 */
export function isBlockedIPv4(address) {
  const octets = parseIPv4(address);
  if (!octets) return true;

  const [a, b, c] = octets;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (リンクローカル)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // マルチキャスト / 予約 / ブロードキャスト

  return false;
}

function ipv4FromMapped(tail) {
  if (isIP(tail) === 4) return tail;

  const parts = tail.split(':');
  if (parts.length !== 2) return null;

  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** プライベート / 予約済み / ループバックの IPv6 かどうか。 */
export function isBlockedIPv6(address) {
  const value = address.toLowerCase().split('%')[0];

  if (value === '::' || value === '::1') return true;

  if (value.startsWith('::ffff:')) {
    const mapped = ipv4FromMapped(value.slice('::ffff:'.length));
    return mapped ? isBlockedIPv4(mapped) : true;
  }

  const groups = value.split(':');
  const first = Number.parseInt(groups[0] || '0', 16);
  const second = Number.parseInt(groups[1] || '0', 16);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return true;

  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (リンクローカル)
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 (マルチキャスト)
  if (first === 0x0064 && second === 0xff9b) return true; // 64:ff9b::/96 (NAT64)
  if (first === 0x0100 && second === 0) return true; // 100::/64 (discard)
  if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 (ドキュメント用)

  return false;
}

/** 接続を許可しないアドレスかどうか。判定できない場合は安全側に倒す。 */
export function isBlockedAddress(address) {
  const value = String(address ?? '').split('%')[0];
  const family = isIP(value);

  if (family === 4) return isBlockedIPv4(value);
  if (family === 6) return isBlockedIPv6(value);
  return true;
}

/**
 * HTTP チェック対象として妥当な URL か検証する。
 * スキーム・認証情報・（必要なら）ポートを制限する。
 */
export function assertHttpUrl(rawUrl, { strictPorts = false } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedTargetError('URL を解釈できません');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(`未対応のスキームです (${url.protocol})`);
  }

  if (url.username || url.password) {
    throw new BlockedTargetError('認証情報を含む URL はチェックできません');
  }

  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;

  if (strictPorts && port !== 80 && port !== 443) {
    throw new BlockedTargetError(`許可されていないポートです (${port})`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) {
    throw new BlockedTargetError(`プライベート / 予約済みアドレスです (${host})`);
  }

  return { url, host, port };
}

/**
 * ホスト名を解決し、全アドレスが公開アドレスであることを確認する。
 * IP リテラルの場合は解決せずに検証する。
 */
export async function resolvePublicAddresses(host, lookup) {
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedTargetError(`プライベート / 予約済みアドレスです (${host})`);
    }
    return [host];
  }

  let records;
  try {
    records = await lookup(host, { all: true });
  } catch (error) {
    throw error;
  }

  const list = Array.isArray(records) ? records : [records];
  const addresses = list
    .map((record) => (typeof record === 'string' ? record : record?.address))
    .filter(Boolean);

  if (addresses.length === 0) {
    throw new BlockedTargetError('アドレスを解決できません');
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedTargetError(
        `プライベート / 予約済みアドレスに解決されました (${address})`
      );
    }
  }

  return addresses;
}
