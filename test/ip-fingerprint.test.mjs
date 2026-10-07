import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { egressCacheKey } from '../lib/systemproxy.mjs';
import { launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const firstIp = '203.0.113.11';
const secondIp = '203.0.113.12';
const geography = {
  countryCode: 'JP', timezone: 'Asia/Tokyo', lat: 35.6762, lon: 139.6503,
  source: 'fixture', isProxy: false, isHosting: false,
  detectionSource: 'fixture', detectionError: null,
};

function cliFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-ip-config-'));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Copy only executable source. Existing browser profiles and real IP caches
  // are never read, copied or opened by this regression fixture.
  fs.copyFileSync(path.join(source, 'fp-browser.mjs'), path.join(temporary, 'fp-browser.mjs'));
  fs.cpSync(path.join(source, 'lib'), path.join(temporary, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(temporary, 'cache'));
  const proxy = 'http://127.0.0.1:65432';
  const geoModule = path.join(temporary, 'lib', 'geo.mjs');
  fs.copyFileSync(geoModule, path.join(temporary, 'lib', 'geo-original.mjs'));
  fs.writeFileSync(geoModule, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    export { isUsableGeo } from './geo-original.mjs';
    export async function lookupGeo(options) {
      assert.equal(options.proxyMode, 'explicit');
      assert.equal(options.proxyUrl, ${JSON.stringify(proxy)});
      options.signal?.throwIfAborted();
      fs.appendFileSync(new URL('../geo-lookups.jsonl', import.meta.url), JSON.stringify({
        proxyMode:options.proxyMode,proxyUrl:options.proxyUrl,
      }) + '\\n');
      return JSON.parse(fs.readFileSync(new URL('../current-geo.json', import.meta.url), 'utf8'));
    }
  `);
  const cacheFile = path.join(temporary, 'cache', 'geo-' + egressCacheKey('explicit', proxy, {}) + '.json');
  return (ip, extra = [], cachedIp = ip) => {
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 2, at: Date.now(), geo: { ...geography, ip: cachedIp } }));
    fs.writeFileSync(path.join(temporary, 'current-geo.json'), JSON.stringify({ ...geography, ip }));
    fs.writeFileSync(path.join(temporary, 'geo-lookups.jsonl'), '');
    const output = execFileSync(process.execPath, [path.join(temporary, 'fp-browser.mjs'),
      '--profile', 'same-profile', '--proxy', proxy, '--cache-geo', '10',
      '--chrome', process.execPath, '--print-config', ...extra], {
      cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const json = output.slice(output.lastIndexOf('\n{'));
    assert.ok(json.trim().startsWith('{'), 'the real CLI must print its generated configuration');
    assert.equal(fs.existsSync(path.join(temporary, 'profiles')), false,
      '--print-config must not create or start a browser profile');
    assert.equal(fs.readFileSync(path.join(temporary, 'geo-lookups.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length, 1,
      'the CLI must query the current exit once even when a valid geography cache exists');
    return JSON.parse(json);
  };
}

test('actual CLI derives a stable fingerprint seed from the current IP within one country and profile', t => {
  const config = cliFixture(t);
  const first = config(firstIp);
  const second = config(secondIp);
  const repeated = config(firstIp);
  assert.equal(first.locale, second.locale, 'both exits have the same country');
  assert.equal(first.timezoneId, second.timezoneId, 'both exits have the same timezone');
  assert.deepEqual(first, repeated, 'returning to the same IP must reproduce its configuration');
  assert.notEqual(first.noiseSeed, second.noiseSeed, 'changing only the exit IP must change the seed');
});

test('actual CLI enables the generated Canvas and Audio fingerprint by default', t => {
  const config = cliFixture(t);
  for (const ip of [firstIp, secondIp]) {
    const cfg = config(ip);
    assert.equal(cfg.canvasNoise, true, 'the generated fingerprint must reach Canvas without extra flags');
    assert.equal(cfg.audioNoise, true, 'the generated fingerprint must reach Audio without extra flags');
    assert.ok(Number.isInteger(cfg.hardwareConcurrency) && cfg.hardwareConcurrency > 0);
    assert.ok([0.25, 0.5, 1, 2, 4, 8, 16, 32].includes(cfg.deviceMemory));
    assert.equal(cfg.webrtcExpectedIp, ip);
  }
});

test('actual CLI retains explicit hardware choices while the current IP selects the noise', t => {
  const config = cliFixture(t);
  const first = config(firstIp, ['--cores', '12', '--device-memory', '16']);
  const second = config(secondIp, ['--cores', '12', '--device-memory', '16']);
  for (const cfg of [first, second]) {
    assert.equal(cfg.hardwareConcurrency, 12);
    assert.equal(cfg.deviceMemory, 16);
  }
  assert.notEqual(first.noiseSeed, second.noiseSeed);
});

test('actual CLI gives the same IP the same fingerprint across profile names', t => {
  const config = cliFixture(t);
  const first = config(firstIp);
  const second = config(firstIp, ['--profile', 'another-profile']);
  assert.equal(first.noiseSeed, second.noiseSeed, 'browser data isolation must not select the IP fingerprint');
  assert.equal(first.fingerprintId, second.fingerprintId);
  assert.equal(first.hardwareConcurrency, second.hardwareConcurrency);
  assert.equal(first.deviceMemory, second.deviceMemory);
});

test('actual CLI chooses the freshly observed IP over a still-valid cache for the same proxy', t => {
  const config = cliFixture(t);
  const current = config(secondIp, [], firstIp);
  const expected = config(secondIp);
  const previous = config(firstIp);
  assert.equal(current.sourceIp, secondIp);
  assert.equal(current.webrtcExpectedIp, secondIp);
  assert.equal(current.fingerprintId, expected.fingerprintId);
  assert.notEqual(current.fingerprintId, previous.fingerprintId);
  assert.notEqual(current.noiseSeed, previous.noiseSeed);
});

test('IP-derived fingerprints normalize equivalent IPv6 addresses and reject invalid IP input', async () => {
  const { canonicalIPAddress, deriveFingerprint } = await import('../lib/fingerprint.mjs');
  const short = '2001:db8::1';
  const expanded = '2001:0DB8:0000:0000:0000:0000:0000:0001';
  assert.equal(canonicalIPAddress(short), canonicalIPAddress(expanded));
  assert.deepEqual(deriveFingerprint(short), deriveFingerprint(expanded));
  assert.notEqual(deriveFingerprint(short).noiseSeed, deriveFingerprint('2001:db8::2').noiseSeed);
  for (const value of [undefined, null, '', 'invalid', '256.1.1.1', ['203.0.113.1']]) {
    assert.throws(() => deriveFingerprint(value), 'invalid current IP must not silently generate a fingerprint');
  }
});

const fingerprintExpression = `(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(110,90,170)'; ctx.fillRect(0,0,32,32);
  ctx.fillStyle = 'rgb(30,190,70)'; ctx.fillText('IP fingerprint',1,17);
  const canvasFirst = canvas.toDataURL();
  const canvasSecond = canvas.toDataURL();
  const offline = new OfflineAudioContext(1,4096,44100);
  const oscillator = offline.createOscillator();
  oscillator.type = 'triangle'; oscillator.frequency.value = 1000;
  const compressor = offline.createDynamicsCompressor();
  oscillator.connect(compressor); compressor.connect(offline.destination);
  oscillator.start(0);
  const buffer = await offline.startRendering();
  const samples = Array.from(buffer.getChannelData(0));
  const repeated = Array.from(buffer.getChannelData(0));
  const copied = new Float32Array(buffer.length); buffer.copyFromChannel(copied,0);
  return {
    canvas:canvasFirst, samples,
    canvasStable:canvasFirst === canvasSecond,
    audioStable:samples.every((sample,index) => sample === repeated[index]),
    audioCopyMatches:samples.every((sample,index) => sample === copied[index]),
    cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,
    locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
})()`;

test('real Chrome changes Canvas and OfflineAudio fingerprints for a changed IP and repeats the same IP',
  { timeout: 90000 }, async t => {
    const config = cliFixture(t);
    const configs = [config(firstIp), config(secondIp), config(firstIp)];
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-ip-browser-'));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><meta charset="utf-8"><title>IP fingerprint fixture</title>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const fingerprints = [];
    const owned = [];
    try {
      for (const [index, cfg] of configs.entries()) {
        const launched = await launchChrome({ exe: resolveChromePath(),
          userDataDir: path.join(temporary, 'run-' + index),
          args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync',
            '--no-proxy-server', '--lang=' + cfg.locale, '--accept-lang=' + cfg.acceptLanguage],
        });
        const current = { ...launched, driver: null };
        owned.push(current);
        current.driver = await runDriver({ wsUrl: launched.wsUrl, cfg });
        const target = await current.driver.openUrl(url);
        const result = await current.driver.cdp.send('Runtime.evaluate', {
          expression: fingerprintExpression, awaitPromise: true, returnByValue: true,
        }, current.driver.sessionByTarget.get(target));
        assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
        const value = result.result.value;
        assert.equal(value.canvasStable, true);
        assert.equal(value.audioStable, true);
        assert.equal(value.audioCopyMatches, true, 'both native AudioBuffer read APIs must agree');
        assert.ok(value.samples.some(sample => sample !== 0), 'the OfflineAudio graph must actually render');
        const digest = input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
        fingerprints.push({ ...value, canvas: digest(value.canvas), samples: digest(value.samples) });
        await current.driver.cdp.send('Browser.close').catch(() => {});
        current.driver.cdp.close();
        killChrome(current.proc);
      }
      await t.test('Canvas responds to an IP change within the same country and profile', () => {
        assert.notEqual(fingerprints[0].canvas, fingerprints[1].canvas,
          'same country and same profile must still produce a different Canvas fingerprint after an IP change');
      });
      await t.test('OfflineAudio responds to the same IP change', () => {
        assert.notEqual(fingerprints[0].samples, fingerprints[1].samples,
          'the common OfflineAudio fingerprint must change with the IP');
      });
      await t.test('returning to the same IP repeats actual browser readings', () => {
        assert.deepEqual(fingerprints[0], fingerprints[2], 'same IP must reproduce actual browser readings');
      });
    } finally {
      for (const current of owned.reverse()) {
        if (current.driver && !current.driver.cdp.closed) {
          await current.driver.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
        }
        current.driver?.cdp.close();
        killChrome(current.proc);
      }
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await sleep(200);
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
