import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIdentity, resolveIdentity, validateIdentity } from '../lib/identity.mjs';
import { parseArgs } from '../lib/options.mjs';
import { CDP } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';

const version = { product: 'Chrome/154.0.8037.58' };
const template = () => ({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36',
  platform: 'Win32',
  userAgentMetadata: {
    brands: [{ brand: 'Chromium', version: '{major}' }, { brand: 'Google Chrome', version: '{major}' }, { brand: 'Not A;Brand', version: '24' }],
    fullVersionList: [{ brand: 'Chromium', version: '{version}' }, { brand: 'Google Chrome', version: '{version}' }, { brand: 'Not A;Brand', version: '24.0.0.0' }],
    fullVersion: '{version}', platform: 'Windows', platformVersion: '13.0.0', architecture: 'x86', bitness: '64',
    model: '', mobile: false, wow64: false, formFactors: ['Desktop'],
  },
});
const resolve = identity => resolveIdentity(identity, version, 'win32', 'x64');
const structural = identity => validateIdentity(identity, 'win32', 'x64');

for (const [name, userAgent] of [
  ['mixed Windows and Linux tokens', ua => ua.replace('Windows NT 10.0', 'Windows NT 10.0; Linux x86_64')],
  ['an ARM64 Windows UA with x64 Client Hints', ua => ua.replace('Win64; x64', 'Win64; ARM64')],
  ['a skeletal UA missing the Chrome engine framing', () => 'Windows NT 10.0 Chrome/{version}'],
]) {
  test('identity rejects ' + name, () => {
    const input = template(); input.userAgent = userAgent(input.userAgent);
    assert.throws(() => resolve(input), /--identity/);
  });
}

test('canonical desktop UA framing accepts Headless Chrome and reduced macOS/Linux platform tokens', () => {
  const headless = template(); headless.userAgent = headless.userAgent.replace('Chrome/', 'HeadlessChrome/');
  assert.match(resolve(headless).userAgent, /HeadlessChrome\/154\.0\.0\.0/);

  const mac = template();
  mac.userAgent = mac.userAgent.replace('Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7');
  mac.platform = 'MacIntel';
  Object.assign(mac.userAgentMetadata, { platform: 'macOS', platformVersion: '14.0.0', architecture: 'arm' });
  assert.equal(resolveIdentity(mac, version, 'darwin', 'arm64').userAgentMetadata.architecture, 'arm');

  const linux = template();
  linux.userAgent = linux.userAgent.replace('Windows NT 10.0; Win64; x64', 'X11; Linux x86_64');
  linux.platform = 'Linux x86_64';
  Object.assign(linux.userAgentMetadata, { platform: 'Linux', platformVersion: '' });
  assert.equal(resolveIdentity(linux, version, 'linux', 'x64').userAgentMetadata.platform, 'Linux');

  mac.userAgent = mac.userAgent.replace('Intel Mac OS X', 'Windows NT 10.0; Intel Mac OS X');
  linux.userAgent = linux.userAgent.replace('Linux x86_64', 'Linux x86_64; Macintosh');
  assert.throws(() => validateIdentity(mac, 'darwin', 'arm64'), /--identity/);
  assert.throws(() => validateIdentity(linux, 'linux', 'x64'), /--identity/);
});

test('identity expands actual versions without mutating the template', () => {
  const input = template(); const identity = resolve(input);
  assert.match(identity.userAgent, /Chrome\/154\.0\.0\.0/);
  assert.equal(identity.userAgentMetadata.fullVersionList[0].version, '154.0.8037.58');
  assert.equal(identity.userAgentMetadata.fullVersion, '154.0.8037.58');
  assert.equal(input.userAgentMetadata.fullVersion, '{version}');
  delete input.userAgentMetadata.fullVersion;
  assert.equal(resolve(input).userAgentMetadata.fullVersion, undefined);
  assert.equal(resolveIdentity(null, { product: 'unrecognized' }), null);
  const nextRelease = template(); nextRelease.userAgent = nextRelease.userAgent.replace('{major}', '155');
  assert.equal(resolveIdentity(nextRelease, { product: 'Chrome/155.1.2.3' }, 'win32', 'x64').userAgentMetadata.brands[0].version, '155');
});

