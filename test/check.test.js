import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCsv } from '../src/parse.js';
import { classifyHttpStatus, checkOne, runChecks } from '../src/check.js';

test('HTTP ステータスを結果レベルに変換する', () => {
  assert.equal(classifyHttpStatus(200), 'ok');
  assert.equal(classifyHttpStatus(301), 'ok');
  assert.equal(classifyHttpStatus(401), 'warn');
  assert.equal(classifyHttpStatus(403), 'warn');
  assert.equal(classifyHttpStatus(404), 'dead');
  assert.equal(classifyHttpStatus(410), 'dead');
  assert.equal(classifyHttpStatus(500), 'error');
});

test('DNS 失敗時は HTTP をスキップしてエラーにする', async () => {
  const entry = analyzeCsv('⭐, missing.example.invalid, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => {
        const error = new Error('not found');
        error.code = 'ENOTFOUND';
        throw error;
      },
      fetchImpl: async () => {
        throw new Error('HTTP は呼ばれないはず');
      }
    }
  );

  assert.equal(result.dns, 'fail');
  assert.equal(result.http, 'skipped');
  assert.equal(result.level, 'error');
  assert.match(result.detail, /DNS/);
});

test('HTTP 404 をリンク切れとして扱う', async () => {
  const entry = analyzeCsv('⭐, www.example.com, yellow').urls[0];
  const methods = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        return { status: 404, body: { cancel() {} } };
      }
    }
  );

  // HEAD の 404 は誤判定の可能性があるため GET で確認する
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.method, 'GET');
  assert.equal(result.level, 'dead');
  assert.equal(result.status, 404);
  assert.equal(result.detail, 'HTTP 404 (リンク切れ)');
});

test('元 URL が 404 で www 付きが応答する場合は詳細に補足する', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return {
          status: url === 'https://www.example.com/' ? 200 : 404,
          body: { cancel() {} }
        };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.equal(result.status, 404);
  assert.equal(result.www, 'ok');
  assert.equal(result.wwwStatus, 200);
  assert.equal(result.wwwUrl, 'https://www.example.com/');
  assert.match(result.detail, /www 付きでは応答あり \(HTTP 200\)/);
  assert.ok(calls.includes('HEAD https://www.example.com/'));
});

test('元 URL が 404 で www 付きも応答しない場合は補足しない', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async () => ({ status: 404, body: { cancel() {} } })
    }
  );

  assert.equal(result.level, 'dead');
  assert.equal(result.www, 'fail');
  assert.equal(result.wwwStatus, 404);
  assert.equal(result.detail, 'HTTP 404 (リンク切れ)');
});

test('元ドメインの DNS 解決に失敗しても www 付きの結果を記録する', async () => {
  const entry = analyzeCsv('⭐, oreilly.co.jp, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async (host) => {
        if (host === 'www.oreilly.co.jp') return { address: '93.184.216.34' };
        const error = new Error('not found');
        error.code = 'ENOTFOUND';
        throw error;
      },
      fetchImpl: async () => ({ status: 200, body: { cancel() {} } })
    }
  );

  assert.equal(result.dns, 'fail');
  assert.equal(result.http, 'skipped');
  assert.equal(result.level, 'error');
  assert.equal(result.www, 'ok');
  assert.equal(result.wwwStatus, 200);
  assert.equal(result.wwwUrl, 'https://www.oreilly.co.jp/');
  assert.match(result.detail, /DNS 解決失敗/);
  assert.match(result.detail, /www 付きでは応答あり \(HTTP 200\)/);
});

test('元 URL が 5xx で www 付きが応答する場合は詳細に補足する', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url) => ({
        status: url === 'https://www.example.com/' ? 200 : 503,
        body: { cancel() {} }
      })
    }
  );

  assert.equal(result.level, 'error');
  assert.equal(result.status, 503);
  assert.match(result.detail, /サーバーエラー/);
  assert.match(result.detail, /www 付きでは応答あり \(HTTP 200\)/);
});

