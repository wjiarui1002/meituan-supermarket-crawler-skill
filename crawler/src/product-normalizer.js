import { createHash } from 'node:crypto';

export function extractMenuFromPayload(payload, context = {}) {
  const menus = [];
  const seenMenus = new WeakSet();

  walkExpanded(payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (!Array.isArray(value.food_spu_tags)) return;
    if (seenMenus.has(value)) return;
    seenMenus.add(value);
    menus.push(value.food_spu_tags);
  });
  walkExpanded(payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (!Array.isArray(value.product_spu_list)) return;
    if (seenMenus.has(value)) return;
    seenMenus.add(value);
    const categoryId = stringify(value.product_tag_id ?? value.tag_id ?? value.tag);
    const requestedCategoryId = context.requestedCategoryId ?? categoryId;
    const requestedContext = context.categoryContextById?.get(requestedCategoryId)
      ?? context.categoryContextById?.get(categoryId);
    menus.push([{
      tag: requestedCategoryId,
      id: requestedCategoryId,
      response_tag: categoryId,
      name: requestedContext?.secondCategoryName ?? (categoryId && context.categoryById ? context.categoryById.get(categoryId) : null),
      first_category_name: requestedContext?.firstCategoryName ?? null,
      second_category_name: requestedContext?.secondCategoryName ?? null,
      sequence: requestedCategoryId && context.categoryOrderById ? context.categoryOrderById.get(requestedCategoryId) : null,
      product_count: value.product_count,
      spus: value.product_spu_list,
    }]);
  });

  const shopInfo = findShopInfo(payload);
  const menuContext = {
    ...context,
    shopName: context.shopName ?? shopInfo.shop_name,
    shopUrl: context.shopUrl ?? context.pageUrl ?? shopInfo.shop_url,
    poiIdStr: context.poiIdStr ?? readQueryParam(context.pageUrl, 'poi_id_str') ?? shopInfo.poi_id_str,
    categoryById: context.categoryById,
    categoryOrderById: context.categoryOrderById,
  };
  const categories = [];
  const products = [];
  const seenCategories = new Set();
  const seenProducts = new Set();

  for (const tags of menus) {
    tags.forEach((tag, index) => {
      const category = normalizeCategory(tag, index, menuContext);
      const categoryKey = fingerprintCategory(category);
      if (!seenCategories.has(categoryKey)) {
        seenCategories.add(categoryKey);
        categories.push({ ...category, _dedupe_key: categoryKey });
      }

      for (const spu of Array.isArray(tag?.spus) ? tag.spus : []) {
        const product = normalizeProduct(spu, tag, index, menuContext);
        const productKey = fingerprintProduct(product);
        if (seenProducts.has(productKey)) continue;
        seenProducts.add(productKey);
        products.push({ ...product, _dedupe_key: productKey });
      }
    });
  }

  return { categories, products };
}

export function normalizeCategory(tag, index = 0, context = {}) {
  return {
    shop_name: context.shopName ?? null,
    shop_url: context.shopUrl ?? context.pageUrl ?? null,
    poi_id_str: context.poiIdStr ?? null,
    category_id: stringify(tag?.tag ?? tag?.id),
    category_name: clean(tag?.name),
    first_category_name: clean(tag?.first_category_name ?? context.firstCategoryName),
    second_category_name: clean(tag?.second_category_name ?? tag?.name ?? context.secondCategoryName),
    category_order: numberOrNull(tag?.sequence) ?? index,
    product_count: numberOrNull(tag?.product_count) ?? (Array.isArray(tag?.spus) ? tag.spus.length : 0),
    crawled_at: context.capturedAt ?? new Date().toISOString(),
    raw: tag,
  };
}

