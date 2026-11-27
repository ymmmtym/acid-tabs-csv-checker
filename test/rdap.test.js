import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCsv } from '../src/parse.js';
import { checkOne } from '../src/check.js';
import {
  daysUntil,
  describeRdap,
  lookupRdap,
  registrableDomain,
  summarizeRdap
} from '../src/rdap.js';

test('登録可能ドメインを導出する', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com.'), 'example.com');
  assert.equal(registrableDomain('Example.COM'), 'example.com');
});

test('2 段階サフィックスは 3 ラベルを登録単位とする', () => {
  assert.equal(registrableDomain('www.example.co.jp'), 'example.co.jp');
  assert.equal(registrableDomain('example.ne.jp'), 'example.ne.jp');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.com.au'), 'example.com.au');
});

test('登録単位を導出できないホストは null', () => {
  assert.equal(registrableDomain('localhost'), null);
  assert.equal(registrableDomain(''), null);
  assert.equal(registrableDomain(null), null);
  assert.equal(registrableDomain('127.0.0.1'), null);
  assert.equal(registrableDomain('::1'), null);
  assert.equal(registrableDomain('[::1]'), null);
  assert.equal(registrableDomain('co.jp'), null);
  assert.equal(registrableDomain('a..com'), null);
});

test('RDAP の応答から有効期限と登録日だけを取り出す', () => {
  const summary = summarizeRdap({
    ldhName: 'EXAMPLE.COM',
    events: [
      { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
      { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' }
    ],
    status: ['client transfer prohibited'],
    entities: [{ vcardArray: ['vcard', [['fn', {}, 'text', '個人名']]] }]
  });

  assert.deepEqual(summary, {
    domain: 'example.com',
    registration: '1995-08-14',
    expiration: '2027-08-13',
    statuses: ['client transfer prohibited']
  });
});

test('壊れた RDAP 応答では null を返す', () => {
  assert.equal(summarizeRdap(null), null);
  assert.equal(summarizeRdap('text'), null);
  assert.equal(summarizeRdap({}), null);
});

test('有効期限までの残り日数を計算する', () => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  assert.equal(daysUntil('2026-11-29', now), 10);
  assert.equal(daysUntil('2026-11-19', now), 0);
  assert.equal(daysUntil('2026-11-01', now), -18);
  assert.equal(daysUntil(null, now), null);
  assert.equal(daysUntil('not-a-date', now), null);
});

test('有効期限の説明文を組み立てる', () => {
  const now = Date.parse('2026-11-19T00:00:00Z');

  assert.match(
    describeRdap({ domain: 'example.com', expiration: '2027-11-19' }, now),
    /example\.com の有効期限まで 365 日/
  );
  assert.match(
    describeRdap({ domain: 'example.com', expiration: '2026-12-01' }, now),
    /期限切れ間近/
  );
  assert.match(
    describeRdap({ domain: 'example.com', expiration: '2026-11-01' }, now),
    /有効期限を過ぎています/
  );
  assert.match(describeRdap({ domain: 'example.com', expiration: null }, now), /取得できませんでした/);
  assert.equal(describeRdap(null, now), '');
});

test('RDAP 問い合わせは登録情報を返す', async () => {
  const calls = [];
  let sentHeaders;
  const result = await lookupRdap('example.com', {
    fetchImpl: async (url, options) => {
      calls.push(url);
      sentHeaders = options?.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ldhName: 'EXAMPLE.COM',
          events: [{ eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' }]
        })
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /rdap\.org\/domain\/example\.com/);
  assert.equal(result.ok, true);
  assert.equal(result.domain, 'example.com');
  assert.equal(result.expiration, '2027-08-13');
  // rdap.org は User-Agent の無い要求を 403 で拒否する
  assert.match(sentHeaders['user-agent'], /acid-tabs-checker/);
});

test('RDAP の 404 を TLD 未対応とドメイン未登録で区別する', async () => {
  const unsupported = await lookupRdap('example.jp', {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ title: 'No RDAP service is available for this resource' })
    })
  });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.reason, /TLD は RDAP に未対応/);

  const unregistered = await lookupRdap('gone.example.com', {
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      }
    })
  });
  assert.equal(unregistered.ok, false);
  assert.match(unregistered.reason, /登録されていません/);
});

test('RDAP の失敗は例外ではなく理由として返す', async () => {
  const notFound = await lookupRdap('example.com', {
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) })
  });
  assert.equal(notFound.ok, false);
  assert.match(notFound.reason, /HTTP 500/);

  const broken = await lookupRdap('example.com', {
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /接続できませんでした/);
});

test('DNS 失敗時のみ RDAP を確認し、結果に有効期限を足す', async () => {
  const entry = analyzeCsv('⭐, www.example.com, yellow').urls[0];
  const rdapUrls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, rdap: true, timeoutMs: 1000 },
    {
      // チェック対象は引けないが、RDAP の接続先は引ける状況
      lookup: async (host) => {
        if (host === 'rdap.org') return { address: '199.19.117.1', family: 4 };
        const error = new Error('not found');
        error.code = 'ENOTFOUND';
        throw error;
      },
      fetchImpl: async () => {
        throw new Error('HTTP は呼ばれないはず');
      },
      rdapFetchImpl: async (url) => {
        rdapUrls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ldhName: 'EXAMPLE.COM',
            events: [{ eventAction: 'expiration', eventDate: '2099-01-01T00:00:00Z' }]
          })
        };
      }
    }
  );

  assert.deepEqual(rdapUrls.length, 1);
  assert.match(rdapUrls[0], /rdap\.org\/domain\/example\.com$/);
  assert.equal(result.dns, 'fail');
  assert.equal(result.expiration, '2099-01-01');
  assert.match(result.detail, /example\.com の有効期限まで/);
  // 期限が十分先なら元の error 判定を変えない
  assert.equal(result.level, 'error');
});

