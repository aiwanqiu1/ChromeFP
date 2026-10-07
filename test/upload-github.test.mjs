import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'upload-github.ps1');
const windowsOnly = { skip: process.platform !== 'win32', timeout: 90_000 };
const runtimeFiles = [
  'profiles/store/Cookies', 'cache/chrome/browser.zip', 'logs/private.log',
  '_probe/browser-output.json', 'local-shortcut.lnk', 'assets/local-shortcut.lnk',
];

function writeFile(directory, relativePath, content) {
  const target = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture(t, { ignoreRuntime = true } = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'chromefp-upload-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const project = path.join(directory, "项目 with spaces and 'quote'");
  const remote = path.join(directory, '远端 with spaces.git');
  fs.mkdirSync(project);
  fs.copyFileSync(source, path.join(project, 'upload-github.ps1'));
  writeFile(project, 'content.txt', 'initial safe source\n');
  if (ignoreRuntime) {
    writeFile(project, '.gitignore', '/profiles/\n/cache/\n/logs/\n/_probe/\n*.lnk\n');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(directory, 'empty.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
    GCM_INTERACTIVE: 'Never',
  });
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const result = { directory, project, remote, env };
  git(result, ['init', '--quiet', '--initial-branch=main']);
  git(result, ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  configureIdentity(result);
  return result;
}

function run(command, args, { cwd, env, status = 0 }) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  const diagnostic = `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`;
  if (status !== null) assert.equal(result.status, status, diagnostic);
  else assert.notEqual(result.status, null, diagnostic);
  return result;
}

function git(f, args, { cwd = f.project, status = 0 } = {}) {
  return run('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: f.env, status });
}

function gitText(f, args, options) {
  return git(f, args, options).stdout.trim();
}

function configureIdentity(f, cwd = f.project) {
  for (const [key, value] of [
    ['user.name', 'Upload fixture'], ['user.email', 'upload-fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'],
  ]) git(f, ['config', key, value], { cwd });
}

function seedCommit(f, message = 'fixture initial commit') {
  git(f, ['add', '-A']);
  git(f, ['commit', '--quiet', '-m', message]);
  return gitText(f, ['rev-parse', 'HEAD']);
}

function addOrigin(f) {
  git(f, ['remote', 'add', 'origin', f.remote]);
}

function upload(f, args = [], status = 0) {
  return run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(f.project, 'upload-github.ps1'), ...args,
  ], { cwd: f.directory, env: f.env, status });
}

function remoteHead(f) {
  return gitText(f, ['--git-dir', f.remote, 'rev-parse', 'refs/heads/main']);
}

