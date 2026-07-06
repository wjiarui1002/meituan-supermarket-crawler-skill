#!/usr/bin/env node
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { isLikelyCommentUrl, makePageKey, shouldParseResponse, summarizePayload } from './api-discovery.js';
import { extractCommentsFromPayload, fingerprintComment } from './comment-normalizer.js';
import { CDP_ENDPOINT, HOME_URL, OUTPUT_DIR, selectPreferredPage } from './config.js';
import { appendError, appendJsonlRecords, readSeenKeysFromJsonl, upsertJsonlRecords } from './jsonl-store.js';
import { extractMenuFromPayload } from './product-normalizer.js';
import { extractShopFromPageSnapshot, extractShopsFromPayload, fingerprintShop } from './shop-normalizer.js';
import { loadState, saveState, updateAfterError, updateAfterPage } from './state.js';

const DEFAULTS = {
  cdpUrl: process.env.MEITUAN_CDP || CDP_ENDPOINT,
  url: process.env.MEITUAN_HOME_URL || HOME_URL,
  outDir: process.env.MEITUAN_OUTPUT_DIR || OUTPUT_DIR,
  listenMs: 120000,
  scrollSteps: 8,
  scrollDelayMs: 1500,
  pageIndex: 0,
  goto: true,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await run(options);
}

