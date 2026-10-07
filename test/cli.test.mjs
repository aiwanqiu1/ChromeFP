import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { CDP, profileInUse, sleep } from '../lib/cdp.mjs';
import { egressCacheKey } from '../lib/systemproxy.mjs';

async function exerciseCLI(t, identityRequested = false, proxyFromConfig = false) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-cli-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  const source = fileURLToPath(new URL('../', import.meta.url));
  fs.copyFileSync(path.join(source, 'fp-browser.mjs'), path.join(temporary, 'fp-browser.mjs'));
  fs.cpSync(path.join(source, 'lib'), path.join(temporary, 'lib'), { recursive: true });
  const sockets = new Set();
  // A real listening proxy satisfies readiness checks without forwarding any
  // external request. Verification remains reachable through localhost bypass.
  const proxyServer = http.createServer((_request, response) => {
    response.writeHead(502, { 'connection': 'close' });
    response.end('External requests are disabled in the CLI fixture');
  });
  proxyServer.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxyServer.on('connect', (_request, socket) => {
    // Chrome can cancel a rejected CONNECT with RST; this raw socket is owned
    // by the fixture after HTTP hands it to the CONNECT listener.
    socket.on('error', () => {});
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (proxyServer.listening) await new Promise(resolve => proxyServer.close(resolve));
  });
  await new Promise((resolve, reject) => {
    proxyServer.once('error', reject);
    proxyServer.listen(0, '127.0.0.1', resolve);
  });
  const proxy = 'http://127.0.0.1:' + proxyServer.address().port;
  const geo = { ip: '203.0.113.1', countryCode: 'JP', timezone: 'Asia/Tokyo',
    lat: 35.6762, lon: 139.6503, source: 'fixture', isProxy: false, isHosting: true,
    detectionSource: 'ipquery.io', detectionError: null };
  const geoModule = path.join(temporary, 'lib', 'geo.mjs');
  fs.copyFileSync(geoModule, path.join(temporary, 'lib', 'geo-original.mjs'));
  // Keep the real CLI and browser. Only its external geography query is a
  // fixture, so the chosen proxy must still flow into the query correctly.
  fs.writeFileSync(geoModule, `
    import assert from 'node:assert/strict';
    export { isUsableGeo } from './geo-original.mjs';
    export async function lookupGeo(options) {
      assert.equal(options.proxyMode, 'explicit');
      assert.equal(options.proxyUrl, ${JSON.stringify(proxy)});
      options.signal?.throwIfAborted();
      return ${JSON.stringify(geo)};
    }
  `);
  if (proxyFromConfig) fs.writeFileSync(path.join(temporary, 'launcher-config.json'), JSON.stringify({ proxy }));
  fs.mkdirSync(path.join(temporary, 'cache'));
  fs.writeFileSync(path.join(temporary, 'cache', 'geo-' + egressCacheKey('explicit', proxy, {}) + '.json'), JSON.stringify({
    version: 2, at: Date.now(), geo,
  }));
  const extra = identityRequested ? ['--identity', path.join(source, 'examples', 'windows-identity.json'), '--viewport', '1100x700', '--screen', '1600x900', '--dpr', '1.25'] : [];
  const child = spawn(process.execPath, [path.join(temporary, 'fp-browser.mjs'), '--headless', '--profile', '测试 A',
    ...(proxyFromConfig ? [] : ['--proxy', proxy]), '--cache-geo', '10', ...extra], { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', cdp;
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { errors += data.toString(); });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes('✅ 已就绪') && child.exitCode === null && Date.now() < deadline) await sleep(50);
    assert.ok(output.includes('✅ 已就绪'), errors || 'CLI startup timed out');
    assert.ok(output.includes('指定代理 ' + proxy), 'CLI must apply the selected proxy before geography lookup and browser startup');
    assert.match(output, /代理 \/ 机房\s*: 否 \/ 是\s+\[来源: ipquery\.io\]/);
    const directory = path.join(temporary, 'profiles', '测试 A');
    const [port, browserPath] = fs.readFileSync(path.join(directory, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    const verificationUrl = output.match(/自检页\s*:\s*(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    assert.ok(verificationUrl);
    const verification = await fetch(verificationUrl);
    assert.equal(verification.status, 200);
    const html = await verification.text();
    const expected = JSON.parse(html.match(/(?:const|let) EXPECT = ([^\n]+);/)[1]);
    assert.equal(expected.isProxy, false);
    assert.equal(expected.isHosting, true);
    assert.equal(expected.detectionSource, 'ipquery.io');
    cdp = await CDP.connect('ws://127.0.0.1:' + port + browserPath);
    if (identityRequested) {
      const page = (await cdp.send('Target.getTargets')).targetInfos.find(info => info.url === verificationUrl);
      assert.ok(page);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      const result = await cdp.send('Runtime.evaluate', { expression: '({ua:navigator.userAgent,platform:navigator.userAgentData.platform,viewport:[innerWidth,innerHeight],screen:[screen.width,screen.height],dpr:devicePixelRatio})', returnByValue: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined);
      assert.ok(!result.result.value.ua.includes('HeadlessChrome'));
      assert.equal(result.result.value.platform, 'Windows');
      assert.deepEqual(result.result.value.viewport, [1100, 700]);
      assert.deepEqual(result.result.value.screen, [1600, 900]);
      assert.equal(result.result.value.dpr, 1.25);
    }
    await cdp.send('Browser.close').catch(() => {});
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
    assert.equal(code, 0, errors || 'CLI did not exit normally');
    assert.equal(profileInUse(directory), false);
    await assert.rejects(fetch(verificationUrl, { signal: AbortSignal.timeout(1000) }));
  } finally {
    cdp?.close();
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      } else child.kill();
    }
    await sleep(200);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('CLI closes its browser and verification server when Chrome closes', { timeout: 25000 }, t => exerciseCLI(t));
test('CLI carries identity and metrics flags into its real Chrome session', { timeout: 25000, skip: process.platform !== 'win32' || process.arch !== 'x64' }, t => exerciseCLI(t, true));
test('CLI applies the project proxy without requiring shortcut arguments', { timeout: 25000 }, t => exerciseCLI(t, false, true));
