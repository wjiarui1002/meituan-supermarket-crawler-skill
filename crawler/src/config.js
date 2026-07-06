export const CDP_ENDPOINT = 'http://127.0.0.1:9222';
export const CDP_PORT = '9222';
export const HOME_URL = 'https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page&utm_source=60030&channel=mtib';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
export const WINDOW_SIZE = '390,844';
export const WINDOW_POSITION = '160,100';
export const OUTPUT_DIR = '美团评论采集结果';
export const PROFILE_DIR = 'chrome-profile';

const MEITUAN_TARGET_RE = /h5\.waimai\.meituan\.com|i\.waimai\.meituan\.com|verify\.meituan\.com|passport\.meituan\.com|meituan\.com/;

export function isMeituanTargetUrl(url) {
  return MEITUAN_TARGET_RE.test(String(url || ''));
}

export function selectPreferredPage(pages, pageIndex = 0) {
  const preferred = pages.find((page) => isMeituanTargetUrl(readPageUrl(page)));
  return preferred ?? pages[pageIndex] ?? pages[0] ?? null;
}

function readPageUrl(page) {
  if (!page) return '';
  if (typeof page.url === 'function') return page.url();
  return page.url || '';
}
