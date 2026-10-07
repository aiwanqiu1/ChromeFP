import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { CDP, launchChrome } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { buildProvider } from '../lib/provider.mjs';
import { startVerifyServer } from '../lib/verifypage.mjs';
import { parseArgs } from '../lib/options.mjs';
import { isUsableGeo } from '../lib/geo.mjs';
import { egressCacheKey, shouldProtectWebRTC, describeEgress } from '../lib/systemproxy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('CDP disconnect rejects pending commands immediately', async () => {
  class Socket extends EventTarget { send() {} }
  const socket = new Socket();
  const cdp = new CDP(socket);
  const result = cdp.send('Test.pending', {}, undefined, 100).catch(error => error.message);
  socket.dispatchEvent(new Event('close'));
  assert.equal(cdp.pending.size, 0);
  assert.match(await result, /关闭|断开|closed/i);
  await assert.rejects(cdp.send('Test.afterClose', {}, undefined, 100), /关闭|断开|closed/i);
});

test('navigation waits for the actual completion of target overrides', async () => {
  const originalConnect = CDP.connect;
  const events = new Map();
  const calls = [];
  let finishOverride;
  const override = new Promise(resolve => { finishOverride = resolve; });
  const fake = {
    closed: false,
    on(method, listener) { events.set(method, listener); },
    close() { this.closed = true; events.get('__closed')?.({}); },
    async send(method, params = {}, sessionId) {
      calls.push(method);
      if (method === 'Browser.getVersion') return { product: 'Chrome/Test' };
      if (method === 'Target.createTarget') {
        events.get('Target.attachedToTarget')({ sessionId: 'session', targetInfo: { type: 'page', targetId: 'target' } });
        return { targetId: 'target' };
      }
      if (method === 'Emulation.setTimezoneOverride') await override;
      return {};
    },
  };
  CDP.connect = async () => fake;
  let driver;
  let opened;
  try {
    driver = await runDriver({ wsUrl: 'unused', cfg: { timezoneId: 'Asia/Tokyo' } });
    opened = driver.openUrl('https://example.invalid/');
    await tick();
    assert.equal(calls.includes('Page.navigate'), false, 'document must not execute before overrides finish');
  } finally {
    finishOverride();
    await opened;
    fake.close();
    CDP.connect = originalConnect;
  }
  assert.equal(calls.includes('Page.navigate'), true);
});

function providerSandbox(cfg) {
  class Canvas {
    constructor() { this.width = 8; this.height = 8; this.pixels = new Uint8ClampedArray(256).fill(100); }
    getContext() { return new Context(this); }
    toDataURL() { return Array.from(this.pixels).join(','); }
    toBlob(callback) { callback(this.toDataURL()); }
  }
  class Context {
    constructor(canvas) { this.canvas = canvas; }
    getImageData() { return { width: 8, height: 8, data: this.canvas.pixels.slice() }; }
    putImageData(image) { this.canvas.pixels.set(image.data); }
    drawImage(canvas) { this.canvas.pixels.set(canvas.pixels); }
  }
  class Audio {
    getFloatFrequencyData(data) { data.fill(-20); }
  }
  const related = '192.168.1.123';
  const hidden = '198.51.100.77';
  const sdp = [
    'v=0',
    `a=candidate:1 1 udp 1 ${hidden} 5000 typ srflx raddr ${related} rport 4000`,
    `a=candidate:2 1 udp 1 203.0.113.1 5000 typ relay raddr ${hidden} rport 4000`,
    `a=candidate:3 1 udp 1 ${related} 4000 typ host`,
    'a=candidate:4 1 udp 1 local-name.local 4000 typ host',
  ].join('\r\n') + '\r\n';
  class RTC extends EventTarget {
    constructor() { super(); this.handler = null; }
    get onicecandidate() { return this.handler; }
    set onicecandidate(handler) { this.handler = handler; }
    get localDescription() { return { type: 'offer', sdp }; }
    get currentLocalDescription() { return this.localDescription; }
    get pendingLocalDescription() { return this.localDescription; }
    async createOffer() { return { type: 'offer', sdp }; }
    async createAnswer() { return { type: 'answer', sdp }; }
    async getStats() { return new Map([
      ['hidden', { id: 'hidden', type: 'local-candidate', address: hidden }],
      ['allowed', { id: 'allowed', type: 'local-candidate', address: '203.0.113.1', relatedAddress: hidden }],
      ['remote', { id: 'remote', type: 'remote-candidate', address: '198.51.100.2' }],
    ]); }
  }
  class Transport {
    getLocalCandidates() { return [{ candidate: `candidate:2 1 udp 1 203.0.113.1 5000 typ relay raddr ${hidden} rport 4000`, relatedAddress: hidden }]; }
    getSelectedCandidatePair() { return { local: this.getLocalCandidates()[0], remote: { candidate: '' } }; }
  }
  const context = vm.createContext({
    Navigator: class {}, HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context,
    AnalyserNode: Audio, RTCPeerConnection: RTC, RTCIceTransport: Transport,
    RTCSessionDescription: class { constructor(description) { Object.assign(this, description); } },
    document: { createElement: () => new Canvas() },
    Uint8ClampedArray, Uint8Array, Event, EventTarget,
  });
  vm.runInContext(buildProvider({ noiseSeed: 12345, ...cfg }), context);
  return { Canvas, Context, Audio, RTC, Transport, hidden, related };
}

