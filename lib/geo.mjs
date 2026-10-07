// 出口 IP 归属地查询
//
// 关键设计：不用 Node 自己发请求（Node 走不了 Chrome 的代理/PAC 分流），
// 正式会话直接在已打开的 Chrome 中查询；print-config 等无会话场景才启动临时浏览器。
// 分流或轮换代理仍可能按域名使用不同出口；固定来源顺序选 IP，并公开各接口观察结果。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isIP } from 'node:net';
import { CDP, launchChrome, killChrome, sleep } from './cdp.mjs';
import { proxyArgs, waitForProxy } from './systemproxy.mjs';

const IP_ENDPOINTS = [
  { name: 'ipify.org', url: 'https://api.ipify.org/?format=json' },
  { name: 'ipquery.io', url: 'https://api.ipquery.io/?format=json' },
];

const canonicalIP = value => {
  const version = typeof value === 'string' ? isIP(value) : 0;
  if (!version) return null;
  try { return new URL('http://' + (version === 6 ? '[' + value + ']' : value) + '/').hostname; }
  catch { return null; }
};

function observationSummary(observations, selectedSource) {
  const ips = new Set(observations.filter(row => row.ip).map(row => canonicalIP(row.ip)));
  return { egressObservations: observations,
    egressWarning: ips.size > 1
      ? '检测到按域名分流或轮换的多个公网出口：' + observations.filter(row => row.ip)
        .map(row => row.source + '=' + row.ip).join('，') + '；本次固定使用 ' + selectedSource + '，其他网站可能使用不同出口。'
      : null };
}

/** 将接口字段映射为统一结构，随后由 isUsableGeo 验证。 */
export function parseGeoResponse(name, j) {
  if (!j || !j.ip) return null;
  if (name === 'ipapi.co') {
    return j.country_code ? {
      ip: j.ip, countryCode: j.country_code, country: j.country_name, region: j.region,
      city: j.city, timezone: j.timezone, lat: j.latitude, lon: j.longitude,
      isp: j.org, org: j.org, isProxy: null, isHosting: null,
    } : null;
  }
  if (name === 'ipinfo.io') {
    const coordinates = typeof j.loc === 'string' ? j.loc.split(',').map(value => value.trim()) : [];
    const [lat, lon] = coordinates.length === 2 && coordinates.every(value => value !== '')
      ? coordinates.map(Number) : [NaN, NaN];
    return {
      ip: j.ip, countryCode: j.country, country: j.country, region: j.region,
      city: j.city, timezone: j.timezone, lat, lon,
      isp: j.org, org: j.org, isProxy: null, isHosting: null,
    };
  }
  if (name === 'ipquery.io') {
    const location = j.location;
    return location ? {
      ip: j.ip, countryCode: location.country_code, country: location.country,
      region: location.state, city: location.city, timezone: location.timezone,
      lat: location.latitude, lon: location.longitude,
      isp: j.isp?.isp, org: j.isp?.org, isProxy: null, isHosting: null,
    } : null;
  }
  return null;
}

/** 只接受同一个 IP 的布尔判定；缺失或错误类型保留未知。 */
export function parseIPDetectionResponse(j, expectedIP) {
  const expected = canonicalIP(expectedIP);
  if (!expected || canonicalIP(j?.ip) !== expected) return null;
  return {
    isProxy: typeof j.risk?.is_proxy === 'boolean' ? j.risk.is_proxy : null,
    isHosting: typeof j.risk?.is_datacenter === 'boolean' ? j.risk.is_datacenter : null,
  };
}

