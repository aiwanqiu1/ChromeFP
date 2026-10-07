import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'start-chrome.ps1');
const quotePowerShell = value => "'" + value.replaceAll("'", "''") + "'";

function runFixture({ args = [], exitCode = 0, missingEntry = false, nodePath = process.execPath, directExecution = false, beforeInvoke = '', reuseConfiguration = {}, reuseWaitMilliseconds = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chromefp-launcher-'));
  const project = path.join(directory, "项目 with spaces and 'quote'");
  fs.mkdirSync(project);
  const launcher = path.join(project, 'start-chrome.ps1');
  const startsFile = path.join(directory, 'node-starts.txt');
  const completionFile = path.join(directory, 'node-completed.txt');
  fs.copyFileSync(source, launcher);
  if (!missingEntry) {
    fs.writeFileSync(path.join(project, 'fp-browser.mjs'), `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(startsFile)}, 'start\\n');
      console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
      console.error('测试错误输出，不丢失中文');
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync(${JSON.stringify(completionFile)}, 'complete');
      process.exit(${exitCode});
    `);
  }
  const configuration = path.join(directory, 'configuration.json');
  fs.writeFileSync(configuration, JSON.stringify({ project, nodePath, args, reuseConfiguration, completionFile }));
  const wrapper = path.join(directory, 'verify.ps1');
  fs.writeFileSync(wrapper, '\uFEFF' + `
$ErrorActionPreference = 'Stop'
. ${quotePowerShell(launcher)}
$configuration = Get-Content -LiteralPath ${quotePowerShell(configuration)} -Raw -Encoding UTF8 | ConvertFrom-Json
$script:popupMessages = New-Object 'System.Collections.Generic.List[object]'
$script:reuseFacts = [ordered]@{}
function Show-ChromeFpError {
    param([string]$Detail, [string]$LogDirectory)
    $script:popupMessages.Add([pscustomobject]@{ detail = $Detail; logs = $LogDirectory })
}
${beforeInvoke}
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$code = Invoke-ChromeFpLauncher -ProjectRoot $configuration.project -NodePath $configuration.nodePath -BrowserArguments ([string[]]$configuration.args)${reuseWaitMilliseconds === null ? '' : ' -ReuseWaitMilliseconds ' + reuseWaitMilliseconds}
$timer.Stop()
[pscustomobject]@{ code = $code; popups = @($script:popupMessages.ToArray()); elapsedMs = $timer.ElapsedMilliseconds; facts = $script:reuseFacts } | ConvertTo-Json -Depth 5 -Compress
`);
  try {
    const commandArguments = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File'];
    commandArguments.push(...(directExecution ? [launcher, '-NodePath', nodePath, ...args] : [wrapper]));
    const result = spawnSync('powershell.exe', commandArguments, { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const summary = directExecution ? { code: result.status, output: result.stdout } : JSON.parse(result.stdout.trim());
    const logsDirectory = path.join(project, 'logs');
    const logs = fs.existsSync(logsDirectory) ? fs.readdirSync(logsDirectory) : [];
    const stdout = logs.filter(name => name.endsWith('.out.log')).map(name => fs.readFileSync(path.join(logsDirectory, name), 'utf8'));
    const stderr = logs.filter(name => name.endsWith('.err.log')).map(name => fs.readFileSync(path.join(logsDirectory, name), 'utf8'));
    const nodeStarts = fs.existsSync(startsFile) ? fs.readFileSync(startsFile, 'utf8').trim().split(/\r?\n/).length : 0;
    return { summary, stdout, stderr, project, nodeStarts };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('Windows shortcut launcher retains lifecycle, argument boundaries and UTF-8 logs', { skip: process.platform !== 'win32' }, () => {
  const args = ['--profile', '店铺 A', '引号 "inside"', 'C:\\folder with spaces\\', '', 'https://example.com/?a=1&b=2', 'literal $() `'];
  const result = runFixture({ args });
  assert.equal(result.summary.code, 0);
  assert.deepEqual(result.summary.popups, []);
  assert.ok(result.summary.elapsedMs >= 300, 'launcher must wait until Node exits');
  assert.equal(result.stdout.length, 1);
  assert.equal(result.stderr.length, 1);
  assert.deepEqual(JSON.parse(result.stdout[0]), { args, cwd: result.project });
  assert.match(result.stderr[0], /测试错误输出，不丢失中文/);
});

test('Windows shortcut launcher reports a failed child once with diagnostic logs', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ exitCode: 4 });
  assert.equal(result.summary.code, 4);
  assert.equal(result.summary.popups.length, 1);
  assert.match(result.summary.popups[0].detail, /错误代码：4/);
  assert.match(result.summary.popups[0].detail, /测试错误输出，不丢失中文/);
  assert.equal(result.summary.popups[0].logs, path.join(result.project, 'logs'));
});

test('Windows shortcut launcher reports startup errors before spawning Node', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ missingEntry: true });
  assert.equal(result.summary.code, 1);
  assert.equal(result.summary.popups.length, 1);
  assert.match(result.summary.popups[0].detail, /找不到 fp-browser\.mjs/);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr[0], /找不到 fp-browser\.mjs/);
});

