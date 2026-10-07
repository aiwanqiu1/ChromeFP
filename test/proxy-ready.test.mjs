import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import * as readiness from '../lib/systemproxy.mjs';
import { lookupGeo } from '../lib/geo.mjs';

async function proxyFixture(t) {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  t.after(() => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
  }));
  return { server, url: 'http://127.0.0.1:' + port };
}

test('explicit proxy waits for a late local service and resumes on the same endpoint', async t => {
  const { server, url } = await proxyFixture(t);
  const messages = [];
  await readiness.waitForProxy(url, {
    timeoutMs: 1000, intervalMs: 20,
    log(message) {
      messages.push(message);
      server.listen(new URL(url).port, '127.0.0.1');
    },
  });
  assert.equal(messages.length, 1, 'only announce waiting once');
  assert.match(messages[0], /代理.*等待/);
});

test('an unavailable explicit proxy has a bounded wait and actionable diagnostics', async t => {
  const { url } = await proxyFixture(t);
  const started = Date.now();
  await assert.rejects(readiness.waitForProxy(url, { timeoutMs: 100, intervalMs: 20 }), error => {
    assert.match(error.message, /代理连接失败/);
    assert.match(error.message, /127\.0\.0\.1/);
    assert.match(error.message, /代理软件/);
    assert.match(error.message, /launcher-config\.json/);
    return true;
  });
  assert.ok(Date.now() - started < 1000, 'deadline must bound retries');
});

test('proxy waiting can be cancelled immediately or between attempts', async t => {
  const { url } = await proxyFixture(t);
  const cancelled = new AbortController();
  const reason = new Error('cancelled proxy startup');
  cancelled.abort(reason);
  await assert.rejects(readiness.waitForProxy(url, { signal: cancelled.signal }), error => error === reason);

  const controller = new AbortController();
  await assert.rejects(readiness.waitForProxy(url, {
    signal: controller.signal, intervalMs: 5000,
    log() { controller.abort(reason); },
  }), error => error === reason);
});

test('an already listening proxy continues without retry messages', async t => {
  const { server, url } = await proxyFixture(t);
  await new Promise(resolve => server.listen(new URL(url).port, '127.0.0.1', resolve));
  await readiness.waitForProxy(url, { log() { assert.fail('ready proxy should not wait'); } });
});

test('geography lookup diagnoses an unavailable configured proxy before launching Chrome', async t => {
  const { url } = await proxyFixture(t);
  await assert.rejects(lookupGeo({
    chromeExe: 'missing-test-chrome.exe', proxyMode: 'explicit', proxyUrl: url,
    proxyTimeoutMs: 100,
  }), /代理连接失败/);
});
