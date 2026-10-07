// 国家/地区 -> 浏览器语言与时区推导
// 时区不靠猜：优先用 IP 归属地接口返回的 IANA 时区；这里只做语言兜底映射。

/** countryCode -> [主 locale, Accept-Language 串(不带 q 值), 备用语言列表] */
export const COUNTRY_LOCALE = {
  CN: ['zh-CN', 'zh-CN,zh,en-US,en', ['zh-CN', 'zh', 'en-US', 'en']],
  HK: ['zh-HK', 'zh-HK,zh,en-US,en', ['zh-HK', 'zh', 'en-US', 'en']],
  MO: ['zh-MO', 'zh-MO,zh,en-US,en', ['zh-MO', 'zh', 'en-US', 'en']],
  TW: ['zh-TW', 'zh-TW,zh,en-US,en', ['zh-TW', 'zh', 'en-US', 'en']],
  SG: ['en-SG', 'en-SG,en-US,en,zh-CN,zh', ['en-SG', 'en-US', 'en', 'zh-CN', 'zh']],
  MY: ['ms-MY', 'ms-MY,ms,en-US,en', ['ms-MY', 'ms', 'en-US', 'en']],
  JP: ['ja-JP', 'ja-JP,ja,en-US,en', ['ja-JP', 'ja', 'en-US', 'en']],
  KR: ['ko-KR', 'ko-KR,ko,en-US,en', ['ko-KR', 'ko', 'en-US', 'en']],
  IN: ['en-IN', 'en-IN,en,hi', ['en-IN', 'en', 'hi']],
  ID: ['id-ID', 'id-ID,id,en-US,en', ['id-ID', 'id', 'en-US', 'en']],
  TH: ['th-TH', 'th-TH,th,en-US,en', ['th-TH', 'th', 'en-US', 'en']],
  VN: ['vi-VN', 'vi-VN,vi,en-US,en', ['vi-VN', 'vi', 'en-US', 'en']],
  PH: ['en-PH', 'en-PH,en,fil', ['en-PH', 'en', 'fil']],
  US: ['en-US', 'en-US,en', ['en-US', 'en']],
  CA: ['en-CA', 'en-CA,en-US,en,fr-CA,fr', ['en-CA', 'en-US', 'en', 'fr-CA', 'fr']],
  GB: ['en-GB', 'en-GB,en-US,en', ['en-GB', 'en-US', 'en']],
  AU: ['en-AU', 'en-AU,en-US,en', ['en-AU', 'en-US', 'en']],
  NZ: ['en-NZ', 'en-NZ,en-US,en', ['en-NZ', 'en-US', 'en']],
  IE: ['en-IE', 'en-IE,en-US,en', ['en-IE', 'en-US', 'en']],
  DE: ['de-DE', 'de-DE,de,en-US,en', ['de-DE', 'de', 'en-US', 'en']],
  AT: ['de-AT', 'de-AT,de,en-US,en', ['de-AT', 'de', 'en-US', 'en']],
  CH: ['de-CH', 'de-CH,de,fr-CH,fr,en-US,en', ['de-CH', 'de', 'fr-CH', 'fr', 'en-US', 'en']],
  FR: ['fr-FR', 'fr-FR,fr,en-US,en', ['fr-FR', 'fr', 'en-US', 'en']],
  BE: ['nl-BE', 'nl-BE,nl,fr-BE,fr,en-US,en', ['nl-BE', 'nl', 'fr-BE', 'fr', 'en-US', 'en']],
  NL: ['nl-NL', 'nl-NL,nl,en-US,en', ['nl-NL', 'nl', 'en-US', 'en']],
  ES: ['es-ES', 'es-ES,es,en-US,en', ['es-ES', 'es', 'en-US', 'en']],
  IT: ['it-IT', 'it-IT,it,en-US,en', ['it-IT', 'it', 'en-US', 'en']],
  PT: ['pt-PT', 'pt-PT,pt,en-US,en', ['pt-PT', 'pt', 'en-US', 'en']],
  BR: ['pt-BR', 'pt-BR,pt,en-US,en', ['pt-BR', 'pt', 'en-US', 'en']],
  MX: ['es-MX', 'es-MX,es,en-US,en', ['es-MX', 'es', 'en-US', 'en']],
  AR: ['es-AR', 'es-AR,es,en-US,en', ['es-AR', 'es', 'en-US', 'en']],
  CL: ['es-CL', 'es-CL,es,en-US,en', ['es-CL', 'es', 'en-US', 'en']],
  RU: ['ru-RU', 'ru-RU,ru,en-US,en', ['ru-RU', 'ru', 'en-US', 'en']],
  UA: ['uk-UA', 'uk-UA,uk,ru,en-US,en', ['uk-UA', 'uk', 'ru', 'en-US', 'en']],
  PL: ['pl-PL', 'pl-PL,pl,en-US,en', ['pl-PL', 'pl', 'en-US', 'en']],
  CZ: ['cs-CZ', 'cs-CZ,cs,en-US,en', ['cs-CZ', 'cs', 'en-US', 'en']],
  SE: ['sv-SE', 'sv-SE,sv,en-US,en', ['sv-SE', 'sv', 'en-US', 'en']],
  NO: ['nb-NO', 'nb-NO,nb,en-US,en', ['nb-NO', 'nb', 'en-US', 'en']],
  DK: ['da-DK', 'da-DK,da,en-US,en', ['da-DK', 'da', 'en-US', 'en']],
  FI: ['fi-FI', 'fi-FI,fi,en-US,en', ['fi-FI', 'fi', 'en-US', 'en']],
  TR: ['tr-TR', 'tr-TR,tr,en-US,en', ['tr-TR', 'tr', 'en-US', 'en']],
  IL: ['he-IL', 'he-IL,he,en-US,en', ['he-IL', 'he', 'en-US', 'en']],
  AE: ['ar-AE', 'ar-AE,ar,en-US,en', ['ar-AE', 'ar', 'en-US', 'en']],
  SA: ['ar-SA', 'ar-SA,ar,en-US,en', ['ar-SA', 'ar', 'en-US', 'en']],
  EG: ['ar-EG', 'ar-EG,ar,en-US,en', ['ar-EG', 'ar', 'en-US', 'en']],
  ZA: ['en-ZA', 'en-ZA,en-US,en', ['en-ZA', 'en-US', 'en']],
  NG: ['en-NG', 'en-NG,en-US,en', ['en-NG', 'en-US', 'en']],
};

