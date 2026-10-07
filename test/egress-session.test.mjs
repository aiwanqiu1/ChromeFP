import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { CDP, sleep } from '../lib/cdp.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const observedIp = '203.0.113.51';
const directSystem = { supported: true, enabled: false, server: null, pac: null, bypass: null, autoDetect: false };

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-egress-session-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.copyFileSync(path.join(source, 'fp-browser.mjs'), path.join(temporary, 'fp-browser.mjs'));
  fs.cpSync(path.join(source, 'lib'), path.join(temporary, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'launcher-config.json'), JSON.stringify({ proxy: null }));
  const systemFile = path.join(temporary, 'system-fixture.json');
  fs.writeFileSync(systemFile, JSON.stringify(directSystem));
  const replaceModule = (name, replacement) => {
    const modulePath = path.join(temporary, 'lib', name + '.mjs');
    fs.copyFileSync(modulePath, path.join(temporary, 'lib', name + '-original.mjs'));
    fs.writeFileSync(modulePath, replacement);
  };
  replaceModule('systemproxy', `
    import fs from 'node:fs';
    export * from './systemproxy-original.mjs';
    export function readWindowsProxy() {
      return JSON.parse(fs.readFileSync(new URL('../system-fixture.json',import.meta.url),'utf8'));
    }
  `);
  replaceModule('geo', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { CDP } from './cdp.mjs';
    import { egressCacheKey, readWindowsProxy } from './systemproxy.mjs';
    export { isUsableGeo } from './geo-original.mjs';
    export async function lookupGeo(options) {
      options.signal?.throwIfAborted();
      assert.equal(options.proxyMode,'auto','inherit the computer network without a named proxy app');
      assert.equal(options.proxyUrl,null);
      if (!process.argv.includes('--print-config')) {
        assert.equal(typeof options.wsUrl,'string','regular startup must observe the running formal browser');
        const [port,browserPath] = fs.readFileSync(new URL('../profiles/session-match/DevToolsActivePort',import.meta.url),'utf8').trim().split(/\\r?\\n/);
        assert.equal(options.wsUrl,'ws://127.0.0.1:'+port+browserPath,
          'startup and monitoring must use the browser belonging to this user-data-dir');
        const cdp=await CDP.connect(options.wsUrl);
        try { assert.match((await cdp.send('Browser.getVersion')).product,/Chrome\\//); }
        finally { cdp.close(); }
      }
      const systemProxySnapshot=readWindowsProxy();
      fs.appendFileSync(new URL('../events.jsonl',import.meta.url),JSON.stringify({type:'lookup',wsUrl:options.wsUrl??null,systemProxySnapshot})+'\\n');
      return {ip:${JSON.stringify(observedIp)},countryCode:'JP',timezone:'Asia/Tokyo',lat:35.6,lon:139.6,
        source:'fixture',isProxy:false,isHosting:false,detectionSource:'fixture',detectionError:null,
        egressKey:egressCacheKey('auto',null,systemProxySnapshot),systemProxySnapshot};
    }
  `);
  replaceModule('driver', `
    import fs from 'node:fs';
    import { runDriver as original } from './driver-original.mjs';
    export async function runDriver(options) {
      const driver=await original(options);
      const update=driver.updateConfig.bind(driver);
      driver.updateConfig=async cfg=>{
        const result=await update(cfg);
        fs.appendFileSync(new URL('../events.jsonl',import.meta.url),JSON.stringify({type:'apply',sourceIp:cfg.sourceIp,
          noiseSeed:cfg.noiseSeed,webrtcExpectedIp:cfg.webrtcExpectedIp})+'\\n');
        return result;
      };
      return driver;
    }
  `);
  replaceModule('ip-monitor', `
    import { startIPMonitor as original } from './ip-monitor-original.mjs';
    export function startIPMonitor(options) { return original({...options,intervalMs:50}); }
  `);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return {
    temporary,
    setSystem(value) { fs.writeFileSync(systemFile, JSON.stringify(value)); },
    events() {
      try { return fs.readFileSync(path.join(temporary, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

test('print-config can observe the automatic system exit without starting a formal user browser', t => {
  const current = fixture(t);
  const output = execFileSync(process.execPath, [path.join(current.temporary, 'fp-browser.mjs'), '--profile', 'session-match',
    '--chrome', process.execPath, '--print-config'], {
    cwd: current.temporary, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cfg = JSON.parse(output.slice(output.lastIndexOf('\n{')));
  assert.equal(cfg.sourceIp, observedIp);
  assert.equal(fs.existsSync(path.join(current.temporary, 'profiles')), false);
  assert.equal(current.events().filter(event => event.type === 'lookup').length, 1);
});

test('real CLI observes its formal browser and updates same-IP system proxy changes while keeping the fingerprint stable',
  { timeout: 30000 }, async t => {
    const current = fixture(t);
    const child = spawn(process.execPath, [path.join(current.temporary, 'fp-browser.mjs'), '--headless', '--profile', 'session-match'], {
      cwd: current.temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '', cdp;
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { errors += data.toString(); });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const until = async (check, message, timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline && child.exitCode === null) {
        if (await check()) return;
        await sleep(50);
      }
      assert.fail(errors || message);
    };
    try {
      await until(() => output.includes('✅ 已就绪'), 'CLI must become ready with the formal browser observation');
      const verifyUrl = output.match(/自检页\s*:\s*(http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
      assert.ok(verifyUrl);
      const state = () => fetch(verifyUrl + 'state').then(response => response.json());
      const initial = await state();
      assert.equal(initial.webrtcProtect, false);
      const firstProxy = { ...directSystem, enabled: true, server: '127.0.0.1:7890' };
      current.setSystem(firstProxy);
      let afterProxy;
      await until(async () => {
        afterProxy = await state();
        return afterProxy.webrtcProtect === true && afterProxy.egressDesc.includes(firstProxy.server);
      }, 'same-IP system proxy enable must update protection and displayed effective route');
      const secondProxy = { ...firstProxy, server: '127.0.0.1:7891' };
      current.setSystem(secondProxy);
      let afterPort;
      await until(async () => {
        afterPort = await state();
        return afterPort.egressDesc.includes(secondProxy.server);
      }, 'same-IP system proxy port changes must update the observed route');
      for (const next of [afterProxy, afterPort]) {
        assert.equal(next.ip, observedIp);
        assert.equal(next.noiseSeed, initial.noiseSeed);
        assert.equal(next.fingerprintId, initial.fingerprintId);
        assert.equal(next.webrtcExpectedIp, observedIp);
      }
      const events = current.events();
      const queries = events.filter(event => event.type === 'lookup');
      assert.ok(queries.length >= 3);
      assert.equal(new Set(queries.map(event => event.wsUrl)).size, 1,
        'startup and later network observations must come from the same browser session');
      const applied = events.filter(event => event.type === 'apply');
      assert.equal(applied.length, 2, 'each changed effective route is applied once despite unchanged public IP');
      assert.ok(applied.every(event => event.noiseSeed === initial.noiseSeed && event.webrtcExpectedIp === observedIp));
      cdp = await CDP.connect(queries[0].wsUrl);
      await cdp.send('Browser.close').catch(() => {});
      assert.equal(await Promise.race([exited, sleep(5000).then(() => 'timeout')]), 0, errors);
    } finally {
      cdp?.close();
      if (child.exitCode === null) {
        if (process.platform === 'win32') {
          try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
        } else child.kill();
      }
      await sleep(300);
    }
  });
