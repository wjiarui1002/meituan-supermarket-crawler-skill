import { createHash } from 'node:crypto';

const SHOP_NAME_KEYS = ['poi_name', 'shopName', 'shop_name', 'wmPoiName', 'name', 'title'];
const SHOP_ID_KEYS = ['wm_poi_id', 'wmPoiId', 'shopId', 'shop_id', 'poiId'];
const POI_ID_STR_KEYS = ['poi_id_str', 'poiIdStr'];
const RATING_KEYS = ['wm_poi_score', 'shopRating', 'shop_rating', 'shopStar', 'score', 'rating'];
const MONTHLY_SALES_KEYS = ['month_sales_tip', 'monthlySales', 'monthly_sales', 'monthSalesTip', 'salesTip'];
const PHONE_KEYS = ['phone', 'shopPhone', 'shop_phone', 'poiPhone', 'telephone', 'tel'];
const ADDRESS_KEYS = ['address', 'shopAddress', 'shop_address', 'poiAddress'];
const DELIVERY_FEE_KEYS = ['shipping_fee_tip', 'deliveryFee', 'delivery_fee', 'shippingFeeTip'];
const MIN_ORDER_KEYS = ['min_price_tip', 'minOrderAmount', 'min_order_amount', 'minPriceTip'];
const BUSINESS_HOUR_KEYS = ['business_hours', 'businessHours', 'openingHours', 'openHours', 'delivery_time_tip', 'serTime'];
const NOTICE_KEYS = ['bulletin', 'notice', 'shopNotice', 'shop_notice', 'announcement'];
const URL_KEYS = ['scheme', 'shopUrl', 'shop_url', 'url'];

export function extractShopsFromPayload(payload, context = {}) {
  const shops = [];
  const seen = new Set();

  walkExpanded(payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (!looksLikeShop(value)) return;
    const shop = normalizeShop(value, context);
    const key = fingerprintShop(shop);
    if (seen.has(key)) return;
    seen.add(key);
    shops.push(shop);
  });

  return shops;
}

export function normalizeShop(raw, context = {}) {
  return {
    shop_id: stringify(firstValue(raw, SHOP_ID_KEYS)),
    poi_id_str: stringify(firstValue(raw, POI_ID_STR_KEYS)),
    shop_name: firstString(raw, SHOP_NAME_KEYS) ?? context.shopName ?? null,
    shop_rating: firstNumber(raw, RATING_KEYS),
    monthly_sales: firstString(raw, MONTHLY_SALES_KEYS),
    shop_phone: normalizePhone(firstString(raw, PHONE_KEYS)),
    shop_address: firstString(raw, ADDRESS_KEYS),
    delivery_fee: firstString(raw, DELIVERY_FEE_KEYS),
    min_order_amount: firstString(raw, MIN_ORDER_KEYS),
    business_hours: firstString(raw, BUSINESS_HOUR_KEYS),
    shop_notice: firstString(raw, NOTICE_KEYS),
    shop_url: firstString(raw, URL_KEYS) ?? context.pageUrl ?? null,
    crawled_at: context.capturedAt ?? new Date().toISOString(),
    raw,
  };
}

export function extractShopFromPageSnapshot(snapshot, context = {}) {
  const text = String(snapshot?.text ?? '');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = clean(snapshot?.title);
  const firstLine = lines[0] ?? null;
  const shopName = title || firstLine;
  if (!shopName) return null;

  const raw = {
    title,
    url: snapshot?.url ?? null,
    text,
    poi_id_str: readQueryParam(snapshot?.url, 'poi_id_str'),
    poiIdStr: readQueryParam(snapshot?.url, 'poi_id_str'),
    poi_name: shopName,
    wm_poi_score: findRating(lines, shopName),
    phone: findPhone(lines),
    address: findLine(lines, /地址|门店地址|商家地址/),
    shipping_fee_tip: findLine(lines, /配送费|配送\s*约?¥|预估加配送费/),
    min_price_tip: findLine(lines, /起送/),
    delivery_time_tip: findLine(lines, /营业|配送约|配送\s*\d+\s*分钟/),
    bulletin: findLine(lines, /^公告[:：]/),
    scheme: snapshot?.url ?? null,
  };

  return normalizeShop(raw, { ...context, pageUrl: snapshot?.url });
}

export function fingerprintShop(shop) {
  if (shop.poi_id_str) return `poi:${shop.poi_id_str}`;
  if (shop.shop_id) return `shop:${shop.shop_id}`;
  const basis = [
    shop.shop_name,
    shop.shop_address,
    shop.shop_phone,
    shop.shop_url,
  ].filter(Boolean).join('|');
  return `hash:${createHash('sha256').update(basis).digest('hex')}`;
}

function looksLikeShop(value) {
  const keys = new Set(Object.keys(value));
  const hasShopName = SHOP_NAME_KEYS.some((key) => value[key] != null);
  const hasStrongShopSignal = [
    'poi_name',
    'wm_poi_score',
    'month_sales_tip',
    'min_price_tip',
    'shipping_fee_tip',
    'poi_id_str',
    'shopPhone',
    'shopAddress',
    'businessHours',
  ].some((key) => keys.has(key));
  const hasGenericContactSignal = hasShopName
    && (PHONE_KEYS.some((key) => keys.has(key)) || ADDRESS_KEYS.some((key) => keys.has(key)));
  return hasShopName && (hasStrongShopSignal || hasGenericContactSignal);
}

function walkExpanded(value, visit, seen = new WeakSet()) {
  const expanded = maybeParseJsonString(value);
  if (expanded !== value) {
    walkExpanded(expanded, visit, seen);
    return;
  }

  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) walkExpanded(item, visit, seen);
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const child of Object.values(value)) walkExpanded(child, visit, seen);
  }
}

function maybeParseJsonString(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function firstValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function firstString(obj, keys) {
  const value = firstValue(obj, keys);
  if (value === null) return null;
  if (Array.isArray(value)) {
    const item = value.find((entry) => entry !== null && entry !== undefined && entry !== '');
    if (item === undefined) return null;
    return stringifyString(item);
  }
  return stringifyString(value);
}

function stringifyString(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function firstNumber(obj, keys) {
  const value = firstValue(obj, keys);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (number > 5 && number <= 50) return number / 10;
  return number;
}

function stringify(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function clean(value) {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

function normalizePhone(value) {
  if (!value) return null;
  const phonePattern = /400[-\s]?\d{3}[-\s]?\d{4}|(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}/;
  const match = value.match(phonePattern);
  if (match) return match[0];
  return value.replace(/^电话[:：]\s*/, '').trim() || null;
}

function findRating(lines, shopName) {
  const start = Math.max(lines.indexOf(shopName), 0);
  for (const line of lines.slice(start, start + 6)) {
    if (/^\d(?:\.\d)?$/.test(line)) return Number(line);
  }
  return null;
}

function findPhone(lines) {
  const phonePattern = /400[-\s]?\d{3}[-\s]?\d{4}|(?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}/;
  const explicit = lines.find((item) => /电话|商家电话/.test(item) && phonePattern.test(item));
  if (explicit) return explicit;
  const line = lines.find((item) => phonePattern.test(item));
  return line ?? null;
}

function findLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) ?? null;
}

function readQueryParam(url, key) {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}
