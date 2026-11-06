import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCsv } from '../src/parse.js';
import { buildCleanedCsv } from '../public/clean.js';

test('選択した URL だけを削除する', () => {
  const analysis = analyzeCsv('⭐, a.com b.com, yellow\n🎵, c.com, green');
  const target = analysis.urls.find((url) => url.raw === 'b.com');

  const csv = buildCleanedCsv({ analysis, selectedIds: new Set([target.id]) });

  assert.equal(csv, '⭐, a.com, yellow\n🎵, c.com, green\n');
});

test('カテゴリ内の URL をすべて削除すると行ごと削除する', () => {
  const analysis = analyzeCsv('⭐, a.com b.com, yellow\n🎵, c.com, green');
  const selected = new Set(
    analysis.urls.filter((url) => url.line === 1).map((url) => url.id)
  );

  const csv = buildCleanedCsv({ analysis, selectedIds: selected });

  assert.equal(csv, '🎵, c.com, green\n');
});

test('カテゴリ順と URL 順を維持する', () => {
  const analysis = analyzeCsv('⭐, a.com b.com c.com, yellow\n🎵, d.com e.com, green');
  const selected = new Set(
    analysis.urls.filter((url) => url.raw === 'b.com' || url.raw === 'd.com').map((url) => url.id)
  );

  const csv = buildCleanedCsv({ analysis, selectedIds: selected });

  assert.equal(csv, '⭐, a.com c.com, yellow\n🎵, e.com, green\n');
});

test('重複 URL は出現単位で削除できる', () => {
  const analysis = analyzeCsv('⭐, a.com a.com, yellow');
  const first = analysis.urls[0];

  const csv = buildCleanedCsv({ analysis, selectedIds: new Set([first.id]) });

  assert.equal(csv, '⭐, a.com, yellow\n');
});

test('選択していない対象外 URL は残す', () => {
  const analysis = analyzeCsv('⭐, *.aws blog.* chrome://settings localhost:3000, yellow');

  const csv = buildCleanedCsv({ analysis, selectedIds: new Set() });

  assert.equal(csv, '⭐, *.aws blog.* chrome://settings localhost:3000, yellow\n');
});

test('選択が0件なら URL 順を保った CSV を返す', () => {
  const analysis = analyzeCsv('⭐, example.com https://example.com/ github.com, yellow');

  const csv = buildCleanedCsv({ analysis, selectedIds: new Set() });

  assert.equal(csv, '⭐, example.com https://example.com/ github.com, yellow\n');
});

test('元から URL がないカテゴリ行は残す', () => {
  const analysis = analyzeCsv('⭐, , yellow');

  const csv = buildCleanedCsv({ analysis, selectedIds: new Set() });

  assert.equal(csv, '⭐, , yellow\n');
});

test('BOM と改行コードを指定どおりに出力する', () => {
  const analysis = analyzeCsv('\uFEFF⭐, a.com b.com, yellow\r\n🎵, c.com, green');
  const target = analysis.urls.find((url) => url.raw === 'b.com');

  const csv = buildCleanedCsv({
    analysis,
    selectedIds: new Set([target.id]),
    eol: '\r\n',
    bom: true
  });

  assert.equal(csv, '\uFEFF⭐, a.com, yellow\r\n🎵, c.com, green\r\n');
});

test('analysis がない場合はエラーにする', () => {
  assert.throws(
    () => buildCleanedCsv({ analysis: null, selectedIds: new Set() }),
    TypeError
  );
});
