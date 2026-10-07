#!/usr/bin/env node
// 按本次出口 IP 对齐 Chrome 区域参数；每个 profile 独立保存浏览器数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, resolveChromePath, launchChrome, killChrome, profileInUse, acquireProfileSession, sleep } from './lib/cdp.mjs';
import { readWindowsProxy, proxyArgs, describeEgress, egressCacheKey, shouldProtectWebRTC, waitForProxy } from './lib/systemproxy.mjs';
import { lookupGeo, isUsableGeo } from './lib/geo.mjs';
import { deriveLocale, sameTimezone } from './lib/config.mjs';
import { profileDirectory } from './lib/options.mjs';
import { parseLauncherArgs } from './lib/launcher-config.mjs';
import { runDriver } from './lib/driver.mjs';
import { startVerifyServer } from './lib/verifypage.mjs';
import { buildFingerprintConfig } from './lib/fingerprint.mjs';
import { startIPMonitor } from './lib/ip-monitor.mjs';
import { persistBrowserLanguage, updateBrowserLanguage } from './lib/browser-language.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(ROOT, 'profiles');
const CACHE_DIR = path.join(ROOT, 'cache');
const GEO_CACHE_VERSION = 2; // 旧缓存没有代理 / 机房查询结果，首次使用时刷新。
const IP_MONITOR_MS = 10000;

// No user pages are opened during the initial language selection. Wait for the
// owned browser to flush its profile before updating its native preferences.
async function closeStartupBrowser(browser) {
  if (!browser || browser.proc.exitCode !== null) return;
  const exited = new Promise(resolve => browser.proc.once('exit', resolve));
  let connection;
  try {
    connection = await CDP.connect(browser.wsUrl);
    await connection.send('Browser.close', {}, undefined, 2000).catch(() => {});
  } finally { connection?.close(); }
  await Promise.race([exited, sleep(5000)]);
  if (browser.proc.exitCode === null) {
    killChrome(browser.proc);
    await Promise.race([exited, sleep(3000)]);
  }
  if (browser.proc.exitCode === null) throw new Error('Chrome 尚未退出，无法安全更新浏览器语言设置');
}

const HELP = `
指纹启动器 — 读取当前系统出口 IP 生成指纹，运行中自动检测并更新

用法:
  node fp-browser.mjs [选项] [网址...]

出口链路（命令行参数优先）:
  (默认)                 读取 launcher-config.json；未配置 proxy 时跟随系统代理
  --proxy <url>          强制指定代理，如 http://127.0.0.1:7892 或 socks5://127.0.0.1:7892
  --direct               关闭浏览器代理（仍跟随 VPN/TUN）

身份与 profile:
  --profile <名字>       独立身份（独立的 Chrome user-data-dir），默认 default
  --list                 列出已有身份
  --identity <JSON路径>   同时覆盖 UA 和完整 Client Hints（平台与实际 Chrome 匹配）

对齐项:
  --viewport <宽x高>     实验性顶层网页视口，如 1280x720（OOPIF 保留原生屏幕）
  --screen <宽x高>       仿真屏幕尺寸，默认与视口一致
  --dpr <倍率>           仿真像素比例，默认 1；屏幕/DPR 需配合 --viewport
  --no-geo-location      不覆盖地理位置（默认按出口 IP 覆盖）
  --cores <n>            指定 hardwareConcurrency（默认按当前 IP 生成）
  --device-memory <n>    覆盖 navigator.deviceMemory（需页面级补丁）
  --webgl <vendor>|<renderer>  覆盖 WebGL 厂商/渲染器（需页面级补丁）

指纹补丁（默认按当前 IP 开启，保留同一 IP 的稳定读数）:
  --canvas-noise         对 Canvas 读数加当前 IP 对应的固定噪声
  --audio-noise          对音频读数加当前 IP 对应的固定噪声

WebRTC 公网 IP 泄露:
  走代理时 WebRTC 的 UDP 不经过 HTTP 代理，会泄露真实公网 IP。
  默认在走代理时启用页面级过滤，覆盖候选事件、SDP 和统计读数。\n  保留 mDNS 候选；过滤不是网络层防泄露保证，可能影响视频通话。
  --webrtc-protect       强制开启
  --no-webrtc-protect    强制关闭（视频通话若异常可关掉试试）

其他:
  --chrome <路径>        指定 chrome.exe
  --cache-geo <分钟>     同一 IP 的代理/机房判定缓存；出口 IP 始终重新查询
  --refresh              忽略缓存，重新查归属地
  --verify / --no-verify 是否打开自检页，默认打开
  --headless             无头模式（测试用）
  --print-config         只打印推导结果，不启动浏览器
  --verbose              打印每个 target 的附加日志
`;