// 专属 hidden about:blank 不受用户页面 CSP、Service Worker 或页面脚本影响，
// 仍使用正式 profile 的 NetworkContext / 系统代理 / PAC / 浏览器扩展代理。
// https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-loadNetworkResource
async function lookupLiveGeo({ wsUrl, proxyMode, proxyUrl, timeoutMs, detectionTimeoutMs, signal, previousGeo }) {
  let cdp;
  let targetId;
  let sessionId;
  const streams = new Set();
  const abort = () => cdp?.close(); // 只关闭本次查询连接；hidden target 随它的会话一起销毁。
  try {
    cdp = await CDP.connect(wsUrl);
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', hidden: true, background: true }, undefined, timeoutMs));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, timeoutMs));
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId, timeoutMs);
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, sessionId, timeoutMs);
    const frameId = frameTree?.frame?.id;
    if (!frameId) throw new Error('正式浏览器查询目标缺少网络 frame');

    const readJSON = async ({ name, url }, limitMs = timeoutMs) => {
      const deadline = Date.now() + limitMs;
      const send = (method, params) => {
        signal?.throwIfAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`${name}: 超时`);
        return cdp.send(method, params, sessionId, remaining);
      };
      let handle;
      try {
        const { resource } = await send('Network.loadNetworkResource', { frameId, url,
          options: { disableCache: true, includeCredentials: false } });
        handle = resource?.stream;
        if (handle) streams.add(handle);
        if (!resource?.success || (resource.httpStatusCode && resource.httpStatusCode >= 400)) {
          throw new Error(`${name}: ${resource?.netErrorName || 'HTTP ' + (resource?.httpStatusCode || '网络请求失败')}`);
        }
        if (!handle) throw new Error(`${name}: 接口没有返回数据流`);
        const chunks = [];
        let size = 0;
        for (;;) {
          const part = await send('IO.read', { handle, size: 65536 });
          const chunk = Buffer.from(part.data || '', part.base64Encoded ? 'base64' : 'utf8');
          size += chunk.length;
          if (size > 1048576) throw new Error(`${name}: 接口响应超过限制`);
          chunks.push(chunk);
          if (part.eof) break;
        }
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new Error(`${name}: 接口没有返回有效 JSON`); }
        if (json && (json.error || json.message || json.reason || json.bogon)) {
          throw new Error(`${name}: ${json.error || json.message || json.reason || 'bogon'}`);
        }
        return json;
      } finally {
        if (handle) {
          streams.delete(handle);
          if (!cdp.closed) await cdp.send('IO.close', { handle }, sessionId, 1000).catch(() => {});
        }
      }
    };

    const results = await Promise.allSettled(IP_ENDPOINTS.map(async endpoint => {
      const json = await readJSON(endpoint);
      if (!canonicalIP(json?.ip)) throw new Error(endpoint.name + ': 接口未返回有效公网 IP');
      return { source: endpoint.name, ip: json.ip };
    }));
    signal?.throwIfAborted();
    const observations = results.map((result, index) => result.status === 'fulfilled' ? result.value
      : { source: IP_ENDPOINTS[index].name, ip: null, error: result.reason.message });
    // 来源顺序固定，不能以响应速度决定身份；两次观察均在正式浏览器中实时执行。
    const observed = observations.find(row => row.ip);
    if (!observed) throw new Error('所有公网 IP 检测接口都失败：\n  - ' + observations.map(row => row.error).join('\n  - '));
    const summary = observationSummary(observations, observed.source);
    if (isUsableGeo(previousGeo) && canonicalIP(previousGeo.ip) === canonicalIP(observed.ip)) {
      return { ...previousGeo, ip: observed.ip, proxyMode, proxyUrl, egressSource: observed.source, ...summary };
    }
    const encodedIP = encodeURIComponent(observed.ip);
    const failures = [];
    let geo;
    let source;
    let detection = { isProxy: null, isHosting: null, detectionSource: 'ipquery.io', detectionError: null };
    const parseMatchingGeo = (name, json) => {
      if (canonicalIP(json?.ip) !== canonicalIP(observed.ip)) throw new Error(name + ': 返回的 IP 与已观测的公网出口 IP 不一致');
      const parsed = parseGeoResponse(name, json);
      if (!isUsableGeo(parsed)) throw new Error(name + ': 缺少有效的国家、时区或坐标');
      return parsed;
    };
    try {
      const json = await readJSON({ name: 'ipquery.io',
        url: 'https://api.ipquery.io/' + encodedIP + '?format=json' }, Math.min(timeoutMs, detectionTimeoutMs));
      const risk = parseIPDetectionResponse(json, observed.ip);
      if (!risk) throw new Error('ipquery.io: 判定接口返回的 IP 与已观测的公网出口 IP 不一致');
      detection = { ...risk, detectionSource: 'ipquery.io',
        detectionError: risk.isProxy === null || risk.isHosting === null ? '接口未提供完整的代理 / 机房判定' : null };
      try { geo = parseMatchingGeo('ipquery.io', json); source = 'ipquery.io'; }
      catch (error) { failures.push(error.message); }
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(error.message);
      detection.detectionError = error.message;
    }
    // 风险判定未知不会丢弃有效归属地。备用接口也只能查询已独立观测的 IP，
    // 不能使用请求自身的出口或不匹配响应悄悄替换本次身份。
    if (!geo) {
      for (const endpoint of [
        { name: 'ipapi.co', url: 'https://ipapi.co/' + encodedIP + '/json/' },
        { name: 'ipinfo.io', url: 'https://ipinfo.io/' + encodedIP + '/json' },
      ]) {
        try {
          const json = await readJSON(endpoint);
          geo = parseMatchingGeo(endpoint.name, json);
          source = endpoint.name;
          break;
        } catch (error) {
          signal?.throwIfAborted();
          failures.push(error.message);
        }
      }
    }
    if (!geo) throw new Error('所有指定 IP 归属地接口都失败：\n  - ' + failures.join('\n  - '));
    return { ...geo, ip: observed.ip, countryCode: geo.countryCode.toUpperCase(), ...detection, source,
      proxyMode, proxyUrl, egressSource: observed.source, ...summary };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (cdp && !cdp.closed) {
      for (const handle of streams) await cdp.send('IO.close', { handle }, sessionId, 1000).catch(() => {});
      if (targetId) await cdp.send('Target.closeTarget', { targetId }, undefined, 1000).catch(() => {});
      cdp.close();
    }
  }
}

