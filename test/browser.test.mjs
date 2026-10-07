import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CDP, launchChrome, killChrome, profileInUse, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { startVerifyServer } from '../lib/verifypage.mjs';

const cfg = {
  timezoneId: 'Asia/Tokyo', locale: 'ja-JP', overrideGeolocation: true,
  latitude: 35.6762, longitude: 139.6503,
  hardwareConcurrency: 8, deviceMemory: 8, canvasNoise: true, audioNoise: true,
  webrtcExpectedIp: '203.0.113.1', noiseSeed: 12345,
};
const page = `<!doctype html><meta charset="utf-8"><script>
window.firstRead = {
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  language: navigator.language, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
  ua: navigator.userAgent, platform: navigator.userAgentData?.platform,
};
</script>`;

async function read(driver, target, expression) {
  const result = await driver.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true },
    driver.sessionByTarget.get(target));
  assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
  return result.result.value;
}
async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  assert.fail('browser result did not become ready');
}

test('real Chrome: startup, new pages, workers, patches, profiles and verification', { timeout: 90000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-browser-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  const browsers = [];
  let verification;
  const server = http.createServer((request, response) => {
    if (request.url === '/headers') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ language: request.headers['accept-language'], hints: request.headers['sec-ch-ua'] }));
    } else { response.writeHead(200, { 'content-type': 'text/html' }); response.end(page); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const start = async name => {
    const directory = path.join(temporary, name);
    const launched = await launchChrome({ exe: resolveChromePath(), userDataDir: directory,
      args: ['--headless=new', '--no-startup-window', '--no-first-run', '--no-default-browser-check',
        '--disable-sync', '--no-proxy-server', '--lang=ja-JP', '--accept-lang=ja-JP,ja,en-US,en'] });
    const owned = { ...launched, directory, driver: null };
    browsers.push(owned);
    owned.driver = await runDriver({ wsUrl: launched.wsUrl, cfg, log: message => {
      if (/\[错误\]/.test(message)) console.error(message);
    } });
    return owned;
  };
  try {
    const first = await start('配置 A');
    const { driver } = first;
    let target;
    await t.test('initial scripts and concurrent tabs all see the configured environment', async () => {
      const targets = await Promise.all(Array.from({ length: 3 }, () => driver.openUrl(url)));
      [target] = targets;
      for (const id of targets) {
        await until(async () => !!await read(driver, id, 'window.firstRead'));
        const value = await read(driver, id, 'window.firstRead');
        assert.equal(value.timezone, 'Asia/Tokyo'); assert.equal(value.language, 'ja-JP');
        assert.equal(value.cores, 8); assert.equal(value.memory, 8);
        assert.ok(value.ua.includes('Chrome/')); assert.equal(value.platform, 'Windows');
        const headers = await read(driver, id, 'fetch("/headers").then(r=>r.json())');
        assert.ok(headers.language.startsWith('ja-JP')); assert.ok(headers.hints.includes('Chrom'));
      }
    });
    await t.test('a user-created tab is also covered before its first script', async () => {
      const result = await driver.cdp.send('Runtime.evaluate', { expression: 'window.open("' + url + 'new", "_blank")', userGesture: true },
        driver.sessionByTarget.get(target));
      assert.equal(result.exceptionDetails, undefined);
      let id;
      await until(async () => {
        const info = (await driver.cdp.send('Target.getTargets')).targetInfos.find(item => item.url === url + 'new');
        if (!info) return false;
        id = info.targetId;
        await driver.waitForTarget(id);
        return !!await read(driver, id, 'window.firstRead');
      });
      const value = await read(driver, id, 'window.firstRead');
      assert.equal(value.timezone, 'Asia/Tokyo'); assert.equal(value.cores, 8);
    });
    await t.test('Worker and cross-origin iframe retain the same hardware readings and timezone', async () => {
      const worker = await read(driver, target, `(async()=>{
        const source = 'onmessage=()=>postMessage({ timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, cores:navigator.hardwareConcurrency, memory:navigator.deviceMemory, language:navigator.language })';
        const blob = URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
        const worker = new Worker(blob);
        try { return await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('worker timeout')),5000);
          worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)}; worker.postMessage(1);
        }); } finally {worker.terminate();URL.revokeObjectURL(blob)}
      })()`);
      assert.equal(worker.timezone, 'Asia/Tokyo'); assert.equal(worker.cores, 8); assert.equal(worker.memory, 8);
      const iframeUrl = url.replace('127.0.0.1', 'localhost');
      await read(driver, target, `window.childRead=null; addEventListener('message',e=>window.childRead=e.data);
        const frame=document.createElement('iframe');frame.src='${iframeUrl}';document.body.append(frame);`);
      let iframe;
      await until(async () => {
        iframe = (await driver.cdp.send('Target.getTargets')).targetInfos.find(info => info.type === 'iframe');
        return !!iframe;
      });
      await driver.waitForTarget(iframe.targetId);
      await until(async () => !!await read(driver, iframe.targetId, 'window.firstRead'));
      const child = await read(driver, iframe.targetId, 'window.firstRead');
      assert.equal(child.timezone, 'Asia/Tokyo'); assert.equal(child.cores, 8); assert.equal(child.memory, 8);
    });
    await t.test('Canvas exports are stable, do not alter the display, and match toBlob', async () => {
      const value = await read(driver, target, `(async()=>{
        const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;
        const context=canvas.getContext('2d');context.fillStyle='rgb(100,100,100)';context.fillRect(0,0,24,24);
        const first=canvas.toDataURL();const second=canvas.toDataURL();
        const image=context.getImageData(0,0,24,24).data;
        const other=document.createElement('canvas');other.width=24;other.height=24;
        other.getContext('2d').drawImage(canvas,0,0);
        const raw=other.getContext('2d').getImageData(0,0,24,24).data;
        const blob=await new Promise(resolve=>canvas.toBlob(resolve));
        const blobUrl=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.readAsDataURL(blob)});
        return {stable:first===second,unchanged:Array.from(image).join(',')===Array.from(raw).join(','),blobMatches:first===blobUrl};
      })()`);
      assert.deepEqual(value, { stable: true, unchanged: true, blobMatches: true });
    });
    await t.test('Canvas negative dimensions preserve the noise for the same pixel region', async () => {
      const value = await read(driver, target, `(()=>{
        const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
        const context=canvas.getContext('2d');context.fillStyle='rgb(100,100,100)';context.fillRect(0,0,8,8);
        const expected=Array.from(context.getImageData(0,0,8,8).data);
        return [[8,0,-8,8],[0,8,8,-8],[8,8,-8,-8]].every(args=>
          Array.from(context.getImageData(...args).data).every((pixel,index)=>pixel===expected[index]));
      })()`);
      assert.equal(value, true);
    });
    await t.test('Audio noise preserves unused destination array entries', async () => {
      const value = await read(driver, target, `(async()=>{
        const audio=new AudioContext();
        try {
          const analyser=audio.createAnalyser();analyser.fftSize=32;
          const samples=new Float32Array(analyser.frequencyBinCount+4).fill(37);
          analyser.getFloatFrequencyData(samples);
          return Array.from(samples.slice(analyser.frequencyBinCount));
        } finally {await audio.close()}
      })()`);
      assert.deepEqual(value, [37, 37, 37, 37]);
    });
    await t.test('WebRTC native reports remain iterable and listener removal works', async () => {
      const value = await read(driver, target, `(async()=>{
        const pc=new RTCPeerConnection();pc.createDataChannel('probe');let count=0;
        const listener=()=>count++;
        pc.addEventListener('icecandidate',listener);pc.removeEventListener('icecandidate',listener);
        const event=new Event('icecandidate');Object.defineProperty(event,'candidate',{value:{candidate:'candidate:1 1 udp 1 203.0.113.1 5000 typ srflx'}});
        pc.dispatchEvent(event);
        await pc.setLocalDescription(await pc.createOffer());
        const report=await pc.getStats();let rows=0;report.forEach(()=>rows++);
        const size=report.size;const entries=Array.from(report).length;
        const sdp=pc.localDescription.sdp;pc.close();return {count,rows,size,entries,sdp:typeof sdp};
      })()`);
      assert.equal(value.count, 0); assert.equal(value.rows, value.size); assert.equal(value.entries, value.size);
      assert.equal(value.sdp, 'string');
    });
    await t.test('Windows rejects a duplicate profile even when no launcher lock is present', async () => {
      if (process.platform !== 'win32') return;
      fs.rmSync(path.join(first.directory, '.fp-launcher.lock'));
      assert.equal(profileInUse(first.directory), true);
      const portFile = path.join(first.directory, 'DevToolsActivePort');
      const before = fs.readFileSync(portFile, 'utf8');
      await assert.rejects(launchChrome({ exe: resolveChromePath(), userDataDir: first.directory,
        args: ['--headless=new'] }), /占用/);
      assert.equal(fs.readFileSync(portFile, 'utf8'), before);
    });
    await t.test('separate profiles isolate Cookie and localStorage', async () => {
      await read(driver, target, 'document.cookie="profile=first; path=/";localStorage.setItem("profile","first")');
      const second = await start('配置 B');
      const secondTarget = await second.driver.openUrl(url);
      await until(async () => !!await read(second.driver, secondTarget, 'window.firstRead'));
      const values = await read(second.driver, secondTarget, '({cookie:document.cookie,storage:localStorage.getItem("profile")})');
      assert.equal(values.cookie.includes('profile=first'), false); assert.equal(values.storage, null);
    });
    await t.test('verification renders external fields as text and completes its checks', async () => {
      const attack = '</script><script>window.injected=true</script><img src=x onerror="window.injected=true">';
      verification = await startVerifyServer({ ...cfg, timezone: cfg.timezoneId, ip: cfg.webrtcExpectedIp,
        countryCode: 'JP', region: attack, locale: 'ja-JP', webrtcProtect: true, egressDesc: '测试' });
      const verifyTarget = await driver.openUrl(verification.url);
      await until(async () => await read(driver, verifyTarget, 'document.querySelectorAll("#consistency tr").length > 0'));
      const value = await read(driver, verifyTarget, '({injected:!!window.injected,images:document.images.length,text:document.body.textContent,summary:document.querySelector("#consistency").textContent,errors:document.querySelectorAll("#consistency .bad").length})');
      assert.equal(value.injected, false); assert.equal(value.images, 0); assert.equal(value.text.includes(attack), true);
      assert.equal(value.summary.includes('自检失败'), false, value.summary); assert.equal(value.errors, 0, value.summary);
    });
  } finally {
    if (verification) await verification.close();
    for (const owned of browsers.reverse()) {
      if (owned.driver && !owned.driver.cdp.closed) await owned.driver.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
      owned.driver?.cdp.close();
      killChrome(owned.proc);
    }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await sleep(300);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
