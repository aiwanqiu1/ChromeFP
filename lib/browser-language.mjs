// Chrome 的网页/CDP 语言与浏览器偏好分别维护。离线写入只用于已停止的 profile；
// 运行时通过原生设置页更新内容偏好及下次启动的 UI 语言，不触碰登录数据。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CDP, sleep } from './cdp.mjs';

const PREF_KEYS = ['intl.accept_languages', 'intl.selected_languages', 'translate_recent_target', 'intl.app_locale'];
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function languageConfig(locale, languages) {
  if (typeof locale !== 'string' || !locale || !Array.isArray(languages) || !languages.length ||
      languages.some(value => typeof value !== 'string' || !value)) throw new Error('浏览器语言配置无效');
  let parsed;
  try { parsed = new Intl.Locale(locale); for (const language of languages) new Intl.Locale(language); }
  catch { throw new Error('浏览器语言配置包含无效的语言标签'); }
  // Chrome Translate accepts Norwegian as "no", while website/UI preferences
  // retain the modern Bokmål tag (for example nb-NO).
  const translateTarget = parsed.language === 'zh'
    ? parsed.maximize().script === 'Hant' ? 'zh-TW' : 'zh-CN'
    : parsed.language === 'nb' ? 'no' : parsed.language;
  return { locale, selected: languages.join(','), translateTarget };
}

function readPreferences(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error(path.basename(file) + ' 偏好 JSON 损坏，已保留原文件'); }
  if (!plainObject(parsed) || (Object.hasOwn(parsed, 'intl') && !plainObject(parsed.intl))) {
    throw new Error(path.basename(file) + ' 偏好 JSON 结构无效，已保留原文件');
  }
  return parsed;
}

export function persistBrowserLanguage({ userDataDir, locale, languages }) {
  if (typeof userDataDir !== 'string' || !userDataDir) throw new Error('浏览器 profile 目录无效');
  const config = languageConfig(locale, languages);
  const directory = path.resolve(userDataDir);
  const localFile = path.join(directory, 'Local State');
  const preferencesFile = path.join(directory, 'Default', 'Preferences');
  // 两个文件都校验完才进行写入，不能用语言修复覆盖原有的损坏 JSON。
  const localState = readPreferences(localFile);
  const preferences = readPreferences(preferencesFile);
  localState.intl = { ...localState.intl, app_locale: config.locale };
  preferences.intl = { ...preferences.intl, selected_languages: config.selected };
  preferences.translate_recent_target = config.translateTarget;
  const files = [[localFile, localState], [preferencesFile, preferences]];
  const temporary = [];
  try {
    // 先准备所有同目录临时文件，再原子替换各目标文件。
    for (const [file, value] of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = file + '.tmp-' + randomUUID();
      temporary.push(temp);
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    for (let index = 0; index < files.length; index++) fs.renameSync(temporary[index], files[index][0]);
  } finally {
    for (const temp of temporary) { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return { locale: config.locale, languages: [...languages], translateTarget: config.translateTarget };
}

export async function updateBrowserLanguage({ wsUrl, locale, languages, signal }) {
  const config = languageConfig(locale, languages);
  signal?.throwIfAborted();
  const cdp = await CDP.connect(wsUrl);
  let targetId;
  const settingsUrl = 'chrome://settings/languages?chromefpLanguage=' + randomUUID();
  // 普通后台 WebUI 能使用原生 settingsPrivate；Chrome 154 的 hidden WebUI 会崩溃。
  const send = (method, params = {}, sessionId, timeout = 6000) => {
    signal?.throwIfAborted();
    const request = cdp.send(method, params, sessionId, timeout);
    if (!signal) return request;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new Error('浏览器语言更新已取消'));
      signal.addEventListener('abort', abort, { once: true });
      request.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  };
  try {
    signal?.throwIfAborted();
    // 创建阶段等待 acknowledgement 以持有自己的 targetId，随后取消也能完整清理。
    ({ targetId } = await cdp.send('Target.createTarget', { url: settingsUrl, background: true }, undefined, 6000));
    signal?.throwIfAborted();
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const deadline = Date.now() + 6000;
    let ready = false;
    while (Date.now() < deadline) {
      const check = await send('Runtime.evaluate', { expression: 'Boolean(globalThis.chrome?.settingsPrivate?.setPref)', returnByValue: true }, sessionId);
      if (check.result?.value === true) { ready = true; break; }
      await sleep(50);
    }
    if (!ready) throw new Error('Chrome 原生语言设置接口未就绪');
    const expression = `(async()=>{
      const config=${JSON.stringify(config)};
      const getPref=key=>new Promise((resolve,reject)=>chrome.settingsPrivate.getPref(key,pref=>{
        const error=chrome.runtime.lastError?.message;
        if(error||!pref)reject(new Error(error||('无法读取浏览器语言偏好 '+key)));else resolve(pref.value);
      }));
      const updates=[['intl.selected_languages',config.selected],['translate_recent_target',config.translateTarget],['intl.app_locale',config.locale]];
      for(const [key,value] of updates){
        const current=await getPref(key);
        if(current===value)continue;
        await new Promise((resolve,reject)=>chrome.settingsPrivate.setPref(key,value,'',ok=>{
          const error=chrome.runtime.lastError?.message;
          if(!ok||error)reject(new Error(error||('浏览器语言偏好 '+key+' 不可写，可能由启动参数或策略控制')));else resolve();
        }));
      }
      const prefs={};for(const key of ${JSON.stringify(PREF_KEYS)})prefs[key]=await getPref(key);
      for(const [key,value] of updates)if(prefs[key]!==value)throw new Error('浏览器语言偏好 '+key+' 未成功更新');
      if(prefs['intl.accept_languages'].split(',')[0]!==config.selected.split(',')[0])throw new Error('浏览器内容首选语言未成功更新');
      const translateTarget=await new Promise(resolve=>chrome.languageSettingsPrivate.getTranslateTargetLanguage(resolve));
      if(translateTarget!==config.translateTarget)throw new Error('浏览器翻译目标语言未成功更新');
      return {prefs,translateTarget,uiLocale:document.documentElement.lang,uiTitle:document.title};
    })()`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '浏览器语言更新失败');
    }
    return { targetId, ...result.result.value };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    if (!cdp.closed) {
      // 若创建 command 超时，按本次独有 URL 找回自己的后台页，绝不关闭用户设置页。
      if (!targetId) {
        const targets = await cdp.send('Target.getTargets', {}, undefined, 1000).catch(() => ({}));
        targetId = targets.targetInfos?.find(info => info.url === settingsUrl)?.targetId;
      }
      if (targetId) {
        await cdp.send('Target.closeTarget', { targetId }, undefined, 1000).catch(() => {});
        // closeTarget 的确认可能早于 target 真正销毁；等自己的页退出后再关连接。
        const deadline = Date.now() + 1000;
        while (!cdp.closed && Date.now() < deadline) {
          const targets = await cdp.send('Target.getTargets', {}, undefined, 1000).catch(() => ({}));
          if (!targets.targetInfos?.some(info => info.targetId === targetId)) break;
          await sleep(25);
        }
      }
      cdp.close();
    }
  }
}
