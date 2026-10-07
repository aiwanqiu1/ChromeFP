import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { deriveFingerprint } from '../lib/fingerprint.mjs';

const japan = {
  ip: '203.0.113.1', countryCode: 'JP', timezone: 'Asia/Tokyo',
  lat: 35.6762, lon: 139.6503, source: 'fixture', isProxy: false, isHosting: false,
  detectionSource: 'fixture', detectionError: null,
};
const otherJapan = { ...japan, ip: '203.0.113.2' };
const america = {
  ...japan, ip: '203.0.113.3', countryCode: 'US', timezone: 'America/New_York',
  lat: 40.7, lon: -74,
};

async function until(check, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

const workerSource = `onmessage=async()=>postMessage({
  timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale:Intl.DateTimeFormat().resolvedOptions().locale,
  language:navigator.language,languages:navigator.languages,
  cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,
  headers:await fetch('/headers').then(response=>response.json())
});`;
const probePage = `<!doctype html><script>
window.firstRead={timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language};
window.pageNonce=crypto.randomUUID();
window.liveWorker=new Worker('/worker.js');
window.readLiveWorker=()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('live worker timeout')),5000);
  liveWorker.addEventListener('message',event=>{clearTimeout(timer);resolve(event.data)},{once:true});
  liveWorker.postMessage(1);
});
</script><body>live IP probe</body>`;

test('real CLI changes existing and new page fingerprints when the current IP changes', { timeout: 90000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-live-ip-cli-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const fixture = path.join(temporary, 'current-geo.json');
  const queries = path.join(temporary, 'geo-queries.log');
  const writeGeo = geo => {
    fs.writeFileSync(fixture + '.next', JSON.stringify(geo));
    fs.renameSync(fixture + '.next', fixture);
  };
  writeGeo(japan);
  fs.copyFileSync(path.join(source, 'fp-browser.mjs'), path.join(temporary, 'fp-browser.mjs'));
  fs.cpSync(path.join(source, 'lib'), path.join(temporary, 'lib'), { recursive: true });
  fs.renameSync(path.join(temporary, 'lib', 'geo.mjs'), path.join(temporary, 'lib', 'geo-original.mjs'));
  fs.writeFileSync(path.join(temporary, 'lib', 'geo.mjs'), `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    export { isUsableGeo } from './geo-original.mjs';
    export async function lookupGeo(options) {
      assert.equal(options.proxyMode, 'direct');
      assert.equal(options.proxyUrl, null);
      options.signal?.throwIfAborted();
      const geo = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
      fs.appendFileSync(${JSON.stringify(queries)}, geo.ip + '\\n');
      return geo;
    }
  `);
  fs.renameSync(path.join(temporary, 'lib', 'ip-monitor.mjs'), path.join(temporary, 'lib', 'ip-monitor-real.mjs'));
  fs.writeFileSync(path.join(temporary, 'lib', 'ip-monitor.mjs'), `
    import { startIPMonitor as realMonitor } from './ip-monitor-real.mjs';
    export function startIPMonitor(options) { return realMonitor({ ...options, intervalMs: 150 }); }
  `);
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, language: request.headers['accept-language'] });
    response.setHeader('cache-control', 'no-store');
    if (request.url === '/worker.js') {
      response.writeHead(200, { 'content-type': 'application/javascript' });
      response.end(workerSource);
    } else if (request.url === '/headers') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ language: request.headers['accept-language'] }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(probePage);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const probeUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const child = spawn(process.execPath, [path.join(temporary, 'fp-browser.mjs'),
    '--headless', '--direct', '--profile', 'live-ip', '--chrome', resolveChromePath(), '--url', probeUrl,
  ], { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '', cdp;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
    child.once('error', error => { errors += error.message; resolve('spawn failed'); });
  });
  const directory = path.join(temporary, 'profiles', 'live-ip');
  try {
    await until(() => output.includes('✅ 已就绪'), 'CLI failed to start: ' + errors, 20000);
    const [port, browserPath] = fs.readFileSync(path.join(directory, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    const verificationUrl = output.match(/自检页\s*:\s*(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    assert.ok(verificationUrl, output);
    cdp = await CDP.connect('ws://127.0.0.1:' + port + browserPath);
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const verificationTarget = targets.find(info => info.url === verificationUrl);
    const probeTarget = targets.find(info => info.url === probeUrl);
    assert.ok(verificationTarget);
    assert.ok(probeTarget);
    const attach = async targetId => (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const verifySession = await attach(verificationTarget.targetId);
    const probeSession = await attach(probeTarget.targetId);
    const read = async (sessionId, expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const state = async () => (await fetch(verificationUrl + 'state')).json();
    await until(() => read(probeSession, '!!window.firstRead'), 'probe first script did not run');
    await read(probeSession, `localStorage.setItem('live-ip-login-marker','preserved')`);
    const nonce = await read(probeSession, 'window.pageNonce');
    await read(verifySession, `(async()=>{
      window.liveCanvas=document.createElement('canvas');liveCanvas.width=32;liveCanvas.height=24;
      const context=liveCanvas.getContext('2d');context.fillStyle='rgb(100,100,100)';context.fillRect(0,0,32,24);
      const offline=new OfflineAudioContext(1,4096,44100),oscillator=offline.createOscillator();
      oscillator.type='triangle';oscillator.frequency.value=1000;oscillator.connect(offline.destination);oscillator.start();
      window.liveAudioBuffer=await offline.startRendering();window.liveVerifyNonce=crypto.randomUUID();
    })()`);
    const fingerprintRead = () => read(verifySession, `(()=>{
      const samples=liveAudioBuffer.getChannelData(0),bytes=new Uint8Array(samples.buffer);
      let audio=2166136261;for(const byte of bytes)audio=Math.imul(audio^byte,16777619);
      return {canvas:liveCanvas.toDataURL(),audio:audio>>>0,nonce:liveVerifyNonce,
        timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,
        language:navigator.language,languages:navigator.languages,cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory};
    })()`);
    const waitForIP = async geo => {
      await until(async () => (await state()).ip === geo.ip, 'live IP state did not update: ' + output + errors);
      try {
        await until(() => read(verifySession, `EXPECT.ip===${JSON.stringify(geo.ip)}`), 'open self-check page kept the old IP');
      } catch (error) {
        await read(verifySession, `window.pendingReadDiagnostics={};
          for(const name of ['workerTimezone','webrtcReadings','geolocation','audioHash'])
            globalThis[name]().then(value=>pendingReadDiagnostics[name]=value)
              .catch(error=>pendingReadDiagnostics[name]=error.message);`);
        await sleep(3500);
        const diagnosis = JSON.stringify(await read(verifySession, `({ip:EXPECT.ip,checking:typeof checking==='undefined'?null:checking,
          pending:typeof pendingExpect==='undefined'?null:pendingExpect?.ip,reads:pendingReadDiagnostics,
          visibility:document.visibilityState,actual:document.getElementById('actual').innerText,
          consistency:document.getElementById('consistency').innerText})`));
        t.diagnostic(diagnosis);
        throw new Error(error.message + '\n' + diagnosis + '\n' + output + errors, { cause: error });
      }
    };
    const initial = await fingerprintRead();
    const initialState = await state();
    assert.equal(initialState.fingerprintId, deriveFingerprint(japan.ip).fingerprintId);
    assert.equal(initial.language, 'ja-JP');
    assert.equal(initial.timezone, 'Asia/Tokyo');
    assert.equal((await read(probeSession, 'readLiveWorker()')).language, 'ja-JP');
    assert.match((await read(probeSession, "fetch('/headers').then(r=>r.json())")).language, /^ja-JP/);
    await t.test('another IP in the same country changes the original Canvas and rendered audio reads', async () => {
      writeGeo(otherJapan);
      await waitForIP(otherJapan);
      const changed = await fingerprintRead();
      assert.notEqual(changed.canvas, initial.canvas);
      assert.notEqual(changed.audio, initial.audio);
      assert.equal(changed.nonce, initial.nonce, 'the original document stayed open');
      assert.equal(changed.language, 'ja-JP');
      assert.equal(changed.timezone, 'Asia/Tokyo');
      assert.equal((await state()).fingerprintId, deriveFingerprint(otherJapan.ip).fingerprintId);
      const checksBefore = fs.readFileSync(queries, 'utf8').trim().split('\n').length;
      const updatesBefore = output.match(/IP 指纹更新/g)?.length || 0;
      await until(() => fs.readFileSync(queries, 'utf8').trim().split('\n').length >= checksBefore + 2, 'unchanged IP was not rechecked');
      assert.deepEqual(await fingerprintRead(), changed, 'unchanged current IP retains the same fingerprint');
      assert.equal(output.match(/IP 指纹更新/g)?.length || 0, updatesBefore);
    });
    await t.test('a country change updates existing pages and their original Worker without navigation', async () => {
      writeGeo(america);
      await waitForIP(america);
      const changed = await fingerprintRead();
      assert.equal(changed.language, 'en-US');
      assert.equal(changed.locale, 'en-US');
      assert.equal(changed.timezone, 'America/New_York');
      assert.equal(changed.nonce, initial.nonce);
      const probe = await read(probeSession, `({nonce:pageNonce,marker:localStorage.getItem('live-ip-login-marker'),
        initial:firstRead,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})`);
      assert.equal(probe.nonce, nonce);
      assert.equal(probe.marker, 'preserved');
      assert.deepEqual(probe.initial, { timezone: 'Asia/Tokyo', language: 'ja-JP' });
      assert.equal(probe.language, 'en-US');
      assert.equal(probe.timezone, 'America/New_York');
      const worker = await read(probeSession, 'readLiveWorker()');
      assert.equal(worker.language, 'en-US');
      assert.equal(worker.locale, 'en-US');
      assert.equal(worker.timezone, 'America/New_York');
      assert.match(worker.headers.language, /^en-US/);
      assert.match((await read(probeSession, "fetch('/headers').then(r=>r.json())")).language, /^en-US/);
    });
    await t.test('a newly opened page sees the latest language and timezone in its first script and request', async () => {
      const newUrl = probeUrl + 'new-after-ip-change';
      await cdp.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(newUrl)},'_blank')`, userGesture: true }, probeSession);
      let target;
      await until(async () => {
        target = (await cdp.send('Target.getTargets')).targetInfos.find(info => info.url === newUrl);
        return !!target;
      }, 'new page did not open');
      const session = await attach(target.targetId);
      await until(() => read(session, '!!window.firstRead'), 'new page first script did not run');
      assert.deepEqual(await read(session, 'firstRead'), { timezone: 'America/New_York', language: 'en-US' });
      assert.match(requests.find(request => request.url === '/new-after-ip-change')?.language || '', /^en-US/);
      const worker = await read(session, 'readLiveWorker()');
      assert.equal(worker.language, 'en-US');
      assert.equal(worker.timezone, 'America/New_York');
    });
    await t.test('returning to the original IP restores its fingerprint in the same document', async () => {
      writeGeo(japan);
      await waitForIP(japan);
      assert.deepEqual(await fingerprintRead(), initial);
      assert.equal((await state()).fingerprintId, initialState.fingerprintId);
      assert.equal(await read(probeSession, "localStorage.getItem('live-ip-login-marker')"), 'preserved');
    });
    await cdp.send('Browser.close').catch(() => {});
    assert.equal(await Promise.race([exited, sleep(5000).then(() => 'timeout')]), 0, errors);
    await assert.rejects(fetch(verificationUrl, { signal: AbortSignal.timeout(1000) }));
  } finally {
    if (cdp && !cdp.closed) await cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
    cdp?.close();
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      } else child.kill();
    }
    await Promise.race([exited, sleep(1000)]);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
