import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCommentsFromPayload, fingerprintComment, normalizeComment } from '../src/comment-normalizer.js';

test('extractCommentsFromPayload finds nested comment arrays', () => {
  const payload = {
    data: {
      list: [
        {
          id: 'c1',
          userName: '张三',
          comment: '很好吃',
          score: 5,
          pictures: ['https://img.example/1.jpg'],
        },
      ],
    },
  };

  const comments = extractCommentsFromPayload(payload);

  assert.equal(comments.length, 1);
  assert.equal(comments[0].raw.id, 'c1');
  assert.equal(comments[0].content, '很好吃');
});

test('normalizeComment keeps raw fields and maps common review fields', () => {
  const normalized = normalizeComment(
    {
      reviewId: 123,
      shopId: 456,
      shopName: '测试店',
      productName: '牛肉饭',
      userName: '李四',
      star: 4,
      review: '分量足',
      reviewTime: '2026-07-06',
      images: [{ url: 'https://img.example/2.jpg' }],
      merchantReply: { content: '谢谢', time: '2026-07-07' },
    },
    {
      sourceUrl: 'https://www.meituan.com/api/review',
      pageUrl: 'https://www.meituan.com/shop/1',
      capturedAt: '2026-07-06T10:00:00.000Z',
    },
  );

  assert.equal(normalized.comment_id, '123');
  assert.equal(normalized.shop_id, '456');
  assert.equal(normalized.product_name, '牛肉饭');
  assert.equal(normalized.rating, 4);
  assert.equal(normalized.comment_content, '分量足');
  assert.deepEqual(normalized.comment_images, ['https://img.example/2.jpg']);
  assert.equal(normalized.merchant_reply_content, '谢谢');
  assert.equal(normalized.raw.reviewId, 123);
});

test('fingerprintComment uses stable id when present and content fallback otherwise', () => {
  assert.equal(fingerprintComment({ comment_id: 'abc' }), 'id:abc');
  assert.match(
    fingerprintComment({
      shop_name: '店',
      product_name: '饭',
      user_nickname: '王五',
      comment_time: '2026-07-06',
      comment_content: '不错',
    }),
    /^hash:/,
  );
});
