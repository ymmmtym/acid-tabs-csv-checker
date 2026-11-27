import { isIP } from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '::1']);

function isLoopbackHost(host) {
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(bare)) return true;
  // 127.0.0.0/8
  return isIP(bare) === 4 && bare.startsWith('127.');
}

/**
 * 公開環境で動いているかを判定する。
 * 明示指定（APP_ENV）を最優先し、次に待ち受けホストで判断する。
 * ループバック以外で待ち受けるのは、外部から到達できる構成だけ。
 */
export function isDeployed(env = process.env) {
  if (env.APP_ENV) return env.APP_ENV === 'deployed';
  if (env.VERCEL) return true;
  return !isLoopbackHost(env.HOST);
}
