import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { lookupGeo } from '../lib/geo.mjs';

test('formal and temporary browsers select the same current IP despite reversed observation response times',
  { timeout: 45000 }, async t => {
    const addresses = { 'api.ipify.org': '203.0.113.11', 'api.ipquery.io': '203.0.113.12' };
    let slower = 'api.ipquery.io';
    const requests = [];
    const timers = new Set();
    const sockets = new Set();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-egress-priority-'));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    let formal;
    // A closed local proxy fixture: requests never reach a public endpoint.
    // Both provider responses remain unchanged between observations. Only
    // response latency changes, as can happen on a split route or dual stack.
    const proxy = http.createServer((request, response) => {
      const endpoint = new URL(request.url, 'http://fixture.invalid');
      const route = endpoint.pathname.match(/^\/([^/]+)(\/.*)$/);
      const provider = route?.[1];
      const requestPath = route?.[2];
      const observation = requestPath === '/' && Object.hasOwn(addresses, provider);
      const metadataIp = provider === 'api.ipquery.io' ? requestPath?.match(/^\/([^/]+)$/)?.[1] : undefined;
      requests.push({ provider, observation, metadataIp });
      const json = observation ? { ip: addresses[provider] } : metadataIp ? {
        ip: decodeURIComponent(metadataIp),
        location: { country_code: 'JP', country: 'Japan', timezone: 'Asia/Tokyo', latitude: 35.6, longitude: 139.6 },
        risk: { is_proxy: false, is_datacenter: false },
      } : null;
      const reply = () => {
        response.writeHead(json ? 200 : 204, { 'content-type': 'application/json', 'connection': 'close',
          'cache-control': 'public, max-age=3600' });
        response.end(json ? JSON.stringify(json) : undefined);
      };
      if (observation && provider === slower) {
        const timer = setTimeout(() => { timers.delete(timer); reply(); }, 900);
        timers.add(timer);
      } else reply();
    });
    proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    proxy.on('connect', (_request, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const originalConnect = CDP.connect;
    t.after(async () => {
      CDP.connect = originalConnect;
      if (formal) {
        const cdp = await originalConnect(formal.wsUrl).catch(() => null);
        if (cdp) { await cdp.send('Browser.close', {}, undefined, 1000).catch(() => {}); cdp.close(); }
        killChrome(formal.proc);
      }
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
      await sleep(200);
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    CDP.connect = async (...args) => {
      const cdp = await originalConnect.apply(CDP, args);
      const send = cdp.send.bind(cdp);
      cdp.send = (method, params = {}, ...rest) => {
        if (method === 'Network.loadNetworkResource') {
          const endpoint = new URL(params.url);
          assert.ok(Object.hasOwn(addresses, endpoint.hostname), 'use only the selected public-IP observation and explicit-IP metadata endpoints');
          assert.equal(params.options?.disableCache, true, 'current-IP observations must bypass the formal profile HTTP cache');
          params = { ...params, url: 'http://fixture.invalid/' + endpoint.hostname + endpoint.pathname + endpoint.search };
        }
        return send(method, params, ...rest);
      };
      return cdp;
    };
    const options = { chromeExe: resolveChromePath(), proxyMode: 'explicit',
      proxyUrl: 'http://127.0.0.1:' + proxy.address().port, timeoutMs: 5000, detectionTimeoutMs: 1000 };
    const first = await lookupGeo(options);
    slower = 'api.ipify.org';
    const second = await lookupGeo(options);
    formal = await launchChrome({ exe: options.chromeExe, userDataDir: temporary,
      args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-background-networking', '--proxy-server=' + options.proxyUrl],
    });
    const sameSession = await lookupGeo({ ...options, wsUrl: formal.wsUrl });
    assert.deepEqual(requests.filter(request => request.observation).map(request => request.provider).sort(),
      ['api.ipify.org', 'api.ipify.org', 'api.ipify.org', 'api.ipquery.io', 'api.ipquery.io', 'api.ipquery.io']);
    assert.equal(second.ip, first.ip,
      'observation latency must not select a different identity when the selected network route has not changed');
    assert.equal(sameSession.ip, first.ip, 'print-config and the formal browser must use the same source priority');
    assert.equal(first.ip, addresses['api.ipify.org']);
    for (const result of [first, second, sameSession]) {
      assert.deepEqual(result.egressObservations.map(observation => observation.ip).sort(), Object.values(addresses).sort());
      assert.ok(result.egressWarning?.includes(addresses['api.ipify.org']) && result.egressWarning.includes(addresses['api.ipquery.io']),
        'conflicting per-domain exits must remain visible while source priority stays stable');
      assert.equal(result.countryCode, 'JP');
    }
    assert.deepEqual(requests.filter(request => request.metadataIp).map(request => request.metadataIp),
      [first.ip, first.ip, first.ip], 'geography and risk queries must explicitly name the selected current IP');
  });
