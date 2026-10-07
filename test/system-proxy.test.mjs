import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as proxy from '../lib/systemproxy.mjs';

const root = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const registry = lines => [root, ...lines.map(line => '    ' + line), '', root + '\\5.0', ''].join('\r\n');

test('registry parser keeps an empty PAC separate from the following subkey', () => {
  assert.equal(typeof proxy.parseWindowsProxySettings, 'function');
  const result = proxy.parseWindowsProxySettings(registry([
    'ProxyEnable    REG_DWORD    0x1',
    'ProxyServer    REG_SZ    127.0.0.1:7897',
    'ProxyOverride    REG_SZ    <local>',
    'AutoConfigURL    REG_SZ    ',
  ]));
  assert.deepEqual(result, {
    supported: true, enabled: true, server: '127.0.0.1:7897',
    pac: null, bypass: '<local>', autoDetect: null,
  });
  assert.doesNotMatch(proxy.describeEgress('auto', null, result), /PAC|HKEY_CURRENT_USER/);
});

test('empty proxy values never consume the next registry value or key', () => {
  const result = proxy.parseWindowsProxySettings(registry([
    'ProxyEnable    REG_DWORD    0x0',
    'ProxyServer    REG_SZ    ',
    'ProxyOverride    REG_SZ    ',
    'AutoConfigURL    REG_SZ',
  ]));
  assert.deepEqual(result, {
    supported: true, enabled: false, server: null,
    pac: null, bypass: null, autoDetect: null,
  });
});

test('registry parser accepts tabs, LF output and nonempty proxy values', () => {
  const output = [root,
    '\tProxyEnable\tREG_DWORD\t0x1',
    '\tProxyServer\tREG_SZ\thttp=127.0.0.1:7897;https=127.0.0.1:7897',
    '\tProxyOverride\tREG_SZ\tlocalhost;127.0.0.1;<local>',
    '\tAutoConfigURL\tREG_SZ\thttps://example.invalid/proxy.pac',
  ].join('\n');
  const result = proxy.parseWindowsProxySettings(output);
  assert.equal(result.enabled, true);
  assert.equal(result.server, 'http=127.0.0.1:7897;https=127.0.0.1:7897');
  assert.equal(result.bypass, 'localhost;127.0.0.1;<local>');
  assert.equal(result.pac, 'https://example.invalid/proxy.pac');
});

test('automatic proxy discovery comes only from the connection flags byte', () => {
  const main = registry(['ProxyEnable    REG_DWORD    0x0']);
  for (const [hex, expected] of [
    ['010000000000000009000000', true],
    ['010000000000000001000000', false],
    ['010000000000000008000000', true],
  ]) {
    const connections = root + '\\Connections\r\n    DefaultConnectionSettings    REG_BINARY    ' + hex;
    assert.equal(proxy.parseWindowsProxySettings(main, connections).autoDetect, expected);
  }
  for (const connections of [undefined, '', 'DefaultConnectionSettings    REG_BINARY    ',
    'DefaultConnectionSettings    REG_BINARY    0100',
    'DefaultConnectionSettings    REG_BINARY    \r\n' + root + '\\Connections']) {
    assert.equal(proxy.parseWindowsProxySettings(main, connections).autoDetect, null);
  }
});

test('automatic browser egress inherits current system routing without pinning an old port', () => {
  assert.deepEqual(proxy.proxyArgs('auto', null), []);
  assert.deepEqual(proxy.proxyArgs('direct', null), ['--no-proxy-server']);
  assert.deepEqual(proxy.proxyArgs('explicit', 'http://127.0.0.1:7897'), [
    '--proxy-server=http://127.0.0.1:7897', '--proxy-bypass-list=localhost;127.0.0.1',
  ]);
});