test('Canvas noise is repeatable and does not change the displayed canvas', () => {
  const { Canvas } = providerSandbox({ canvasNoise: true });
  const canvas = new Canvas();
  const before = Array.from(canvas.pixels);
  const first = canvas.toDataURL();
  assert.equal(canvas.toDataURL(), first);
  assert.deepEqual(Array.from(canvas.pixels), before);
  const context = canvas.getContext('2d');
  assert.deepEqual(Array.from(context.getImageData().data), Array.from(context.getImageData().data));
});

test('audio noise is repeatable for the same native readings', () => {
  const { Audio } = providerSandbox({ audioNoise: true });
  const audio = new Audio();
  const first = new Float32Array(256), second = new Float32Array(256);
  audio.getFloatFrequencyData(first); audio.getFloatFrequencyData(second);
  assert.deepEqual(first, second);
});

function candidateEvent(address, type = 'srflx') {
  const event = new Event('icecandidate');
  event.candidate = { candidate: `candidate:1 1 udp 1 ${address} 5000 typ ${type}` };
  return event;
}

test('WebRTC preserves listener identity and filters object listeners', () => {
  const { RTC } = providerSandbox({ webrtcExpectedIp: '203.0.113.1' });
  const rtc = new RTC();
  let called = 0;
  const listener = () => called++;
  rtc.addEventListener('icecandidate', listener);
  rtc.removeEventListener('icecandidate', listener);
  rtc.dispatchEvent(candidateEvent('203.0.113.1'));
  assert.equal(called, 0);
  rtc.addEventListener('icecandidate', { handleEvent() { called++; } });
  rtc.dispatchEvent(candidateEvent('198.51.100.77'));
  assert.equal(called, 0);
  rtc.onicecandidate = listener;
  assert.equal(rtc.onicecandidate, listener);
});

test('WebRTC also filters local SDP and local candidate statistics', async () => {
  const { RTC, Transport, hidden, related } = providerSandbox({ webrtcExpectedIp: '203.0.113.1' });
  const rtc = new RTC();
  for (const description of [await rtc.createOffer(), await rtc.createAnswer(), rtc.localDescription,
    rtc.currentLocalDescription, rtc.pendingLocalDescription]) {
    assert.equal(description.sdp.includes(hidden), false);
    assert.equal(description.sdp.includes(related), false);
    assert.equal(description.sdp.includes('local-name.local'), true);
  }
  const stats = Array.from((await rtc.getStats()).values());
  assert.equal(JSON.stringify(stats).includes(hidden), false);
  assert.equal(stats.some(row => row.type === 'remote-candidate'), true);
  const transport = new Transport();
  assert.equal(JSON.stringify(transport.getLocalCandidates()).includes(hidden), false);
  assert.equal(JSON.stringify(transport.getSelectedCandidatePair()).includes(hidden), false);
});

