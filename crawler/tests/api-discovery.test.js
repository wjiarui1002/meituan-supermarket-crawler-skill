import test from 'node:test';
import assert from 'node:assert/strict';

import { isLikelyCommentUrl, makePageKey, summarizePayload } from '../src/api-discovery.js';

test('isLikelyCommentUrl recognizes comment and review endpoints', () => {
  assert.equal(isLikelyCommentUrl('https://example.test/api/review/list?page=1'), true);
  assert.equal(isLikelyCommentUrl('https://example.test/api/comment/list?page=1'), true);
  assert.equal(isLikelyCommentUrl('https://example.test/api/order/list'), false);
});

test('makePageKey includes path and pagination params', () => {
  const key = makePageKey('https://example.test/api/review/list?page=2&shopId=3&uuid=x');

  assert.equal(key, '/api/review/list?page=2&shopId=3');
});

test('summarizePayload returns array and pagination hints', () => {
  const summary = summarizePayload({
    data: {
      comments: [{ id: 1, content: 'a' }],
      total: 20,
      hasMore: true,
      page: 1,
    },
  });

  assert.equal(summary.arrayCount, 1);
  assert.equal(summary.total, 20);
  assert.equal(summary.hasMore, true);
  assert.equal(summary.page, 1);
});
