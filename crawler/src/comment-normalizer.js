import { createHash } from 'node:crypto';

const COMMENT_ARRAY_KEYS = new Set([
  'comments',
  'commentList',
  'comment_list',
  'reviews',
  'reviewList',
  'review_list',
  'evaluations',
  'evaluationList',
  'list',
  'dataList',
  'items',
]);

const CONTENT_KEYS = ['comment', 'content', 'review', 'text', 'commentContent', 'reviewContent', 'body'];
const ID_KEYS = ['commentId', 'comment_id', 'reviewId', 'review_id', 'id', 'uuid'];
const USER_KEYS = ['userName', 'username', 'nickName', 'nickname', 'userNickName', 'name'];
const TIME_KEYS = ['commentTime', 'reviewTime', 'time', 'ctime', 'createdAt', 'createTime'];
const RATING_KEYS = ['score', 'star', 'rating', 'avgScore', 'commentScore'];

export function extractCommentsFromPayload(payload, context = {}) {
  const candidates = [];
  walk(payload, [], (value, path) => {
    if (!Array.isArray(value) || value.length === 0) return;
    const key = String(path.at(-1) ?? '');
    const objectItems = value.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (objectItems.length === 0) return;
    if (!COMMENT_ARRAY_KEYS.has(key) && !objectItems.some(looksLikeComment)) return;
    for (const item of objectItems) {
      if (looksLikeComment(item)) {
        candidates.push(normalizeComment(item, context));
      }
    }
  });
  return candidates;
}

export function normalizeComment(raw, context = {}) {
  const content = firstString(raw, CONTENT_KEYS);
  const commentId = firstValue(raw, ID_KEYS);
  const shopId = firstValue(raw, ['shopId', 'shop_id', 'poiId', 'wmPoiId']);
  const productId = firstValue(raw, ['productId', 'product_id', 'spuId', 'skuId', 'dishId']);
  const reply = raw.merchantReply ?? raw.reply ?? raw.bizReply ?? raw.shopReply ?? {};
  const images = collectImageUrls(raw);

  return {
    _dedupe_key: null,
    comment_id: stringify(commentId),
    shop_id: stringify(shopId),
    shop_name: firstString(raw, ['shopName', 'shop_name', 'poiName', 'wmPoiName']) ?? context.shopName ?? null,
    product_id: stringify(productId),
    product_name: firstString(raw, ['productName', 'product_name', 'spuName', 'skuName', 'dishName']) ?? null,
    user_nickname: firstString(raw, USER_KEYS),
    user_avatar: firstString(raw, ['avatar', 'userAvatar', 'user_avatar', 'avatarUrl', 'headUrl']),
    rating: firstNumber(raw, RATING_KEYS),
    content,
    comment_content: content,
    comment_time: stringify(firstValue(raw, TIME_KEYS)),
    comment_images: images,
    comment_videos: collectVideoUrls(raw),
    comment_tags: collectTags(raw),
    purchased_info: firstString(raw, ['spec', 'sku', 'skuInfo', 'buyInfo', 'orderInfo']),
    taste_score: firstNumber(raw, ['tasteScore', 'taste_score', 'flavorScore']),
    package_score: firstNumber(raw, ['packageScore', 'package_score', 'packScore']),
    delivery_score: firstNumber(raw, ['deliveryScore', 'delivery_score', 'deliverScore']),
    merchant_reply_content: firstString(reply, ['content', 'replyContent', 'text']),
    merchant_reply_time: stringify(firstValue(reply, ['time', 'replyTime', 'createdAt'])),
    anonymous: Boolean(firstValue(raw, ['anonymous', 'isAnonymous', 'anon'])),
    has_images: images.length > 0,
    source_url: context.sourceUrl ?? null,
    page_url: context.pageUrl ?? null,
    captured_at: context.capturedAt ?? new Date().toISOString(),
    raw,
  };
}

export function fingerprintComment(comment) {
  if (comment.comment_id) return `id:${comment.comment_id}`;
  const basis = [
    comment.shop_id,
    comment.shop_name,
    comment.product_id,
    comment.product_name,
    comment.user_nickname,
    comment.comment_time,
    comment.comment_content,
  ].filter(Boolean).join('|');
  return `hash:${createHash('sha256').update(basis).digest('hex')}`;
}

function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...path, index], visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key], visit);
    }
  }
}

function looksLikeComment(item) {
  const hasContent = CONTENT_KEYS.some((key) => typeof item[key] === 'string' && item[key].trim());
  const hasReviewId = ID_KEYS.some((key) => item[key] != null);
  const hasRating = RATING_KEYS.some((key) => item[key] != null);
  const hasUser = USER_KEYS.some((key) => item[key] != null);
  return hasContent && (hasReviewId || hasRating || hasUser);
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
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function firstNumber(obj, keys) {
  const value = firstValue(obj, keys);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringify(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function collectImageUrls(raw) {
  return collectUrls(raw, ['image', 'img', 'pic', 'photo', 'picture']);
}

function collectVideoUrls(raw) {
  return collectUrls(raw, ['video']);
}

function collectUrls(raw, keyHints) {
  const urls = new Set();
  walk(raw, [], (value, path) => {
    const key = String(path.at(-1) ?? '').toLowerCase();
    const keyMatches = keyHints.some((hint) => key.includes(hint));
    if (!keyMatches) return;
    if (typeof value === 'string' && /^https?:\/\//.test(value)) urls.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && /^https?:\/\//.test(item)) urls.add(item);
        if (item && typeof item === 'object') {
          const url = item.url ?? item.src ?? item.imageUrl ?? item.picUrl;
          if (typeof url === 'string' && /^https?:\/\//.test(url)) urls.add(url);
        }
      }
    }
  });
  return [...urls];
}

function collectTags(raw) {
  const tags = new Set();
  for (const key of ['tags', 'tagList', 'labels', 'labelList']) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === 'string') tags.add(item);
      if (item && typeof item === 'object') {
        const text = item.name ?? item.text ?? item.label ?? item.title;
        if (text) tags.add(String(text));
      }
    }
  }
  return [...tags];
}