// 不允许接口缺字段时静默退回本机时区或把缺失坐标当成 0。
export function isUsableGeo(geo) {
  if (!geo || typeof geo.ip !== 'string' || !isIP(geo.ip) ||
      typeof geo.countryCode !== 'string' || !/^[a-z]{2}$/i.test(geo.countryCode) ||
      typeof geo.timezone !== 'string' || !geo.timezone ||
      !Number.isFinite(geo.lat) || Math.abs(geo.lat) > 90 ||
      !Number.isFinite(geo.lon) || Math.abs(geo.lon) > 180) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: geo.timezone }); return true; } catch { return false; }
}

/**
 * 用一次性的 headless Chrome 查出口归属地。
 *
 * 有 wsUrl 时使用已打开的浏览器；无会话时使用临时 Chrome。
 * 接口并行读取，按固定顺序选择有效 IP；随后显式查询该 IP 的归属地及风险。
 *
 * @param {object} o
 * @param {string}  o.chromeExe
 * @param {string}  [o.wsUrl] 正式 Chrome 的 CDP WebSocket
 * @param {string}  [o.proxyMode]  'auto' | 'direct' | 'explicit'
 * @param {string?} [o.proxyUrl]
 * @param {number}  [o.timeoutMs]
 * @param {Function}[o.log]
 */
export async function lookupGeo({ chromeExe, wsUrl, proxyMode = 'auto', proxyUrl = null, timeoutMs = 15000, detectionTimeoutMs = 5000, proxyTimeoutMs = 10000, log = () => {}, signal, previousGeo }) {
  signal?.throwIfAborted();
  if (wsUrl) return lookupLiveGeo({ wsUrl, proxyMode, proxyUrl, timeoutMs, detectionTimeoutMs, signal, previousGeo });
  if (proxyMode === 'explicit') {
    await waitForProxy(proxyUrl, { timeoutMs: proxyTimeoutMs, signal, log });
  }
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-geo-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-sync', '--disable-background-networking', '--window-size=800,600',
    ...proxyArgs(proxyMode, proxyUrl),
  ];

  let proc = null;
  try {
    const launched = await launchChrome({ exe: chromeExe, args, userDataDir: ud, timeoutMs: 20000, signal });
    proc = launched.proc;
    return await lookupLiveGeo({ wsUrl: launched.wsUrl, proxyMode, proxyUrl,
      timeoutMs, detectionTimeoutMs, signal, previousGeo });
  } finally {
    killChrome(proc);
    await sleep(300);
    // ud 来自本次 mkdtemp；仅清理这个临时 profile。
    if (path.dirname(path.resolve(ud)) === path.resolve(os.tmpdir()) && path.basename(ud).startsWith('fp-geo-')) {
      try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    }
  }
}

/**
 * 代理生效性诊断：分别在「当前出口链路」和「强制直连」下查 IP。
 * 两者相同 = 代理没起作用，指纹会对不上。
 */
export async function checkProxyEffective({ chromeExe, proxyMode, proxyUrl, log }) {
  const via = await lookupGeo({ chromeExe, proxyMode, proxyUrl, log });
  if (proxyMode === 'direct') return { via, direct: via, effective: true, inconclusive: false };

  // 只有「继承系统代理」时才值得对比：查到的国家和本地直连国家一样就可疑
  let direct = null;
  try {
    direct = await lookupGeo({ chromeExe, proxyMode: 'direct', log: () => {} });
  } catch { /* 直连被墙时查不到很正常，不影响结论 */ }

  const effective = direct ? via.ip !== direct.ip : true;
  return { via, direct, effective, inconclusive: !direct };
}
