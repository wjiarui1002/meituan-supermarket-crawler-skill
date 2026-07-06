import test from 'node:test';
import assert from 'node:assert/strict';

import { HOME_URL, isMeituanTargetUrl, selectPreferredPage } from '../src/config.js';

test('HOME_URL uses Meituan Waimai H5 entry', () => {
  assert.equal(HOME_URL, 'https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page&utm_source=60030&channel=mtib');
});

test('isMeituanTargetUrl prefers waimai and verification pages', () => {
  assert.equal(isMeituanTargetUrl('https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page'), true);
  assert.equal(isMeituanTargetUrl('https://i.waimai.meituan.com/tsp/open/openh5/home/shopList'), true);
  assert.equal(isMeituanTargetUrl('https://verify.meituan.com/'), true);
  assert.equal(isMeituanTargetUrl('https://example.com/'), false);
});

test('selectPreferredPage chooses Meituan page before first page fallback', () => {
  const page = selectPreferredPage([
    { url: () => 'about:blank' },
    { url: () => 'https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page' },
  ]);

  assert.equal(page.url(), 'https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page');
});
