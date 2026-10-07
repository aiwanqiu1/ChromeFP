// 极简 CDP 客户端 + Chrome 启动器
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message}${m.error.code != null ? ' (' + m.error.code + ')' : ''}`));
        else resolve(m.result);
      } else if (m.method) {
        for (const h of this.handlers.get(m.method) || []) {
          try { h(m.params, m.sessionId); } catch { /* 事件处理器不抛出 */ }
        }
      }
    });
    ws.addEventListener('close', (ev) => {
      this.closed = true;
      this.closeCode = ev && ev.code;
      this.closeReason = ev && ev.reason;
      for (const { reject } of this.pending.values()) reject(new Error('CDP 调试连接已断开'));
      this.pending.clear();
      for (const h of this.handlers.get('__closed') || []) { try { h(ev); } catch {} }
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return this;
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error('CDP 调试连接已关闭'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws.close(); } catch {} }

  static async connect(url, timeoutMs = 10000) {
    if (typeof WebSocket !== 'function') throw new Error('需要 Node.js 22 或更新版本（缺少内置 WebSocket）');
    const ws = new WebSocket(url);
    try { await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接 CDP 端点超时: ' + url)), timeoutMs);
      const failed = () => { clearTimeout(t); reject(new Error('连接 CDP 端点失败: ' + url)); };
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', failed, { once: true });
      ws.addEventListener('close', failed, { once: true });
    }); } catch (error) { try { ws.close(); } catch {} throw error; }
    return new CDP(ws);
  }
}

/** 定位 chrome.exe：环境变量 CHROME_PATH 优先，其次常见安装路径 */
export function resolveChromePath(explicit) {
  const requested = explicit || process.env.CHROME_PATH;
  if (requested) {
    if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) throw new Error('指定的 Chrome 程序不存在或不是文件');
    return path.resolve(requested);
  }
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  throw new Error('找不到 chrome.exe，请用 --chrome <路径> 或设置 CHROME_PATH 环境变量');
}

/**
 * 启动 Chrome 并等待调试端点就绪。
 * 用 --remote-debugging-port=0 让 Chrome 自己挑端口，再从 profile 目录的
 * DevToolsActivePort 文件读回来，避免端口冲突。
 */
export async function launchChrome({ exe, args = [], userDataDir, timeoutMs = 30000, signal }) {
  signal?.throwIfAborted();
  // 在改动 profile 文件前验证程序和独占状态。
  if (!exe || !fs.statSync(exe).isFile()) throw new Error('Chrome 程序不存在或不是文件');
  fs.mkdirSync(userDataDir, { recursive: true });
  const release = acquireProfile(userDataDir);
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let proc;
  try {
    fs.rmSync(portFile, { force: true });
    const full = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${path.resolve(userDataDir)}`, ...args];
    if (!args.includes('about:blank')) full.push('about:blank');
    proc = spawn(exe, full, { stdio: 'ignore', windowsHide: true });
    let spawnError;
    proc.once('error', error => { spawnError = error; release(); });
    proc.once('exit', release);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (proc.exitCode != null) throw new Error(`Chrome 启动后立刻退出（exit ${proc.exitCode}）`);
      try {
        if (fs.existsSync(portFile)) {
          const txt = fs.readFileSync(portFile, 'utf8').split(/\r?\n/).filter(Boolean);
          const port = Number(txt[0]);
          if (txt.length >= 2 && Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\//.test(txt[1])) {
            return { proc, port, wsUrl: `ws://127.0.0.1:${port}${txt[1]}`, userDataDir };
          }
        }
      } catch { /* 文件可能正在写，重试 */ }
      await sleep(50);
    }
    throw new Error('等待 Chrome 调试端口超时');
  } catch (error) {
    killChrome(proc);
    release();
    throw error;
  }
}

export function killChrome(proc) {
  if (!proc?.pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      return;
    } catch {}
  }
  try { proc.kill(); } catch {}
}

const lockPath = directory => path.join(directory, '.fp-launcher.lock');
const sessionLockPath = directory => path.join(directory, '.fp-session.lock');
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function launcherInUse(directory) {
  try { return alive(JSON.parse(fs.readFileSync(lockPath(directory), 'utf8')).pid); }
  catch {
    // 另一个启动器可能刚取得独占锁、还没来得及写 PID。
    try { return Date.now() - fs.statSync(lockPath(directory)).mtimeMs < 30000; } catch { return false; }
  }
}

function sessionInUse(directory, allowOwn = false) {
  const file = sessionLockPath(directory);
  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Session owner not written yet');
    return alive(pid) && (!allowOwn || pid !== process.pid);
  } catch {
    // An atomic creator may still be writing its owner. Never reclaim that marker.
    try { return Date.now() - fs.statSync(file).mtimeMs < 30000; } catch { return false; }
  }
}

/** Hold one launcher session across browser exits and language-selection relaunches. */
export function acquireProfileSession(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  if (profileInUse(userDataDir)) throw new Error('Chrome profile 已被占用，请关闭原窗口或换一个 --profile 名字');
  const file = sessionLockPath(userDataDir);
  const token = crypto.randomUUID();
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = fs.openSync(file, 'wx'); break; }
    catch (error) {
      // Acquisition itself must reject another session in this process too.
      if (error.code !== 'EEXIST' || sessionInUse(userDataDir)) throw new Error('Chrome profile 已被占用');
      fs.rmSync(file, { force: true });
    }
  }
  if (descriptor === undefined) throw new Error('无法取得 Chrome profile 会话独占锁');
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); }
  finally { fs.closeSync(descriptor); }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true }); } catch {}
  };
}

/** Windows 没有 Unix 的 SingletonLock，需检查实际 Chrome 进程。 */
export function profileInUse(userDataDir) {
  // Only the outer session marker is reentrant for its owner. Its live Chrome
  // and legacy launch marker still prevent two browser instances sharing data.
  if (sessionInUse(userDataDir, true) || launcherInUse(userDataDir)) return true;
  if (process.platform === 'win32') {
    const normalize = value => {
      try { return fs.realpathSync(value).toLowerCase(); } catch { return path.resolve(value).toLowerCase(); }
    };
    let processes;
    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object CommandLine) | ConvertTo-Json -Compress"],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      processes = JSON.parse(output.trim() || '[]');
    } catch { throw new Error('无法确认 Chrome profile 占用状态，请稍后重试'); }
    const target = normalize(userDataDir);
    for (const entry of Array.isArray(processes) ? processes : [processes]) {
      const command = entry?.CommandLine || '';
      const match = command.match(/(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)|--user-data-dir\s+"([^"]+)"|--user-data-dir\s+([^\s"]+))/i);
      const directory = match?.slice(1).find(Boolean);
      if (directory && normalize(directory) === target) return true;
    }
    return false;
  }
  for (const f of ['SingletonLock', 'lockfile', 'SingletonCookie']) {
    try { if (fs.existsSync(path.join(userDataDir, f))) return true; } catch {}
  }
  return false;
}

function acquireProfile(directory) {
  if (profileInUse(directory)) throw new Error('Chrome profile 已被占用，请关闭原窗口或换一个 --profile 名字');
  const file = lockPath(directory);
  const token = crypto.randomUUID();
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { descriptor = fs.openSync(file, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || launcherInUse(directory)) throw new Error('Chrome profile 已被占用');
      fs.rmSync(file, { force: true });
    }
  }
  if (descriptor === undefined) throw new Error('无法取得 Chrome profile 独占锁');
  try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); }
  finally { fs.closeSync(descriptor); }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true }); } catch {}
  };
}
