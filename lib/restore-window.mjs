// 仅借用已验证 ChromeFP 会话的本地端点恢复窗口；不创建驱动或接管 profile。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP } from './cdp.mjs';

function profileEndpoint(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir || !path.isAbsolute(userDataDir)) {
    throw new Error('浏览器数据目录无效');
  }
  try {
    const file = path.join(userDataDir, 'DevToolsActivePort');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 2048) throw new Error();
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^([1-9]\d{0,4})\r?\n(\/devtools\/browser\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\r?\n?$/i);
    if (!match || Number(match[1]) > 65535) throw new Error();
    // 文件只提供端口和随机 browser ID，主机强制固定为本机回环地址。
    return `ws://127.0.0.1:${match[1]}${match[2]}`;
  } catch {
    throw new Error('现有浏览器的本地调试端点无效或不存在');
  }
}

/** 调用方先验证启动器锁和 Chrome 进程归属；本函数只打开一个空白窗口。 */
export async function restoreProfileWindow(userDataDir, { timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    throw new Error('窗口恢复超时参数无效');
  }
  const endpoint = profileEndpoint(userDataDir);
  let cdp;
  try {
    try { cdp = await CDP.connect(endpoint, timeoutMs); }
    catch { throw new Error('无法连接现有浏览器的本地调试端点'); }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true }, undefined, timeoutMs);
    if (typeof targetId !== 'string' || !targetId) throw new Error('现有浏览器未返回新窗口');
    await cdp.send('Target.activateTarget', { targetId }, undefined, timeoutMs);
    return { targetId };
  } finally {
    // 只断开临时客户端；原启动器及其自动附加驱动继续覆盖新窗口。
    cdp?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('窗口恢复需要一个浏览器数据目录');
    process.exitCode = 1;
  } else {
    try {
      await restoreProfileWindow(process.argv[2]);
      console.log('已恢复 ChromeFP 浏览器窗口');
    } catch {
      // 不把端点、现有标签页 URL 或 profile 内容写进日志。
      console.error('无法恢复 ChromeFP 浏览器窗口，请关闭原会话后重试');
      process.exitCode = 1;
    }
  }
}