test('identity rejects partial metadata, unsafe strings and contradictory platforms before Chrome', () => {
  const bad = [];
  const missing = template(); delete missing.userAgentMetadata.bitness; bad.push(missing);
  const unknown = template(); unknown.userAgentMetadata.random = true; bad.push(unknown);
  const injection = template(); injection.userAgent += '\r\nX-Injected: true'; bad.push(injection);
  const mobile = template(); mobile.userAgentMetadata.mobile = true; bad.push(mobile);
  const model = template(); model.userAgentMetadata.model = 'Pixel 9'; bad.push(model);
  const platform = template(); platform.userAgentMetadata.platform = 'macOS'; bad.push(platform);
  const architecture = template(); architecture.userAgentMetadata.architecture = 'arm'; bad.push(architecture);
  const oldPlatform = template(); oldPlatform.platform = 'Win64'; bad.push(oldPlatform);
  const noGrease = template(); noGrease.userAgentMetadata.brands[2].brand = 'Safari'; bad.push(noGrease);
  const duplicates = template(); duplicates.userAgentMetadata.brands[2].brand = 'Chromium'; bad.push(duplicates);
  const mismatchedBrands = template(); mismatchedBrands.userAgentMetadata.fullVersionList[2].brand = 'Not_A Brand'; bad.push(mismatchedBrands);
  const differentMajor = template(); differentMajor.userAgentMetadata.brands[1].version = '153'; bad.push(differentMajor);
  const unexpectedToken = template(); unexpectedToken.userAgent = unexpectedToken.userAgent.replace('{major}', '{unsupported}'); bad.push(unexpectedToken);
  for (const identity of bad) assert.throws(() => structural(identity), /--identity/);
  for (const metadata of [null, true, 'invalid', [], { brands: 'invalid' }]) {
    const identity = template(); identity.userAgentMetadata = metadata;
    assert.throws(() => structural(identity), /--identity/);
  }
});

test('identity rejects stale engine versions and desktop cross-platform impersonation', () => {
  const older = resolve(template()); older.userAgent = older.userAgent.replace('154.0.0.0', '153.0.0.0');
  assert.throws(() => resolve(older), /--identity/);
  const stalePatch = resolve(template()); stalePatch.userAgentMetadata.fullVersionList[0].version = '154.0.7000.1';
  assert.throws(() => resolve(stalePatch), /实际 Chrome/);
  const unreducedStaleUa = resolve(template()); unreducedStaleUa.userAgent = unreducedStaleUa.userAgent.replace('154.0.0.0', '154.0.7000.1');
  assert.throws(() => resolve(unreducedStaleUa), /实际 Chrome/);
  assert.throws(() => resolveIdentity(template(), version, 'linux', 'x64'), /本机|一致/);
  assert.throws(() => resolveIdentity(template(), { product: 'Chrome/Test' }, 'win32', 'x64'), /无法确认/);
});

