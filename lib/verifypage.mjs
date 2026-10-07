// 本地自检页：显示本次配置与实际读数；外部数据一律按文本处理。
import http from 'node:http';

const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const PAGE = expect => String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>指纹自检</title>
<style>
body{font:13px/1.6 ui-monospace,Consolas,monospace;margin:0;padding:18px;background:#0f1115;color:#dfe4ec}
h2{font-size:14px;margin:20px 0 8px;color:#8ab4f8;border-bottom:1px solid #2a2f3a;padding-bottom:6px}
table{border-collapse:collapse;width:100%;max-width:1000px}
td{padding:3px 10px 3px 0;vertical-align:top;border-bottom:1px solid #1c2129;overflow-wrap:anywhere}
td:first-child{color:#9aa4b2;width:230px}
.ok{color:#5ddc7a}.bad{color:#ff6b6b}.warn{color:#ffc857}
</style></head><body>
<h2>当前出口 IP 与对应指纹</h2><table id="egress"></table>
<h2>浏览器实际读数</h2><table id="actual"></table>
<h2>与本次配置的对照</h2><table id="consistency"></table>
<script>
let EXPECT = ${scriptJson(expect)};
function rows(id, pairs) {
  const table = document.getElementById(id);
  table.replaceChildren();
  for (const [key, value, kind] of pairs) {
    const row = document.createElement('tr');
    const label = document.createElement('td'), cell = document.createElement('td');
    label.textContent = key; cell.textContent = String(value ?? '未知');
    if (kind) cell.className = kind;
    row.append(label, cell); table.append(row);
  }
}
function workerTimezone() {
  return new Promise(resolve => {
    let worker, timer, url;
    const finish = value => {
      clearTimeout(timer); worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      resolve(value);
    };
    try {
      url = URL.createObjectURL(new Blob(['onmessage=()=>postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
        { type: 'application/javascript' }));
      worker = new Worker(url);
      timer = setTimeout(() => finish('超时'), 2000);
      worker.onmessage = event => finish(event.data);
      worker.onerror = () => finish('Worker 失败');
      worker.postMessage(1);
    } catch (error) { finish('不可用: ' + error.message); }
  });
}
async function webrtcReadings() {
  const found = new Map();
  let connection;
  try {
    connection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const add = (address, type, source) => {
      if (address) found.set(source + '|' + address + '|' + type, { address, type, source });
    };
    connection.onicecandidate = event => {
      if (!event.candidate) return;
      const parts = event.candidate.candidate.trim().split(/\s+/);
      if (parts[6] === 'typ') add(parts[4], parts[7], '事件');
    };
    connection.createDataChannel('probe');
    await connection.setLocalDescription(await connection.createOffer());
    await new Promise(resolve => {
      if (connection.iceGatheringState === 'complete') { resolve(); return; }
      const timer = setTimeout(resolve, 2500);
      connection.addEventListener('icegatheringstatechange', () => {
        if (connection.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
    for (const line of (connection.localDescription?.sdp || '').split(/\r?\n/)) {
      if (!line.startsWith('a=candidate:')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts[6] === 'typ') add(parts[4], parts[7], 'SDP');
    }
    const stats = await connection.getStats();
    for (const row of stats.values()) if (row.type === 'local-candidate') add(row.address || row.ip, row.candidateType, '统计');
    return { values: [...found.values()], error: '' };
  } catch (error) { return { values: [...found.values()], error: error.message }; }
  finally { connection?.close(); }
}
function canvasHash() {
  try {
    const canvas = document.createElement('canvas'); canvas.width = 220; canvas.height = 60;
    const context = canvas.getContext('2d');
    context.font = '16px Arial'; context.fillStyle = '#f60'; context.fillRect(0, 0, 120, 30);
    context.fillStyle = '#069'; context.fillText('FingerprintProbe', 2, 20);
    let hash = 5381;
    for (const character of canvas.toDataURL()) hash = ((hash * 33) ^ character.charCodeAt(0)) >>> 0;
    return hash.toString(16);
  } catch { return '不可用'; }
}
async function audioHash() {
  try {
    const context = new OfflineAudioContext(1, 2048, 44100);
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle'; oscillator.frequency.value = 1000;
    oscillator.connect(context.destination); oscillator.start(0);
    const buffer = await context.startRendering();
    const samples = buffer.getChannelData(0);
    let hash = 5381;
    for (const byte of new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)) hash = ((hash * 33) ^ byte) >>> 0;
    return hash.toString(16);
  } catch { return '不可用'; }
}
function geolocation() {
  if (!EXPECT.overrideGeolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    try { navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      error => resolve({ error: error.message }), { timeout: 3000 }); }
    catch (error) { resolve({ error: error.message }); }
  });
}
function normalize(address) {
  const value = String(address).toLowerCase();
  if (value.includes(':')) { try { return new URL('http://[' + value.replace(/^\[|\]$/g, '') + ']/').hostname; } catch {} }
  return value;
}
function renderEgress() {
  const yesNo = value => value === true ? '是' : value === false ? '否' : '未知';
  rows('egress', [
    ['出口 IP', EXPECT.ip],
    ['出口检测来源', EXPECT.egressSource || EXPECT.source || '未知'],
    ['出口观测', (EXPECT.egressObservations || []).map(value => value.source + ': ' +
      (value.ip || value.error || '未获取')).join('；') || '未提供'],
    ...(EXPECT.egressWarning ? [['出口分流提示', EXPECT.egressWarning, 'warn']] : []),
    ['IP 对应指纹', EXPECT.fingerprintId || '未启用 IP 指纹生成'],
    ['自动更新', EXPECT.ipMonitorSeconds ? '每 ' + EXPECT.ipMonitorSeconds + ' 秒检测出口 IP，变化时自动更新' : '未启用'],
    ...(EXPECT.browserUiLocale ? [['Chrome 菜单语言', EXPECT.browserUiLocale +
      (EXPECT.browserUiNeedsRestart ? '；目标 ' + EXPECT.locale + '，重新打开 ChromeFP 后生效'
        : EXPECT.browserUiMatchesLanguage === false ? '；本机 Chrome 缺少 ' + EXPECT.locale + ' 的菜单翻译' : ''),
      EXPECT.browserUiNeedsRestart || EXPECT.browserUiMatchesLanguage === false ? 'warn' : 'ok']] : []),
    ['网站首选语言 / 翻译目标', [EXPECT.locale, EXPECT.translateTarget || EXPECT.locale].filter(Boolean).join(' / ') || '未设置'],
    ['国家 / 地区', [EXPECT.countryCode, EXPECT.region, EXPECT.city].filter(Boolean).join(' ')],
    ['ISP / 组织', [EXPECT.isp, EXPECT.org].filter(Boolean).join(' / ') || '未知'],
    ['接口判定为代理 / 机房', yesNo(EXPECT.isProxy) + ' / ' + yesNo(EXPECT.isHosting),
      EXPECT.isProxy === false && EXPECT.isHosting === false ? 'ok' : 'warn'],
    ['代理 / 机房判定来源', [EXPECT.detectionSource || '未查询', EXPECT.detectionError].filter(Boolean).join('；')],
    ['出口设置', EXPECT.egressDesc], ['归属地来源', EXPECT.source],
  ]);
}
async function renderChecks() {
  renderEgress();
  const current = EXPECT;
  const [worker, rtc, geo, audio] = await Promise.all([workerTimezone(), webrtcReadings(), geolocation(), audioHash()]);
  if (current !== EXPECT) return;
  const actual = Intl.DateTimeFormat().resolvedOptions();
  let headers = {};
  try { headers = await (await fetch('/echo')).json(); } catch {}
  const hints = navigator.userAgentData;
  let highHints = null;
  if (hints && EXPECT.identity) {
    try { highHints = await hints.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors']); } catch {}
  }
  let renderer = '不可用';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    if (extension) renderer = gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) + ' | ' + gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
  } catch {}
  if (current !== EXPECT) return;
  rows('actual', [
    ['时区', actual.timeZone], ['Worker 内时区', worker], ['Intl locale', actual.locale],
    ['navigator.language', navigator.language], ['navigator.languages', JSON.stringify(navigator.languages)],
    ['Accept-Language', headers['accept-language']], ['User-Agent', navigator.userAgent], ['sec-ch-ua', headers['sec-ch-ua']],
    ['Client Hints', hints ? hints.platform + ' mobile=' + hints.mobile : '不可用'],
    ['完整 Client Hints', highHints ? JSON.stringify(highHints) : '未启用身份覆盖或接口不可用'],
    ['hardwareConcurrency', navigator.hardwareConcurrency], ['deviceMemory', navigator.deviceMemory],
    ['屏幕', screen.width + 'x' + screen.height + ' @' + devicePixelRatio + 'x'],
    ['网页视口', innerWidth + 'x' + innerHeight], ['实际窗口', outerWidth + 'x' + outerHeight],
    ['地理位置', geo ? geo.error || geo.latitude + ', ' + geo.longitude : '未启用覆盖'],
    ['Canvas 哈希', canvasHash()], ['Audio 哈希', audio], ['WebGL 渲染器', renderer],
    ['WebRTC 可见地址', rtc.values.map(value => value.address + ' (' + value.type + ', ' + value.source + ')').join(' , ') ||
      rtc.error || '未获取到候选；无法据此确认防护有效'],
    ['navigator.webdriver', navigator.webdriver],
  ]);
  const timezoneOk = actual.timeZone === EXPECT.timezone;
  const languageOk = String(navigator.languages?.[0] || '').toLowerCase() === String(EXPECT.locale).toLowerCase();
  const comparisons = [
    ['时区', '期望 ' + EXPECT.timezone + ' → 实际 ' + actual.timeZone, timezoneOk ? 'ok' : 'bad'],
    ['首选语言', '期望 ' + EXPECT.locale + ' → 实际 ' + navigator.language, languageOk ? 'ok' : 'bad'],
    ['Worker 内时区', '期望 ' + EXPECT.timezone + ' → 实际 ' + worker, worker === EXPECT.timezone ? 'ok' : 'bad'],
  ];
  for (const field of ['hardwareConcurrency', 'deviceMemory']) {
    if (EXPECT[field] != null) comparisons.push([field, '期望 ' + EXPECT[field] + ' → 实际 ' + navigator[field],
      navigator[field] === EXPECT[field] ? 'ok' : 'bad']);
  }
  if (EXPECT.identity) {
    const configured = EXPECT.identity;
    const metadata = configured.userAgentMetadata;
    const brands = rows => JSON.stringify((rows || []).map(row => [row.brand, row.version]).sort((a, b) => a[0].localeCompare(b[0])));
    const uaOk = navigator.userAgent === configured.userAgent && navigator.platform === configured.platform && headers['user-agent'] === configured.userAgent;
    const lowOk = hints && hints.platform === metadata.platform && hints.mobile === metadata.mobile && brands(hints.brands) === brands(metadata.brands);
    const highOk = highHints && brands(highHints.fullVersionList) === brands(metadata.fullVersionList) &&
      ['architecture', 'bitness', 'model', 'platformVersion', 'wow64'].every(key => highHints[key] === metadata[key]) &&
      JSON.stringify(highHints.formFactors) === JSON.stringify(metadata.formFactors);
    comparisons.push(['UA / 请求头', uaOk ? '与完整身份配置一致' : 'UA、旧平台或请求头与配置不一致', uaOk ? 'ok' : 'bad']);
    comparisons.push(['Client Hints 低熵', lowOk ? '与身份配置一致' : '与身份配置不一致', lowOk ? 'ok' : 'bad']);
    comparisons.push(['Client Hints 高熵', highOk ? '与身份配置一致' : highHints ? '与身份配置不一致' : '接口未返回完整读数', highOk ? 'ok' : highHints ? 'bad' : 'warn']);
  }
  if (EXPECT.deviceMetrics) {
    const metrics = EXPECT.deviceMetrics;
    const geometryOk = innerWidth === metrics.width && innerHeight === metrics.height && screen.width === metrics.screenWidth &&
      screen.height === metrics.screenHeight && Math.abs(devicePixelRatio - metrics.deviceScaleFactor) < 0.0001;
    comparisons.push(['视口 / 屏幕 / DPR', geometryOk ? '与本次配置一致' : '与本次配置不一致', geometryOk ? 'ok' : 'bad']);
    comparisons.push(['窗口与桌面', '配置覆盖网页视口、屏幕与 DPR；跨进程 iframe、实际窗口尺寸、可用工作区和真实桌面保留原生行为', 'warn']);
  }
  if (EXPECT.overrideGeolocation) {
    const ok = geo && !geo.error && Math.abs(geo.latitude - EXPECT.latitude) < 0.05 && Math.abs(geo.longitude - EXPECT.longitude) < 0.05;
    comparisons.push(['定位', ok ? '与本次配置一致' : '未获取到匹配坐标', ok ? 'ok' : 'bad']);
  }
  const leaks = rtc.values.filter(value => value.type !== 'relay' && !/\.local$/i.test(value.address) &&
    !['0.0.0.0', '::', '[::]'].includes(value.address) && normalize(value.address) !== normalize(EXPECT.ip));
  comparisons.push(['WebRTC 页面读数', leaks.length ? '出现非预期地址: ' + leaks.map(value => value.address).join(', ') :
    rtc.values.length && !rtc.error ? '本次检查未发现非预期地址' : '未获取到完整候选，结果不确定',
    leaks.length ? 'bad' : rtc.values.length && !rtc.error ? 'ok' : 'warn']);
  comparisons.push(['WebRTC 过滤范围', EXPECT.webrtcProtect ?
    '事件、SDP 和统计的页面级过滤；不保证底层网络流量不暴露 IP' : '未启用页面级过滤', 'warn']);
  comparisons.push(['设备隔离', 'GPU、字体和底层渲染等信号仍可能关联不同 profile', 'warn']);
  rows('consistency', comparisons);
}
let checking = true;
let pendingExpect;
const failed = error => rows('consistency', [['自检失败', error.message, 'bad']]);
async function applyPending() {
  if (checking) return;
  checking = true;
  try {
    while (pendingExpect) {
      EXPECT = pendingExpect; pendingExpect = undefined;
      await renderChecks();
    }
  } catch (error) { failed(error); }
  finally { checking = false; }
}
const initialCheck = renderChecks().catch(failed).finally(() => { checking = false; void applyPending(); });
if (EXPECT.ipMonitorSeconds) {
  // Local server push also reaches background tabs whose timers are throttled.
  const updates = new EventSource('/events');
  updates.onmessage = event => {
    try {
      const next = JSON.parse(event.data);
      if (JSON.stringify(next) !== JSON.stringify(EXPECT)) {
        EXPECT = next; renderEgress(); pendingExpect = next; void applyPending();
      }
    } catch (error) { failed(error); }
  };
  addEventListener('pagehide', () => updates.close(), { once: true });
}
initialCheck;
</script></body></html>`;

export async function startVerifyServer(expect) {
  let current = { ...expect };
  const listeners = new Set();
  const server = http.createServer((request, response) => {
    const host = String(request.headers.host || '').split(':')[0].toLowerCase();
    if (!['127.0.0.1', 'localhost'].includes(host)) { response.writeHead(403); response.end('Forbidden'); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    if (request.url?.split('?')[0] === '/events') {
      response.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      if (request.method === 'HEAD') { response.end(); return; }
      listeners.add(response);
      const remove = () => listeners.delete(response);
      response.once('close', remove); response.once('error', remove);
      response.write('data: ' + JSON.stringify(current) + '\n\n');
    } else if (request.url?.split('?')[0] === '/state') {
      response.writeHead(200, { ...headers, 'content-type': 'application/json' });
      response.end(request.method === 'HEAD' ? '' : JSON.stringify(current));
    } else if (request.url?.split('?')[0] === '/echo') {
      response.writeHead(200, { ...headers, 'content-type': 'application/json' });
      const fingerprintHeaders = {};
      for (const name of ['accept-language', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-platform']) {
        if (request.headers[name]) fingerprintHeaders[name] = request.headers[name];
      }
      response.end(request.method === 'HEAD' ? '' : JSON.stringify(fingerprintHeaders));
    } else {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      response.end(request.method === 'HEAD' ? '' : PAGE(current));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  let closing;
  return {
    url: 'http://127.0.0.1:' + server.address().port + '/',
    update(next) {
      current = { ...next };
      const event = 'data: ' + JSON.stringify(current) + '\n\n';
      for (const response of listeners) {
        if (response.destroyed || response.writableEnded) listeners.delete(response);
        else response.write(event);
      }
    },
    close() {
      if (!closing) closing = new Promise(resolve => {
        for (const response of listeners) response.end();
        listeners.clear();
        server.close(() => resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
