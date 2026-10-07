import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseLauncherArgs } from '../lib/launcher-config.mjs';

function configuration(t, content) {
  const file = path.join(os.tmpdir(), 'chromefp-launcher-config-' + randomUUID() + '.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  t.after(() => {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  return file;
}

test('project proxy is the default for empty shortcut arguments and a named profile', t => {
  const file = configuration(t, JSON.stringify({ proxy: 'http://127.0.0.1:7897' }));
  for (const argv of [[], ['--profile', '店铺 A']]) {
    const options = parseLauncherArgs(argv, file);
    assert.equal(options.proxy, 'http://127.0.0.1:7897');
    assert.equal(options.direct, false);
    assert.equal(options.profile, argv[1] || 'default');
  }
});

test('explicit proxy and direct access take precedence over project proxy', t => {
  const file = configuration(t, JSON.stringify({ proxy: 'http://127.0.0.1:7897' }));
  assert.equal(parseLauncherArgs(['--proxy', 'socks5://127.0.0.1:1080'], file).proxy,
    'socks5://127.0.0.1:1080');
  const direct = parseLauncherArgs(['--direct'], file);
  assert.equal(direct.proxy, null);
  assert.equal(direct.direct, true);
  assert.throws(() => parseLauncherArgs(['--direct', '--proxy', 'http://localhost:7897'], file),
    /不能同时使用/);
});

test('missing file and unset project proxy preserve automatic system proxy behavior', t => {
  for (const content of [undefined, '{}', '{"proxy":null}']) {
    const options = parseLauncherArgs([], configuration(t, content));
    assert.equal(options.proxy, null);
    assert.equal(options.direct, false);
  }
});

test('UTF-8 BOM configuration is accepted', t => {
  const file = configuration(t, '\uFEFF{"proxy":"http://127.0.0.1:7897"}');
  assert.equal(parseLauncherArgs([], file).proxy, 'http://127.0.0.1:7897');
});

test('invalid project settings fail rather than silently falling back to system or direct access', t => {
  for (const content of ['{', 'null', '[]', '123', '"proxy"', '{"port":7897}',
    '{"proxy":7897}', '{"proxy":false}', '{"proxy":{}}', '{"proxy":""}',
    '{"proxy":"localhost:7897"}', '{"proxy":"ftp://localhost:7897"}',
    '{"proxy":"http://user:secret@localhost:7897"}', '{"proxy":"http://localhost:7897/path"}',
    '{"proxy":"http://localhost:7897","unknown":true}']) {
    const file = configuration(t, content);
    assert.throws(() => parseLauncherArgs([], file), /launcher-config\.json/, content);
  }
});

test('help, profile listing and explicit egress can recover from invalid project settings', t => {
  const file = configuration(t, 'malformed');
  assert.equal(parseLauncherArgs(['--help'], file).help, true);
  assert.equal(parseLauncherArgs(['-h'], file).help, true);
  assert.equal(parseLauncherArgs(['--list'], file).list, true);
  assert.equal(parseLauncherArgs(['--direct'], file).direct, true);
  assert.equal(parseLauncherArgs(['--proxy', 'http://localhost:7897'], file).proxy,
    'http://localhost:7897');
});

test('oversized project configuration is rejected while 16 KB is accepted', t => {
  const valid = '{"proxy":"http://127.0.0.1:7897"}';
  const file = configuration(t, valid.padEnd(16 * 1024, ' '));
  assert.equal(parseLauncherArgs([], file).proxy, 'http://127.0.0.1:7897');
  fs.appendFileSync(file, ' ');
  assert.throws(() => parseLauncherArgs([], file), /16 KB/);
});

test('other invalid CLI options still fail when a default proxy is configured', t => {
  const file = configuration(t, '{"proxy":"http://127.0.0.1:7897"}');
  assert.throws(() => parseLauncherArgs(['--profile', '..'], file), /--profile/);
  assert.throws(() => parseLauncherArgs(['--proxy'], file), /缺少参数值/);
  assert.throws(() => parseLauncherArgs(['--unknown'], file), /未知参数/);
});
