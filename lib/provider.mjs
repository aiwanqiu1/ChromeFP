// 页面级补丁仍有可检测的修改面，无法提供内核级设备隔离。
import { randomUUID } from 'node:crypto';

export function buildProvider(cfg, installationKey = randomUUID()) {
  const languages = cfg.languages || (cfg.acceptLanguage
    ? cfg.acceptLanguage.split(',').map(value => value.split(';')[0].trim()).filter(Boolean)
    : cfg.locale ? [cfg.locale] : null);
  const CFG = {
    locale: cfg.locale ?? null,
    languages,
    deviceMemory: cfg.deviceMemory ?? null,
    hardwareConcurrency: cfg.hardwareConcurrency ?? null,
    webglVendor: cfg.webglVendor ?? null,
    webglRenderer: cfg.webglRenderer ?? null,
    canvasNoise: cfg.canvasNoise ?? false,
    audioNoise: cfg.audioNoise ?? false,
    webrtcExpectedIp: cfg.webrtcExpectedIp ?? null,
  };
  if (!Object.values(CFG).some(value => value !== null && value !== false)) return '';
  // 同一个驱动复用这份脚本，重复注入共享私有安装令牌。
  return '(' + installProvider.toString() + ')(' + JSON.stringify(CFG) + ',' + (cfg.noiseSeed ?? 1) +
    ',' + JSON.stringify(installationKey) + ');';
}