test('invalid CLI values are rejected before network or browser startup', () => {
  for (const args of [
    ['--profile', '..'], ['--profile', '../other'], ['--profile', 'CON'],
    ['--cores', 'NaN'], ['--cores', '0'], ['--cores', '1.5'],
    ['--device-memory', '3'], ['--cache-geo', '-1'],
    ['--proxy', 'http://user:password@localhost:1234'], ['--direct', '--proxy', 'http://localhost:1234'],
    ['--profile'], ['--webgl'], ['--url', 'javascript:alert(1)'],
  ]) {
    const result = spawnSync(process.execPath, ['fp-browser.mjs', ...args, '--help'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal((result.stderr || '').includes('user:password'), false);
    assert.equal((result.stderr || '').includes('TypeError:'), false);
  }
});

test('verification data cannot terminate the inline script or create HTML', async () => {
  const server = await startVerifyServer({ region: '</script><script>window.injected=1</script>',
    city: '<img src=x onerror=alert(1)>', ip: '203.0.113.1', countryCode: 'JP', timezone: 'Asia/Tokyo', locale: 'ja-JP' });
  try {
    const html = await (await fetch(server.url)).text();
    assert.equal((html.match(/<script>/g) || []).length, 1);
    assert.equal(html.includes('b.innerHTML = v'), false);
  } finally { await server.close(); }
});

test('an invalid Chrome executable fails quickly with the actual error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-test-'));
  const start = Date.now();
  try {
    await assert.rejects(launchChrome({ exe: path.join(dir, 'does-not-exist.exe'), userDataDir: dir, timeoutMs: 900 }), /ENOENT|找不到|不存在/);
    assert.ok(Date.now() - start < 800);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the normal startup refreshes geography, and opt-in caches follow system proxy settings', () => {
  assert.equal(parseArgs([]).cacheMinutes, 0);
  const first = { supported: true, enabled: true, server: '127.0.0.1:7890', pac: null, bypass: null, autoDetect: false };
  assert.notEqual(egressCacheKey('auto', null, first), egressCacheKey('auto', null, { ...first, server: '127.0.0.1:7891' }));
  assert.notEqual(egressCacheKey('auto', null, first), egressCacheKey('auto', null, { ...first, enabled: false }));
  assert.notEqual(egressCacheKey('auto', null, first), egressCacheKey('auto', null, { ...first, pac: 'https://example.invalid/proxy.pac' }));
});

test('invalid geolocation responses cannot silently restore the local timezone or use zero coordinates', () => {
  const valid = { ip: '203.0.113.1', countryCode: 'JP', timezone: 'Asia/Tokyo', lat: 35.6762, lon: 139.6503 };
  assert.equal(isUsableGeo(valid), true);
  for (const broken of [{ timezone: '' }, { lat: null }, { lon: undefined }, { ip: 'invalid' },
    { countryCode: '' }, { timezone: 'not-a-timezone' }, { lat: 91 }, { lon: 181 }]) {
    assert.equal(isUsableGeo({ ...valid, ...broken }), false);
  }
});

test('WebRTC auto mode distinguishes configured proxy, direct access and unknown auto-discovery', () => {
  const direct = { supported: true, enabled: false, server: null, pac: null, autoDetect: false };
  assert.equal(shouldProtectWebRTC(null, 'auto', direct), false);
  assert.equal(shouldProtectWebRTC(null, 'auto', { ...direct, enabled: true }), true);
  assert.equal(shouldProtectWebRTC(null, 'auto', { ...direct, autoDetect: null }), true);
  assert.equal(shouldProtectWebRTC(null, 'explicit', direct), true);
  assert.equal(shouldProtectWebRTC(null, 'direct', direct), false);
  assert.equal(shouldProtectWebRTC(true, 'direct', direct), true);
  assert.equal(shouldProtectWebRTC(false, 'explicit', direct), false);
  assert.equal(describeEgress('auto', null, { ...direct, pac: 'https://proxy.invalid/file.pac?token=secret' }).includes('secret'), false);
});