test('元 URL が OK の場合は www 付きを確認しない', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return { status: 200, body: { cancel() {} } };
      }
    }
  );

  assert.equal(result.level, 'ok');
  assert.deepEqual(calls, ['HEAD https://example.com/']);
});

test('www. で始まるホストは www 付きの追加確認をしない', async () => {
  const entry = analyzeCsv('⭐, www.example.com, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return { status: 404, body: { cancel() {} } };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.deepEqual(calls, [
    'HEAD https://www.example.com/',
    'GET https://www.example.com/'
  ]);
});

test('IP リテラルは www 付きの追加確認をしない', async () => {
  const entry = analyzeCsv('⭐, 93.184.216.34, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return { status: 404, body: { cancel() {} } };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.deepEqual(calls, [
    'HEAD https://93.184.216.34/',
    'GET https://93.184.216.34/'
  ]);
});

test('www オプションが false の場合は www 付きを確認しない', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, www: false, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return { status: 404, body: { cancel() {} } };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.deepEqual(calls, [
    'HEAD https://example.com/',
    'GET https://example.com/'
  ]);
});

test('HEAD が 404 でも GET が 200 ならリンク切れにしない', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  const methods = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        return {
          status: options.method === 'HEAD' ? 404 : 200,
          body: { cancel() {} }
        };
      }
    }
  );

  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.method, 'GET');
  assert.equal(result.level, 'ok');
  assert.equal(result.status, 200);
});

test('パス付き URL が 404 のときトップページの状態を補足する', async () => {
  const entry = analyzeCsv('⭐, example.com/articles, yellow').urls[0];
  const calls = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url, options) => {
        calls.push(`${options.method} ${url}`);
        return {
          status: url === 'https://example.com/' ? 200 : 404,
          body: { cancel() {} }
        };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.equal(result.status, 404);
  assert.match(result.detail, /トップページは応答あり/);
  assert.ok(calls.includes('HEAD https://example.com/'));
});

test('パス付き URL とトップページの両方が 404 ならその旨を補足する', async () => {
  const entry = analyzeCsv('⭐, example.com/articles, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async () => ({ status: 404, body: { cancel() {} } })
    }
  );

  assert.equal(result.level, 'dead');
  assert.equal(result.status, 404);
  assert.match(result.detail, /トップページも404/);
});

test('トップページが 5xx の場合はサーバーエラーとして補足する', async () => {
  const entry = analyzeCsv('⭐, example.com/articles, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url) => ({
        status: url === 'https://example.com/' ? 503 : 404,
        body: { cancel() {} }
      })
    }
  );

  assert.equal(result.level, 'dead');
  assert.match(result.detail, /トップページはサーバーエラー/);
});

test('トップページを確認できなくてもリンク切れのままにする', async () => {
  const entry = analyzeCsv('⭐, example.com/articles, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (url) => {
        if (url === 'https://example.com/') throw new Error('connection refused');
        return { status: 404, body: { cancel() {} } };
      }
    }
  );

  assert.equal(result.level, 'dead');
  assert.equal(result.status, 404);
  assert.match(result.detail, /トップページは確認できませんでした/);
});

test('HEAD が 405 の場合は GET で再試行する', async () => {
  const entry = analyzeCsv('⭐, example.com, yellow').urls[0];
  const methods = [];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => ({ address: '93.184.216.34' }),
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        return {
          status: options.method === 'HEAD' ? 405 : 200,
          body: { cancel() {} }
        };
      }
    }
  );

  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.method, 'GET');
  assert.equal(result.level, 'ok');
});

test('チェック対象外の URL は通信せずにスキップする', async () => {
  const entry = analyzeCsv('⭐, *.aws, yellow').urls[0];

  const result = await checkOne(
    entry,
    { dns: true, http: true, timeoutMs: 1000 },
    {
      lookup: async () => {
        throw new Error('DNS は呼ばれないはず');
      },
      fetchImpl: async () => {
        throw new Error('HTTP は呼ばれないはず');
      }
    }
  );

  assert.equal(result.level, 'skipped');
  assert.match(result.detail, /ワイルドカード/);
});

