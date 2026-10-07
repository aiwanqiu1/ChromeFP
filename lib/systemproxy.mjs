// Windows 系统代理探测 + 代理参数生成
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** 等待显式代理就绪；代理软件较慢启动时仍保留原出口链路。 */
export async function waitForProxy(proxyUrl, { timeoutMs = 10000, intervalMs = 250, signal, log = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('代理等待超时参数无效');
  }
  const url = new URL(proxyUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || ({ 'http:': 80, 'https:': 443, 'socks4:': 1080, 'socks5:': 1080 })[url.protocol]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口无效');
  const endpoint = redactProxy(proxyUrl);
  const deadline = performance.now() + timeoutMs;
  let lastError;
  let announced = false;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const result = await new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        resolve(error);
      };
      const abort = () => finish(new Error('代理连接等待已取消'));
      const timer = setTimeout(() => finish({ code: 'ETIMEDOUT' }), Math.min(750, deadline - performance.now()));
      socket.once('connect', () => finish(null));
      socket.once('error', finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    if (!result) return;
    lastError = result.code || '连接失败';
    if (!announced) {
      announced = true;
      log('代理尚未就绪，等待连接 ' + endpoint + '（最多 ' + timeoutMs / 1000 + ' 秒）...');
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      try { await delay(Math.min(intervalMs, remaining), undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  }
  signal?.throwIfAborted();
  throw new Error('代理连接失败：' + endpoint + ' 在 ' + timeoutMs / 1000 + ' 秒内未就绪（' + lastError + '）。\n' +
    '请启动代理软件，确认代理地址和端口；如端口已更改，请修改 launcher-config.json 的 proxy 或使用 --proxy 指定。');
}

/** 解析 reg query 输出；connectionOutput 缺失时保留自动发现状态未知。 */
export function parseWindowsProxySettings(out, connectionOutput = '') {
  const pick = name => {
    // REG_SZ 可以为空；只能消费同行的空格，避免把下一行值或子键当成配置。
    const re = new RegExp('^[\\t ]*' + name + '[\\t ]+REG_\\w+[\\t ]*([^\\r\\n]*)\\r?$', 'm');
    const match = out.match(re);
    return match ? match[1].trim() : null;
  };
  const binary = connectionOutput.match(/^[\t ]*DefaultConnectionSettings[\t ]+REG_BINARY[\t ]+([0-9a-f]+)[\t ]*\r?$/im)?.[1];
  return {
    supported: true,
    enabled: pick('ProxyEnable') === '0x1',
    server: pick('ProxyServer') || null,
    pac: pick('AutoConfigURL') || null,
    bypass: pick('ProxyOverride') || null,
    autoDetect: binary && binary.length >= 18 ? !!(Buffer.from(binary, 'hex')[8] & 8) : null,
  };
}

/**
 * 读取当前 Windows 用户级代理设置（WinINET）。
 * 失败不致命——只是少一条诊断信息。
 */
export function readWindowsProxy() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    let connections = '';
    try {
      connections = execFileSync('reg', ['query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections',
        '/v', 'DefaultConnectionSettings'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {}
    return parseWindowsProxySettings(out, connections);
  } catch {
    return { supported: false, enabled: false, server: null, pac: null, bypass: null, autoDetect: null };
  }
}

/** 生成代理相关的 Chrome 参数 */
export function proxyArgs(mode, explicitUrl) {
  if (mode === 'direct') return ['--no-proxy-server'];
  if (mode === 'explicit' && explicitUrl) {
    return [`--proxy-server=${explicitUrl}`, '--proxy-bypass-list=localhost;127.0.0.1'];
  }
  // auto：什么都不加 = Chrome 按系统设置走（含 PAC / 分流规则），和日常使用完全一致
  return [];
}

/** 人类可读的出口链路描述 */
export function describeEgress(mode, explicitUrl, sys) {
  if (mode === 'direct') return '关闭浏览器代理（仍跟随系统网络和 VPN/TUN）';
  if (mode === 'explicit') return `指定代理 ${redactProxy(explicitUrl)}`;
  if (!sys.supported) return '继承系统设置（无法读取系统代理配置）';
  if (sys.pac) return `继承系统设置（PAC 自动配置：${redactProxy(sys.pac)}）`;
  if (sys.enabled && sys.server) return `继承系统设置（系统代理 ${redactProxy(sys.server)}）`;
  if (sys.autoDetect !== false) return '继承系统设置（代理自动发现启用或状态未知）';
  if (sys.server) return `继承系统设置（代理已配置为 ${redactProxy(sys.server)}，但当前未启用）`;
  return '继承系统设置（当前无系统代理，仍跟随系统网络和 VPN/TUN）';
}

function redactProxy(value) {
  if (String(value).includes('@')) return '（认证信息已隐藏）';
  try {
    const url = new URL(value);
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return String(value).replace(/[?#].*$/, ''); }
}

// 同一代理 URL 内部切节点无法从系统设置察觉，因此默认禁用归属地缓存。
export function egressCacheKey(mode, explicitUrl, sys) {
  return crypto.createHash('sha1').update(JSON.stringify({ version: 2, mode,
    proxy: mode === 'explicit' ? explicitUrl : null,
    system: mode === 'auto' ? sys : null,
  })).digest('hex').slice(0, 12);
}

export function shouldProtectWebRTC(forced, mode, sys) {
  if (forced !== null && forced !== undefined) return forced;
  if (mode === 'direct') return false;
  if (mode === 'explicit') return true;
  // 系统代理或自动发现状态未知时保守开启。
  return !sys.supported || sys.enabled || !!sys.pac || sys.autoDetect !== false;
}