async function main() {
  let opt;
  try { opt = parseLauncherArgs(process.argv.slice(2), path.join(ROOT, 'launcher-config.json')); }
  catch (error) { error.exitCode = 2; throw error; }
  if (opt.help) { console.log(HELP); return; }
  if (opt.list) {
    console.log('已有身份：');
    if (!fs.existsSync(PROFILES_DIR)) { console.log('  （还没有）'); return; }
    for (const entry of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = profileDirectory(PROFILES_DIR, entry.name);
      let size = 0;
      const walk = dir => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const file = path.join(dir, item.name);
          if (item.isDirectory()) walk(file);
          else if (item.isFile()) { try { size += fs.statSync(file).size; } catch {} }
        }
      };
      try { walk(directory); } catch {}
      console.log('  ' + entry.name.padEnd(24) + ' ' + (size / 1048576).toFixed(1) + ' MB  ' +
        (profileInUse(directory) ? '[运行中]' : ''));
    }
    return;
  }
  if (typeof WebSocket !== 'function') throw new Error('请安装 Node.js 22 或更新版本');
  const userDataDir = profileDirectory(PROFILES_DIR, opt.profile);
  const chromeExe = resolveChromePath(opt.chrome);
  // 先检查占用，避免查询出口后才发现同一身份无法启动。
  if (!opt.printConfig && profileInUse(userDataDir)) throw new Error('该 profile 已被占用，请关闭原窗口或换一个 --profile 名字');
  const proxyMode = opt.direct ? 'direct' : opt.proxy ? 'explicit' : 'auto';
  const sys = readWindowsProxy();
  const abortController = new AbortController();
  const { signal } = abortController;
  const interrupted = name => {
    const error = new Error('收到 ' + name + '，会话已结束');
    error.exitCode = name === 'Ctrl+C' ? 130 : 143;
    abortController.abort(error);
  };
  const onInterrupt = () => interrupted('Ctrl+C');
  const onTerminate = () => interrupted('终止信号');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  let launched;
  let driver;
  let verifyServer;
  let ipMonitor;
  let browserUiLocale = null;
  let browserUiRequestedLocale = null;
  let browserTranslateTarget = null;
  let nativeLanguageNeedsApply = false;
  let releaseProfileSession;
  const log = (...args) => console.log(...args);
  try {
    log('\n════════════════════════════════════════════════');
    log('  Chrome 指纹对齐启动器');
    log('════════════════════════════════════════════════');
    log('Chrome      : ' + chromeExe);
    log('出口链路    : ' + describeEgress(proxyMode, opt.proxy, sys));
    if (proxyMode === 'auto' && sys.pac) log('提示        : PAC 可按网站分流，归属地接口与目标网站的出口可能不同');
    const cacheKey = egressCacheKey(proxyMode, opt.proxy, sys);
    const cacheFile = path.join(CACHE_DIR, 'geo-' + cacheKey + '.json');
    let previousGeo;
    if (opt.cacheMinutes > 0 && !opt.refresh) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const age = Date.now() - cached.at;
        if (cached.version === GEO_CACHE_VERSION && Number.isFinite(cached.at) && age >= 0 &&
            age < opt.cacheMinutes * 60000 && isUsableGeo(cached.geo)) {
          previousGeo = cached.geo;
        }
      } catch {}
    }
    const chromeArgs = [
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled',
      ...proxyArgs(proxyMode, opt.proxy),
    ];
    if (opt.headless) chromeArgs.push('--headless=new', '--window-size=1280,900');
    if (!opt.printConfig) {
      if (proxyMode === 'explicit') await waitForProxy(opt.proxy, { signal, log });
      releaseProfileSession = acquireProfileSession(userDataDir);
      // Use this profile and Chrome's network stack, including proxy extensions.
      // Normal mode first queries without showing menus in the old UI language.
      log('启动 Chrome，检测实际生效的网络出口...');
      launched = await launchChrome({ exe: chromeExe,
        args: opt.headless ? chromeArgs : [...chromeArgs, '--no-startup-window'], userDataDir, signal });
    }
    const queryCurrentGeo = async (lookupSignal, previous) => {
      const currentSys = readWindowsProxy();
      const result = await lookupGeo({
        chromeExe, proxyMode, proxyUrl: opt.proxy, wsUrl: launched?.wsUrl,
        signal: lookupSignal, log, previousGeo: previous,
      });
      return { ...result, systemProxySnapshot: currentSys,
        egressKey: egressCacheKey(proxyMode, opt.proxy, currentSys) };
    };
    log('查询当前公网出口 IP 与归属地（使用实际浏览器网络）...');
    let geo = await queryCurrentGeo(signal, previousGeo);
    if (!opt.printConfig && !opt.headless) {
      // Native menu resources are loaded only at startup. Configure them before
      // showing the normal browser, then recheck its actual public exit IP.
      for (let attempt = 0; attempt < 3; attempt++) {
        const language = deriveLocale(geo.countryCode);
        await closeStartupBrowser(launched);
        signal.throwIfAborted();
        persistBrowserLanguage({ userDataDir, locale: language.locale, languages: language.languages });
        log('浏览器语言  : ' + language.locale + '（菜单、网站首选语言、翻译目标）');
        launched = await launchChrome({ exe: chromeExe, args: chromeArgs, userDataDir, signal });
        geo = await queryCurrentGeo(signal, geo);
        if (deriveLocale(geo.countryCode).locale === language.locale) {
          browserUiLocale = language.locale;
          browserUiRequestedLocale = language.locale;
          break;
        }
        log('启动期间出口地区发生变化，重新匹配浏览器语言...');
      }
      if (!browserUiLocale) throw new Error('启动期间出口地区持续变化，无法确定对应浏览器语言，请待网络稳定后重试');
    }
    if (opt.cacheMinutes > 0) {
      try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ version: GEO_CACHE_VERSION, at: Date.now(), geo }, null, 2));
      } catch { log('[警告] 归属地缓存写入失败，本次查询结果仍有效'); }
    }
    signal.throwIfAborted();
    if (geo.egressWarning) log('[警告] ' + geo.egressWarning);
    log('出口 IP     : ' + geo.ip + '  ' + geo.countryCode + ' ' + (geo.region || '') + ' ' + (geo.city || ''));
    const yesNo = value => value === true ? '是' : value === false ? '否' : '未知';
    log('代理 / 机房 : ' + yesNo(geo.isProxy) + ' / ' + yesNo(geo.isHosting) +
      '  [来源: ' + (geo.detectionSource || '未提供') + ']');
    if (geo.detectionError) log('[警告] 代理 / 机房判定不完整: ' + geo.detectionError);
    const loc = deriveLocale(geo.countryCode);
    const timezoneId = geo.timezone;
    const osTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const webrtcProtect = shouldProtectWebRTC(opt.webrtcProtect, proxyMode, geo.systemProxySnapshot);
    let cfg = buildFingerprintConfig(opt, geo, { webrtcProtect });
    log('\n  时区        : ' + timezoneId + (sameTimezone(osTimezone, timezoneId) ? '（与本机一致）' : '（覆盖浏览器时区）'));
    log('  语言        : ' + loc.locale + '   Accept-Language: ' + loc.acceptLanguage);
    log('  IP 指纹     : ' + cfg.fingerprintId + '（当前 IP 派生，Canvas / 音频已开启）');
    log('  核心 / 内存 : ' + cfg.hardwareConcurrency + ' / ' + cfg.deviceMemory + ' GB');
    if (opt.identity) log('  UA / CH     : 使用完整身份配置，启动时校验本机 Chrome 版本与平台');
    if (opt.deviceMetrics) log('  视口 / 屏幕 : ' + opt.deviceMetrics.width + 'x' + opt.deviceMetrics.height + ' / ' + opt.deviceMetrics.screenWidth + 'x' + opt.deviceMetrics.screenHeight + '，DPR ' + opt.deviceMetrics.deviceScaleFactor);
    log('  地理位置    : ' + (opt.overrideGeolocation ? geo.lat + ', ' + geo.lon : '不覆盖'));
    log('  UA / Client Hints : 保留 Chrome 原值');
    log('  WebRTC      : ' + (webrtcProtect ? '启用页面级过滤（事件 / SDP / 统计）' : '未启用页面级过滤'));
    const patchOn = webrtcProtect || cfg.hardwareConcurrency !== null || cfg.deviceMemory !== null ||
      cfg.webglVendor || cfg.canvasNoise || cfg.audioNoise;
    log('  页面级补丁  : ' + (patchOn ? '已启用，存在可被检测的 JS 修改面' : '无'));
    if (opt.printConfig) { log('\n推导出的完整配置：'); log(JSON.stringify(cfg, null, 2)); return; }

    // Keep headless checks and native preferences consistent too; normal mode
    // already loaded the selected UI language from its persisted profile.
    const nativeLanguage = await updateBrowserLanguage({ wsUrl: launched.wsUrl, locale: cfg.locale, languages: cfg.languages, signal });
    browserTranslateTarget = nativeLanguage.translateTarget;
    if (browserUiRequestedLocale) {
      browserUiLocale = nativeLanguage.uiLocale || browserUiRequestedLocale;
      if (new Intl.Locale(browserUiLocale).language !== new Intl.Locale(cfg.locale).language) {
        log('[提示] 本机 Chrome 没有 ' + cfg.locale + ' 的菜单翻译，实际菜单语言为 ' + browserUiLocale + '；网站首选语言仍为 ' + cfg.locale);
      }
    }

    log('\n安装当前出口 IP 对应的指纹与区域设置...');
    driver = await runDriver({
      wsUrl: launched.wsUrl, cfg,
      log: message => { if (opt.verbose || /\[警告\]|\[错误\]/.test(message)) log(message); },
    });
    launched.proc.once('exit', () => driver.cdp.close());
    signal.throwIfAborted();
    const urls = [];
    const verifyExpect = (currentGeo, currentCfg, currentSys) => ({
      ...currentGeo, ...currentCfg, timezone: currentCfg.timezoneId,
      identity: driver.identity,
      egressDesc: describeEgress(proxyMode, opt.proxy, currentSys),
      webrtcProtect: Boolean(currentCfg.webrtcExpectedIp), ipMonitorSeconds: IP_MONITOR_MS / 1000,
      browserUiLocale, browserUiRequestedLocale,
      translateTarget: browserTranslateTarget,
      browserUiMatchesLanguage: !browserUiLocale || new Intl.Locale(browserUiLocale).language === new Intl.Locale(currentCfg.locale).language,
      browserUiNeedsRestart: Boolean(browserUiRequestedLocale && browserUiRequestedLocale !== currentCfg.locale),
    });
    if (opt.verify) {
      verifyServer = await startVerifyServer(verifyExpect(geo, cfg, geo.systemProxySnapshot));
      urls.push(verifyServer.url);
      log('自检页      : ' + verifyServer.url);
    }
    urls.push(...opt.urls);
    if (!urls.length) urls.push('about:blank');
    // 普通启动时 Chrome 会先开一个初始窗口（还可能带回被恢复的旧标签页）。
    // 先记下这些初始 target，等本次页面全部开好后再关掉，界面里只留本次会话的页面。
    const startupTargets = await driver.cdp.send('Target.getTargets')
      .then(({ targetInfos = [] }) => targetInfos.filter(info => info.type === 'page').map(info => info.targetId))
      .catch(() => []);
    let opened = 0;
    for (let index = 0; index < urls.length; index++) {
      signal.throwIfAborted();
      try { await driver.openUrl(urls[index]); opened++; }
      catch (error) {
        if (driver.cdp.closed) throw error;
        log('[警告] 第 ' + (index + 1) + ' 个页面打开失败: ' + error.message);
      }
    }
    // 必须先有本次自己的页面，才能安全关掉初始标签页，否则可能把窗口关空导致会话提前结束。
    if (opened) {
      for (const targetId of startupTargets) {
        await driver.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    }
    if (driver.cdp.closed) throw new Error('区域覆盖驱动已停止');
    ipMonitor = startIPMonitor({
      initialGeo: geo, intervalMs: IP_MONITOR_MS, signal, log,
      lookup: ({ signal: lookupSignal }) => queryCurrentGeo(lookupSignal, geo),
      onObservation: nextGeo => {
        if (signal.aborted || driver.cdp.closed ||
            (nextGeo.egressWarning === geo.egressWarning && nextGeo.egressSource === geo.egressSource &&
             JSON.stringify(nextGeo.egressObservations) === JSON.stringify(geo.egressObservations))) return;
        geo = { ...geo, egressObservations: nextGeo.egressObservations,
          egressWarning: nextGeo.egressWarning, egressSource: nextGeo.egressSource };
        verifyServer?.update(verifyExpect(geo, cfg, geo.systemProxySnapshot));
        if (geo.egressWarning) log('[警告] ' + geo.egressWarning);
        else log('出口观测    : ' + geo.ip + '；本次有效检测接口返回相同 IP');
      },
      onChange: async (nextGeo, previousGeo) => {
        if (signal.aborted || driver.cdp.closed) return;
        const currentSys = nextGeo.systemProxySnapshot;
        const nextCfg = buildFingerprintConfig(opt, nextGeo, {
          webrtcProtect: shouldProtectWebRTC(opt.webrtcProtect, proxyMode, currentSys),
        });
        await driver.updateConfig(nextCfg);
        if (nativeLanguageNeedsApply || nextCfg.locale !== cfg.locale ||
            JSON.stringify(nextCfg.languages) !== JSON.stringify(cfg.languages)) {
          nativeLanguageNeedsApply = true;
          const nativeLanguage = await updateBrowserLanguage({ wsUrl: launched.wsUrl, locale: nextCfg.locale, languages: nextCfg.languages, signal });
          browserTranslateTarget = nativeLanguage.translateTarget;
          nativeLanguageNeedsApply = false;
        }
        cfg = nextCfg;
        geo = nextGeo;
        verifyServer?.update(verifyExpect(nextGeo, nextCfg, currentSys));
        if (nextGeo.egressWarning) log('[警告] ' + nextGeo.egressWarning);
        log('出口更新    : ' + previousGeo.ip + ' → ' + nextGeo.ip + '；' + describeEgress(proxyMode, opt.proxy, currentSys));
        log('IP 指纹更新  : ' + nextCfg.fingerprintId + '；已应用到现有页面和新标签页');
        if (browserUiRequestedLocale && browserUiRequestedLocale !== nextCfg.locale) {
          log('语言更新    : 网站首选语言和翻译目标已更新为 ' + nextCfg.locale + '；菜单语言重新打开 ChromeFP 后生效');
        }
      },
    });
    log('IP 自动检测 : 每 ' + IP_MONITOR_MS / 1000 + ' 秒查询当前出口；IP 或系统代理变化时自动更新');
    log('\n✅ 已就绪。请保持此命令行窗口开启，它负责给新页面应用覆盖。');
    log('   结束时关闭 Chrome 窗口，或按 Ctrl+C。');
    const interruptedPromise = new Promise(resolve => {
      if (signal.aborted) resolve({});
      else signal.addEventListener('abort', () => resolve({}), { once: true });
    });
    const outcome = await Promise.race([driver.closed, interruptedPromise]);
    signal.throwIfAborted();
    if (outcome?.error) throw outcome.error;
    log('\nChrome 已关闭。共处理 target ' + driver.stats.attached + ' 个。');
  } finally {
    await ipMonitor?.stop();
    // 初始化失败、连接中断和 Ctrl+C 都清理本次拥有的进程和自检服务。
    if (driver && !driver.cdp.closed) await driver.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
    driver?.cdp.close();
    killChrome(launched?.proc);
    if (verifyServer) await verifyServer.close();
    releaseProfileSession?.();
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
}

main().catch(error => {
  console.error('\n❌ ' + error.message);
  process.exitCode = error.exitCode || 1;
});
