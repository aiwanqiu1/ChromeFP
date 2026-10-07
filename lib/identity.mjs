import fs from 'node:fs';

const REQUIRED_METADATA = ['brands', 'fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'mobile', 'bitness', 'wow64', 'formFactors'];
const METADATA_FIELDS = new Set([...REQUIRED_METADATA, 'fullVersion']);
const IDENTITY_FIELDS = new Set(['userAgent', 'platform', 'userAgentMetadata']);
const REAL_BRANDS = ['Chromium', 'Google Chrome'];
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw new Error('--identity ' + message); };
const cleanString = (value, label, allowEmpty = false, maximum = 1024) => {
  if (typeof value !== 'string' || (!allowEmpty && !value) || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail(label + ' 必须是有效字符串');
};
const sampleVersion = (value, major, version) => value.replaceAll('{major}', major).replaceAll('{version}', version);
const host = (platform, architecture) => {
  const platforms = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const architectures = { x64: ['x86', '64'], ia32: ['x86', '32'], arm64: ['arm', '64'], arm: ['arm', '32'] };
  if (!platforms[platform] || !architectures[architecture]) fail('当前系统或 CPU 架构暂不支持身份覆盖');
  return { platform: platforms[platform], architecture: architectures[architecture][0], bitness: architectures[architecture][1] };
};

export function validateIdentity(identity, hostPlatform = process.platform, hostArchitecture = process.arch) {
  if (!plainObject(identity) || Object.keys(identity).some(key => !IDENTITY_FIELDS.has(key)) ||
      !['userAgent', 'platform', 'userAgentMetadata'].every(key => Object.hasOwn(identity, key))) fail('必须包含 userAgent、platform、userAgentMetadata，不能使用其他字段');
  cleanString(identity.userAgent, 'userAgent', false, 2048);
  cleanString(identity.platform, 'platform', false, 128);
  const inputBrands = Array.isArray(identity.userAgentMetadata?.brands) ? identity.userAgentMetadata.brands : [];
  const inputFullVersions = Array.isArray(identity.userAgentMetadata?.fullVersionList) ? identity.userAgentMetadata.fullVersionList : [];
  const brandVersion = inputBrands.find(row => row?.brand === 'Chromium')?.version;
  const literalFull = inputFullVersions.find(row => row?.brand === 'Chromium')?.version;
  const literalMajor = identity.userAgent.match(/\b(?:Headless)?Chrome\/(\d+)/)?.[1] || (typeof brandVersion === 'string' ? brandVersion.match(/^\d+$/)?.[0] : null) || (typeof literalFull === 'string' ? literalFull.match(/^(\d+)\./)?.[1] : null) || '1';
  const sampleFull = typeof literalFull === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(literalFull) ? literalFull : literalMajor + '.0.1.0';
  const sample = value => sampleVersion(value, literalMajor, sampleFull);
  if (/[{}]/.test(sample(identity.userAgent))) fail('仅支持 {version} 和 {major} 版本占位符');
  const ua = /^Mozilla\/5\.0 \(([^()]+)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) (?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+) Safari\/537\.36$/.exec(sample(identity.userAgent));
  if (!ua) fail('仅支持包含完整 Mozilla、AppleWebKit、Chrome 和 Safari 结构的同系统桌面 Chrome UA');
  const metadata = identity.userAgentMetadata;
  if (!plainObject(metadata) || Object.keys(metadata).some(key => !METADATA_FIELDS.has(key)) ||
      !REQUIRED_METADATA.every(key => Object.hasOwn(metadata, key))) fail('userAgentMetadata 必须提供完整的 Client Hints 字段');
  for (const key of ['platform', 'platformVersion', 'architecture', 'model', 'bitness']) cleanString(metadata[key], 'userAgentMetadata.' + key, ['model', 'platformVersion'].includes(key), 128);
  if (metadata.mobile !== false || metadata.model !== '' || metadata.wow64 !== false ||
      !Array.isArray(metadata.formFactors) || metadata.formFactors.length !== 1 || metadata.formFactors[0] !== 'Desktop') fail('仅支持 mobile=false、model=""、wow64=false、formFactors=["Desktop"] 的原生桌面身份');
  const native = host(hostPlatform, hostArchitecture);
  if (metadata.platform !== native.platform || metadata.architecture !== native.architecture || metadata.bitness !== native.bitness) fail('平台、架构和位数必须与本机一致');
  if (metadata.platformVersion && !/^\d+\.\d+\.\d+$/.test(metadata.platformVersion)) fail('platformVersion 必须是三段数字版本或空字符串');
  // 缩减 UA 的架构标记不等于真实架构：macOS ARM 仍使用 Intel，架构由 CH 单独校验。
  const platformMatches = hostPlatform === 'win32'
    ? ua[1] === 'Windows NT 10.0; Win64; x64' && identity.platform === 'Win32'
    : hostPlatform === 'darwin'
      ? /^Macintosh; Intel Mac OS X \d+_\d+(?:_\d+)?$/.test(ua[1]) && identity.platform === 'MacIntel'
      : /^X11; Linux (?:x86_64|i686|aarch64|armv7l)$/.test(ua[1]) && identity.platform === (hostArchitecture === 'arm64' ? 'Linux aarch64' : hostArchitecture === 'arm' ? 'Linux armv7l' : hostArchitecture === 'ia32' ? 'Linux i686' : 'Linux x86_64');
  if (!platformMatches) fail('userAgent、navigator.platform 和 Client Hints 平台不一致');
  for (const key of ['brands', 'fullVersionList']) {
    const rows = metadata[key];
    if (!Array.isArray(rows) || rows.length !== 3) fail(key + ' 必须包含 Chromium、Google Chrome 和一个 GREASE 品牌');
    const names = new Set();
    for (const row of rows) {
      if (!plainObject(row) || Object.keys(row).length !== 2 || !Object.hasOwn(row, 'brand') || !Object.hasOwn(row, 'version')) fail(key + ' 的每项必须仅包含 brand 和 version');
      cleanString(row.brand, key + '.brand', false, 128); cleanString(row.version, key + '.version', false, 128);
      if (names.has(row.brand)) fail(key + ' 不能重复品牌'); names.add(row.brand);
      const version = sample(row.version);
      if (!(key === 'brands' ? /^\d+$/.test(version) : /^\d+\.\d+\.\d+\.\d+$/.test(version))) fail(key + ' 的版本格式无效');
    }
    if (!REAL_BRANDS.every(brand => names.has(brand))) fail(key + ' 缺少真实 Chrome 品牌');
    const grease = [...names].find(name => !REAL_BRANDS.includes(name));
    if (!/[\s_();=?./:-]/.test(grease) || /Microsoft Edge|Firefox|Safari|Opera|Brave/i.test(grease)) fail(key + ' 的第三项必须是 GREASE 品牌');
  }
  const names = metadata.brands.map(row => row.brand).sort();
  if (names.join('\n') !== metadata.fullVersionList.map(row => row.brand).sort().join('\n')) fail('brands 与 fullVersionList 的品牌集合必须一致');
  for (const row of metadata.brands) {
    const full = metadata.fullVersionList.find(other => other.brand === row.brand);
    if (sample(row.version) !== sample(full.version).split('.')[0]) fail('brands 与 fullVersionList 的同一品牌主版本必须一致');
  }
  if (Object.hasOwn(metadata, 'fullVersion')) {
    cleanString(metadata.fullVersion, 'fullVersion', false, 128);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(sample(metadata.fullVersion))) fail('fullVersion 版本格式无效');
  }
  const uaVersion = ua[2];
  for (const brand of REAL_BRANDS) {
    if (sample(metadata.brands.find(row => row.brand === brand).version) !== uaVersion.split('.')[0]) fail('UA 与 Client Hints 主版本不一致');
  }
  return identity;
}

