import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP, resolveChromePath, sleep } from '../lib/cdp.mjs';

const japan = {
  ip: '203.0.113.21', countryCode: 'JP', timezone: 'Asia/Tokyo',
  lat: 35.6, lon: 139.6, source: 'fixture', isProxy: false, isHosting: false,
  detectionSource: 'fixture', detectionError: null,
};
const america = {
  ...japan, ip: '203.0.113.22', countryCode: 'US', timezone: 'America/New_York', lat: 40.7, lon: -74,
};

async function until(check, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  assert.fail(message);
}

test('normal CLI aligns native Chrome UI and website language while preserving a live session', {
  timeout: 90000, skip: process.platform !== 'win32',
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-native-language-cli-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.copyFileSync(path.join(source, 'fp-browser.mjs'), path.join(temporary, 'fp-browser.mjs'));
  fs.cpSync(path.join(source, 'lib'), path.join(temporary, 'lib'), { recursive: true });
  const fixture = path.join(temporary, 'current-geo.json');
  const queries = path.join(temporary, 'geo-queries.jsonl');
  const launches = path.join(temporary, 'launches.jsonl');
  const writeGeo = geo => {
    fs.writeFileSync(fixture + '.next', JSON.stringify(geo));
    fs.renameSync(fixture + '.next', fixture);
  };
  writeGeo(japan);
  fs.renameSync(path.join(temporary, 'lib', 'geo.mjs'), path.join(temporary, 'lib', 'geo-real.mjs'));
  fs.writeFileSync(path.join(temporary, 'lib', 'geo.mjs'), `
    import fs from 'node:fs';
    export { isUsableGeo } from './geo-real.mjs';
    export async function lookupGeo(options) {
      options.signal?.throwIfAborted();
      const geo = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
      fs.appendFileSync(${JSON.stringify(queries)}, JSON.stringify({ ip: geo.ip, wsUrl: options.wsUrl }) + '\\n');
      return geo;
    }
  `);
  fs.renameSync(path.join(temporary, 'lib', 'ip-monitor.mjs'), path.join(temporary, 'lib', 'ip-monitor-real.mjs'));
  fs.writeFileSync(path.join(temporary, 'lib', 'ip-monitor.mjs'), `
    import { startIPMonitor as realMonitor } from './ip-monitor-real.mjs';
    export function startIPMonitor(options) { return realMonitor({ ...options, intervalMs: 150 }); }
  `);
  // Keep the actual launcher and Chrome; move only test-owned windows offscreen.
  fs.renameSync(path.join(temporary, 'lib', 'cdp.mjs'), path.join(temporary, 'lib', 'cdp-real.mjs'));
  fs.writeFileSync(path.join(temporary, 'lib', 'cdp.mjs'), `
    import fs from 'node:fs';
    import { launchChrome as realLaunch } from './cdp-real.mjs';
    export * from './cdp-real.mjs';
    export async function launchChrome(options) {
      fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ args: options.args }) + '\\n');
      return realLaunch({ ...options, args: [...(options.args || []), '--window-position=-32000,-32000'] });
    }
  `);
  const requests = [];
  const server = http.createServer((request, response) => {
    const language = request.headers['accept-language'] || '';
    const japanese = language.startsWith('ja');
    requests.push({ url: request.url, language });
    response.setHeader('cache-control', 'no-store');
    if (request.url === '/localized') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ language, content: japanese ? '日本語のコンテンツ' : 'English content' }));
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><meta charset="utf-8"><script>
        window.firstLanguage=navigator.language;window.pageNonce=crypto.randomUUID();
      </script><body>${japanese ? '日本語のコンテンツ' : 'English content'}</body>`);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const websiteUrl = 'http://127.0.0.1:' + server.address().port + '/';
  const profile = path.join(temporary, 'profiles', 'native-language');
  // Reproduce a previously saved Chinese UI and translation target without
  // copying or reading any real browser profile or account data.
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ intl: { app_locale: 'zh-CN' } }));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    intl: { selected_languages: 'en-US,zh-CN,zh', accept_languages: 'en-US,zh-CN,zh' },
    translate_recent_target: 'zh-CN',
  }));
  const owned = [];
  const start = async () => {
    const child = spawn(process.execPath, [path.join(temporary, 'fp-browser.mjs'),
      '--direct', '--no-verify', '--profile', 'native-language', '--chrome', resolveChromePath(), '--url', websiteUrl,
    ], { cwd: temporary, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const session = { child, output: '', errors: '', cdp: null };
    owned.push(session);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { session.output += data; });
    child.stderr.on('data', data => { session.errors += data; });
    session.exited = new Promise(resolve => {
      child.once('exit', code => resolve(code));
      child.once('error', error => { session.errors += error.message; resolve('spawn failed'); });
    });
    await until(() => {
      if (child.exitCode !== null) throw new Error('CLI failed: ' + session.output + session.errors);
      return session.output.includes('✅ 已就绪');
    }, 'native-language CLI did not start', 25000);
    const [port, browserPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    session.cdp = await CDP.connect('ws://127.0.0.1:' + port + browserPath);
    session.read = async (sid, expression) => {
      const result = await session.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    session.attach = async targetId => (await session.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const website = (await session.cdp.send('Target.getTargets')).targetInfos.find(target => target.url === websiteUrl);
    assert.ok(website);
    session.websiteSession = await session.attach(website.targetId);
    await until(() => session.read(session.websiteSession, '!!window.pageNonce'), 'website first script did not run');
    const { targetId } = await session.cdp.send('Target.createTarget', { url: 'chrome://settings/languages', background: true });
    session.settingsSession = await session.attach(targetId);
    await until(() => session.read(session.settingsSession,
      "document.title.length>0&&typeof chrome.settingsPrivate?.getPref==='function'"), 'native settings APIs did not load');
    session.native = () => session.read(session.settingsSession, `(async()=>{
      const get=key=>new Promise(resolve=>chrome.settingsPrivate.getPref(key,pref=>resolve(pref?.value)));
      return {title:document.title,htmlLanguage:document.documentElement.lang,
        appLocale:await get('intl.app_locale'),selected:await get('intl.selected_languages'),
        accept:await get('intl.accept_languages'),translate:await get('translate_recent_target')};
    })()`);
    session.close = async () => {
      await session.cdp.send('Browser.close').catch(() => {});
      assert.equal(await Promise.race([session.exited, sleep(7000).then(() => 'timeout')]), 0, session.output + session.errors);
      session.cdp.close();
    };
    return session;
  };
  try {
    const first = await start();
    const nonce = await first.read(first.websiteSession, `
      document.cookie='native-language-login=preserved; Path=/; Max-Age=3600';
      localStorage.setItem('native-language-login','preserved');pageNonce;`);
    await t.test('the first native menu resources, language preferences and website response use the IP language', async () => {
      const native = await first.native();
      assert.equal(native.htmlLanguage, 'ja');
      assert.match(native.title, /設定/);
      assert.ok(['ja', 'ja-JP'].includes(native.appLocale));
      assert.equal(native.selected.split(',')[0], 'ja-JP');
      assert.match(native.accept, /^ja-JP/);
      assert.ok(['ja', 'ja-JP'].includes(native.translate));
      const website = await first.read(first.websiteSession,
        '({language:navigator.language,first:firstLanguage,content:document.body.innerText})');
      assert.equal(website.language, 'ja-JP');
      assert.equal(website.first, 'ja-JP');
      assert.match(website.content, /日本語/);
      assert.match(requests.find(request => request.url === '/')?.language || '', /^ja-JP/);
      const startRecords = fs.readFileSync(launches, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(startRecords.some(record => record.args.includes('--no-startup-window')), 'initial IP probe must not open a visible window');
      assert.equal(startRecords.some(record => record.args.some(arg => arg.startsWith('--lang='))), false,
        'persistent native preferences must remain writable while running');
      const observed = fs.readFileSync(queries, 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(new Set(observed.map(row => row.wsUrl)).size >= 2, 'check the final browser network after the native UI launch');
    });
    await t.test('changing IP updates live content preferences while native menu resources wait for restart', async () => {
      writeGeo(america);
      await until(() => first.read(first.websiteSession, "navigator.language==='en-US'"), 'live website language stayed Japanese');
      await until(async () => {
        const native = await first.native();
        return native.selected.split(',')[0] === 'en-US' && native.appLocale === 'en-US' &&
          ['en', 'en-US'].includes(native.translate);
      }, 'native language or translation preferences stayed Japanese');
      const native = await first.native();
      assert.equal(native.appLocale, 'en-US', 'save the next native UI language during this session');
      assert.equal(native.htmlLanguage, 'ja', 'native UI strings require a browser restart');
      assert.match(native.title, /設定/);
      assert.match(native.accept, /^en-US/);
      assert.ok(['en', 'en-US'].includes(native.translate));
      const website = await first.read(first.websiteSession, `(async()=>({
        nonce:pageNonce,first:firstLanguage,language:navigator.language,
        cookie:document.cookie,stored:localStorage.getItem('native-language-login'),
        latest:await fetch('/localized').then(response=>response.json())
      }))()`);
      assert.equal(website.nonce, nonce);
      assert.equal(website.first, 'ja-JP');
      assert.equal(website.language, 'en-US');
      assert.match(website.cookie, /native-language-login=preserved/);
      assert.equal(website.stored, 'preserved');
      assert.match(website.latest.language, /^en-US/);
      assert.equal(website.latest.content, 'English content');
    });
    await first.close();
    await t.test('closing Chrome persists the new native UI, preferred languages and translation language', async () => {
      const state = JSON.parse(fs.readFileSync(path.join(profile, 'Local State'), 'utf8'));
      const preferences = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
      assert.equal(state.intl?.app_locale, 'en-US');
      assert.equal(preferences.intl?.selected_languages.split(',')[0], 'en-US');
      assert.match(preferences.intl?.accept_languages, /^en-US/);
      assert.ok(['en', 'en-US'].includes(preferences.translate_recent_target));
    });
    const second = await start();
    await t.test('the next normal startup uses the latest IP language for native UI and content without losing login data', async () => {
      const native = await second.native();
      assert.equal(native.htmlLanguage, 'en');
      assert.match(native.title, /Settings/);
      assert.equal(native.appLocale, 'en-US');
      const website = await second.read(second.websiteSession, `({
        language:navigator.language,first:firstLanguage,content:document.body.innerText,
        cookie:document.cookie,stored:localStorage.getItem('native-language-login')
      })`);
      assert.equal(website.language, 'en-US');
      assert.equal(website.first, 'en-US');
      assert.equal(website.content, 'English content');
      assert.match(website.cookie, /native-language-login=preserved/);
      assert.equal(website.stored, 'preserved');
    });
    await second.close();
  } finally {
    for (const session of owned) {
      if (session.cdp && !session.cdp.closed) await session.cdp.send('Browser.close', {}, undefined, 1000).catch(() => {});
      session.cdp?.close();
      if (session.child.exitCode === null) {
        try { execFileSync('taskkill.exe', ['/PID', String(session.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
      }
      await Promise.race([session.exited, sleep(1000)]);
    }
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
