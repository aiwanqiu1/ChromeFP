import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { restoreProfileWindow } from '../lib/restore-window.mjs';

const helper = path.resolve(import.meta.dirname, '../lib/restore-window.mjs');
const snapshot = directory => Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name)).toString('base64')]));

test('window restore rejects malformed or stale endpoints without changing profile files', { timeout: 15000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-restore-invalid-'));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  try {
    fs.writeFileSync(path.join(temporary, '.fp-launcher.lock'), '{"pid":12345,"token":"preserved"}');
    fs.writeFileSync(path.join(temporary, 'sentinel'), 'profile data stays intact');
    const invalid = [
      '0\n/devtools/browser/00000000-0000-0000-0000-000000000000',
      '65536\n/devtools/browser/00000000-0000-0000-0000-000000000000',
      '9222\nws://example.com/devtools/browser/fake',
      '9222\n/devtools/browser/../../../private',
      '9222\n/devtools/browser/00000000-0000-0000-0000-000000000000\nextra',
    ];
    for (const value of invalid) {
      fs.writeFileSync(path.join(temporary, 'DevToolsActivePort'), value);
      const before = snapshot(temporary);
      await assert.rejects(restoreProfileWindow(temporary), /端点无效/);
      assert.deepEqual(snapshot(temporary), before);
    }
    fs.writeFileSync(path.join(temporary, 'DevToolsActivePort'), '1\n/devtools/browser/00000000-0000-0000-0000-000000000000');
    const before = snapshot(temporary);
    await assert.rejects(restoreProfileWindow(temporary, { timeoutMs: 500 }), /无法连接/);
    assert.deepEqual(snapshot(temporary), before);
    const cli = spawnSync(process.execPath, [helper, temporary], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /无法恢复 ChromeFP/);
    assert.doesNotMatch(cli.stderr, /127\.0\.0\.1|devtools\/browser|profile data/);
    assert.deepEqual(snapshot(temporary), before);
    await assert.rejects(restoreProfileWindow(temporary, { timeoutMs: 0 }), /超时参数无效/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('real Chrome window restore retains its owner, lock and existing regional driver', { timeout: 60000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-restore-browser-'));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><script>window.firstRead={timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cores:navigator.hardwareConcurrency}</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let launched, driver;
  try {
    launched = await launchChrome({ exe: resolveChromePath(), userDataDir: temporary,
      args: ['--headless=new', '--no-startup-window', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server'] });
    driver = await runDriver({ wsUrl: launched.wsUrl, cfg: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP', hardwareConcurrency: 4 } });
    const lock = fs.readFileSync(path.join(temporary, '.fp-launcher.lock'), 'utf8');
    const port = fs.readFileSync(path.join(temporary, 'DevToolsActivePort'), 'utf8');
    const before = (await driver.cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page');
    const { targetId } = await restoreProfileWindow(temporary);
    await driver.waitForTarget(targetId);
    const after = (await driver.cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page');
    assert.equal(after.length, before.length + 1);
    assert.equal(after.find(info => info.targetId === targetId)?.url, 'about:blank');
    assert.equal(launched.proc.exitCode, null);
    assert.equal(driver.cdp.closed, false);
    assert.equal(fs.readFileSync(path.join(temporary, '.fp-launcher.lock'), 'utf8'), lock);
    assert.equal(fs.readFileSync(path.join(temporary, 'DevToolsActivePort'), 'utf8'), port);
    const sessionId = driver.sessionByTarget.get(targetId);
    await driver.cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' }, sessionId);
    let value;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = await driver.cdp.send('Runtime.evaluate', { expression: 'window.firstRead', returnByValue: true }, sessionId);
      value = result.result.value;
      if (value) break;
      await sleep(50);
    }
    assert.deepEqual(value, { timezone: 'Asia/Tokyo', cores: 4 });
    assert.equal(launched.proc.exitCode, null);
    assert.equal(driver.cdp.closed, false);
  } finally {
    // 只关闭本测试新建的 Chrome 和临时 profile。
    if (driver && !driver.cdp.closed) await driver.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
    driver?.cdp.close();
    killChrome(launched?.proc);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await sleep(300);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