export function normalizeProduct(spu, tag = {}, categoryIndex = 0, context = {}) {
  const skus = Array.isArray(spu?.skus) ? spu.skus : [];
  const primarySku = skus[0] ?? {};
  const productId = spu?.id ?? spu?.spu_id ?? spu?.identity;
  const salesText = clean(spu?.month_saled_content);
  const thirdCategory = findStandardCategory(spu, 3);

  return {
    shop_name: context.shopName ?? null,
    shop_url: context.shopUrl ?? context.pageUrl ?? null,
    poi_id_str: context.poiIdStr ?? null,
    category_name: clean(tag?.name),
    first_category_name: clean(tag?.first_category_name ?? context.firstCategoryName ?? tag?.name),
    second_category_name: clean(tag?.second_category_name ?? context.secondCategoryName ?? tag?.name),
    category_id: stringify(tag?.tag ?? tag?.id),
    category_order: numberOrNull(tag?.sequence) ?? categoryIndex,
    product_id: stringify(productId),
    product_name: clean(spu?.name),
    product_image: clean(spu?.picture ?? primarySku.picture),
    sales_count: pickSalesCount(spu?.month_saled, salesText),
    sales_text: salesText,
    original_price: firstNumber([primarySku.origin_price, primarySku.show_origin_price, spu?.origin_price, spu?.show_origin_price]),
    current_price: pickCurrentPrice(spu, skus),
    activity_price: pickActivityPrice(spu, primarySku),
    hand_price: pickHandPrice(spu, primarySku),
    discount_info: firstClean([
      spu?.promotion_info,
      spu?.promotion?.promotion_text,
      spu?.promotion?.activity_text,
      primarySku.promotion_info,
      primarySku.promotion?.promotion_text,
      primarySku.promotion?.activity_text,
    ]),
    coupon_info: collectCouponTexts(spu, primarySku).join('#') || null,
    third_category_name: clean(thirdCategory?.name),
    third_category_id: stringify(thirdCategory?.id),
    product_review: clean(spu?.praise_content),
    product_rating: numberOrNull(spu?.praise_num_new) ?? numberOrNull(spu?.praise_num),
    product_tags: collectProductTags(spu, primarySku),
    sold_out: isSoldOut(spu, skus),
    product_url: makeProductUrl(context.pageUrl ?? context.shopUrl, productId),
    sku_prices: skus.map(normalizeSku).filter(Boolean),
    product_detail_json: spu ?? null,
    crawled_at: context.capturedAt ?? new Date().toISOString(),
  };
}

export function fingerprintCategory(category) {
  const basis = [
    category.poi_id_str,
    category.shop_name,
    category.category_id,
    category.category_name,
  ].filter(Boolean).join('|');
  return `category:${hash(basis)}`;
}

export function fingerprintProduct(product) {
  const basis = [
    product.poi_id_str,
    product.shop_name,
    product.category_id,
    product.category_name,
    product.product_id,
    product.product_name,
  ].filter(Boolean).join('|');
  return `product:${hash(basis)}`;
}

function pickCurrentPrice(spu, skus) {
  const skuDiscount = skus
    .map((sku) => numberOrNull(sku.full_discount_price))
    .find((value) => value !== null && value >= 0);
  const spuDiscount = numberOrNull(spu?.full_discount_price);
  return firstNumber([
    spuDiscount !== null && spuDiscount >= 0 ? spuDiscount : null,
    skuDiscount,
    spu?.min_price,
    skus[0]?.price,
  ]);
}

function pickActivityPrice(spu, sku) {
  const skuActivity = numberOrNull(sku?.unify_price?.activity_info?.activity_price);
  const spuActivity = numberOrNull(spu?.unify_price?.activity_info?.activity_price);
  return firstNumber([
    skuActivity !== null && skuActivity >= 0 ? skuActivity : null,
    spuActivity !== null && spuActivity >= 0 ? spuActivity : null,
  ]);
}

function pickHandPrice(spu, sku) {
  const skuActual = sku?.unify_price?.actual_price_info;
  const spuActual = spu?.unify_price?.actual_price_info;
  return firstNumber([
    skuActual?.actual_price,
    skuActual?.actual_price_str,
    spuActual?.actual_price,
    spuActual?.actual_price_str,
  ]);
}

