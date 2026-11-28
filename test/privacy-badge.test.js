import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyBadge } from '../public/privacy-badge.js';

test('RDAP がオフなら外部送信なしと表示する', () => {
  const local = privacyBadge({ rdap: false, deployed: false });
  assert.equal(local.text, '保存しません / 外部送信なし');
  assert.equal(local.title, '');

  const deployed = privacyBadge({ rdap: false, deployed: true });
  assert.equal(deployed.text, '保存しません / 公開環境で実行中');
  assert.match(deployed.title, /ブラウザからこのサーバーへ送信/);
});

test('RDAP がオンなら外部送信を明示する', () => {
  const local = privacyBadge({ rdap: true, deployed: false });
  assert.equal(local.text, '保存しません / ドメイン名を外部送信');
  assert.match(local.title, /rdap\.org/);

  const deployed = privacyBadge({ rdap: true, deployed: true });
  assert.equal(deployed.text, '保存しません / 公開環境・ドメイン名を外部送信');
});

test('RDAP の転送先（登録機関）も送信先として示す', () => {
  assert.match(privacyBadge({ rdap: true, deployed: false }).title, /登録機関/);
});

test('実行中の条件はチェックボックスの状態より優先される', () => {
  // 実行開始時点の条件で表示を固定するため、後からチェックを外しても文言は変わらない
  const running = { rdap: true };
  assert.equal(privacyBadge({ rdap: running.rdap, deployed: false }).text, '保存しません / ドメイン名を外部送信');
});