test('オフのときは RDAP に問い合わせない', async () => {
  const entry = analyzeCsv('⭐, missing.example.invalid, yellow').urls[0];
  let called = false;

  await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      },
      fetchImpl: async () => {
        throw new Error('呼ばれないはず');
      },
      rdapFetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
    }
  );

  assert.equal(called, false);
});

test('DNS が成功した URL では RDAP を確認しない', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  let called = false;

  const result = await checkOne(
    entry,
    { dns: true, http: true, rdap: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async () => ({ status: 200, body: { cancel() {} } }),
      rdapFetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({}) };
      }
    }
  );

  assert.equal(called, false);
  assert.equal(result.level, 'ok');
  assert.equal(result.expiration, null);
});

test('有効期限が過ぎていても URL の判定は変えない', async () => {
  const entry = analyzeCsv('⭐, expired.example.com, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, rdap: true, timeoutMs: 1000 },
    {
      lookup: async (host) => {
        if (host === 'rdap.org') return { address: '199.19.117.1', family: 4 };
        throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      },
      fetchImpl: async () => ({ status: 200, body: { cancel() {} } }),
      rdapFetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          ldhName: 'EXAMPLE.COM',
          events: [{ eventAction: 'expiration', eventDate: '2020-01-01T00:00:00Z' }]
        })
      })
    }
  );

  assert.equal(result.level, 'error');
  assert.equal(result.expiration, '2020-01-01');
  assert.match(result.detail, /有効期限を過ぎています/);
});

// RDAP は登録機関のサーバーへ転送されるため、各ホップを検証する
const publicLookup = async (host) => {
  if (host === 'rdap.org') return { address: '199.19.117.1', family: 4 };
  if (host === 'rdap.verisign.com') return { address: '199.19.117.2', family: 4 };
  return { address: '93.184.216.34', family: 4 };
};

const rdapPayload = {
  ok: true,
  status: 200,
  json: async () => ({
    ldhName: 'EXAMPLE.COM',
    events: [{ eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' }]
  })
};

test('RDAP の転送を手動で追跡し、転送先にも User-Agent を送る', async () => {
  const calls = [];
  const result = await lookupRdap('example.com', {
    lookup: publicLookup,
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect, ua: options.headers['user-agent'] });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: new Map([['location', 'https://rdap.verisign.com/com/v1/domain/example.com']]),
          body: { cancel() {} }
        };
      }
      return rdapPayload;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.expiration, '2027-08-13');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].redirect, 'manual');
  assert.match(calls[0].url, /rdap\.org/);
  assert.match(calls[1].url, /rdap\.verisign\.com/);
  assert.match(calls[1].ua, /acid-tabs-checker/);
});

test('RDAP の転送先が http なら拒否する', async () => {
  let requested = 0;
  const result = await lookupRdap('example.com', {
    lookup: publicLookup,
    fetchImpl: async () => {
      requested += 1;
      return {
        status: 302,
        headers: new Map([['location', 'http://rdap.verisign.com/com/v1/domain/example.com']]),
        body: { cancel() {} }
      };
    }
  });

  // 平文の転送先は要求しない
  assert.equal(requested, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTPS ではありません/);
});

test('RDAP の転送先がプライベートアドレスなら拒否する', async () => {
  let requested = 0;
  const result = await lookupRdap('example.com', {
    lookup: async (host) => {
      if (host === 'rdap.org') return { address: '199.19.117.1', family: 4 };
      return { address: '10.0.0.5', family: 4 };
    },
    fetchImpl: async () => {
      requested += 1;
      return {
        status: 302,
        headers: new Map([['location', 'https://internal.example/domain/example.com']]),
        body: { cancel() {} }
      };
    }
  });

  assert.equal(requested, 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /プライベート/);
});

test('RDAP の転送が上限を超えたら打ち切る', async () => {
  let requested = 0;
  const result = await lookupRdap('example.com', {
    lookup: publicLookup,
    fetchImpl: async () => {
      requested += 1;
      return {
        status: 302,
        headers: new Map([['location', 'https://rdap.verisign.com/loop']]),
        body: { cancel() {} }
      };
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /リダイレクト回数が上限/);
  assert.equal(requested, 4);
});

test('実行の中断 signal で RDAP の待ち時間を打ち切る', async () => {
  const controller = new AbortController();
  const result = await lookupRdap('example.com', {
    lookup: publicLookup,
    signal: controller.signal,
    fetchImpl: async (url, options) =>
      new Promise((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (options.signal?.aborted) return fail();
        options.signal?.addEventListener('abort', fail, { once: true });
        controller.abort();
      })
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /タイムアウト/);
});
