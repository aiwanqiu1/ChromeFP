import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeoResponse, parseIPDetectionResponse, isUsableGeo } from '../lib/geo.mjs';

const ipinfo = { ip: '203.0.113.1', country: 'JP', timezone: 'Asia/Tokyo', loc: '35.6,139.6' };
const ipapi = { ip: '203.0.113.1', country_code: 'JP', timezone: 'Asia/Tokyo', latitude: 35.6, longitude: 139.6 };

test('known geography providers preserve valid coordinates, including actual zero values', () => {
  assert.equal(isUsableGeo(parseGeoResponse('ipapi.co', ipapi)), true);
  for (const loc of ['35.6,139.6', ' 35.6 , 139.6 ', '0,0', '-90,180']) {
    const parsed = parseGeoResponse('ipinfo.io', { ...ipinfo, loc });
    assert.equal(isUsableGeo(parsed), true, JSON.stringify(loc));
  }
  const zero = parseGeoResponse('ipinfo.io', { ...ipinfo, loc: '0,0' });
  assert.deepEqual([zero.lat, zero.lon], [0, 0]);
});

test('ipinfo rejects missing, blank, extra and non-string coordinate components', () => {
  for (const loc of [undefined, null, '', ',', '35.6,', ',139.6', '  ,  ',
    '35.6,139.6,extra', '35.6', ['35.6', '139.6'], [''], 0, 'NaN,139.6', '91,139.6', '35.6,181']) {
    assert.equal(isUsableGeo(parseGeoResponse('ipinfo.io', { ...ipinfo, loc })), false,
      'invalid loc: ' + JSON.stringify(loc));
  }
});

test('provider and cached geography require string IP, country and timezone fields', () => {
  const valid = { ip: '203.0.113.1', countryCode: 'JP', timezone: 'Asia/Tokyo', lat: 35.6, lon: 139.6 };
  for (const invalid of [{ ip: ['203.0.113.1'] }, { countryCode: ['JP'] },
    { ip: { toString: () => '203.0.113.1' } }, { countryCode: { toString: () => 'JP' } },
    { timezone: ['Asia/Tokyo'] }]) {
    assert.equal(isUsableGeo({ ...valid, ...invalid }), false);
  }
  assert.equal(isUsableGeo(parseGeoResponse('ipinfo.io', { ...ipinfo, ip: ['203.0.113.1'] })), false);
  assert.equal(isUsableGeo(parseGeoResponse('ipinfo.io', { ...ipinfo, country: ['JP'] })), false);
  assert.equal(isUsableGeo(parseGeoResponse('ipapi.co', { ...ipapi, country_code: ['JP'] })), false);
});

test('unrecognized providers and incomplete geography responses are unusable', () => {
  assert.equal(parseGeoResponse('unknown', ipinfo), null);
  for (const [name, fixture] of [['ipinfo.io', ipinfo], ['ipapi.co', ipapi]]) {
    for (const broken of [null, {}, { ...fixture, ip: '' }, { ...fixture, timezone: '' }]) {
      assert.equal(isUsableGeo(parseGeoResponse(name, broken)), false);
    }
  }
});

test('IP detection preserves independent boolean and unknown proxy and datacenter verdicts', () => {
  const cases = [
    [{ is_proxy: true, is_datacenter: false }, true, false],
    [{ is_proxy: false, is_datacenter: true }, false, true],
    [{ is_proxy: false, is_datacenter: false }, false, false],
    [{ is_proxy: true, is_datacenter: true }, true, true],
    [{ is_proxy: true }, true, null],
    [{ is_datacenter: false }, null, false],
    [{ is_proxy: null, is_datacenter: null }, null, null],
    [{}, null, null],
  ];
  for (const [risk, isProxy, isHosting] of cases) {
    const parsed = parseIPDetectionResponse({ ip: ipinfo.ip, risk }, ipinfo.ip);
    assert.ok(parsed, JSON.stringify(risk));
    assert.equal(parsed.isProxy, isProxy, JSON.stringify(risk));
    assert.equal(parsed.isHosting, isHosting, JSON.stringify(risk));
  }
});

test('IP detection never coerces non-boolean flags or treats VPN and Tor as a proxy verdict', () => {
  for (const value of ['true', 'false', 1, 0, [], {}, null]) {
    const parsed = parseIPDetectionResponse({ ip: ipinfo.ip,
      risk: { is_proxy: value, is_datacenter: value } }, ipinfo.ip);
    assert.equal(parsed.isProxy, null, JSON.stringify(value));
    assert.equal(parsed.isHosting, null, JSON.stringify(value));
  }
  const parsed = parseIPDetectionResponse({ ip: ipinfo.ip,
    risk: { is_proxy: false, is_datacenter: false, is_vpn: true, is_tor: true } }, ipinfo.ip);
  assert.equal(parsed.isProxy, false);
  assert.equal(parsed.isHosting, false);
});

test('IP detection rejects empty responses, invalid addresses and verdicts for a different IP', () => {
  const risk = { is_proxy: true, is_datacenter: true };
  for (const response of [null, undefined, {}, [], '', { risk },
    { ip: '', risk }, { ip: 'invalid', risk }, { ip: ['203.0.113.1'], risk },
    { ip: '203.0.113.2', risk }]) {
    assert.equal(parseIPDetectionResponse(response, ipinfo.ip), null, JSON.stringify(response));
  }
  for (const expected of [undefined, null, '', 'invalid', ['203.0.113.1']]) {
    assert.equal(parseIPDetectionResponse({ ip: ipinfo.ip, risk }, expected), null);
  }
});

test('IP detection matches equivalent IPv6 addresses without mixing unrelated addresses', () => {
  const risk = { is_proxy: false, is_datacenter: true };
  const compressed = '2001:db8::1';
  const expanded = '2001:0DB8:0000:0000:0000:0000:0000:0001';
  for (const [ip, expected] of [[compressed, expanded], [expanded, compressed]]) {
    const parsed = parseIPDetectionResponse({ ip, risk }, expected);
    assert.ok(parsed);
    assert.equal(parsed.isProxy, false);
    assert.equal(parsed.isHosting, true);
  }
  assert.equal(parseIPDetectionResponse({ ip: '2001:db8::2', risk }, compressed), null);
});
