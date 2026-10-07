import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveLocale } from '../lib/config.mjs';

for (const [countryCode, expected] of [['HU', 'hu-HU'], ['GR', 'el-GR'], ['RO', 'ro-RO']]) {
  test('IP country ' + countryCode + ' selects its local language instead of US English', () => {
    const result = deriveLocale(countryCode);
    assert.equal(result.locale, expected);
    assert.equal(result.languages[0], expected);
    assert.equal(result.acceptLanguage.split(',')[0], expected);
    assert.equal(result.known, true);
  });
}

test('existing multilingual country preferences remain explicit when language coverage expands', () => {
  for (const [countryCode, primary, alternate] of [
    ['CA', 'en-CA', 'fr-CA'], ['CH', 'de-CH', 'fr-CH'],
    ['IN', 'en-IN', 'hi'], ['SG', 'en-SG', 'zh-CN'],
  ]) {
    const result = deriveLocale(countryCode);
    assert.equal(result.locale, primary);
    assert.equal(result.languages[0], primary);
    assert.ok(result.languages.includes(alternate));
  }
});

test('invalid or unknown country codes cannot silently become an American identity', () => {
  for (const invalid of ['ZZ', 'XX', 'EU', 'UN', 'XA', '419', '', null, undefined]) {
    assert.throws(() => deriveLocale(invalid), String(invalid));
  }
});

// Unicode CLDR regular region validity, excluding eight non-ISO extensions.
// Source: https://raw.githubusercontent.com/unicode-org/cldr/main/common/validity/region.xml
// Compact ranges keep the fixture independent of runtime Intl validity guesses.
const regularRegions = `
  AC~G AI AL~M AO AQ~U AW~X AZ
  BA~B BD~J BL~O BQ~T BV~W BY~Z
  CA CC~D CF~I CK~R CU~Z
  DE DG DJ~K DM DO DZ
  EA EC EE EG~H ER~T
  FI~K FM FO FR
  GA~B GD~I GL~N GP~U GW GY
  HK HM~N HR HT~U
  IC~E IL~O IQ~T
  JE JM JO~P
  KE KG~I KM~N KP KR KW KY~Z
  LA~C LI LK LR~V LY
  MA MC~H MK~Z
  NA NC NE~G NI NL NO~P NR NU NZ
  OM
  PA PE~H PK~N PR~T PW PY
  QA
  RE RO RS RU RW
  SA~E SG~O SR~T SV SX~Z
  TA TC~D TF~H TJ~O TR TT TV~W TZ
  UA UG UM US UY~Z
  VA VC VE VG VI VN VU
  WF WS
  XK
  YE YT
  ZA ZM ZW
`.trim().split(/\s+/).flatMap(token => {
  const [first, last] = token.split('~');
  if (!last) return [first];
  return Array.from({ length: last.charCodeAt(0) - first.charCodeAt(1) + 1 },
    (_, offset) => first[0] + String.fromCharCode(first.charCodeAt(1) + offset));
});
const nonISO = new Set(['AC', 'CP', 'CQ', 'DG', 'EA', 'IC', 'TA', 'XK']);
const isoCountries = regularRegions.filter(code => !nonISO.has(code));

test('all 249 ISO country codes produce a language tagged with the observed IP country', () => {
  assert.equal(isoCountries.length, 249, 'fixture covers all ISO alpha-2 countries and territories');
  assert.equal(new Set(isoCountries).size, 249);
  for (const countryCode of isoCountries) {
    const result = deriveLocale(countryCode);
    assert.equal(new Intl.Locale(result.locale).region, countryCode, countryCode + ' must not become another country');
    assert.equal(result.known, true, countryCode + ' is an actual country or territory');
    assert.equal(result.languages[0], result.locale);
    assert.equal(result.acceptLanguage.split(',')[0], result.locale);
  }
});

test('generated country languages have Intl formatting data instead of using the host language', () => {
  for (const countryCode of isoCountries) {
    const result = deriveLocale(countryCode);
    assert.equal(Intl.DateTimeFormat.supportedLocalesOf(result.locale).length, 1,
      countryCode + ': ' + result.locale + ' would silently format dates in the host language');
    assert.equal(Intl.NumberFormat.supportedLocalesOf(result.locale).length, 1,
      countryCode + ': ' + result.locale + ' would silently format numbers in the host language');
  }
});
