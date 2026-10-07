import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { persistBrowserLanguage, updateBrowserLanguage } from '../lib/browser-language.mjs';

function temporaryProfile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-browser-language-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return directory;
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('offline language changes merge only the requested preferences and preserve profile data', t => {
  const directory = temporaryProfile(t);
  fs.mkdirSync(path.join(directory, 'Default'));
  fs.writeFileSync(path.join(directory, 'Local State'), JSON.stringify({ intl: { app_locale: 'zh-CN', keep: 1 }, other: { value: 42 } }));
  fs.writeFileSync(path.join(directory, 'Default', 'Preferences'), JSON.stringify({
    intl: { selected_languages: 'zh-CN,zh', accept_languages: 'zh-CN,zh', keep: true },
    translate_recent_target: 'zh-CN', extensions: { fixture: true }, session: { keep: 'saved' },
  }));
  fs.writeFileSync(path.join(directory, 'Default', 'Login Data'), 'untouched fixture');
  persistBrowserLanguage({ userDataDir: directory, locale: 'en-US', languages: ['en-US', 'en'] });
  assert.deepEqual(json(path.join(directory, 'Local State')), { intl: { app_locale: 'en-US', keep: 1 }, other: { value: 42 } });
  assert.deepEqual(json(path.join(directory, 'Default', 'Preferences')), {
    intl: { selected_languages: 'en-US,en', accept_languages: 'zh-CN,zh', keep: true },
    translate_recent_target: 'en', extensions: { fixture: true }, session: { keep: 'saved' },
  });
  assert.equal(fs.readFileSync(path.join(directory, 'Default', 'Login Data'), 'utf8'), 'untouched fixture');
  assert.equal(fs.readdirSync(directory).some(name => name.includes('.tmp-')), false);
});

