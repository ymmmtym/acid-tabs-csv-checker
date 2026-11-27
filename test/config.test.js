import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeployed } from '../src/config.js';

test('APP_ENV が明示されていればそれを優先する', () => {
  assert.equal(isDeployed({ APP_ENV: 'deployed', HOST: '127.0.0.1' }), true);
  assert.equal(isDeployed({ APP_ENV: 'local', HOST: '0.0.0.0' }), false);
});

test('ループバックで待ち受ける場合はローカルとみなす', () => {
  assert.equal(isDeployed({}), false);
  assert.equal(isDeployed({ HOST: '127.0.0.1' }), false);
  assert.equal(isDeployed({ HOST: '127.0.0.5' }), false);
  assert.equal(isDeployed({ HOST: 'localhost' }), false);
  assert.equal(isDeployed({ HOST: '::1' }), false);
  assert.equal(isDeployed({ HOST: '[::1]' }), false);
});

test('外部から到達できるホストで待ち受ける場合は公開環境とみなす', () => {
  assert.equal(isDeployed({ HOST: '0.0.0.0' }), true);
  assert.equal(isDeployed({ HOST: '[::]' }), true);
  assert.equal(isDeployed({ HOST: '10.0.0.2' }), true);
});

test('VERCEL は後方互換のため公開環境として扱う', () => {
  assert.equal(isDeployed({ VERCEL: '1' }), true);
});