test('WebRTC once and aborted listeners count only delivered candidates', () => {
  const { RTC } = providerSandbox({ webrtcExpectedIp: '203.0.113.1' });
  const rtc = new RTC();
  let count = 0;
  rtc.addEventListener('icecandidate', () => count++, { once: true });
  rtc.dispatchEvent(candidateEvent('198.51.100.77'));
  rtc.dispatchEvent(candidateEvent('203.0.113.1'));
  rtc.dispatchEvent(candidateEvent('203.0.113.1'));
  assert.equal(count, 1);
  const controller = new AbortController();
  rtc.addEventListener('icecandidate', () => count++, { signal: controller.signal });
  controller.abort();
  rtc.dispatchEvent(candidateEvent('203.0.113.1'));
  assert.equal(count, 1);
});

test('WebRTC keeps TURN relay fallbacks while hiding client addresses', async () => {
  const relay = '198.51.100.22';
  const hidden = '192.0.2.1';
  const relayLine = `candidate:relay 1 udp 1677734911 ${relay} 3478 typ relay raddr ${hidden} rport 5000`;
  const hostLine = `candidate:host 1 udp 2122260223 ${hidden} 5000 typ host`;
  const candidate = { candidate: relayLine, relatedAddress: hidden, sdpMid: '0', sdpMLineIndex: 0 };
  const sdp = `v=0\r\na=${relayLine}\r\na=${hostLine}\r\n`;
  class Peer extends EventTarget {
    get localDescription() { return { type: 'offer', sdp }; }
    async createOffer() { return { type: 'offer', sdp }; }
    async getStats() { return new Map([
      ['relay', { id: 'relay', type: 'local-candidate', candidateType: 'relay', address: relay, relatedAddress: hidden }],
      ['host', { id: 'host', type: 'local-candidate', candidateType: 'host', address: hidden }],
      ['pair', { id: 'pair', type: 'candidate-pair', localCandidateId: 'relay' }],
      ['transport', { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' }],
    ]); }
  }
  class Transport {
    getLocalCandidates() { return [candidate, { candidate: hostLine }]; }
    getSelectedCandidatePair() { return { local: candidate, remote: { candidate: '' } }; }
  }
  const context = vm.createContext({ RTCPeerConnection: Peer, RTCIceTransport: Transport, URL, EventTarget, Event });
  vm.runInContext(buildProvider({ webrtcExpectedIp: '203.0.113.1' }), context);
  const peer = new Peer();
  const events = [];
  peer.addEventListener('icecandidate', event => events.push(event.candidate));
  for (const value of [candidate, { candidate: hostLine }]) {
    const event = new Event('icecandidate'); event.candidate = value; peer.dispatchEvent(event);
  }
  const offer = await peer.createOffer();
  const local = peer.localDescription;
  const stats = await peer.getStats();
  const transport = new Transport();
  const candidates = transport.getLocalCandidates();
  const pair = transport.getSelectedCandidatePair();
  assert.deepEqual({
    delivered: events.length,
    offerHasRelay: offer.sdp.includes(relay),
    localHasRelay: local.sdp.includes(relay),
    statsHasRelay: stats.has('relay'),
    statsHasPair: stats.has('pair'),
    selectedPairReference: stats.get('transport')?.selectedCandidatePairId === 'pair',
    localCandidateCount: candidates.length,
    transportHasRelay: !!pair?.local,
  }, {
    delivered: 1, offerHasRelay: true, localHasRelay: true,
    statsHasRelay: true, statsHasPair: true, selectedPairReference: true,
    localCandidateCount: 1, transportHasRelay: true,
  });
  assert.equal(stats.has('host'), false);
  assert.equal(JSON.stringify({ events, offer, local, stats: Array.from(stats), candidates, pair }).includes(hidden), false);
});
