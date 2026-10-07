import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';

const cfg = { timezoneId: 'Asia/Tokyo', locale: 'ja-JP', hardwareConcurrency: 8,
  deviceMemory: 8, webrtcExpectedIp: '203.0.113.1' };

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(50); }
  assert.fail('page did not become ready');
}

test('headed Chrome keeps extensions, navigation errors and failed overrides usable', { timeout: 60000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-compat-browser-'));
  let launched, driver;
  const messages = [];
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><script>window.firstTimezone=Intl.DateTimeFormat().resolvedOptions().timeZone</script><p>ready</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    launched = await launchChrome({ exe: resolveChromePath(), userDataDir: temporary,
      args: ['--no-startup-window', '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--no-proxy-server', '--window-position=-32000,-32000', '--window-size=800,600'] });
    driver = await runDriver({ wsUrl: launched.wsUrl, cfg, log: message => messages.push(message) });
    const send = driver.cdp.send.bind(driver.cdp);
    const evaluate = async (target, expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true }, driver.sessionByTarget.get(target));
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
      return result.result.value;
    };
    let first;
    await t.test('the reported Page.enable timeout cannot stop the browser', async () => {
      driver.cdp.send = (method, ...args) => method === 'Page.enable'
        ? Promise.reject(new Error('Page.enable 超时')) : send(method, ...args);
      try {
        first = await driver.openUrl(url);
        await waitFor(async () => await evaluate(first, 'window.firstTimezone') === cfg.timezoneId);
        assert.equal(driver.cdp.closed, false);
      } finally { driver.cdp.send = send; }
    });
    await t.test('an override failure resumes its page and leaves other tabs running', async () => {
      if (driver.cdp.closed) assert.fail('browser already stopped');
      driver.cdp.send = (method, ...args) => method === 'Emulation.setTimezoneOverride'
        ? Promise.reject(new Error('injected override timeout')) : send(method, ...args);
      let target;
      try { target = await driver.openUrl(url); }
      finally { driver.cdp.send = send; }
      await waitFor(async () => (await evaluate(target, 'document.body?.textContent'))?.includes('ready'));
      assert.equal(driver.cdp.closed, false);
      assert.ok(messages.some(message => message.includes('injected override timeout')));
      assert.equal((await send('Target.getTargets')).targetInfos.some(info => info.targetId === first), true);
    });
    await t.test('a genuinely unanswered Page.enable request times out and releases its page', { timeout: 12000 }, async () => {
      const socket = driver.cdp.ws;
      const write = socket.send.bind(socket);
      const before = driver.stats.failed;
      socket.send = message => {
        if (JSON.parse(message).method !== 'Page.enable') write(message);
      };
      let target;
      try { target = await driver.openUrl(url); }
      finally { socket.send = write; }
      await waitFor(async () => (await evaluate(target, 'document.body?.textContent'))?.includes('ready'));
      assert.ok(driver.stats.failed > before);
      assert.equal(driver.cdp.closed, false);
      assert.ok(messages.some(message => message.includes('Page.enable 超时')));
      assert.equal(await evaluate(first, 'window.firstTimezone'), cfg.timezoneId);
    });
    await t.test('a navigation command timeout leaves its loading tab open', async () => {
      const before = new Set((await send('Target.getTargets')).targetInfos.map(info => info.targetId));
      driver.cdp.send = (method, ...args) => method === 'Page.navigate'
        ? Promise.reject(new Error('Page.navigate 超时')) : send(method, ...args);
      try { await assert.rejects(driver.openUrl(url), /Page.navigate 超时/); }
      finally { driver.cdp.send = send; }
      const pages = (await send('Target.getTargets')).targetInfos.filter(info => !before.has(info.targetId) && info.type === 'page');
      assert.equal(pages.length, 1);
      assert.equal(driver.cdp.closed, false);
    });
    await t.test('a refused connection keeps the native error tab for retry', async () => {
      if (driver.cdp.closed) assert.fail('browser already stopped');
      const unused = http.createServer();
      await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
      const port = unused.address().port;
      await new Promise(resolve => unused.close(resolve));
      const target = await driver.openUrl('http://127.0.0.1:' + port + '/');
      await waitFor(async () => (await evaluate(target, 'document.body?.textContent'))?.includes('ERR_CONNECTION_REFUSED'));
      assert.ok((await send('Target.getTargets')).targetInfos.some(info => info.targetId === target));
      assert.ok(messages.some(message => message.includes('ERR_CONNECTION_REFUSED')));
    });
    await t.test('extensions and settings can open, reload, and navigate back to a covered website', async () => {
      if (driver.cdp.closed) assert.fail('browser already stopped');
      const target = await driver.openUrl('chrome://extensions/');
      const session = driver.sessionByTarget.get(target);
      for (const address of ['chrome://extensions/', 'chrome://settings/', 'chrome://extensions/']) {
        await send('Page.navigate', { url: address }, session);
        await waitFor(async () => await evaluate(target, 'location.href') === address &&
          await evaluate(target, 'document.readyState') === 'complete');
        assert.equal(await evaluate(target, 'Boolean(globalThis[Symbol.for("ChromeFP.provider.installed")])'), false);
      }
      await send('Page.reload', {}, session);
      await waitFor(async () => await evaluate(target, 'document.readyState') === 'complete');
      assert.equal(await evaluate(target, 'Boolean(globalThis[Symbol.for("ChromeFP.provider.installed")])'), false);
      await send('Page.navigate', { url }, session);
      await waitFor(async () => await evaluate(target, 'window.firstTimezone') === cfg.timezoneId);
      assert.equal(await evaluate(target, 'navigator.deviceMemory'), 8);
      assert.equal(await evaluate(target, 'Boolean(globalThis[Symbol.for("ChromeFP.provider.installed")])'), false);
      assert.equal(driver.cdp.closed, false);
      assert.equal(launched.proc.exitCode, null);
    });
  } finally {
    if (driver && !driver.cdp.closed) await driver.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
    driver?.cdp.close(); killChrome(launched?.proc);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await sleep(300);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
