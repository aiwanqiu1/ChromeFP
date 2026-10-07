import fs from 'node:fs';
import { parseArgs } from './options.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;

/** Project defaults apply to both the shortcut and CLI, after explicit arguments. */
export function parseLauncherArgs(argv, configFile) {
  const options = parseArgs(argv);
  if (options.help || options.list || options.proxy !== null || options.direct) return options;

  let bytes;
  try {
    if (fs.statSync(configFile).size > MAX_CONFIG_BYTES) {
      throw new Error('配置文件不能超过 16 KB');
    }
    bytes = fs.readFileSync(configFile);
  } catch (error) {
    if (error.code === 'ENOENT') return options;
    throw new Error('无法读取 launcher-config.json：' + error.message);
  }
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error('launcher-config.json 不能超过 16 KB');

  let config;
  try {
    config = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('launcher-config.json 必须是有效的 JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => key !== 'proxy')) {
    throw new Error('launcher-config.json 必须是只包含 proxy 配置的 JSON 对象');
  }
  if (!Object.hasOwn(config, 'proxy') || config.proxy === null) return options;
  if (typeof config.proxy !== 'string') {
    throw new Error('launcher-config.json 的 proxy 必须是代理网址字符串或 null');
  }
  try {
    options.proxy = parseArgs(['--proxy', config.proxy]).proxy;
  } catch (error) {
    throw new Error('launcher-config.json 的 proxy 无效：' + error.message);
  }
  return options;
}
