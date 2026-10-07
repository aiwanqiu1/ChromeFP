import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { CDP, resolveChromePath } from '../lib/cdp.mjs';
import { lookupGeo } from '../lib/geo.mjs';

const geography = {
  ip: '203.0.113.42', countryCode: 'JP', timezone: 'Asia/Tokyo',
  lat: 35.6762, lon: 139.6503,
};
const fixtures = {
  'ipapi.co': { ip: geography.ip, country_code: 'jp', timezone: geography.timezone,
    latitude: geography.lat, longitude: geography.lon },
  'ipinfo.io': { ip: geography.ip, country: 'jp', timezone: geography.timezone,
    loc: geography.lat + ',' + geography.lon },
};
const ipqueryGeography = { ip: geography.ip,
  location: { country_code: 'jp', timezone: geography.timezone,
    latitude: geography.lat, longitude: geography.lon },
  risk: { is_proxy: true, is_datacenter: true } };

async function dormantProxy(t, { geographyBodies = fixtures, detectionBody, holdDetection = false, onDetectionRequest = () => {} } = {}) {
  const requests = [];
  const sockets = new Set();
  // This is a local HTTP proxy fixture: it never forwards any request.
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, host: request.headers.host,
      remoteAddress: request.socket.remoteAddress });
    const endpoint = new URL(request.url, 'http://fixture.example');
    const provider = endpoint.pathname.match(/^\/(ipapi\.co|ipinfo\.io)\/[^/]+\/json\/?$/)?.[1];
    const detectedIP = endpoint.pathname.match(/^\/api\.ipquery\.io\/([^/]+)$/)?.[1];
    if (detectedIP) {
      onDetectionRequest(request);
      if (holdDetection) return;
    }
    const observation = /^\/(?:api\.ipify\.org|api\.ipquery\.io)\/?$/.test(endpoint.pathname);
    const body = provider ? geographyBodies[provider] : detectedIP ? detectionBody ?? ipqueryGeography
      : observation ? { ip: geography.ip } : undefined;
    response.writeHead(body ? 200 : 204, {
      'content-type': 'application/json', 'connection': 'close',
    });
    response.end(body ? JSON.stringify(body) : undefined);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return { server, requests, port, url: 'http://127.0.0.1:' + port };
}

