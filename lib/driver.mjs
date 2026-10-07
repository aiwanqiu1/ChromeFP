// CDP 驱动：给浏览器里的每一个 target 注入「与出口 IP 一致」的区域参数
//
// 更新语言时同时携带 Browser.getVersion 的原生 UA 和原生 Client Hints，
// 保持请求头与页面读数一致；显式 --identity 仍优先使用完整身份。
//
// 驱动应用区域覆盖以及显式请求的身份和顶层视口仿真：
//   1) 时区（本机 OS 时区改不了，TZ 环境变量在 Windows 上被 Chrome 完全忽略）
//   2) 地理位置（按出口 IP）
//   3) 可选的 hardwareConcurrency / 页面级补丁
//   4) 可选的完整 UA 身份，以及顶层页面的 viewport / screen / DPR
//
// 必须用 Target.setAutoAttach 的原因：Emulation 覆盖是按 target 生效的，
// 新标签页不继承；只有 autoAttach + waitForDebuggerOnStart 才能在新 target 的
// 页面脚本执行之前完成覆盖。
import { CDP } from './cdp.mjs';
import { buildProvider } from './provider.mjs';
import { resolveIdentity } from './identity.mjs';
import { randomUUID } from 'node:crypto';

const PAGE_LIKE = new Set(['page', 'iframe', 'webview', 'background_page']);
const WORKER_LIKE = new Set(['worker', 'shared_worker', 'service_worker', 'worklet']);
const TARGET_COMMAND_TIMEOUT = 3000;
const TARGET_READY_TIMEOUT = 45000;

