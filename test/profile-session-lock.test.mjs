import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import * as browser from '../lib/cdp.mjs';

const moduleUrl = new URL('../lib/cdp.mjs', import.meta.url).href;
const marker = directory => path.join(directory, '.fp-session.lock');

function temporaryProfile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-profile-session-'));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

function fromAnotherProcess(directory) {
  const expression = `
    import {profileInUse,acquireProfileSession} from ${JSON.stringify(moduleUrl)};
    const directory=${JSON.stringify(directory)};
    const inUse=profileInUse(directory);
    let acquired=false,error;
    try { const release=acquireProfileSession(directory); acquired=true;release(); }
    catch(failure) {error=failure.message;}
    console.log(JSON.stringify({inUse,acquired,error}));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', expression], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim());
}

async function closeOwnedBrowser(launched) {
  if (!launched || launched.proc.exitCode !== null) return;
  const exited = new Promise(resolve => launched.proc.once('exit', resolve));
  let cdp;
  try {
    cdp = await browser.CDP.connect(launched.wsUrl);
    await cdp.send('Browser.close').catch(() => {});
    assert.equal(await Promise.race([exited, browser.sleep(7000).then(() => 'timeout')]), 0);
  } finally {
    cdp?.close();
    if (launched.proc.exitCode === null) browser.killChrome(launched.proc);
    await Promise.race([exited, browser.sleep(1000)]);
  }
}

test('a profile session keeps another launcher out between two owned Chrome instances', {
  timeout: 70000, skip: process.platform !== 'win32',
}, async t => {
  assert.equal(typeof browser.acquireProfileSession, 'function');
  const directory = temporaryProfile(t);
  const release = browser.acquireProfileSession(directory);
  const record = fs.readFileSync(marker(directory), 'utf8');
  const owned = [];
  const launch = async () => {
    const result = await browser.launchChrome({
      exe: browser.resolveChromePath(), userDataDir: directory,
      args: ['--headless=new', '--no-startup-window', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-proxy-server'],
    });
    owned.push(result);
    return result;
  };
  try {
    assert.equal(browser.profileInUse(directory), false, 'this owner may start its first Chrome');
    assert.throws(() => browser.acquireProfileSession(directory), /占用|独占/,
      'a second session lease in the same Node process is still a duplicate');
    const first = await launch();
    assert.equal(browser.profileInUse(directory), true, 'an active Chrome remains busy even for the session owner');
    await closeOwnedBrowser(first);
    assert.equal(fs.existsSync(path.join(directory, '.fp-launcher.lock')), false);
    assert.equal(fs.readFileSync(marker(directory), 'utf8'), record);
    assert.equal(browser.profileInUse(directory), false, 'the session owner may relaunch after its browser exits');
    const competitor = fromAnotherProcess(directory);
    assert.equal(competitor.inUse, true);
    assert.equal(competitor.acquired, false);
    assert.match(competitor.error, /占用|独占/);
    const second = await launch();
    assert.equal(browser.profileInUse(directory), true);
    await assert.rejects(launch(), /占用/);
    // The actual Windows Chrome guard must also survive an absent legacy marker.
    fs.rmSync(path.join(directory, '.fp-launcher.lock'));
    assert.equal(browser.profileInUse(directory), true);
    await assert.rejects(launch(), /占用/);
    await closeOwnedBrowser(second);
    assert.equal(fs.readFileSync(marker(directory), 'utf8'), record);
    release();
    assert.equal(fs.existsSync(marker(directory)), false);
    assert.deepEqual(fromAnotherProcess(directory), { inUse: false, acquired: true });
  } finally {
    for (const launched of owned.reverse()) await closeOwnedBrowser(launched).catch(() => {});
    release();
  }
});

test('fresh incomplete session markers block acquisition while old incomplete markers can be reclaimed', t => {
  assert.equal(typeof browser.acquireProfileSession, 'function');
  const directory = temporaryProfile(t);
  for (const incomplete of ['', '{', '{}', '{"pid":0}']) {
    fs.writeFileSync(marker(directory), incomplete);
    assert.equal(browser.profileInUse(directory), true);
    assert.throws(() => browser.acquireProfileSession(directory), /占用|独占/);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(marker(directory), old, old);
    const release = browser.acquireProfileSession(directory);
    assert.equal(JSON.parse(fs.readFileSync(marker(directory), 'utf8')).pid, process.pid);
    release();
    assert.equal(fs.existsSync(marker(directory)), false);
  }
});

test('a live foreign owner is busy even when its session marker is old', async t => {
  assert.equal(typeof browser.acquireProfileSession, 'function');
  const directory = temporaryProfile(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    windowsHide: true, stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    fs.writeFileSync(marker(directory), JSON.stringify({ pid: child.pid, token: 'foreign-owner' }));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(marker(directory), old, old);
    assert.equal(browser.profileInUse(directory), true);
    assert.throws(() => browser.acquireProfileSession(directory), /占用|独占/);
  } finally {
    child.kill();
    await exited;
  }
  const release = browser.acquireProfileSession(directory);
  assert.equal(JSON.parse(fs.readFileSync(marker(directory), 'utf8')).pid, process.pid);
  release();
});

test('session release only removes its own token and never weakens a legacy launcher lock', t => {
  assert.equal(typeof browser.acquireProfileSession, 'function');
  const directory = temporaryProfile(t);
  const release = browser.acquireProfileSession(directory);
  assert.equal(browser.profileInUse(directory), false);
  fs.writeFileSync(path.join(directory, '.fp-launcher.lock'), JSON.stringify({ pid: process.pid, token: 'legacy-owner' }));
  assert.equal(browser.profileInUse(directory), true);
  assert.throws(() => browser.acquireProfileSession(directory), /占用|独占/);
  fs.writeFileSync(marker(directory), JSON.stringify({ pid: process.pid, token: 'replacement-owner' }));
  release();
  release();
  assert.equal(JSON.parse(fs.readFileSync(marker(directory), 'utf8')).token, 'replacement-owner');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.fp-launcher.lock'), 'utf8')).token, 'legacy-owner');
});