test('Windows shortcut launcher falls back to PATH after an embedded Node path disappears', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ nodePath: 'C:\\not-a-real-chromefp-runtime\\node.exe' });
  assert.equal(result.summary.code, 0, JSON.stringify(result.summary));
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.stdout.length, 1);
});

test('Windows shortcut selects one executable when PATH contains multiple Node installations', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({
    nodePath: 'C:\\missing-embedded-runtime\\node.exe',
    reuseConfiguration: { primaryNode: process.execPath },
    beforeInvoke: `
function Get-Command {
    param([string]$Name, [string]$CommandType)
    if ($Name -ne 'node.exe' -or $CommandType -ne 'Application') { throw 'Unexpected command lookup in fixture' }
    return @(
        [pscustomobject]@{ Source = $configuration.reuseConfiguration.primaryNode },
        [pscustomobject]@{ Source = 'C:\\another-runtime\\node.exe' }
    )
}
`,
  });
  assert.equal(result.summary.code, 0, JSON.stringify(result.summary));
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.nodeStarts, 1);
  assert.equal(result.stdout.length, 1);
});

test('Windows shortcut launcher accepts the real PowerShell -File invocation and forwards profile arguments', { skip: process.platform !== 'win32' }, () => {
  const args = ['--profile', '店铺 A', '--direct'];
  const result = runFixture({ args, directExecution: true });
  assert.equal(result.summary.code, 0);
  assert.equal(result.summary.output, '');
  assert.deepEqual(JSON.parse(result.stdout[0]), { args, cwd: result.project });
});

const reuseMocks = `
$script:reuseFacts['shows'] = 0
$script:reuseFacts['waits'] = 0
$script:reuseFacts['releases'] = 0
$script:reuseFacts['disposals'] = 0
$script:reuseFacts['mutexProfiles'] = New-Object 'System.Collections.Generic.List[string]'
$script:fixtureMutex = [pscustomobject]@{}
$script:fixtureMutex | Add-Member -MemberType ScriptMethod -Name WaitOne -Value {
    param([int]$Milliseconds)
    $script:reuseFacts['waits']++
    if ($configuration.reuseConfiguration.mode -in @('contested', 'unavailable')) {
        Start-Sleep -Milliseconds 25
        return $false
    }
    if ($configuration.reuseConfiguration.mode -eq 'abandoned' -and $script:reuseFacts['waits'] -eq 1) {
        throw (New-Object System.Threading.AbandonedMutexException)
    }
    return $true
}
$script:fixtureMutex | Add-Member -MemberType ScriptMethod -Name ReleaseMutex -Value {
    $script:reuseFacts['releases']++
    $script:reuseFacts['nodeCompletedAtRelease'] = Test-Path -LiteralPath $configuration.completionFile
}
$script:fixtureMutex | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $script:reuseFacts['disposals']++
}
function New-ChromeFpSessionMutex {
    param([string]$ProfileDirectory)
    $script:reuseFacts['mutexProfiles'].Add($ProfileDirectory)
    return $script:fixtureMutex
}
function TryShow-ChromeFpProfile {
    param([string]$ProjectRoot, [string]$ProfileDirectory)
    $script:reuseFacts['shows']++
    $script:reuseFacts['lastProject'] = $ProjectRoot
    $script:reuseFacts['lastProfile'] = $ProfileDirectory
    if ($configuration.reuseConfiguration.mode -eq 'live') { return $true }
    if ($configuration.reuseConfiguration.mode -eq 'ready-after-claim') { return $script:reuseFacts['waits'] -ge 1 }
    if ($configuration.reuseConfiguration.mode -eq 'contested') { return $script:reuseFacts['waits'] -ge 2 }
    return $false
}
`;

test('Windows shortcut reuses its live profile without spawning another Node or showing an error', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'live' } });
  assert.equal(result.summary.code, 0);
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.nodeStarts, 0, 'an existing managed browser must not start another Node session');
  assert.equal(result.stdout.length, 0);
  assert.equal(result.summary.facts.lastProject, result.project);
  assert.equal(result.summary.facts.lastProfile, path.join(result.project, 'profiles', 'default'));
});

