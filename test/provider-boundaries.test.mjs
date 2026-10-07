import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildProvider } from '../lib/provider.mjs';
import { startVerifyServer } from '../lib/verifypage.mjs';

test('Canvas noise uses the same pixels for positive and negative read dimensions', () => {
  class Canvas { constructor() { this.width = 8; this.height = 8; } }
  class Context {
    constructor(canvas) { this.canvas = canvas; }
    getImageData(_x, _y, width, height) {
      return { width: Math.abs(width), height: Math.abs(height),
        data: new Uint8ClampedArray(Math.abs(width * height) * 4).fill(100) };
    }
  }
  const realm = vm.createContext({ HTMLCanvasElement: Canvas, CanvasRenderingContext2D: Context });
  vm.runInContext(buildProvider({ canvasNoise: true, noiseSeed: 12345 }), realm);
  const context = new Context(new Canvas());
  const positive = context.getImageData(0, 0, 8, 8).data;
  for (const args of [[8, 0, -8, 8], [0, 8, 8, -8], [8, 8, -8, -8]]) {
    assert.deepEqual(context.getImageData(...args).data, positive, JSON.stringify(args));
  }
});

test('Audio noise leaves samples beyond frequencyBinCount untouched', () => {
  class Audio {
    get frequencyBinCount() { return 4; }
    getFloatFrequencyData(data) { data.fill(-20, 0, Math.min(data.length, this.frequencyBinCount)); }
  }
  const realm = vm.createContext({ AnalyserNode: Audio });
  vm.runInContext(buildProvider({ audioNoise: true, noiseSeed: 12345 }), realm);
  const samples = new Float32Array(8).fill(37);
  new Audio().getFloatFrequencyData(samples);
  assert.deepEqual(Array.from(samples.slice(4)), [37, 37, 37, 37]);
  assert.ok(samples.slice(0, 4).some(value => value !== -20), 'actual frequency samples still receive noise');
});

async function verifyTables(expect = {}, candidateType = 'relay') {
  const server = await startVerifyServer({ ip: '203.0.113.1', countryCode: 'US',
    timezone: 'UTC', locale: 'en-US', overrideGeolocation: false, webrtcProtect: true, ...expect });
  let html;
  try { html = await (await fetch(server.url)).text(); }
  finally { await server.close(); }
  const tables = new Map();
  const element = () => ({ children: [], replaceChildren() { this.children = []; },
    append(...children) { this.children.push(...children); }, getContext() { return null; } });
  const document = { createElement: element, getElementById(id) {
    if (!tables.has(id)) tables.set(id, element());
    return tables.get(id);
  } };
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; }
    createDataChannel() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    setLocalDescription() { return Promise.resolve(); }
    get localDescription() { return { sdp: `a=candidate:1 1 udp 1 198.51.100.22 3478 typ ${candidateType}\r\n` }; }
    getStats() { return Promise.resolve(new Map([['candidate', { type: 'local-candidate',
      candidateType, address: '198.51.100.22' }]])); }
    close() {}
  }
  const realm = vm.createContext({ document, RTCPeerConnection: Peer,
    navigator: { language: 'en-US', languages: ['en-US'] },
    screen: { width: 1280, height: 720 }, devicePixelRatio: 1, innerWidth: 1280,
    innerHeight: 720, outerWidth: 1280, outerHeight: 720, URL, Blob,
    setTimeout, clearTimeout, fetch: async () => ({ json: async () => ({}) }) });
  await vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], realm);
  return tables;
}

async function webRtcComparison(candidateType) {
  const tables = await verifyTables({}, candidateType);
  const row = tables.get('consistency').children.find(value => value.children[0].textContent === 'WebRTC 页面读数');
  assert.ok(row, 'verification must complete and render its WebRTC comparison');
  return { kind: row.children[1].className, text: row.children[1].textContent };
}

test('verification allows TURN relay addresses and still flags unexpected client candidates', async () => {
  assert.equal((await webRtcComparison('relay')).kind, 'ok');
  assert.equal((await webRtcComparison('srflx')).kind, 'bad');
});

test('verification displays independent IP detection verdicts and marks detected or unknown values as warnings', async () => {
  const cases = [
    [true, false, '是 / 否', 'warn'],
    [false, true, '否 / 是', 'warn'],
    [true, true, '是 / 是', 'warn'],
    [false, false, '否 / 否', 'ok'],
    [null, false, null, 'warn'],
    [false, undefined, null, 'warn'],
    [undefined, undefined, null, 'warn'],
  ];
  for (const [isProxy, isHosting, text, kind] of cases) {
    const tables = await verifyTables({ isProxy, isHosting, detectionSource: 'ipquery.io' });
    const row = tables.get('egress').children.find(value => value.children[0].textContent === '接口判定为代理 / 机房');
    assert.ok(row, 'verification must display the IP detection verdicts');
    assert.equal(row.children[1].className, kind);
    if (text) assert.equal(row.children[1].textContent, text);
    else assert.match(row.children[1].textContent, /接口未提供|未知/);
    const source = tables.get('egress').children.find(value => value.children[0].textContent === '代理 / 机房判定来源');
    assert.ok(source, 'IP detection must have its own source row');
    assert.ok(source.children[1].textContent.includes('ipquery.io'));
  }
});

test('verification renders IP detection failure and its source as text', async () => {
  const detectionSource = '</script><script>window.injected=true</script>';
  const detectionError = '<img src=x onerror=alert(1)> 判定接口超时';
  const tables = await verifyTables({ isProxy: null, isHosting: null, detectionSource, detectionError });
  const row = tables.get('egress').children.find(value => value.children[0].textContent === '代理 / 机房判定来源');
  assert.ok(row);
  assert.ok(row.children[1].textContent.includes(detectionSource));
  assert.ok(row.children[1].textContent.includes(detectionError));
});