function normalizeSku(sku) {
  if (!sku || typeof sku !== 'object') return null;
  const discountPrice = numberOrNull(sku.full_discount_price);
  const activityPrice = pickActivityPrice(null, sku);
  const handPrice = pickHandPrice(null, sku);
  return {
    sku_id: stringify(sku.id),
    spec: clean(sku.spec),
    price: numberOrNull(sku.price),
    original_price: firstNumber([sku.origin_price, sku.show_origin_price]),
    discount_price: discountPrice !== null && discountPrice >= 0 ? discountPrice : null,
    activity_price: activityPrice,
    hand_price: handPrice,
    stock: numberOrNull(sku.stock),
    upc: clean(sku.upccode ?? sku.upc ?? sku.upc_code ?? sku.upcCode),
    promotion_info: firstClean([sku.promotion_info, sku.promotion?.promotion_text, sku.promotion?.activity_text]),
  };
}

function collectProductTags(spu, sku) {
  const tags = new Set();
  for (const value of [spu?.promotion_info, spu?.label_text, spu?.food_label_text, spu?.like_ratio_desc, sku?.promotion_info]) {
    const cleaned = clean(value);
    if (cleaned) tags.add(cleaned);
  }
  for (const label of asArray(spu?.product_label_picture_list)) {
    const cleaned = clean(label?.label_text ?? label?.text ?? label?.name);
    if (cleaned) tags.add(cleaned);
  }
  for (const label of asArray(spu?.poi_food_tag_list)) {
    const cleaned = clean(label?.name ?? label?.text ?? label?.content);
    if (cleaned) tags.add(cleaned);
  }
  return [...tags];
}

function collectCouponTexts(spu, sku) {
  const texts = new Set();
  for (const source of [spu, sku]) {
    for (const label of asArray(source?.dynamic_act_labels)) {
      for (const subTag of asArray(label?.sub_tags)) {
        const text = clean(subTag?.text);
        if (text) texts.add(text);
      }
    }
    const coupon = source?.promotion?.coupon;
    for (const value of [
      coupon?.coupon_text,
      coupon?.text,
      coupon?.name,
      source?.promotion?.delivery_discount,
    ]) {
      const text = clean(value);
      if (text) texts.add(text);
    }
  }
  return [...texts];
}

function findStandardCategory(spu, level) {
  return asArray(spu?.standardCategorys).find((category) => numberOrNull(category?.level) === level) ?? null;
}

function pickSalesCount(value, salesText) {
  const direct = numberOrNull(value);
  const parsed = parseSalesText(salesText);
  if ((direct === null || direct === 0) && parsed !== null) return parsed;
  return direct;
}

function parseSalesText(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/月售\s*([0-9]+(?:\.[0-9]+)?)(万)?\+?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  return Math.round(base * (match[2] ? 10000 : 1));
}

function isSoldOut(spu, skus) {
  const status = numberOrNull(spu?.status);
  const realStatus = numberOrNull(spu?.realStatus);
  if (status !== null && status !== 0) return true;
  if (realStatus !== null && realStatus !== 0) return true;
  if (skus.length === 0) return false;
  return !skus.some((sku) => {
    const stock = numberOrNull(sku.stock);
    const realStock = numberOrNull(sku.real_stock);
    return stock === null || stock > 0 || realStock === null || realStock > 0 || realStock === -1;
  });
}

function findShopInfo(payload) {
  const info = {};
  walkExpanded(payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (!info.shop_name) info.shop_name = clean(value.poi_name ?? value.shopName ?? value.shop_name ?? value.wmPoiName);
    if (!info.poi_id_str) info.poi_id_str = stringify(value.poi_id_str ?? value.poiIdStr);
    if (!info.shop_url) info.shop_url = clean(value.scheme ?? value.shopUrl ?? value.shop_url ?? value.url);
  });
  return info;
}

function makeProductUrl(pageUrl, productId) {
  if (!pageUrl || !productId) return null;
  try {
    const url = new URL(pageUrl);
    url.searchParams.set('dishId', String(productId));
    return url.toString();
  } catch {
    return pageUrl;
  }
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

function firstNumber(values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function firstClean(values) {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringify(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function clean(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readQueryParam(url, key) {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