test('identity loader validates local JSON and parseArgs exposes identity before any startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-identity-unit-'));
  try {
    const file = path.join(directory, 'identity.json'); fs.writeFileSync(file, '\uFEFF' + JSON.stringify(template()));
    assert.equal(loadIdentity(file, 'win32', 'x64').platform, 'Win32');
    if (process.platform === 'win32' && process.arch === 'x64') assert.equal(parseArgs(['--identity', file]).identity.platform, 'Win32');
    fs.writeFileSync(file, '{invalid'); assert.throws(() => loadIdentity(file), /JSON/);
    fs.writeFileSync(file, ' '.repeat(65537)); assert.throws(() => loadIdentity(file), /64 KB/);
    assert.throws(() => parseArgs(['--identity', path.join(directory, 'missing.json')]), /无法读取/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('device metrics are opt-in, include an explicit desktop screen and validate all CLI combinations', () => {
  assert.equal(parseArgs([]).identity, null); assert.equal(parseArgs([]).deviceMetrics, null);
  assert.deepEqual(parseArgs(['--viewport', '1200x800']).deviceMetrics,
    { width: 1200, height: 800, screenWidth: 1200, screenHeight: 800, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(parseArgs(['--dpr', '1.5', '--screen', '1920x1080', '--viewport', '1200X800']).deviceMetrics,
    { width: 1200, height: 800, screenWidth: 1920, screenHeight: 1080, deviceScaleFactor: 1.5, mobile: false });
  for (const argv of [['--screen', '1920x1080'], ['--dpr', '1'], ['--viewport', '0x800'], ['--viewport', '1200.5x800'],
    ['--viewport', '16385x800'], ['--viewport', '1200x800', '--screen', '1000x800'], ['--viewport', '1200x800', '--dpr', 'NaN'],
    ['--viewport', '1200x800', '--dpr', 'Infinity'], ['--viewport', '1200x800', '--dpr', '0.49'], ['--viewport', '1200x800', '--dpr', '4.1']]) {
    assert.throws(() => parseArgs(argv), /--viewport|--screen|--dpr/);
  }
});

test('driver installs requested identity before navigation and never forces iframe viewport dimensions', async () => {
  const originalConnect = CDP.connect;
  const handlers = new Map(); const calls = []; let index = 0;
  const fake = { closed: false, on(method, listener) { handlers.set(method, listener); }, close() { this.closed = true; handlers.get('__closed')?.(); },
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === 'Browser.getVersion') return version;
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Target.createTarget') {
        const targetId = 'page-' + ++index;
        handlers.get('Target.attachedToTarget')({ sessionId: targetId, targetInfo: { type: 'page', targetId, url: 'about:blank' } });
        return { targetId };
      }
      return {};
    } };
  CDP.connect = async () => fake;
  try {
    const metrics = parseArgs(['--viewport', '1200x800']).deviceMetrics;
    const driver = await runDriver({ wsUrl: 'unused', cfg: { identity: template(), deviceMetrics: metrics, acceptLanguage: 'ja-JP,ja' } });
    await driver.openUrl('https://example.invalid/');
    const uaIndex = calls.findIndex(call => call.method === 'Emulation.setUserAgentOverride');
    const navIndex = calls.findIndex(call => call.method === 'Page.navigate');
    assert.ok(uaIndex >= 0 && uaIndex < navIndex);
    assert.equal(calls[uaIndex].params.acceptLanguage, 'ja-JP,ja');
    assert.equal(calls[uaIndex].params.userAgentMetadata.fullVersionList[0].version, '154.0.8037.58');
    handlers.get('Target.attachedToTarget')({ sessionId: 'iframe', targetInfo: { type: 'iframe', targetId: 'iframe', url: 'https://other.invalid/' } });
    await driver.waitForTarget('iframe');
    assert.equal(calls.some(call => call.method === 'Emulation.setDeviceMetricsOverride' && call.sessionId === 'iframe'), false);
    assert.equal(calls.some(call => call.method === 'Emulation.setUserAgentOverride' && call.sessionId === 'iframe'), true);
  } finally { fake.close(); CDP.connect = originalConnect; }
});

test('requested worker identity has a Network fallback and a failed override still resumes that worker', async () => {
  const originalConnect = CDP.connect; const handlers = new Map(); const calls = []; const warnings = [];
  const fake = { closed: false, on(method, listener) { handlers.set(method, listener); }, close() { this.closed = true; handlers.get('__closed')?.(); },
    async send(method, params = {}, sessionId) {
      calls.push({ method, sessionId });
      if (method === 'Browser.getVersion') return version;
      if (method === 'Target.getTargets') return { targetInfos: [] };
      if (method === 'Emulation.setUserAgentOverride') throw new Error("'Emulation.setUserAgentOverride' wasn't found");
      if (method === 'Network.setUserAgentOverride') throw new Error('diagnostic unsupported worker');
      return {};
    } };
  CDP.connect = async () => fake;
  try {
    const driver = await runDriver({ wsUrl: 'unused', cfg: { identity: template() }, log: message => warnings.push(message) });
    handlers.get('Target.attachedToTarget')({ sessionId: 'worker', targetInfo: { type: 'worker', targetId: 'worker' } });
    await driver.waitForTarget('worker');
    assert.equal(calls.some(call => call.method === 'Network.setUserAgentOverride'), true);
    assert.equal(calls.some(call => call.method === 'Runtime.runIfWaitingForDebugger' && call.sessionId === 'worker'), true);
    assert.equal(driver.cdp.closed, false); assert.ok(warnings.some(message => message.includes('身份覆盖失败')));
  } finally { fake.close(); CDP.connect = originalConnect; }
});
