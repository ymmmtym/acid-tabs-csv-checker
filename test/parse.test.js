import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCsv, classifyToken } from '../src/parse.js';

test('CSV をカテゴリと URL に分解する', () => {
  const analysis = analyzeCsv(
    '⭐, example.com github.com, yellow\n🎵, soundcloud.com, green'
  );

  assert.equal(analysis.summary.categories, 2);
  assert.equal(analysis.summary.urls, 3);
  assert.deepEqual(
    analysis.categories.map((category) => category.emoji),
    ['⭐', '🎵']
  );
  assert.equal(analysis.urls[0].host, 'example.com');
  assert.equal(analysis.urls[0].url, 'https://example.com');
  assert.equal(analysis.urls[0].checkable, true);
});

test('ワイルドカード・特殊スキーム・ローカル URL を分類する', () => {
  assert.equal(classifyToken('*.aws').type, 'wildcard');
  assert.equal(classifyToken('blog.*').type, 'wildcard');
  assert.equal(classifyToken('http*://localhost').type, 'wildcard');
  assert.equal(classifyToken('chrome://settings').type, 'special');
  assert.equal(classifyToken('about:blank').type, 'special');
  assert.equal(classifyToken('localhost:3000').type, 'private');
  assert.equal(classifyToken('192.168.1.1').type, 'private');
  assert.equal(classifyToken('yumenomatayume.home').type, 'private');
  assert.equal(classifyToken('example.com').type, 'domain');
  assert.equal(classifyToken('https://example.com/foo').type, 'domain');
  assert.equal(classifyToken('not-a-domain').type, 'invalid');
  assert.equal(classifyToken('').type, 'invalid');
});

test('正規化した重複 URL を検出する', () => {
  const analysis = analyzeCsv(
    '⭐, example.com https://EXAMPLE.com/ example.com/path, yellow\n' +
      '🎵, example.com/path, green'
  );

  assert.equal(analysis.duplicates.length, 2);
  assert.deepEqual(
    analysis.duplicates.map((group) => group.key).sort(),
    ['example.com', 'example.com/path']
  );
  assert.equal(analysis.summary.duplicateUrls, 2);
  assert.equal(analysis.urls[1].isDuplicate, true);
  assert.equal(analysis.urls[1].duplicateOf, analysis.urls[0].id);
});

test('構造エラーと空の URL を検出する', () => {
  const analysis = analyzeCsv('no commas\n⭐, a.com\n⭐, , yellow');

  assert.ok(analysis.issues.some((issue) => issue.code === 'malformed-row'));
  assert.ok(analysis.issues.some((issue) => issue.code === 'empty-urls'));
});

test('BOM と CRLF を処理する', () => {
  const analysis = analyzeCsv('\uFEFF⭐, a.com, yellow\r\n🎵, b.com, green\r\n');

  assert.equal(analysis.summary.categories, 2);
  assert.equal(analysis.summary.urls, 2);
});

test('URL 内のカンマを壊さない', () => {
  const analysis = analyzeCsv('⭐, example.com/search?q=a,b, yellow');

  assert.equal(analysis.summary.urls, 1);
  assert.equal(analysis.urls[0].host, 'example.com');
  assert.equal(analysis.categories[0].color, 'yellow');
});
