import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { deriveLocale } from './config.mjs';
import { isUsableGeo } from './geo.mjs';

/** Normalize equivalent IPv6 spellings before comparing or deriving an identity. */
export function canonicalIPAddress(ip) {
  const version = typeof ip === 'string' ? isIP(ip) : 0;
  if (!version) throw new Error('生成指纹需要有效的当前公网 IP');
  if (version === 4) return ip;
  try { return new URL('http://[' + ip + ']/').hostname.slice(1, -1); }
  catch { throw new Error('生成指纹需要有效的当前公网 IP'); }
}

// IP selects a consistent desktop configuration, rather than guessing hardware
// from geography. UA, Chrome version, GPU and display stay native unless selected.
const DESKTOPS = [
  { hardwareConcurrency: 4, deviceMemory: 4 },
  { hardwareConcurrency: 8, deviceMemory: 8 },
  { hardwareConcurrency: 12, deviceMemory: 8 },
  { hardwareConcurrency: 16, deviceMemory: 16 },
];

export function deriveFingerprint(ip) {
  const sourceIp = canonicalIPAddress(ip);
  const digest = createHash('sha256').update('ChromeFP:ip:v1:' + sourceIp).digest();
  return {
    sourceIp, fingerprintId: digest.toString('hex').slice(0, 16),
    noiseSeed: digest.readUInt32BE(0),
    ...DESKTOPS[digest[4] % DESKTOPS.length],
    canvasNoise: true, audioNoise: true,
  };
}

export function buildFingerprintConfig(opt, geo, { webrtcProtect = false } = {}) {
  if (!isUsableGeo(geo)) throw new Error('当前 IP 的归属地数据无效，无法生成对应指纹');
  const fingerprint = deriveFingerprint(geo.ip);
  const loc = deriveLocale(geo.countryCode);
  return {
    ...fingerprint,
    timezoneId: geo.timezone, locale: loc.locale, acceptLanguage: loc.acceptLanguage,
    languages: [...loc.languages],
    identity: opt.identity, deviceMetrics: opt.deviceMetrics,
    latitude: geo.lat, longitude: geo.lon, overrideGeolocation: opt.overrideGeolocation,
    hardwareConcurrency: opt.hardwareConcurrency ?? fingerprint.hardwareConcurrency,
    deviceMemory: opt.deviceMemory ?? fingerprint.deviceMemory,
    webglVendor: opt.webglVendor, webglRenderer: opt.webglRenderer,
    webrtcExpectedIp: webrtcProtect ? fingerprint.sourceIp : null,
  };
}