test('並列数を6から段階的に増やす', async () => {
  const hosts = Array.from({ length: 18 }, (_, index) => `h${index}.example.com`);
  const entries = analyzeCsv(`⭐, ${hosts.join(' ')}, yellow`).urls;

  let active = 0;
  let maxActive = 0;

  const results = await runChecks(
    entries,
    { dns: false, http: true, timeoutMs: 1000, concurrency: 30 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { status: 200, body: { cancel() {} } };
      }
    }
  );

  assert.equal(results.length, 18);
  assert.ok(maxActive > 6, `maxActive=${maxActive}`);
  assert.ok(maxActive <= 30, `maxActive=${maxActive}`);
});

test('runChecks が全件を処理して完了ごとに通知する', async () => {
  const entries = analyzeCsv('⭐, ok.com dead.com, yellow').urls;
  const seen = [];

  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 2 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: async (url) => ({
        status: url.includes('dead') ? 404 : 200,
        body: { cancel() {} }
      }),
      onResult: (result) => seen.push(result.id)
    }
  );

  assert.equal(results.length, 2);
  assert.equal(seen.length, 2);
  assert.equal(results.find((result) => result.host === 'dead.com').level, 'dead');
});

test('runChecks waits for asynchronous result delivery before producing more results', async () => {
  const entries = analyzeCsv('⭐, http://localhost http://127.0.0.1, yellow').urls;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = [];
  let finished = false;
  const checking = runChecks(entries, { concurrency: 1 }, {
    async onResult(result) {
      seen.push(result.id);
      await blocked;
    }
  }).then(results => { finished = true; return results; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.length, 1);
    assert.equal(finished, false);
  } finally {
    release();
    await checking;
  }
  assert.equal(seen.length, 2);
});

test('同じホストの URL でもトップページ確認は 1 回だけ行う', async () => {
  const entries = analyzeCsv('⭐, https://a.example/x https://a.example/y, yellow').urls;
  const requested = [];

  await runChecks(entries, { dns: true, http: true, timeoutMs: 1000, concurrency: 4 }, {
    lookup: async () => ({ address: '1.1.1.1' }),
    fetchImpl: async (url) => {
      requested.push(url);
      return { status: url.endsWith('/') ? 200 : 404, body: { cancel() {} } };
    }
  });

  assert.equal(requested.filter((url) => url === 'https://a.example/').length, 1);
});

test('www 付きの確認も同じホストで 1 回だけ行う', async () => {
  const entries = analyzeCsv('⭐, https://b.example/x https://b.example/y, yellow').urls;
  const requested = [];

  await runChecks(entries, { dns: true, http: true, timeoutMs: 1000, concurrency: 4 }, {
    lookup: async () => ({ address: '1.1.1.1' }),
    fetchImpl: async (url) => {
      requested.push(url);
      const status = url.startsWith('https://www.') ? 200 : 404;
      return { status, body: { cancel() {} } };
    }
  });

  assert.equal(requested.filter((url) => url === 'https://www.b.example/x').length, 1);
});

test('重複 URL は 1 回だけ通信し、行ごとに結果を返す', async () => {
  const entries = analyzeCsv(
    '⭐, https://dup.example/p https://dup.example/p/, yellow'
  ).urls;
  let calls = 0;

  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 4 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, body: { cancel() {} } };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(new Set(results.map((result) => result.id)).size, 2);
  assert.equal(results[0].id, entries[0].id);
  assert.equal(results[1].id, entries[1].id);
});

test('時間切れで未着手の URL はスキップとして返す', async () => {
  const entries = analyzeCsv(
    '⭐, https://slow1.example https://slow2.example https://slow3.example, yellow'
  ).urls;

  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 1, budgetMs: 50 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: (url, options) =>
        new Promise((resolve, reject) => {
          const bail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (options.signal?.aborted) return bail();
          options.signal?.addEventListener('abort', bail, { once: true });
        })
    }
  );

  assert.equal(results.length, 3);
  // 実行中だった 1 件は中断され、残りは未チェックとして返る
  const unfinished = results.filter((result) => /未チェック/.test(result.detail));
  assert.ok(unfinished.length >= 1);
  for (const result of unfinished) {
    assert.equal(result.level, 'skipped');
  }
  for (const result of results) {
    assert.ok(result.id);
  }
});