function remoteFiles(f) {
  return gitText(f, ['--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'refs/heads/main']).split('\n');
}

function assertRuntimeExcluded(f) {
  const files = remoteFiles(f);
  assert.ok(files.includes('content.txt'), 'safe source must reach the remote');
  assert.deepEqual(files.filter(name => /^(profiles|cache|logs|_probe)\//i.test(name) || /\.lnk$/i.test(name)), []);
}

function snapshot(f) {
  const gitDirectory = path.join(f.project, '.git');
  const optionalFile = name => {
    const target = path.join(gitDirectory, name);
    return fs.existsSync(target) ? fs.readFileSync(target) : null;
  };
  return {
    head: gitText(f, ['rev-parse', 'HEAD']),
    index: optionalFile('index'),
    indexMtime: fs.statSync(path.join(gitDirectory, 'index')).mtimeMs,
    config: optionalFile('config'),
    fetchHead: optionalFile('FETCH_HEAD'),
    mergeHead: optionalFile('MERGE_HEAD'),
  };
}

test('Windows GitHub upload handles first push, ignored data, repeat execution and remote advancement', windowsOnly, t => {
  const f = fixture(t);
  for (const name of runtimeFiles) writeFile(f.project, name, 'private runtime data\n');
  upload(f, ['-RepositoryUrl', f.remote, '-Message', '首次 上传测试']);
  const initialHead = gitText(f, ['rev-parse', 'HEAD']);
  assert.equal(remoteHead(f), initialHead);
  assert.equal(gitText(f, ['log', '-1', '--format=%B']), '首次 上传测试');
  assert.equal(gitText(f, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']), 'origin/main');
  assertRuntimeExcluded(f);

  upload(f);
  assert.equal(gitText(f, ['rev-parse', 'HEAD']), initialHead, 'no changes must not create an empty commit');
  assert.equal(remoteHead(f), initialHead);

  const collaborator = path.join(f.directory, 'another checkout');
  git(f, ['clone', '--quiet', f.remote, collaborator], { cwd: f.directory });
  configureIdentity(f, collaborator);
  writeFile(collaborator, 'remote.txt', 'remote collaborator change\n');
  git(f, ['add', 'remote.txt'], { cwd: collaborator });
  git(f, ['commit', '--quiet', '-m', 'remote advancement'], { cwd: collaborator });
  git(f, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main'], { cwd: collaborator });
  const advancedHead = remoteHead(f);
  writeFile(f.project, 'local.txt', 'local source change\n');
  upload(f, ['-Message', '本地 修改测试']);
  const mergedHead = gitText(f, ['rev-parse', 'HEAD']);
  assert.equal(remoteHead(f), mergedHead);
  git(f, ['merge-base', '--is-ancestor', initialHead, mergedHead]);
  git(f, ['merge-base', '--is-ancestor', advancedHead, mergedHead]);
  assert.equal(gitText(f, ['rev-list', '--parents', '-n', '1', mergedHead]).split(' ').length, 3);
  assert.equal(fs.readFileSync(path.join(f.project, 'remote.txt'), 'utf8'), 'remote collaborator change\n');
  assert.equal(gitText(f, ['--git-dir', f.remote, 'show', 'main:local.txt']), 'local source change');
  assertRuntimeExcluded(f);
});

test('Windows GitHub upload excludes runtime data even without a gitignore', windowsOnly, t => {
  const f = fixture(t, { ignoreRuntime: false });
  for (const name of runtimeFiles) writeFile(f.project, name, 'private runtime data\n');
  addOrigin(f);
  upload(f);
  assertRuntimeExcluded(f);
  for (const name of runtimeFiles) {
    assert.equal(fs.readFileSync(path.join(f.project, name), 'utf8'), 'private runtime data\n');
  }
});

test('Windows GitHub upload dry run preserves HEAD, index and remote configuration without fetching', windowsOnly, t => {
  const f = fixture(t);
  seedCommit(f);
  // Protocol restrictions prevent a connection even if DryRun accidentally attempts a fetch.
  git(f, ['remote', 'add', 'origin', 'http://github.com/fixture/no-network.git']);
  git(f, ['config', 'remote.origin.pushurl', 'http://github.com/fixture/no-network.git']);
  writeFile(f.project, 'staged.txt', 'already staged\n');
  git(f, ['add', 'staged.txt']);
  writeFile(f.project, 'untracked.txt', 'must stay untracked\n');
  const old = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(path.join(f.project, 'content.txt'), old, old);
  const before = snapshot(f);
  upload(f, ['-DryRun', '-RepositoryUrl', f.remote, '-Message', '预览 不提交']);
  assert.deepEqual(snapshot(f), before);
  assert.equal(gitText(f, ['diff', '--cached', '--name-only']), 'staged.txt');
  assert.equal(gitText(f, ['remote', 'get-url', 'origin']), 'http://github.com/fixture/no-network.git');
  assert.equal(gitText(f, ['remote', 'get-url', '--push', 'origin']), 'http://github.com/fixture/no-network.git');
});

test('Windows GitHub upload refuses an existing merge conflict without staging or fetching', windowsOnly, t => {
  const f = fixture(t);
  seedCommit(f);
  addOrigin(f);
  git(f, ['checkout', '--quiet', '-b', 'incoming']);
  writeFile(f.project, 'content.txt', 'incoming content\n');
  seedCommit(f, 'incoming change');
  git(f, ['checkout', '--quiet', 'main']);
  writeFile(f.project, 'content.txt', 'local content\n');
  seedCommit(f, 'local change');
  git(f, ['merge', '--no-edit', 'incoming'], { status: 1 });
  const before = snapshot(f);
  const conflict = fs.readFileSync(path.join(f.project, 'content.txt'));
  const result = upload(f, [], null);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'content.txt')), conflict);
  assert.notEqual(gitText(f, ['ls-files', '--unmerged']), '');
});

test('Windows GitHub upload refuses already tracked runtime data', windowsOnly, t => {
  const f = fixture(t);
  writeFile(f.project, 'profiles/store/Cookies', 'already tracked private data\n');
  git(f, ['add', '-f', 'profiles/store/Cookies']);
  seedCommit(f);
  addOrigin(f);
  const before = snapshot(f);
  const result = upload(f, [], null);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /浏览器数据.*已被 Git 跟踪/);
  assert.deepEqual(snapshot(f), before);
  assert.equal(gitText(f, ['--git-dir', f.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/main'], { status: 1 }), '');
});

test('Windows GitHub upload refuses remote runtime data before committing and preserves the local profile', windowsOnly, t => {
  const f = fixture(t);
  const initialHead = seedCommit(f);
  addOrigin(f);
  git(f, ['push', '--quiet', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main']);
  const collaborator = path.join(f.directory, 'checkout with tracked runtime');
  git(f, ['clone', '--quiet', f.remote, collaborator], { cwd: f.directory });
  configureIdentity(f, collaborator);
  writeFile(collaborator, 'profiles/store/Cookies', 'remote profile must not replace local data\n');
  git(f, ['add', '--force', 'profiles/store/Cookies'], { cwd: collaborator });
  git(f, ['commit', '--quiet', '-m', 'remote tracked runtime'], { cwd: collaborator });
  git(f, ['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/main'], { cwd: collaborator });
  const advancedHead = remoteHead(f);

  const profile = path.join(f.project, 'profiles', 'store', 'Cookies');
  writeFile(f.project, 'profiles/store/Cookies', 'private local profile remains intact\n');
  writeFile(f.project, 'content.txt', 'pending source must remain uncommitted\n');
  const before = snapshot(f);
  const result = upload(f, [], null);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /远程分支仍包含浏览器数据/);
  assert.equal(gitText(f, ['rev-parse', 'HEAD']), initialHead);
  assert.deepEqual(fs.readFileSync(path.join(f.project, '.git', 'index')), before.index);
  assert.equal(fs.readFileSync(profile, 'utf8'), 'private local profile remains intact\n');
  assert.equal(fs.readFileSync(path.join(f.project, 'content.txt'), 'utf8'), 'pending source must remain uncommitted\n');
  assert.equal(remoteHead(f), advancedHead);
  assert.equal(gitText(f, ['rev-parse', 'refs/remotes/origin/main']), advancedHead);
});

test('Windows GitHub upload returns failure when the remote rejects a push and retains the local commit', windowsOnly, t => {
  const f = fixture(t);
  const initialHead = seedCommit(f);
  addOrigin(f);
  git(f, ['push', '--quiet', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main']);
  const hook = path.join(f.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "fixture rejected push" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  writeFile(f.project, 'content.txt', 'new source pending upload\n');
  const result = upload(f, ['-Message', '保留 失败上传的本地提交'], null);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /fixture rejected push/);
  assert.equal(remoteHead(f), initialHead);
  assert.notEqual(gitText(f, ['rev-parse', 'HEAD']), initialHead);
  assert.equal(gitText(f, ['show', 'HEAD:content.txt']), 'new source pending upload');
  assert.equal(gitText(f, ['diff', '--cached', '--name-only']), '');
});