function installProvider(CFG, seed, installationKey) {
  // Chrome 的管理页和扩展页面依赖原生接口；注册的脚本仍在随后的网站导航生效。
  // 暂停的 Worker 中读取 WorkerLocation 可阻塞启动，所以仅在 document 环境检查 URL。
  if (globalThis.document && /^(?:chrome(?:-[a-z]+)?|devtools):$/i.test(globalThis.location?.protocol || '')) return;
  const nativeToString = Function.prototype.toString;
  // OOPIF 可能继承父页面注册的脚本；安装状态留在已有包装器的闭包中，
  // 不向页面全局对象添加属性。原生 toString 会忽略这个私有查询参数。
  try {
    const previousRealms = nativeToString.call(nativeToString, installationKey);
    const previous = previousRealms instanceof WeakMap && previousRealms.get(globalThis);
    if (previous) { previous.update(CFG, seed); return; }
  } catch { /* 现有包装器未提供私有握手时，正常安装。 */ }
  const installedRealms = new WeakMap();
  const installed = new Set();
  const installing = name => {
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  };
  const masked = new WeakMap();
  const mask = (fn, name) => {
    masked.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
  };
  const patchedToString = mask(function toString() {
    if (this === patchedToString && arguments[0] === installationKey) return installedRealms;
    return masked.get(this) || nativeToString.call(this);
  }, 'toString');
  Function.prototype.toString = patchedToString;

  const define = (object, property, getter) => {
    Object.defineProperty(object, property, {
      get: mask(getter, 'get ' + property), configurable: true, enumerable: true,
    });
  };
  installedRealms.set(globalThis, { update(nextConfig, nextSeed) {
    CFG = nextConfig;
    seed = nextSeed;
    if (CFG.languages) Object.freeze(CFG.languages);
    installFeatures();
  } });
  if (CFG.languages) Object.freeze(CFG.languages);
  installFeatures();

  function installFeatures() {
    const navigatorType = globalThis.Navigator || globalThis.WorkerNavigator;
    for (const [property, value] of [['deviceMemory', CFG.deviceMemory], ['hardwareConcurrency', CFG.hardwareConcurrency],
      ['language', CFG.languages?.[0]], ['languages', CFG.languages]]) {
      if (!navigatorType || value == null || !installing('navigator.' + property)) continue;
      const original = Object.getOwnPropertyDescriptor(navigatorType.prototype, property);
      define(navigatorType.prototype, property, function () {
        const next = property === 'language' ? CFG.languages?.[0] : CFG[property];
        return next ?? (original?.get ? original.get.call(this) : original?.value);
      });
    }

    if (CFG.locale && globalThis.Intl && installing('Intl')) {
      for (const name of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat',
        'ListFormat', 'DisplayNames', 'Segmenter']) {
        const original = Intl[name];
        if (!original) continue;
        const defaultLocale = args => {
          if (CFG.locale && args[0] === undefined) { args = args.slice(); args[0] = CFG.locale; }
          return args;
        };
        Intl[name] = mask(new Proxy(original, {
          apply(target, receiver, args) { return Reflect.apply(target, receiver, defaultLocale(args)); },
          construct(target, args, newTarget) { return Reflect.construct(target, defaultLocale(args), newTarget); },
        }), name);
      }
    }

    if ((CFG.webglVendor || CFG.webglRenderer) && installing('webgl')) {
      for (const type of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
        if (!type) continue;
        const original = type.prototype.getParameter;
        type.prototype.getParameter = mask(function getParameter(parameter) {
          if (parameter === 37445 && CFG.webglVendor) return CFG.webglVendor;
          if (parameter === 37446 && CFG.webglRenderer) return CFG.webglRenderer;
          return original.apply(this, arguments);
        }, 'getParameter');
      }
    }

    // 每个位置使用固定扰动，不消耗全局随机序列；重复读取结果不随调用顺序改变。
    const noise = index => {
      let value = Math.imul((seed >>> 0) ^ index, 0x45d9f3b);
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      return (value ^ (value >>> 16)) >>> 0;
    };
    if (CFG.canvasNoise && globalThis.CanvasRenderingContext2D && globalThis.HTMLCanvasElement && installing('canvas')) {
      const originalRead = CanvasRenderingContext2D.prototype.getImageData;
      const originalWrite = CanvasRenderingContext2D.prototype.putImageData;
      const perturb = (image, canvasWidth, x = 0, y = 0) => {
        for (let index = 0; index < image.data.length; index += 4) {
          const pixel = index / 4;
          const position = (y + Math.floor(pixel / image.width)) * canvasWidth + x + pixel % image.width;
          const amount = noise(position) % 3 - 1;
          // 不修改透明像素，也不让 0/255 溢出。
          if (image.data[index + 3]) image.data[index] = Math.max(0, Math.min(255, image.data[index] + amount));
        }
        return image;
      };
      CanvasRenderingContext2D.prototype.getImageData = mask(function getImageData(x, y, width, height) {
        const image = originalRead.apply(this, arguments);
        if (!CFG.canvasNoise) return image;
        // WebIDL 的 long 转换及负尺寸都影响实际读取原点；同一像素应使用同一噪声。
        const left = (x >> 0) - ((width >> 0) < 0 ? image.width : 0);
        const top = (y >> 0) - ((height >> 0) < 0 ? image.height : 0);
        return perturb(image, this.canvas.width, left, top);
      }, 'getImageData');
      const copyForExport = canvas => {
        if (!canvas.width || !canvas.height) return canvas;
        const context = canvas.getContext('2d');
        if (!context) return canvas; // WebGL canvas 暂不做页面级像素扰动。
        const image = perturb(originalRead.call(context, 0, 0, canvas.width, canvas.height), canvas.width);
        const copy = document.createElement('canvas');
        copy.width = canvas.width; copy.height = canvas.height;
        originalWrite.call(copy.getContext('2d'), image, 0, 0);
        return copy;
      };
      for (const name of ['toDataURL', 'toBlob']) {
        const original = HTMLCanvasElement.prototype[name];
        if (!original) continue;
        HTMLCanvasElement.prototype[name] = mask(function () {
          // 只在副本上导出，保留原画布内容及原生异常。
          return original.apply(CFG.canvasNoise ? copyForExport(this) : this, arguments);
        }, name);
      }
    }
    if (CFG.audioNoise && globalThis.AnalyserNode && installing('analyser')) {
      const original = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = mask(function getFloatFrequencyData(data) {
        const result = original.apply(this, arguments);
        if (!CFG.audioNoise) return result;
        const count = Math.min(data.length, this.frequencyBinCount);
        for (let index = 0; index < count; index++) {
          if (Number.isFinite(data[index])) data[index] += (noise(index) / 4294967296 - 0.5) * 1e-4;
        }
        return result;
      }, 'getFloatFrequencyData');
    }

    if (CFG.audioNoise && globalThis.AudioBuffer && installing('audioBuffer')) {
      const originalRead = AudioBuffer.prototype.getChannelData;
      const originalCopy = AudioBuffer.prototype.copyFromChannel;
      const channels = new WeakMap();
      const perturb = (buffer, samples, channel) => {
        let states = channels.get(buffer);
        if (!states) { states = new Map(); channels.set(buffer, states); }
        let state = states.get(channel);
        if (!state || state.samples !== samples || state.base.length !== samples.length) {
          state = { samples, base: samples.slice(), last: samples.slice(), seed: null, enabled: false };
          states.set(channel, state);
        }
        const changedSeed = state.seed !== seed || state.enabled !== CFG.audioNoise;
        for (let index = 0; index < samples.length; index++) {
          // 保留 getChannelData 的原生共享、可写 Float32Array。页面改写过的值
          // 成为新的基线；没有改写的旧扰动先恢复，避免重复读取或换 seed 后叠加。
          const edited = !Object.is(samples[index], state.last[index]);
          if (edited) state.base[index] = samples[index];
          if (!changedSeed && !edited) continue;
          const base = state.base[index];
          samples[index] = CFG.audioNoise && Number.isFinite(base)
            ? base + (noise(index ^ Math.imul(channel, 0x9e3779b9)) / 4294967296 - 0.5) * 1e-6 : base;
          state.last[index] = samples[index];
        }
        state.seed = seed;
        state.enabled = CFG.audioNoise;
        return samples;
      };
      AudioBuffer.prototype.getChannelData = mask(function getChannelData(channel) {
        if (!arguments.length) return originalRead.apply(this, arguments);
        // 与 WebIDL unsigned long 一样转换一次；原生方法保留非法索引与 receiver 的异常。
        channel = channel >>> 0;
        const samples = originalRead.call(this, channel);
        return perturb(this, samples, channel);
      }, 'getChannelData');
      if (originalCopy) AudioBuffer.prototype.copyFromChannel = mask(function copyFromChannel(destination, channel, start = 0) {
        // 先执行原生复制及验证，未复制到的 destination 尾部必须保留。
        const result = originalCopy.apply(this, arguments);
        channel = channel >>> 0;
        start = start >>> 0;
        const samples = perturb(this, originalRead.call(this, channel), channel);
        const count = Math.min(destination.length, Math.max(0, samples.length - start));
        if (count) destination.set(samples.subarray(start, start + count));
        return result;
      }, 'copyFromChannel');
    }

    if (!CFG.webrtcExpectedIp || !globalThis.RTCPeerConnection || !installing('webrtc')) return;
    const normalize = address => {
      const value = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
      if (value.includes(':')) {
        try { return new URL('http://[' + value + ']/').hostname; } catch {}
      }
      return value;
    };
    const allowed = address => !CFG.webrtcExpectedIp || normalize(address) === normalize(CFG.webrtcExpectedIp) || /\.local$/i.test(String(address));
    const candidateInfo = line => /^(?:a=)?candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s+(\w+)/i.exec(line);
    const keepCandidate = line => {
      if (!CFG.webrtcExpectedIp) return true;
      const info = candidateInfo(line);
      // TURN relay 地址属于中继服务，可保留；关联的客户端 raddr 仍需隐藏。
      return !!info && (info[2].toLowerCase() === 'relay' || allowed(info[1]));
    };
    const sanitizeCandidate = line => String(line).replace(/(\sraddr\s+)(\S+)/gi,
      (_, prefix, address) => prefix + (allowed(address) ? address : address.includes(':') ? '::' : '0.0.0.0'));
    const sanitizeSdp = sdp => String(sdp || '').split(/\r?\n/).filter(line => {
      return !/^a=candidate:/i.test(line) || keepCandidate(line);
    }).map(line => {
      if (/^a=candidate:/i.test(line)) return sanitizeCandidate(line);
      if (/^c=IN IP[46] /i.test(line)) return line.replace(/(\S+)$/, address =>
        allowed(address) ? address : address.includes(':') ? '::' : '0.0.0.0');
      if (/^o=/i.test(line)) return line.replace(/(\S+)$/, address =>
        allowed(address) ? address : address.includes(':') ? '::' : '0.0.0.0');
      return line;
    }).join('\r\n');
    const description = value => !CFG.webrtcExpectedIp ? value : value && ({ type: value.type, sdp: sanitizeSdp(value.sdp) });

    const safeCandidate = candidate => {
      const sanitized = sanitizeCandidate(candidate.candidate);
      if (sanitized === candidate.candidate && (!candidate.relatedAddress || allowed(candidate.relatedAddress))) return candidate;
      const data = { ...(candidate.toJSON?.() || candidate), candidate: sanitized };
      if (data.relatedAddress && !allowed(data.relatedAddress)) data.relatedAddress = '0.0.0.0';
      return globalThis.RTCIceCandidate ? new RTCIceCandidate(data) : data;
    };
    const filterEvent = event => {
      const candidate = event?.candidate;
      if (!candidate?.candidate) return event;
      if (!keepCandidate(candidate.candidate)) return null;
      const safe = safeCandidate(candidate);
      if (safe === candidate) return event;
      return new Proxy(event, {
        get(target, property) {
          if (property === 'candidate') return safe;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };

    const prototype = RTCPeerConnection.prototype;
    const originalAdd = prototype.addEventListener;
    const originalRemove = prototype.removeEventListener;
    const listeners = new WeakMap();
    const captureOf = options => typeof options === 'boolean' ? options : !!options?.capture;
    prototype.addEventListener = mask(function addEventListener(type, listener, options) {
      if (type !== 'icecandidate' || !listener || !['function', 'object'].includes(typeof listener)) {
        return originalAdd.apply(this, arguments);
      }
      const capture = captureOf(options);
      let byListener = listeners.get(this);
      if (!byListener) { byListener = new WeakMap(); listeners.set(this, byListener); }
      let byCapture = byListener.get(listener);
      if (!byCapture) { byCapture = new Map(); byListener.set(listener, byCapture); }
      let entry = byCapture.get(capture);
      if (!entry) {
        const once = typeof options === 'object' && !!options?.once;
        entry = { wrapper: null };
        const cleanup = () => {
          byCapture.delete(capture);
          entry.signal?.removeEventListener('abort', cleanup);
        };
        entry.wrapper = function (event) {
          const safe = filterEvent(event);
          if (!safe) return;
          if (once) {
            originalRemove.call(this, type, entry.wrapper, capture);
            cleanup();
          }
          if (typeof listener === 'function') listener.call(this, safe);
          else if (typeof listener.handleEvent === 'function') listener.handleEvent.call(listener, safe);
        };
        entry.cleanup = cleanup;
        entry.signal = typeof options === 'object' ? options?.signal : undefined;
        byCapture.set(capture, entry);
        if (entry.signal?.aborted) { cleanup(); return; }
        entry.signal?.addEventListener('abort', cleanup, { once: true });
      }
      const actual = typeof options === 'object' && options ? {
        capture, once: false, passive: options.passive, signal: options.signal,
      } : options;
      try { return originalAdd.call(this, type, entry.wrapper, actual); }
      catch (error) { entry.cleanup(); throw error; }
    }, 'addEventListener');
    prototype.removeEventListener = mask(function removeEventListener(type, listener, options) {
      const entry = listener && type === 'icecandidate'
        ? listeners.get(this)?.get(listener)?.get(captureOf(options)) : null;
      if (!entry) return originalRemove.apply(this, arguments);
      entry.cleanup();
      return originalRemove.call(this, type, entry.wrapper, options);
    }, 'removeEventListener');

    const handlerDescriptor = Object.getOwnPropertyDescriptor(prototype, 'onicecandidate');
    if (handlerDescriptor?.set && handlerDescriptor?.get) {
      const handlers = new WeakMap();
      Object.defineProperty(prototype, 'onicecandidate', {
        ...handlerDescriptor,
        get: mask(function () {
          const value = handlerDescriptor.get.call(this);
          return handlers.has(this) ? handlers.get(this) : value;
        }, 'get onicecandidate'),
        set: mask(function (callback) {
          const actual = typeof callback === 'function' ? function (event) {
            const safe = filterEvent(event);
            if (safe) callback.call(this, safe);
          } : callback;
          handlerDescriptor.set.call(this, actual);
          handlers.set(this, typeof callback === 'function' ? callback : null);
        }, 'set onicecandidate'),
      });
    }

    for (const name of ['createOffer', 'createAnswer']) {
      const original = prototype[name];
      if (!original) continue;
      prototype[name] = mask(function () {
        const args = Array.from(arguments);
        if (typeof args[0] === 'function') {
          const callback = args[0];
          args[0] = value => callback(description(value));
        }
        const result = original.apply(this, args);
        return result?.then ? result.then(description) : result;
      }, name);
    }
    for (const name of ['localDescription', 'currentLocalDescription', 'pendingLocalDescription']) {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      if (!original?.get) continue;
      Object.defineProperty(prototype, name, {
        ...original,
        get: mask(function () {
          const value = original.get.call(this);
          if (!value) return value;
          const safe = description(value);
          return globalThis.RTCSessionDescription ? new RTCSessionDescription(safe) : safe;
        }, 'get ' + name),
      });
    }

    const filterStats = report => {
      if (!CFG.webrtcExpectedIp) return report;
      const filtered = new Map();
      const hidden = new Set();
      for (const [id, row] of report) {
        if (row.type === 'local-candidate' && row.candidateType !== 'relay' &&
          (row.address || row.ip) && !allowed(row.address || row.ip)) {
          hidden.add(id); continue;
        }
        const safe = { ...row };
        if (row.type === 'local-candidate' && safe.relatedAddress && !allowed(safe.relatedAddress)) delete safe.relatedAddress;
        filtered.set(id, safe);
      }
      for (const [id, row] of filtered) {
        if (row.type === 'candidate-pair' && hidden.has(row.localCandidateId)) { filtered.delete(id); hidden.add(id); }
      }
      for (const row of filtered.values()) if (hidden.has(row.selectedCandidatePairId)) delete row.selectedCandidatePairId;
      const methods = new Map();
      let proxy;
      proxy = new Proxy(report, {
        get(target, property) {
          if (property === 'size') return filtered.size;
          if (['get', 'has', 'values', 'keys', 'entries', 'forEach'].includes(property) || property === Symbol.iterator) {
            if (!methods.has(property)) methods.set(property, mask(property === 'forEach'
              ? function forEach(callback, thisArg) { filtered.forEach((value, id) => callback.call(thisArg, value, id, proxy)); }
              : filtered[property].bind(filtered), String(property)));
            return methods.get(property);
          }
          return Reflect.get(target, property, target);
        },
      });
      return proxy;
    };
    for (const type of [RTCPeerConnection, globalThis.RTCRtpSender, globalThis.RTCRtpReceiver]) {
      if (!type?.prototype.getStats) continue;
      const original = type.prototype.getStats;
      type.prototype.getStats = mask(function getStats() {
        return original.apply(this, arguments).then(filterStats);
      }, 'getStats');
    }
    const transport = globalThis.RTCIceTransport?.prototype;
    if (transport?.getLocalCandidates) {
      const original = transport.getLocalCandidates;
      transport.getLocalCandidates = mask(function getLocalCandidates() {
        return original.apply(this, arguments).filter(value => !value.candidate || keepCandidate(value.candidate))
          .map(value => value.candidate ? safeCandidate(value) : value);
      }, 'getLocalCandidates');
    }
    if (transport?.getSelectedCandidatePair) {
      const original = transport.getSelectedCandidatePair;
      transport.getSelectedCandidatePair = mask(function getSelectedCandidatePair() {
        const pair = original.apply(this, arguments);
        if (!pair?.local?.candidate) return pair;
        if (!keepCandidate(pair.local.candidate)) return null;
        return { ...pair, local: safeCandidate(pair.local) };
      }, 'getSelectedCandidatePair');
    }
  }
}
