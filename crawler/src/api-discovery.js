const COMMENT_WORDS = ['comment', 'review', '评价', '评论', 'remark', 'rate'];
const NOISE_WORDS = ['order', 'payment', 'pay', 'cart', 'login'];
const PAGE_KEYS = ['page', 'pageNo', 'pageNum', 'offset', 'start', 'cursor', 'limit', 'shopId', 'poiId', 'wmPoiId', 'productId', 'spuId'];

export function isLikelyCommentUrl(url) {
  const lower = decodeURIComponent(url).toLowerCase();
  return COMMENT_WORDS.some((word) => lower.includes(word.toLowerCase()))
    && !NOISE_WORDS.some((word) => lower.includes(word));
}

export function makePageKey(url) {
  const parsed = new URL(url);
  const params = [];
  for (const key of PAGE_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value !== null) params.push(`${key}=${value}`);
  }
  return `${parsed.pathname}${params.length ? `?${params.join('&')}` : ''}`;
}

export function summarizePayload(payload) {
  const summary = {
    arrayCount: 0,
    total: null,
    hasMore: null,
    page: null,
    cursor: null,
  };
  walk(payload, (key, value) => {
    if (Array.isArray(value)) summary.arrayCount += value.length;
    if (['total', 'totalCount', 'count'].includes(key) && Number.isFinite(Number(value))) summary.total = Number(value);
    if (['hasMore', 'hasNext', 'more'].includes(key) && typeof value === 'boolean') summary.hasMore = value;
    if (['page', 'pageNo', 'pageNum'].includes(key) && Number.isFinite(Number(value))) summary.page = Number(value);
    if (['cursor', 'nextCursor', 'next'].includes(key) && value) summary.cursor = String(value);
  });
  return summary;
}

export function shouldParseResponse(response) {
  const request = response.request();
  const resourceType = request.resourceType();
  if (!['xhr', 'fetch'].includes(resourceType)) return false;
  const url = response.url();
  if (isLikelyCommentUrl(url)) return true;
  const contentType = response.headers()['content-type'] ?? '';
  return contentType.includes('application/json');
}

function walk(value, visit, key = '') {
  visit(key, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, String(index)));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      walk(child, visit, childKey);
    }
  }
}