export async function run(options) {
  const outDir = path.resolve(options.outDir);
  await mkdir(path.join(outDir, 'raw'), { recursive: true });

  const files = {
    comments: path.join(outDir, 'comments.jsonl'),
    shops: path.join(outDir, 'shops.jsonl'),
    products: path.join(outDir, 'products.jsonl'),
    categories: path.join(outDir, 'categories.jsonl'),
    candidates: path.join(outDir, 'interface-candidates.jsonl'),
    errors: path.join(outDir, 'errors.jsonl'),
    state: path.join(outDir, 'state.json'),
    rawDir: path.join(outDir, 'raw'),
  };

  const state = await loadState(files.state);
  const seenFromFile = await readSeenKeysFromJsonl(files.comments);
  const seen = new Set([...state.seen_comment_keys, ...seenFromFile]);

  let browser;
  try {
    browser = await chromium.connectOverCDP(options.cdpUrl);
    const page = getExistingPage(browser, options.pageIndex);

    console.log(`已连接现有浏览器：${options.cdpUrl}`);
    console.log(`只使用已有标签页：${page.url() || '(空白页)'}`);

    const menuContext = {
      categoryById: new Map(),
      categoryOrderById: new Map(),
    };
    const handleResponse = createResponseHandler({ page, files, state, seen, menuContext });
    page.on('response', handleResponse);

    if (options.goto) {
      console.log(`在当前标签打开：${options.url}`);
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    if (await looksLikeLoginRequired(page)) {
      await waitForManualLogin(page);
    }

    await captureCurrentPageShop(page, { files });

    console.log(`开始监听接口 ${options.listenMs}ms，并低频滚动 ${options.scrollSteps} 次触发懒加载。`);
    const scrollTask = autoScrollCurrentPage(page, options.scrollSteps, options.scrollDelayMs);
    await sleep(options.listenMs);
    await scrollTask.catch(() => {});
    await captureCurrentPageShop(page, { files });

    page.off('response', handleResponse);
    await handleResponse.waitForIdle();
    await saveState(files.state, state);
    console.log(`完成。本次输出目录：${outDir}`);
  } catch (error) {
    updateAfterError(state, error);
    await saveState(files.state, state);
    await appendError(files.errors, {
      at: new Date().toISOString(),
      stage: 'fatal',
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

function createResponseHandler({ page, files, state, seen, menuContext }) {
  let chain = Promise.resolve();
  const handler = (response) => {
    chain = chain.then(() => processResponse(response, { page, files, state, seen, menuContext }))
      .catch(async (error) => {
        updateAfterError(state, error);
        await saveState(files.state, state);
        await appendError(files.errors, {
          at: new Date().toISOString(),
          stage: 'response',
          url: response.url(),
          message: error.message,
          stack: error.stack,
        });
      });
  };
  handler.waitForIdle = () => chain;
  return handler;
}

async function processResponse(response, { page, files, state, seen, menuContext }) {
  if (!shouldParseResponse(response)) return;
  const url = response.url();
  let payload;
  try {
    payload = await response.json();
  } catch {
    return;
  }

  const capturedAt = new Date().toISOString();
  const summary = summarizePayload(payload);
  const shops = extractShopsFromPayload(payload, {
    sourceUrl: url,
    pageUrl: page.url(),
    capturedAt,
  }).map((shop) => ({
    ...shop,
    source_url: url,
    page_url: page.url(),
    _dedupe_key: fingerprintShop(shop),
  }));

  if (shops.length > 0) {
    const result = await upsertJsonlRecords(files.shops, shops);
    if (result.inserted > 0 || result.updated > 0) {
      console.log(`店铺信息：新增 ${result.inserted}，补字段 ${result.updated}`);
    }
  }

  const menu = extractMenuFromPayload(payload, {
    sourceUrl: url,
    pageUrl: page.url(),
    capturedAt,
    categoryById: menuContext.categoryById,
    categoryOrderById: menuContext.categoryOrderById,
  });
  if (menu.categories.length > 0) {
    for (const category of menu.categories) {
      if (category.category_id && category.category_name) {
        menuContext.categoryById.set(category.category_id, category.category_name);
        menuContext.categoryOrderById.set(category.category_id, category.category_order);
      }
    }
    const result = await upsertJsonlRecords(files.categories, menu.categories);
    if (result.inserted > 0 || result.updated > 0) {
      console.log(`菜单分类：新增 ${result.inserted}，补字段 ${result.updated}`);
    }
  }
  if (menu.products.length > 0) {
    const result = await upsertJsonlRecords(files.products, menu.products);
    if (result.inserted > 0 || result.updated > 0) {
      console.log(`商品信息：新增 ${result.inserted}，补字段 ${result.updated}`);
    }
  }

  const comments = extractCommentsFromPayload(payload, {
    sourceUrl: url,
    pageUrl: page.url(),
    capturedAt,
  }).map((comment) => {
    const dedupeKey = fingerprintComment(comment);
    return { ...comment, _dedupe_key: dedupeKey };
  });

  if (!isLikelyCommentUrl(url) && comments.length === 0) return;

  const pageKey = makePageKey(url);
  await appendJsonlRecords(files.candidates, [{
    _dedupe_key: `${pageKey}:${capturedAt}`,
    at: capturedAt,
    url,
    page_url: page.url(),
    page_key: pageKey,
    status: response.status(),
    summary,
    extracted_comments: comments.length,
  }], new Set());

  if (comments.length === 0) return;

  const rawPath = path.join(files.rawDir, `${hash(url)}-${Date.now()}.json`);
  await writeFile(rawPath, `${JSON.stringify({ url, page_url: page.url(), captured_at: capturedAt, payload }, null, 2)}\n`, 'utf8');

  const result = await appendJsonlRecords(files.comments, comments, seen);
  updateAfterPage(state, {
    sourceUrl: url,
    pageKey,
    commentKeys: comments.map((comment) => comment._dedupe_key),
  });
  await saveState(files.state, state);

  console.log(`评论接口：${pageKey}，新增 ${result.written}，重复 ${result.skipped}`);
}

async function captureCurrentPageShop(page, { files }) {
  const snapshot = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''),
  };
  const capturedAt = new Date().toISOString();
  const shop = extractShopFromPageSnapshot(snapshot, { capturedAt, pageUrl: snapshot.url });
  if (!shop) return;
  const record = {
    ...shop,
    source_url: snapshot.url,
    page_url: snapshot.url,
    _dedupe_key: fingerprintShop(shop),
  };
  const result = await upsertJsonlRecords(files.shops, [record]);
  if (result.inserted > 0 || result.updated > 0) {
    console.log(`当前页面店铺信息：新增 ${result.inserted}，补字段 ${result.updated}`);
  }
}

function getExistingPage(browser, pageIndex) {
  const contexts = browser.contexts();
  const allPages = contexts.flatMap((context) => context.pages());
  const selected = selectPreferredPage(allPages, pageIndex);
  if (selected) return selected;
  for (const context of contexts) {
    const pages = context.pages();
    if (pages[pageIndex]) return pages[pageIndex];
  }
  throw new Error('没有找到已有页面。请先用远程调试端口启动 Chrome，并打开一个标签页；程序不会新建标签页。');
}

async function looksLikeLoginRequired(page) {
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  return /登录|请登录|立即登录/.test(text) && !/退出|账号|个人中心/.test(text);
}

async function waitForManualLogin(page) {
  console.log('检测到页面可能需要登录。请在当前页面手动完成登录、定位或验证码处理。');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('完成后按回车继续：');
  } finally {
    rl.close();
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

async function autoScrollCurrentPage(page, steps, delayMs) {
  for (let index = 0; index < steps; index += 1) {
    await page.evaluate(() => {
      const menuScroller = document.querySelector('[id^="spu-list-"]');
      if (menuScroller && menuScroller.scrollHeight > menuScroller.clientHeight) {
        menuScroller.scrollTop += Math.max(menuScroller.clientHeight * 0.75, 500);
        return;
      }
      window.scrollBy({ top: Math.max(window.innerHeight * 0.8, 600), left: 0, behavior: 'smooth' });
    });
    await sleep(delayMs);
  }
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--cdp-url') parsed.cdpUrl = next, index += 1;
    else if (arg === '--url') parsed.url = next, index += 1;
    else if (arg === '--out-dir') parsed.outDir = next, index += 1;
    else if (arg === '--listen-ms') parsed.listenMs = Number(next), index += 1;
    else if (arg === '--scroll-steps') parsed.scrollSteps = Number(next), index += 1;
    else if (arg === '--scroll-delay-ms') parsed.scrollDelayMs = Number(next), index += 1;
    else if (arg === '--page-index') parsed.pageIndex = Number(next), index += 1;
    else if (arg === '--no-goto') parsed.goto = false;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`用法：
  npm start -- [选项]

选项：
  --cdp-url <url>          已有 Chrome 的 CDP 地址，默认 ${CDP_ENDPOINT}
  --url <url>              在当前标签打开的地址，默认 ${HOME_URL}
  --no-goto                不跳转，直接监听当前页面
  --out-dir <dir>          输出目录，默认 ${OUTPUT_DIR}
  --listen-ms <ms>         监听时长，默认 120000
  --scroll-steps <n>       低频滚动次数，默认 8
  --scroll-delay-ms <ms>   每次滚动间隔，默认 1500
  --page-index <n>         使用已有页面索引，默认 0
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