function routeChromeToFixture(t) {
  const navigations = [];
  let connected = 0;
  const originalConnect = CDP.connect;
  t.after(() => { CDP.connect = originalConnect; });
  CDP.connect = async (...args) => {
    const cdp = await originalConnect.apply(CDP, args);
    connected++;
    const send = cdp.send.bind(cdp);
    const browser = await send('Browser.getVersion');
    assert.match(browser.product, /Chrome\//, 'use the actual Chrome CDP connection');
    // Only replace endpoint URLs. CDP resource loads, streams and the proxy stack
    // still run in the actual Chrome started by lookupGeo.
    cdp.send = (method, params = {}, ...rest) => {
      if (method === 'Network.loadNetworkResource') {
        const endpoint = new URL(params.url);
        assert.equal(endpoint.protocol, 'https:');
        assert.ok(Object.hasOwn(fixtures, endpoint.hostname) || ['api.ipquery.io','api.ipify.org'].includes(endpoint.hostname),
          'no unexpected public endpoint');
        navigations.push(endpoint);
        params = { ...params, url: 'http://fixture.example/' + endpoint.hostname + endpoint.pathname + endpoint.search };
      }
      return send(method, params, ...rest);
    };
    return cdp;
  };
  return { navigations, get connected() { return connected; } };
}

function assertDetectionRequest(requests, navigations, geo) {
  const navigation = navigations.filter(endpoint => endpoint.hostname === 'api.ipquery.io' && endpoint.pathname !== '/');
  assert.equal(navigation.length, 1, 'classify the observed IP exactly once');
  assert.equal(navigation[0].pathname, '/' + encodeURIComponent(geo.ip));
  assert.equal(navigation[0].search, '?format=json');
  const detectionRequests = requests.filter(request => /^http:\/\/fixture\.example\/api\.ipquery\.io\/[^/?]+\?format=json$/.test(request.url));
  assert.equal(detectionRequests.length, 1, 'Chrome must send classification through the same explicit proxy');
  assert.equal(detectionRequests[0].url, 'http://fixture.example/api.ipquery.io/' + encodeURIComponent(geo.ip) + '?format=json');
  assert.equal(detectionRequests[0].host, 'fixture.example');
  assert.equal(detectionRequests[0].remoteAddress, '127.0.0.1');
}

test('real Chrome resumes geography and proxy/datacenter lookup through the same late explicit proxy', { timeout: 45000 }, async t => {
  const geographyBodies = { ...fixtures,
    'ipinfo.io': { ...fixtures['ipinfo.io'], ip: '203.0.113.43' },
  };
  const { server, requests, port, url } = await dormantProxy(t, { geographyBodies });
  const messages = [];
  const chrome = routeChromeToFixture(t);
  let listen;
  const geo = await lookupGeo({
    chromeExe: resolveChromePath(), proxyMode: 'explicit', proxyUrl: url,
    proxyTimeoutMs: 3000, timeoutMs: 5000,
    log(message) {
      messages.push(message);
      assert.equal(chrome.connected, 0, 'proxy readiness must precede Chrome connection');
      listen = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      listen.catch(() => {});
    },
  });
  await listen;
  assert.equal(messages.length, 1, 'announce waiting exactly once');
  assert.match(messages[0], /代理.*等待/);
  assert.ok(messages[0].includes(url), 'keep the selected proxy endpoint');
  assert.equal(chrome.connected, 1, 'reuse the geography Chrome connection for classification');
  assert.deepEqual(chrome.navigations.map(endpoint => endpoint.hostname).sort(), ['api.ipify.org', 'api.ipquery.io', 'api.ipquery.io']);
  assert.equal(geo.ip, geography.ip, 'keep the independently observed IP');
  assert.equal(geo.source, 'ipquery.io');assert.equal(geo.egressSource, 'ipify.org');
  for (const [key, value] of Object.entries(geography)) {
    if (key !== 'ip') assert.equal(geo[key], value, key);
  }
  assert.equal(geo.proxyMode, 'explicit');
  assert.equal(geo.proxyUrl, url);
  assert.equal(geo.isProxy, true);
  assert.equal(geo.isHosting, true);
  assert.equal(geo.detectionSource, 'ipquery.io');
  assert.equal(geo.detectionError, null);
  assertDetectionRequest(requests, chrome.navigations, geo);
  assert.ok(requests.length >= 3, 'Chrome must reach the local proxy instead of resolving the fixture domain');
  for (const request of requests.filter(request => request.url.startsWith('http://fixture.example/'))) {
    assert.equal(request.host, 'fixture.example');
    assert.equal(request.remoteAddress, '127.0.0.1');
  }
});

for (const scenario of [
  { name: 'negative proxy/datacenter results',
    detectionBody: { ip: geography.ip, risk: { is_proxy: false, is_datacenter: false } },
    isProxy: false, isHosting: false },
  { name: 'classification API failure', detectionBody: { error: 'classification unavailable' },
    error: /classification unavailable/ },
  { name: 'classification for a different IP',
    detectionBody: { ip: '203.0.113.99', risk: { is_proxy: true, is_datacenter: true } },
    error: /IP.*不一致/ },
  { name: 'classification timeout', holdDetection: true, error: /超时/ },
  { name: 'incomplete primary geography with valid risk verdicts',
    detectionBody: { ...ipqueryGeography, location: { ...ipqueryGeography.location, latitude: null },
      risk: { is_proxy: true, is_datacenter: false } }, isProxy: true, isHosting: false },
  { name: 'missing risk verdicts with complete primary geography',
    detectionBody: { ...ipqueryGeography, risk: {} }, error: /未提供完整/, primaryGeography: true },
]) {
  test('real Chrome preserves geography with ' + scenario.name, { timeout: 45000 }, async t => {
    const { server, requests, port, url } = await dormantProxy(t, scenario);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const chrome = routeChromeToFixture(t);
    const geo = await lookupGeo({
      chromeExe: resolveChromePath(), proxyMode: 'explicit', proxyUrl: url,
      proxyTimeoutMs: 1000, timeoutMs: 5000, detectionTimeoutMs: 750,
    });
    for (const [key, value] of Object.entries(geography)) assert.equal(geo[key], value, key);
    assert.equal(geo.isProxy, scenario.isProxy ?? null);
    assert.equal(geo.isHosting, scenario.isHosting ?? null);
    assert.equal(geo.detectionSource, 'ipquery.io');
    if (scenario.error) assert.match(geo.detectionError, scenario.error);
    else assert.equal(geo.detectionError, null);
    assert.equal(chrome.connected, 1);
    assertDetectionRequest(requests, chrome.navigations, geo);
    assert.equal(geo.source,scenario.primaryGeography?'ipquery.io':'ipapi.co');
    if (!scenario.primaryGeography) assert.ok(chrome.navigations.some(endpoint=>endpoint.hostname==='ipapi.co'&&endpoint.pathname==='/'+geography.ip+'/json/'),
      'risk failure or missing primary geography must retain a valid explicitly queried fallback');
  });
}

test('aborting a real Chrome classification rejects instead of returning unknown detection', { timeout: 45000 }, async t => {
  const controller = new AbortController();
  const reason = new Error('fixture classification aborted');
  const { server, requests, port, url } = await dormantProxy(t, {
    holdDetection: true, onDetectionRequest: () => controller.abort(reason),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const chrome = routeChromeToFixture(t);
  await assert.rejects(lookupGeo({
    chromeExe: resolveChromePath(), proxyMode: 'explicit', proxyUrl: url,
    proxyTimeoutMs: 1000, timeoutMs: 5000, detectionTimeoutMs: 5000,
    signal: controller.signal,
  }), error => error === reason);
  assert.equal(chrome.connected, 1);
  assertDetectionRequest(requests, chrome.navigations, geography);
});

test('unavailable explicit geography proxy reports actionable Chinese diagnostics without starting Chrome', async t => {
  const { url } = await dormantProxy(t);
  const messages = [];
  const originalConnect = CDP.connect;
  t.after(() => { CDP.connect = originalConnect; });
  CDP.connect = async () => assert.fail('unavailable proxy must stop before Chrome connection');
  await assert.rejects(lookupGeo({
    chromeExe: 'missing-test-chrome.exe', proxyMode: 'explicit', proxyUrl: url,
    proxyTimeoutMs: 100, log: message => messages.push(message),
  }), error => {
    assert.match(error.message, /代理连接失败/);
    assert.ok(error.message.includes(url));
    assert.match(error.message, /启动代理软件/);
    assert.match(error.message, /地址和端口/);
    assert.match(error.message, /launcher-config\.json/);
    assert.match(error.message, /--proxy/);
    assert.doesNotMatch(error.message, /ERR_PROXY_CONNECTION_FAILED|ENOENT|TypeError/);
    return true;
  });
  assert.equal(messages.length, 1);
});
