import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendJsonlRecords, readSeenKeysFromJsonl, upsertJsonlRecords } from '../src/jsonl-store.js';

test('appendJsonlRecords appends only unseen records', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-jsonl-'));
  try {
    const file = path.join(dir, 'comments.jsonl');
    const seen = new Set(['id:1']);

    const result = await appendJsonlRecords(file, [
      { _dedupe_key: 'id:1', comment_content: 'old' },
      { _dedupe_key: 'id:2', comment_content: 'new' },
    ], seen);

    assert.equal(result.written, 1);
    assert.equal(result.skipped, 1);
    assert.deepEqual([...seen].sort(), ['id:1', 'id:2']);

    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).comment_content, 'new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readSeenKeysFromJsonl reconstructs dedupe keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-jsonl-'));
  try {
    const file = path.join(dir, 'comments.jsonl');
    await appendJsonlRecords(file, [
      { _dedupe_key: 'id:1', comment_content: 'a' },
      { _dedupe_key: 'id:2', comment_content: 'b' },
    ], new Set());

    const seen = await readSeenKeysFromJsonl(file);

    assert.deepEqual([...seen].sort(), ['id:1', 'id:2']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('upsertJsonlRecords merges duplicate records by filling missing fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-jsonl-'));
  try {
    const file = path.join(dir, 'shops.jsonl');
    await appendJsonlRecords(file, [{
      _dedupe_key: 'poi:1',
      shop_name: '测试店',
      monthly_sales: '月售1000+',
      shop_notice: null,
    }], new Set());

    const result = await upsertJsonlRecords(file, [{
      _dedupe_key: 'poi:1',
      shop_name: '测试店新版',
      monthly_sales: null,
      shop_notice: '公告：欢迎光临',
    }]);

    assert.deepEqual(result, { inserted: 0, updated: 1, unchanged: 0 });
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.shop_name, '测试店');
    assert.equal(parsed.monthly_sales, '月售1000+');
    assert.equal(parsed.shop_notice, '公告：欢迎光临');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
