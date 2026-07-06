import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function appendJsonlRecords(filePath, records, seen = new Set()) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a');
  let written = 0;
  let skipped = 0;
  try {
    for (const record of records) {
      const key = record._dedupe_key;
      if (key && seen.has(key)) {
        skipped += 1;
        continue;
      }
      await handle.write(`${JSON.stringify(record)}\n`, null, 'utf8');
      if (key) seen.add(key);
      written += 1;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { written, skipped };
}

export async function readSeenKeysFromJsonl(filePath) {
  const seen = new Set();
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return seen;
    throw error;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed._dedupe_key) seen.add(parsed._dedupe_key);
    } catch {
      continue;
    }
  }
  return seen;
}

export async function appendError(filePath, errorRecord) {
  await appendJsonlRecords(filePath, [{ ...errorRecord, _dedupe_key: null }], new Set());
}

export async function upsertJsonlRecords(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readJsonlRecords(filePath);
  const byKey = new Map();
  existing.forEach((record, index) => {
    if (record?._dedupe_key) byKey.set(record._dedupe_key, index);
  });

  const result = { inserted: 0, updated: 0, unchanged: 0 };
  for (const record of records) {
    const key = record?._dedupe_key;
    if (!key || !byKey.has(key)) {
      byKey.set(key, existing.length);
      existing.push(record);
      result.inserted += 1;
      continue;
    }

    const index = byKey.get(key);
    const { merged, changed } = mergeMissingFields(existing[index], record);
    existing[index] = merged;
    if (changed) result.updated += 1;
    else result.unchanged += 1;
  }

  if (result.inserted > 0 || result.updated > 0) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${existing.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    await rename(tmp, filePath);
  }

  return result;
}

async function readJsonlRecords(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function mergeMissingFields(existing, incoming) {
  const merged = { ...existing };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === '_dedupe_key') continue;
    if (isMissing(merged[key]) && !isMissing(value)) {
      merged[key] = value;
      changed = true;
    }
  }
  return { merged, changed };
}

function isMissing(value) {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}
