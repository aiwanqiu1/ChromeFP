import fs from 'node:fs';
import path from 'node:path';
import { loadIdentity } from './identity.mjs';

export function validateProfileName(name) {
  if (typeof name !== 'string' || !name || name.length > 128 || name.startsWith('.') ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[.\s]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error('--profile 必须是有效的目录名称，不能包含路径、保留名称或末尾空格');
  }
  return name;
}

export function profileDirectory(base, name) {
  validateProfileName(name);
  const directory = path.resolve(base, name);
  if (fs.existsSync(directory) && fs.existsSync(base)) {
    const realBase = fs.realpathSync(base);
    const realDirectory = fs.realpathSync(directory);
    if (path.dirname(realDirectory).toLowerCase() !== realBase.toLowerCase() || !fs.statSync(directory).isDirectory()) {
      throw new Error('profile 必须是 profiles 目录内的普通目录');
    }
  }
  return directory;
}

export function parseArgs(argv) {
  const options = {
    profile: 'default', proxy: null, direct: false, chrome: null, urls: [],
    verify: true, overrideGeolocation: true, hardwareConcurrency: null,
    deviceMemory: null, webglVendor: null, webglRenderer: null,
    canvasNoise: false, audioNoise: false, headless: false, printConfig: false,
    cacheMinutes: 0, refresh: false, list: false, help: false, verbose: false,
    webrtcProtect: null, identity: null, deviceMetrics: null,
  };
  let viewport = null;
  let screen = null;
  let dpr = null;
  const dimensions = (value, label) => {
    const match = value.match(/^(\d+)x(\d+)$/i);
    const numbers = match && [Number(match[1]), Number(match[2])];
    if (!numbers || numbers.some(number => !Number.isInteger(number) || number < 64 || number > 16384)) {
      throw new Error(label + ' 必须是 64 到 16384 之间的整数尺寸，格式为 宽x高');
    }
    return numbers;
  };
  const url = value => {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('--url 必须是完整的 HTTP 或 HTTPS 网址'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--url 仅支持 HTTP 或 HTTPS 网址');
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith('--') || value === '-h') throw new Error(`${option} 缺少参数值`);
      return value;
    };
    switch (option) {
      case '--profile': options.profile = validateProfileName(next()); break;
      case '--proxy': options.proxy = next(); break;
      case '--direct': options.direct = true; break;
      case '--chrome': options.chrome = next(); break;
      case '--identity': options.identity = loadIdentity(next()); break;
      case '--viewport': viewport = dimensions(next(), '--viewport'); break;
      case '--screen': screen = dimensions(next(), '--screen'); break;
      case '--dpr': dpr = Number(next()); break;
      case '--url': options.urls.push(url(next())); break;
      case '--verify': options.verify = true; break;
      case '--no-verify': options.verify = false; break;
      case '--geo-location': options.overrideGeolocation = true; break;
      case '--no-geo-location': options.overrideGeolocation = false; break;
      case '--cores': options.hardwareConcurrency = Number(next()); break;
      case '--device-memory': options.deviceMemory = Number(next()); break;
      case '--webgl': {
        const parts = next().split('|');
        if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) throw new Error('--webgl 格式为 "厂商|渲染器"');
        [options.webglVendor, options.webglRenderer] = parts; break;
      }
      case '--canvas-noise': options.canvasNoise = true; break;
      case '--audio-noise': options.audioNoise = true; break;
      case '--webrtc-protect': options.webrtcProtect = true; break;
      case '--no-webrtc-protect': options.webrtcProtect = false; break;
      case '--headless': options.headless = true; break;
      case '--print-config': options.printConfig = true; break;
      case '--cache-geo': options.cacheMinutes = Number(next()); break;
      case '--refresh': options.refresh = true; break;
      case '--list': options.list = true; break;
      case '--verbose': options.verbose = true; break;
      case '-h': case '--help': options.help = true; break;
      default:
        if (/^https?:\/\//i.test(option)) options.urls.push(url(option));
        else throw new Error('未知参数（用 --help 查看用法）');
    }
  }
  if (options.direct && options.proxy) throw new Error('--direct 和 --proxy 不能同时使用');
  if (options.hardwareConcurrency !== null && (!Number.isInteger(options.hardwareConcurrency) ||
      options.hardwareConcurrency < 1 || options.hardwareConcurrency > 1024)) throw new Error('--cores 必须是 1 到 1024 的整数');
  if (options.deviceMemory !== null && ![0.25, 0.5, 1, 2, 4, 8, 16, 32].includes(options.deviceMemory)) {
    throw new Error('--device-memory 支持 0.25、0.5、1、2、4、8、16、32');
  }
  if (!Number.isFinite(options.cacheMinutes) || options.cacheMinutes < 0 || options.cacheMinutes > 1440) {
    throw new Error('--cache-geo 必须是 0 到 1440 之间的分钟数，0 表示每次重新查询');
  }
  if (options.proxy) {
    let proxy;
    try { proxy = new URL(options.proxy); } catch { throw new Error('--proxy 必须是完整的代理网址'); }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname ||
        (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) throw new Error('--proxy 协议或格式不受支持');
    if (proxy.username || proxy.password) throw new Error('--proxy 不支持在网址中携带账号密码，请使用本地代理转发');
  }
  if (screen || dpr !== null) {
    if (!viewport) throw new Error('--screen 和 --dpr 必须同时提供 --viewport');
  }
  if (dpr !== null && (!Number.isFinite(dpr) || dpr < 0.5 || dpr > 4)) throw new Error('--dpr 必须是 0.5 到 4 之间的有限数字');
  if (viewport) {
    const actualScreen = screen || viewport;
    if (viewport[0] > actualScreen[0] || viewport[1] > actualScreen[1]) throw new Error('--viewport 不能大于 --screen');
    options.deviceMetrics = { width: viewport[0], height: viewport[1], screenWidth: actualScreen[0], screenHeight: actualScreen[1], deviceScaleFactor: dpr ?? 1, mobile: false };
  }
  return options;
}