test('offline updates create new profile folders and choose supported translation language codes', t => {
  const directory = path.join(temporaryProfile(t), 'new', 'profile');
  for (const [locale, target] of [['en-US', 'en'], ['ja-JP', 'ja'], ['zh-Hans-SG', 'zh-CN'],
    ['zh-Hant-HK', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-CN', 'zh-CN'], ['de-DE', 'de'], ['nb-NO', 'no']]) {
    persistBrowserLanguage({ userDataDir: directory, locale, languages: [locale] });
    assert.equal(json(path.join(directory, 'Local State')).intl.app_locale, locale);
    assert.equal(json(path.join(directory, 'Default', 'Preferences')).translate_recent_target, target);
  }
});

test('corrupt or non-object preference JSON never overwrites either profile file', t => {
  const directory = temporaryProfile(t);
  fs.mkdirSync(path.join(directory, 'Default'));
  const local = path.join(directory, 'Local State');
  const preferences = path.join(directory, 'Default', 'Preferences');
  for (const [localText, prefText] of [['{broken', '{}'], ['{}', '{broken'], ['[]', '{}'], ['{}', 'null']]) {
    fs.writeFileSync(local, localText); fs.writeFileSync(preferences, prefText);
    assert.throws(() => persistBrowserLanguage({ userDataDir: directory, locale: 'en-US', languages: ['en-US', 'en'] }), /JSON|偏好|配置/);
    assert.equal(fs.readFileSync(local, 'utf8'), localText);
    assert.equal(fs.readFileSync(preferences, 'utf8'), prefText);
  }
});

test('real Chrome updates browser preferences and translation without reloading the website or losing login, and uses the new UI on restart', { timeout: 60000 }, async t => {
  const directory = temporaryProfile(t);
  persistBrowserLanguage({ userDataDir: directory, locale: 'zh-CN', languages: ['zh-CN', 'zh'] });
  const server = http.createServer((request, response) => {
    if (request.url === '/headers') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.headers)); }
    else response.end('<!doctype html><script>window.loadCount=1</script><body>language fixture</body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let launched, driver, owner;
  const originalConnect = CDP.connect;
  try {
    const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server'];
    launched = await launchChrome({ exe: resolveChromePath(), userDataDir: directory, args });
    driver = await runDriver({ wsUrl: launched.wsUrl, cfg: { locale: 'zh-CN', acceptLanguage: 'zh-CN,zh', languages: ['zh-CN', 'zh'] } });
    const page = await driver.openUrl('http://127.0.0.1:' + server.address().port + '/');
    const evaluate = async expression => {
      const result = await driver.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, driver.sessionByTarget.get(page));
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text); return result.result.value;
    };
    await sleep(100);
    await evaluate("document.cookie='login=keep; Max-Age=3600';localStorage.login='keep'");
    const before = (await driver.cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort();
    const changed = await updateBrowserLanguage({ wsUrl: launched.wsUrl, locale: 'en-US', languages: ['en-US', 'en'] });
    assert.equal(changed.prefs['intl.selected_languages'], 'en-US,en');
    assert.equal(changed.prefs['intl.accept_languages'], 'en-US,en');
    assert.equal(changed.prefs['intl.app_locale'], 'en-US');
    assert.equal(changed.prefs.translate_recent_target, 'en'); assert.equal(changed.translateTarget, 'en');
    await driver.updateConfig({ locale: 'en-US', languages: ['en-US', 'en'], acceptLanguage: 'en-US,en' });
    const state = await evaluate(`(async()=>({language:navigator.language,languages:Array.from(navigator.languages),
      headers:await fetch('/headers').then(response=>response.json()),loads:loadCount,cookie:document.cookie,storage:localStorage.login}))()`);
    assert.equal(state.language, 'en-US'); assert.deepEqual(state.languages, ['en-US', 'en']);
    assert.ok(state.headers['accept-language'].startsWith('en-US')); assert.equal(state.loads, 1);
    assert.ok(state.cookie.includes('login=keep')); assert.equal(state.storage, 'keep');
    assert.deepEqual((await driver.cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort(), before);

    // Chrome Translate uses "no" for Bokmål; modern Hebrew/Indonesian codes and
    // a language without a UI resource pack must still retain their local website preferences.
    for (const [locale, target] of [['nb-NO', 'no'], ['he-IL', 'he'], ['id-ID', 'id'], ['ti-ER', 'ti']]) {
      const base = new Intl.Locale(locale).language;
      const languages = [locale, base, 'en-US', 'en'];
      const actual = await updateBrowserLanguage({ wsUrl: launched.wsUrl, locale, languages });
      assert.equal(actual.translateTarget, target); assert.equal(actual.prefs.translate_recent_target, target);
      assert.equal(actual.prefs['intl.app_locale'], locale); assert.equal(actual.prefs['intl.selected_languages'], languages.join(','));
      assert.equal(actual.prefs['intl.accept_languages'].split(',')[0], locale);
      assert.equal(actual.uiLocale, 'zh', 'report the currently loaded UI rather than the pending locale');
    }
    await updateBrowserLanguage({ wsUrl: launched.wsUrl, locale: 'en-US', languages: ['en-US', 'en'] });

    const controller = new AbortController(); const reason = new Error('isolated language update cancelled');
    CDP.connect = async (...args) => {
      const connection = await originalConnect.apply(CDP, args); const send = connection.send.bind(connection);
      connection.send = async (method, ...params) => { const result = await send(method, ...params); if (method === 'Target.attachToTarget') controller.abort(reason); return result; };
      return connection;
    };
    await assert.rejects(updateBrowserLanguage({ wsUrl: launched.wsUrl, locale: 'ja-JP', languages: ['ja-JP', 'ja'], signal: controller.signal }), error => error === reason);
    CDP.connect = originalConnect;
    assert.equal(driver.cdp.closed, false);
    assert.deepEqual((await driver.cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort(), before);
    assert.ok((await evaluate('document.cookie')).includes('login=keep'));
    await driver.cdp.send('Browser.close', {}, undefined, 1000); await driver.closed; driver.cdp.close(); driver = null;
    await new Promise(resolve => { if (launched.proc.exitCode !== null) resolve(); else launched.proc.once('exit', resolve); });
    assert.equal(json(path.join(directory, 'Local State')).intl.app_locale, 'en-US');
    launched = await launchChrome({ exe: resolveChromePath(), userDataDir: directory, args });
    owner = await CDP.connect(launched.wsUrl);
    const { targetId } = await owner.send('Target.createTarget', { url: 'chrome://settings/languages', background: true });
    const { sessionId } = await owner.send('Target.attachToTarget', { targetId, flatten: true });
    await sleep(300);
    const ui = (await owner.send('Runtime.evaluate', { expression: '({title:document.title,language:document.documentElement.lang})', returnByValue: true }, sessionId)).result.value;
    assert.match(ui.title, /Settings/); assert.equal(ui.language, 'en');
  } finally {
    CDP.connect = originalConnect;
    const active = driver?.cdp || owner;
    if (active && !active.closed) await active.send('Browser.close', {}, undefined, 1000).catch(() => {});
    active?.close(); killChrome(launched?.proc);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await sleep(300);
  }
});