export async function runDriver({ wsUrl, cfg, log = () => {} }) {
  const cdp = await CDP.connect(wsUrl);
  const version = await cdp.send('Browser.getVersion').catch(error => { cdp.close(); throw error; });
  let identity;
  try { identity = resolveIdentity(cfg.identity, version); } catch (error) { cdp.close(); throw error; }
  let nativeIdentity = null;
  if (version.userAgent) {
    // about:blank 的不安全上下文没有 UA Client Hints。在开始自动附加前，
    // 用后台内置页读取真正的 Chrome 身份，随后关闭该临时页。
    let targetId;
    try {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'chrome://version/', background: true }));
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const result = await cdp.send('Runtime.evaluate', { expression: `(async()=>{
        for(let attempt=0;attempt<40&&!navigator.userAgentData;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
        if(!navigator.userAgentData)throw new Error('原生 Client Hints 不可用');
        const low=navigator.userAgentData.toJSON();
        const high=await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model',
          'platformVersion','fullVersionList','wow64','formFactors']);
        return {platform:navigator.platform,userAgentMetadata:{...low,...high}};
      })()`, awaitPromise: true, returnByValue: true }, sessionId, TARGET_COMMAND_TIMEOUT);
      if (result.exceptionDetails || !result.result?.value?.userAgentMetadata?.brands?.length) {
        throw new Error('无法读取完整原生 Client Hints');
      }
      nativeIdentity = { userAgent: version.userAgent, ...result.result.value };
    } catch (error) { cdp.close(); throw error; }
    finally {
      if (targetId && !cdp.closed) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
  if (cfg.deviceMetrics) log('  [警告] 屏幕/视口/DPR 为顶层页面仿真；跨进程 iframe、实际窗口和桌面工作区仍可能显示原生值');
  const installationKey = randomUUID();
  let providerSource = buildProvider(cfg, installationKey);
  let revision = 0;
  let updateChain = Promise.resolve();
  const handled = new Set();
  const sessions = new Map();
  const sessionByTarget = new Map();
  const readyWaiters = new Map();
  const targetState = new Map();
  const stats = { attached: 0, overridden: 0, failed: 0, byType: {} };
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const targetCommand = (method, params, sessionId) => cdp.send(method, params, sessionId, TARGET_COMMAND_TIMEOUT);

  function settle(targetId, error) {
    targetState.set(targetId, { ready: !error, error });
    for (const waiter of readyWaiters.get(targetId) || []) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error); else waiter.resolve();
    }
    readyWaiters.delete(targetId);
  }

  cdp.on('__closed', () => {
    const error = new Error('CDP 调试连接已断开');
    for (const targetId of readyWaiters.keys()) settle(targetId, error);
    resolveClosed({});
  });

  async function evaluateProvider(record, source) {
    if (!source) return;
    const contexts = [...record.contexts.values()].filter(context => context.auxData?.isDefault !== false);
    // Runtime.enable 尚未报告 context 的 Worker 仍可在默认 realm 执行。
    const ids = contexts.length ? contexts.map(context => context.id) : [undefined];
    await Promise.all(ids.map(async contextId => {
      try {
        const result = await targetCommand('Runtime.evaluate', { expression: source,
          ...(contextId === undefined ? {} : { contextId }) }, record.sessionId);
        if (result.exceptionDetails) throw new Error('指纹页面补丁执行失败');
      } catch (error) {
        // 导航过程中销毁的旧 realm 无需阻塞，下一文档由注册脚本覆盖。
        if (contextId !== undefined && !record.contexts.has(contextId)) return;
        if (/Cannot find context|Execution context was destroyed|Inspected target navigated/i.test(error.message)) return;
        throw error;
      }
    }));
  }

  async function applyOverrides(record, snapshot, initial = false) {
    const { sessionId, targetInfo } = record;
    const { cfg, identity, providerSource } = snapshot;
    const type = targetInfo?.type || 'unknown';
    if (initial) stats.byType[type] = (stats.byType[type] || 0) + 1;
    const pageLike = PAGE_LIKE.has(type);

    if ((identity || cfg.acceptLanguage || cfg.locale) && (pageLike || WORKER_LIKE.has(type))) {
      const resolved = identity || nativeIdentity;
      const params = resolved && { ...resolved, acceptLanguage: cfg.acceptLanguage || cfg.locale };
      if (params) {
        try {
          await targetCommand('Emulation.setUserAgentOverride', params, sessionId);
        } catch (error) {
          // Worker 协议实现可能只有 Network 域；失败只影响本 target，不阻塞其他页面。
          if (WORKER_LIKE.has(type) && /wasn't found|method not found|not supported|not available/i.test(error.message)) {
            try { await targetCommand('Network.setUserAgentOverride', params, sessionId); }
            catch (fallbackError) {
              stats.failed++; log(`  [警告] 身份覆盖失败(${type}): ${fallbackError.message}`);
              if (!initial) throw fallbackError;
            }
          } else {
            stats.failed++; log(`  [警告] 身份覆盖失败(${type}): ${error.message}`);
            if (!initial) throw error;
          }
        }
      }
    }
    if (cfg.deviceMetrics && (type === 'page' || type === 'webview')) {
      await targetCommand('Emulation.setDeviceMetricsOverride', cfg.deviceMetrics, sessionId).catch(error => {
        stats.failed++; log(`  [警告] 视口和屏幕覆盖失败(${type}): ${error.message}`);
        if (!initial) throw error;
      });
    }

    if (pageLike) {
      // Chrome 需要启用 Page 域才会执行新文档补丁；超时不能关闭其他窗口。
      if (initial) await targetCommand('Page.enable', {}, sessionId).catch(error => {
        stats.failed++;
        log(`  [警告] 页面初始化失败(${type}): ${error.message}；网页补丁可能未生效，继续应用其余覆盖`);
      });
      if (initial) await targetCommand('Runtime.enable', {}, sessionId).catch(() => {});

      // 时区：核心项。实测对 Worker target 也生效
      if (cfg.timezoneId) {
        await targetCommand('Emulation.setTimezoneOverride', { timezoneId: cfg.timezoneId }, sessionId);
        stats.overridden++;
      }

      // 把 Intl locale 精确成完整 locale（--lang 只会给出基础 locale，如 ja 而非 ja-JP）
      if (cfg.locale) {
        await targetCommand('Emulation.setLocaleOverride', { locale: cfg.locale }, sessionId)
          .catch(error => { if (!/already in effect/i.test(error.message)) throw error; });
      }

      if (cfg.hardwareConcurrency) {
        await targetCommand('Emulation.setHardwareConcurrencyOverride',
          { hardwareConcurrency: cfg.hardwareConcurrency }, sessionId)
          .catch(error => log(`  [警告] 核心数 CDP 覆盖失败，使用页面补丁: ${error.message}`));
      }

      if (cfg.overrideGeolocation && cfg.latitude != null && cfg.longitude != null) {
        await targetCommand('Emulation.setGeolocationOverride',
          { latitude: cfg.latitude, longitude: cfg.longitude, accuracy: 5000 }, sessionId);
      }

      if (providerSource) {
        const previous = record.scriptId;
        const { identifier } = await targetCommand('Page.addScriptToEvaluateOnNewDocument', { source: providerSource, runImmediately: true }, sessionId);
        record.scriptId = identifier;
        if (previous) await targetCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous }, sessionId);
        await evaluateProvider(record, providerSource);
      }
    } else if (WORKER_LIKE.has(type)) {
      if (initial) await targetCommand('Runtime.enable', {}, sessionId).catch(() => {});
      // Worker / Service Worker 也有 Date 和 Intl
      if (cfg.timezoneId) await targetCommand('Emulation.setTimezoneOverride', { timezoneId: cfg.timezoneId }, sessionId).catch(() => {});
      if (cfg.locale) {
        await targetCommand('Emulation.setLocaleOverride', { locale: cfg.locale }, sessionId).catch(() => {});
      }
      await evaluateProvider(record, providerSource);
    }
    record.revision = snapshot.revision;
  }

  const snapshot = () => ({ cfg, identity, providerSource, revision });
  function enqueueOverrides(record, config, initial = false) {
    const pending = record.pending.catch(() => {}).then(() => {
      if (!handled.has(record.sessionId) || cdp.closed) return;
      return applyOverrides(record, config, initial);
    });
    record.pending = pending;
    return pending;
  }

  cdp.on('Runtime.executionContextCreated', ({ context }, sessionId) => {
    const record = sessions.get(sessionId);
    if (record && context) record.contexts.set(context.id, context);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }, sessionId) => {
    sessions.get(sessionId)?.contexts.delete(executionContextId);
  });
  cdp.on('Runtime.executionContextsCleared', (_params, sessionId) => {
    sessions.get(sessionId)?.contexts.clear();
  });

  cdp.on('Target.attachedToTarget', (params) => {
    const { sessionId, targetInfo } = params;
    if (handled.has(sessionId)) return;
    handled.add(sessionId);
    const record = { sessionId, targetInfo, contexts: new Map(), pending: Promise.resolve(), revision: -1 };
    sessions.set(sessionId, record);
    stats.attached++;
    const targetId = targetInfo?.targetId;
    if (targetId) {
      sessionByTarget.set(targetId, sessionId);
      targetState.set(targetId, { ready: false });
    }

    (async () => {
      try {
        await enqueueOverrides(record, snapshot(), true);
        // 附加期间恰逢 IP 更新，新目标恢复运行前追上最新配置。
        while (record.revision < revision && handled.has(sessionId) && !cdp.closed) {
          await enqueueOverrides(record, snapshot());
        }
      } catch (error) {
        if (!handled.has(sessionId) || cdp.closed) return;
        stats.failed++;
        log(`  [警告] 覆盖未全部完成(${targetInfo?.type}): ${error.message}；本页继续运行，区域或硬件读数可能不一致`);
      } finally {
        // 即使某项覆盖超时，也要解除调试暂停，避免页面打不开或整个会话退出。
        if (handled.has(sessionId) && !cdp.closed) {
          // 某项覆盖失败也不能漏掉页面派生的 OOPIF 和 Worker。
          if (PAGE_LIKE.has(targetInfo?.type) || WORKER_LIKE.has(targetInfo?.type)) {
            await targetCommand('Target.setAutoAttach',
              { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
              .catch(error => log(`  [警告] 派生目标自动附加失败(${targetInfo?.type}): ${error.message}`));
          }
          try {
            await targetCommand('Runtime.runIfWaitingForDebugger', {}, sessionId);
            if (targetId) settle(targetId);
          } catch (error) {
            if (handled.has(sessionId) && !cdp.closed && targetId) {
              stats.failed++;
              log(`  [警告] 页面恢复运行失败(${targetInfo?.type}): ${error.message}`);
              settle(targetId, error);
            }
          }
        }
      }
    })();
  });

  cdp.on('Target.detachedFromTarget', ({ sessionId, targetId }) => {
    handled.delete(sessionId);
    sessions.delete(sessionId);
    const id = targetId || [...sessionByTarget].find(([, session]) => session === sessionId)?.[0];
    if (id) {
      sessionByTarget.delete(id);
      settle(id, new Error('标签页已关闭'));
      targetState.delete(id);
    }
  });

  function updateConfig(nextConfig) {
    const pending = updateChain.catch(() => {}).then(async () => {
      if (cdp.closed) throw new Error('CDP 调试连接已关闭');
      const nextIdentity = resolveIdentity(nextConfig.identity, version);
      const nextSource = buildProvider(nextConfig, installationKey);
      cfg = nextConfig;
      identity = nextIdentity;
      providerSource = nextSource;
      revision++;
      const latest = snapshot();
      if (cfg.overrideGeolocation) await cdp.send('Browser.grantPermissions', { permissions: ['geolocation'] });
      const records = [...sessions.values()];
      const results = await Promise.allSettled(records.map(record => enqueueOverrides(record, latest)));
      const failures = results.flatMap((result, index) => result.status === 'rejected' && handled.has(records[index].sessionId)
        ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, `有 ${failures.length} 个浏览器目标未完成指纹更新`);
      return { revision, updated: records.length, cfg };
    });
    updateChain = pending;
    return pending;
  }

  function waitForTarget(targetId, timeoutMs = TARGET_READY_TIMEOUT) {
    if (cdp.closed) return Promise.reject(new Error('CDP 调试连接已关闭'));
    const state = targetState.get(targetId);
    if (state?.error) return Promise.reject(state.error);
    if (state?.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = readyWaiters.get(targetId) || new Set();
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        if (!waiters.size) readyWaiters.delete(targetId);
        reject(new Error('等待 target 注入完成超时'));
      }, timeoutMs);
      waiters.add(waiter);
      readyWaiters.set(targetId, waiters);
    });
  }

  /**
   * 打开网址的正确顺序 —— 这是必须的，不能直接用 Target.createTarget({url})：
   *   先建 about:blank → 等驱动把覆盖和页面补丁装完 → 再导航到真实网址。
   * 因为 Page.addScriptToEvaluateOnNewDocument 必须早于文档创建才生效；
   * 直接带 URL 建 target 时文档已经开始跑，页面级补丁会整个失效（实测确认）。
   */
  async function openUrl(url) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    let navigationStarted = false;
    try {
      await waitForTarget(targetId);
      const sid = sessionByTarget.get(targetId);
      if (!sid) throw new Error('未能建立 target 会话');
      navigationStarted = true;
      const result = await cdp.send('Page.navigate', { url }, sid);
      // 网络、代理和证书错误应保留 Chrome 自带的错误页，让用户查看和重试。
      if (result.errorText) log(`  [警告] 页面加载失败: ${result.errorText}；已保留错误页，可重试或检查代理`);
      return targetId;
    } catch (error) {
      // 发起导航后的超时也不能删除仍在加载或已展示错误的标签页。
      if (!navigationStarted) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      throw error;
    }
  }

  try {
    if (cfg.overrideGeolocation) await cdp.send('Browser.grantPermissions', { permissions: ['geolocation'] });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    await Promise.all(targetInfos.filter(info => PAGE_LIKE.has(info.type) && sessionByTarget.has(info.targetId))
      .map(info => waitForTarget(info.targetId).catch(error =>
        log(`  [警告] 初始页面未就绪: ${error.message}；其他页面继续运行`))));
  } catch (error) { cdp.close(); throw error; }

  log(`  Browser: ${version.product}`);
  log('  已开启全局 target 自动附加（新标签页 / iframe / worker 自动继承覆盖）');

  return { cdp, version, get identity() { return identity; }, stats, closed, openUrl, waitForTarget, sessionByTarget, updateConfig };
}
