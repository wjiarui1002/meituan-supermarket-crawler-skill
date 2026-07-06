import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultState, loadState, saveState, updateAfterPage } from '../src/state.js';

test('loadState returns default state when file is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-state-'));
  try {
    const state = await loadState(path.join(dir, 'state.json'));

    assert.equal(state.version, 1);
    assert.deepEqual(state.completed_pages, []);
    assert.deepEqual(state.seen_comment_keys, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('saveState writes atomically readable json', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-state-'));
  try {
    const file = path.join(dir, 'state.json');
    const state = createDefaultState();
    state.current_page = 3;

    await saveState(file, state);

    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(parsed.current_page, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadState backs up corrupt state and returns default', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mt-state-'));
  try {
    const file = path.join(dir, 'state.json');
    await writeFile(file, '{bad json', 'utf8');

    const state = await loadState(file);

    assert.equal(state.version, 1);
    assert.equal(state.recovered_from_corrupt_state, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updateAfterPage records completed page and seen comment keys', () => {
  const state = createDefaultState();

  updateAfterPage(state, {
    sourceUrl: 'https://example.test/review?page=1',
    pageKey: 'page=1',
    commentKeys: ['id:1', 'id:2'],
  });

  assert.equal(state.current_api_url, 'https://example.test/review?page=1');
  assert.deepEqual(state.completed_pages, ['page=1']);
  assert.deepEqual(state.seen_comment_keys, ['id:1', 'id:2']);
});