test('shouldStop が真になったら実行中の通信も中断する', async () => {
  const entries = analyzeCsv('⭐, https://hang.example, yellow').urls;
  let aborted = 0;

  const started = Date.now();
  await runChecks(entries, { dns: true, http: true, timeoutMs: 30000 }, {
    shouldStop: () => Date.now() - started > 50,
    lookup: async () => ({ address: '1.1.1.1' }),
    fetchImpl: (url, options) =>
      new Promise((resolve, reject) => {
        const bail = () => {
          aborted += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (options.signal?.aborted) return bail();
        options.signal?.addEventListener('abort', bail, { once: true });
      })
  });

  assert.ok(aborted > 0);
  assert.ok(Date.now() - started < 5000);
});

test('重複 URL でも行ごとのカテゴリと表記を保持する', async () => {
  const entries = analyzeCsv(
    '⭐, https://same.example/p, yellow\n🎯, https://same.example/p/, blue'
  ).urls;
  let calls = 0;

  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 2 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: async () => {
        calls += 1;
        return { status: 200, body: { cancel() {} } };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(results[0].category, '⭐');
  assert.equal(results[1].category, '🎯');
  assert.equal(results[0].raw, 'https://same.example/p');
  assert.equal(results[1].raw, 'https://same.example/p/');
});

test('スキームとポートが異なる URL は別々に確認する', async () => {
  const entries = analyzeCsv(
    '⭐, https://port.example:8080/p https://port.example:8081/p http://port.example/p, yellow'
  ).urls;

  const seen = [];
  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 3 },
    {
      lookup: async () => ({ address: '1.1.1.1' }),
      fetchImpl: async (url) => {
        seen.push(url);
        return { status: url.includes(':8081') ? 404 : 200, body: { cancel() {} } };
      }
    }
  );

  // 404 の行は GET 再試行とトップページ確認も走るため、対象 URL ごとに確認する
  for (const url of [
    'https://port.example:8080/p',
    'https://port.example:8081/p',
    'http://port.example/p'
  ]) {
    assert.ok(seen.includes(url), `${url} が個別に確認されていない`);
  }
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 404);
  assert.equal(results[2].status, 200);
});

test('中断で打ち切られた行は未着手の行と同じスキップになる', async () => {
  const entries = analyzeCsv('⭐, https://hang2.example, yellow').urls;

  const results = await runChecks(
    entries,
    { dns: true, http: true, timeoutMs: 1000, concurrency: 1 },
    {
      // DNS が返らないまま中断される状況を作る
      lookup: () => new Promise(() => {}),
      fetchImpl: async () => ({ status: 200, body: { cancel() {} } }),
      shouldStop: (() => {
        let calls = 0;
        return () => (calls += 1) > 2;
      })()
    }
  );

  assert.equal(results[0].level, 'skipped');
  assert.match(results[0].detail, /未チェック/);
  assert.equal(results[0].dns, 'skipped');
  assert.equal(results[0].http, 'skipped');
});

test('中断済みなら www 付きの追加確認を始めない', async () => {
  const entries = analyzeCsv('⭐, https://gone.example/p, yellow').urls;
  const seen = [];

  const results = await runChecks(
    entries,
    { dns: true, http: true, www: true, timeoutMs: 1000, concurrency: 1 },
    {
      lookup: async (host) => {
        // www 付きの解決を試みたかどうかで判定する
        if (host.startsWith('www.')) seen.push(host);
        return { address: '1.1.1.1' };
      },
      fetchImpl: async (url) => {
        if (url.includes('gone.example')) {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return { status: 200, body: { cancel() {} } };
      },
      shouldStop: () => true
    }
  );

  assert.deepEqual(seen, []);
  assert.equal(results[0].level, 'skipped');
});