test('Windows shortcut waits for a contested cold start and then shows the first session', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'contested' } });
  assert.equal(result.summary.code, 0);
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.nodeStarts, 0, 'a second click during startup must not launch a competing Node');
  assert.equal(result.summary.facts.waits, 2);
  assert.ok(result.summary.facts.shows >= 3);
  assert.equal(result.summary.facts.releases, 0, 'a follower never releases another launcher\'s mutex');
  assert.equal(result.summary.facts.disposals, 1);
});

test('Windows shortcut recovers an abandoned owner and owns the replacement until Node exits', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'abandoned' } });
  assert.equal(result.summary.code, 0, JSON.stringify(result.summary));
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.nodeStarts, 1);
  assert.equal(result.summary.facts.waits, 1);
  assert.equal(result.summary.facts.releases, 1, 'abandonment grants ownership and requires releasing it');
  assert.equal(result.summary.facts.disposals, 1);
  assert.ok(result.summary.elapsedMs >= 300);
  assert.equal(result.summary.facts.nodeCompletedAtRelease, true, 'the mutex must stay owned until the child finishes');
});

test('Windows shortcut checks again after acquiring a lock instead of racing an existing browser', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'ready-after-claim' } });
  assert.equal(result.summary.code, 0);
  assert.deepEqual(result.summary.popups, []);
  assert.equal(result.nodeStarts, 0);
  assert.equal(result.summary.facts.waits, 1);
  assert.equal(result.summary.facts.releases, 1);
  assert.equal(result.summary.facts.disposals, 1);
});

test('Windows shortcut times out a blocked startup without spawning or releasing another owner', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'unavailable' }, reuseWaitMilliseconds: 100 });
  assert.equal(result.summary.code, 1);
  assert.equal(result.nodeStarts, 0);
  assert.equal(result.summary.popups.length, 1);
  assert.equal(result.summary.facts.releases, 0);
  assert.equal(result.summary.facts.disposals, 1);
  assert.ok(result.summary.facts.waits >= 1);
  assert.ok(result.summary.elapsedMs < 3000, 'waiting for another startup must be bounded');
});

test('Windows shortcut only reuses default or profile-only invocations and isolates mutex names', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture({ args: ['--profile', '店铺 A'], reuseConfiguration: { mode: 'live' }, beforeInvoke: reuseMocks + `
$defaultProfile = Get-ChromeFpReusableProfile -ProjectRoot $configuration.project -BrowserArguments @()
$storeProfile = Get-ChromeFpReusableProfile -ProjectRoot $configuration.project -BrowserArguments @('--profile', '店铺 A')
$script:reuseFacts['defaultKey'] = Get-ChromeFpMutexName -ProfileDirectory $defaultProfile
$script:reuseFacts['storeKey'] = Get-ChromeFpMutexName -ProfileDirectory $storeProfile
$script:reuseFacts['sameKey'] = Get-ChromeFpMutexName -ProfileDirectory ($storeProfile.ToUpperInvariant())
$script:reuseFacts['explicitConfiguration'] = Get-ChromeFpReusableProfile -ProjectRoot $configuration.project -BrowserArguments @('--profile', '店铺 A', '--direct')
$script:reuseFacts['urlInvocation'] = Get-ChromeFpReusableProfile -ProjectRoot $configuration.project -BrowserArguments @('https://example.com/')
$script:reuseFacts['invalidProfile'] = Get-ChromeFpReusableProfile -ProjectRoot $configuration.project -BrowserArguments @('--profile', '..')
` });
  assert.equal(result.summary.code, 0);
  assert.equal(result.nodeStarts, 0);
  assert.equal(result.summary.facts.lastProfile, path.join(result.project, 'profiles', '店铺 A'));
  assert.match(result.summary.facts.defaultKey, /^Local\\ChromeFP-[a-f0-9]{64}$/i);
  assert.notEqual(result.summary.facts.defaultKey, result.summary.facts.storeKey);
  assert.equal(result.summary.facts.storeKey, result.summary.facts.sameKey);
  assert.equal(result.summary.facts.explicitConfiguration, null);
  assert.equal(result.summary.facts.urlInvocation, null);
  assert.equal(result.summary.facts.invalidProfile, null);
});

test('Windows shortcut forwards explicit configuration instead of silently reusing a live profile', { skip: process.platform !== 'win32' }, () => {
  const args = ['--profile', '店铺 A', '--direct'];
  const result = runFixture({ args, beforeInvoke: reuseMocks, reuseConfiguration: { mode: 'live' } });
  assert.equal(result.summary.code, 0);
  assert.equal(result.nodeStarts, 1);
  assert.equal(result.summary.facts.shows, 0);
  assert.deepEqual(JSON.parse(result.stdout[0]), { args, cwd: result.project });
});