// ISO 3166-1 regions, plus Kosovo. Intl maximization supplies likely languages,
// but is not a country-code validator (for example, und-ZZ becomes en-US).
const COUNTRIES = new Set(`
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
  BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
  CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
  DE DJ DK DM DO DZ
  EC EE EG EH ER ES ET
  FI FJ FK FM FO FR
  GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
  HK HM HN HR HT HU
  ID IE IL IM IN IO IQ IR IS IT
  JE JM JO JP
  KE KG KH KI KM KN KP KR KW KY KZ
  LA LB LC LI LK LR LS LT LU LV LY
  MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
  NA NC NE NF NG NI NL NO NP NR NU NZ
  OM
  PA PE PF PG PH PK PL PM PN PR PS PT PW PY
  QA
  RE RO RS RU RW
  SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
  TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
  UA UG UM US UY UZ
  VA VC VE VG VI VN VU
  WF WS XK
  YE YT
  ZA ZM ZW
`.trim().split(/\s+/));

// These likely languages lack Intl formatting data in Chrome/Node. Choose a
// supported language used locally, retaining the actual region in the locale.
// CLDR territory-language data: common/supplemental/supplementalData.xml.
const SUPPORTED_LOCAL_LANGUAGE = {
  AS: 'en', BQ: 'nl', CW: 'nl', HT: 'fr', MV: 'en', PG: 'en',
  PW: 'en', PY: 'es', TK: 'en', TV: 'en', VU: 'en', WS: 'en',
};

/** 由 countryCode 推导 locale / Accept-Language / languages 列表 */
export function deriveLocale(countryCode) {
  const cc = typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
  if (!COUNTRIES.has(cc)) throw new Error('IP 归属地的国家 / 地区代码无效，无法匹配当地语言');
  const hit = COUNTRY_LOCALE[cc];
  if (hit) return { locale: hit[0], acceptLanguage: hit[1], languages: [...hit[2]], known: true };
  // ECMA-402 uses CLDR likely subtags to derive the usual language of a region.
  const language = SUPPORTED_LOCAL_LANGUAGE[cc] || new Intl.Locale('und-' + cc).maximize().language;
  const locale = language + '-' + cc;
  if (!Intl.DateTimeFormat.supportedLocalesOf(locale).length || !Intl.NumberFormat.supportedLocalesOf(locale).length) {
    throw new Error('当前浏览器语言数据不支持 IP 地区的语言：' + locale);
  }
  const languages = [...new Set([locale, language, 'en'])];
  return { locale, acceptLanguage: languages.join(','), languages, known: true };
}

/**
 * 由系统时区 ID 反查是否与目标时区一致，用于给出"是否真的不一致"的诊断。
 * 只做字符串比较，不做偏移量换算——偏移量受夏令时影响，比较没有意义。
 */
export function sameTimezone(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
