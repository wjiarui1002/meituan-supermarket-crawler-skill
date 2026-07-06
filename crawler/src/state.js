import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

export function createDefaultState() {
  return {
    version: 1,
    current_shop: null,
    current_product: null,
    current_api_url: null,
    current_page: null,
    current_cursor: null,
    completed_pages: [],
    seen_comment_keys: [],
    last_success_at: null,
    failure_count: 0,
    last_error: null,
    next_resume_hint: null,
  };
}

export async function loadState(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return { ...createDefaultState(), ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return createDefaultState();
    await backupCorruptState(filePath);
    return { ...createDefaultState(), recovered_from_corrupt_state: true };
  }
}

export async function saveState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

export function updateAfterPage(state, { sourceUrl, pageKey, commentKeys }) {
  state.current_api_url = sourceUrl;
  state.current_page = pageKey;
  state.completed_pages = unique([...state.completed_pages, pageKey]);
  state.seen_comment_keys = unique([...state.seen_comment_keys, ...commentKeys]);
  state.last_success_at = new Date().toISOString();
  state.failure_count = 0;
  state.last_error = null;
  state.next_resume_hint = `continue after ${pageKey}`;
  return state;
}

export function updateAfterError(state, error) {
  state.failure_count = Number(state.failure_count || 0) + 1;
  state.last_error = {
    message: error?.message ?? String(error),
    at: new Date().toISOString(),
  };
  return state;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function backupCorruptState(filePath) {
  const backup = `${filePath}.corrupt-${Date.now()}`;
  try {
    await copyFile(filePath, backup);
  } catch {
    // Best-effort backup only.
  }
}