export function loadIdentity(file, hostPlatform = process.platform, hostArchitecture = process.arch) {
  let parsed;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 65536) fail('文件必须是小于 64 KB 的 JSON 文件');
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.message.startsWith('--identity ')) throw error;
    fail('文件无法读取或 JSON 格式无效');
  }
  return validateIdentity(parsed, hostPlatform, hostArchitecture);
}

export function resolveIdentity(identity, browserVersion, hostPlatform = process.platform, hostArchitecture = process.arch) {
  if (!identity) return null;
  validateIdentity(identity, hostPlatform, hostArchitecture);
  const product = typeof browserVersion === 'string' ? browserVersion : browserVersion?.product;
  const actual = product?.match(/(?:Chrome|Chromium)\/(\d+\.\d+\.\d+\.\d+)/)?.[1];
  if (!actual) fail('无法确认实际 Chrome 完整版本');
  const major = actual.split('.')[0];
  const replace = value => typeof value === 'string' ? value.replaceAll('{version}', actual).replaceAll('{major}', major)
    : Array.isArray(value) ? value.map(replace) : plainObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value;
  const resolved = replace(identity);
  validateIdentity(resolved, hostPlatform, hostArchitecture);
  const uaVersion = resolved.userAgent.match(/\b(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)\b/)[1];
  if (uaVersion !== actual && uaVersion !== major + '.0.0.0') fail('UA 必须使用实际 Chrome 版本或对应的缩减版本');
  for (const brand of REAL_BRANDS) {
    if (resolved.userAgentMetadata.brands.find(row => row.brand === brand).version !== major ||
        resolved.userAgentMetadata.fullVersionList.find(row => row.brand === brand).version !== actual) fail('Client Hints 必须使用实际 Chrome 完整版本');
  }
  if (resolved.userAgentMetadata.fullVersion && resolved.userAgentMetadata.fullVersion !== actual) fail('fullVersion 与实际 Chrome 版本不一致');
  return resolved;
}
