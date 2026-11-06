import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlockedTargetError,
  assertHttpUrl,
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  resolvePublicAddresses
} from '../src/ssrf.js';

test('プライベート / 予約済み IPv4 をブロックする', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255'
  ]) {
    assert.equal(isBlockedIPv4(address), true, address);
  }
});

test('公開 IPv4 はブロックしない', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1']) {
    assert.equal(isBlockedIPv4(address), false, address);
  }
});

test('プライベート / 予約済み IPv6 をブロックする', () => {
  for (const address of [
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1'
  ]) {
    assert.equal(isBlockedIPv6(address), true, address);
  }
});

test('公開 IPv6 はブロックしない', () => {
  assert.equal(isBlockedIPv6('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIPv6('2001:4860:4860::8888'), false);
});

test('判定できないアドレスは安全側に倒してブロックする', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress(undefined), true);
});

test('HTTP / HTTPS 以外の URL を拒否する', () => {
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), BlockedTargetError);
  assert.throws(() => assertHttpUrl('chrome://bookmarks'), BlockedTargetError);
  assert.throws(() => assertHttpUrl('not a url'), BlockedTargetError);
});

test('認証情報を含む URL を拒否する', () => {
  assert.throws(() => assertHttpUrl('https://user:pass@example.com/'), BlockedTargetError);
});

test('プライベート IP を指す URL を拒否する', () => {
  assert.throws(() => assertHttpUrl('http://127.0.0.1/'), BlockedTargetError);
  assert.throws(() => assertHttpUrl('http://[::1]/'), BlockedTargetError);
  assert.throws(() => assertHttpUrl('http://169.254.169.254/latest/meta-data/'), BlockedTargetError);
});

test('strictPorts では 80 / 443 以外のポートを拒否する', () => {
  assert.doesNotThrow(() => assertHttpUrl('http://example.com/', { strictPorts: true }));
  assert.doesNotThrow(() => assertHttpUrl('https://example.com:443/', { strictPorts: true }));
  assert.throws(
    () => assertHttpUrl('http://example.com:8080/', { strictPorts: true }),
    BlockedTargetError
  );
  assert.doesNotThrow(() => assertHttpUrl('http://example.com:8080/', { strictPorts: false }));
});

test('DNS 解決結果にプライベート IP が含まれる場合は拒否する', async () => {
  await assert.rejects(
    resolvePublicAddresses('mixed.example', async () => [
      { address: '93.184.216.34' },
      { address: '10.0.0.5' }
    ]),
    BlockedTargetError
  );
});

test('全アドレスが公開 IP なら解決結果を返す', async () => {
  const addresses = await resolvePublicAddresses('example.com', async () => [
    { address: '93.184.216.34' },
    { address: '2606:2800:220:1:248:1893:25c8:1946' }
  ]);

  assert.deepEqual(addresses, [
    '93.184.216.34',
    '2606:2800:220:1:248:1893:25c8:1946'
  ]);
});

test('IP リテラルは DNS を引かずに検証する', async () => {
  const lookup = async () => {
    throw new Error('lookup は呼ばれないはず');
  };

  assert.deepEqual(await resolvePublicAddresses('1.1.1.1', lookup), ['1.1.1.1']);
  await assert.rejects(resolvePublicAddresses('127.0.0.1', lookup), BlockedTargetError);
});
