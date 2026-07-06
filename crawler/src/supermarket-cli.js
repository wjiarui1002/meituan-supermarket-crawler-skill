#!/usr/bin/env node
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { shouldParseResponse, summarizePayload } from './api-discovery.js';
import { CDP_ENDPOINT, OUTPUT_DIR, selectPreferredPage } from './config.js';
import { appendError, readSeenKeysFromJsonl, upsertJsonlRecords } from './jsonl-store.js';
import { extractMenuFromPayload } from './product-normalizer.js';
import { extractShopFromPageSnapshot, extractShopsFromPayload, fingerprintShop } from './shop-normalizer.js';
import { exportSupermarketWorkbook, readJsonl, updateFormField } from './supermarket-exporter.js';

const DEFAULTS = {
  cdpUrl: process.env.MEITUAN_CDP || CDP_ENDPOINT,
  url: process.env.MEITUAN_SUPERMARKET_URL || null,
  outDir: process.env.MEITUAN_SUPERMARKET_OUTPUT_DIR || path.join(process.cwd(), '美团超市采集结果'),
  listenMs: 180000,
  scrollSteps: 30,
  scrollDelayMs: 2000,
  categoryClickDelayMs: 1200,
  pageRequestDelayMs: 500,
  maxPagesPerCategory: 200,
  pageIndex: 0,
  goto: true,
  reload: false,
  clickCategories: true,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await run(options);
}

export async function run(options) {
  const outDir = path.resolve(options.outDir || OUTPUT_DIR);
  await mkdir(path.join(outDir, 'raw'), { recursive: true });

  const files = {
    shops: path.join(outDir, 'shops.jsonl'),
    products: path.join(outDir, 'products.jsonl'),
    categories: path.join(outDir, 'categories.jsonl'),
    candidates: path.join(outDir, 'interface-candidates.jsonl'),
    errors: path.join(outDir, 'errors.jsonl'),
    rawDir: path.join(outDir, 'raw'),
    workbook: path.join(outDir, '超市商品导出.xlsx'),
  };

  let browser;
  const seenProducts = await readSeenKeysFromJsonl(files.products);
  const seenCategories = await readSeenKeysFromJsonl(files.categories);

  try {
    browser = await chromium.connectOverCDP(options.cdpUrl);
    const page = getExistingPage(browser, options.pageIndex);

    console.log(`已连接现有浏览器：${options.cdpUrl}`);
    console.log(`只使用已有标签页：${page.url() || '(空白页)'}`);

    const menuContext = {
      categoryById: new Map(),
      categoryOrderById: new Map(),
      categoryContextById: new Map(),
    };
    const paginatedTags = new Set();
    const handleResponse = createResponseHandler({
      page,
      files,
      menuContext,
      seenProducts,
      seenCategories,
      paginatedTags,
      options,
    });
    page.on('response', handleResponse);

    if (options.goto && options.url) {
      console.log(`在当前标签打开超市链接：${options.url}`);
      await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else if (!options.url) {
      console.log('未提供 --url，直接监听当前标签页。');
    }

    if (await looksLikeManualActionRequired(page)) {
      await waitForManualAction(page);
    }

    await captureCurrentPageShop(page, { files });

    if (options.reload) {
      console.log('刷新当前标签以重新触发商品接口。');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      if (await looksLikeManualActionRequired(page)) {
        await waitForManualAction(page);
      }
    }

    console.log(`开始监听商品接口 ${options.listenMs}ms，并低频滚动/分类切换触发懒加载。`);
    const deadline = Date.now() + options.listenMs;
    const categoryTask = options.clickCategories
      ? clickCategoriesCurrentPage(page, deadline, options.categoryClickDelayMs)
      : Promise.resolve();
    await sleep(Math.min(1000, options.categoryClickDelayMs));
    const scrollTask = autoScrollCurrentPage(page, options.scrollSteps, options.scrollDelayMs);
    await sleep(options.listenMs);
    await Promise.allSettled([scrollTask, categoryTask]);
    await captureCurrentPageShop(page, { files });

    page.off('response', handleResponse);
    await handleResponse.waitForIdle();

    const products = await readJsonl(files.products);
    if (products.length === 0) {
      console.log('没有采集到商品。请确认当前 Chrome 页面已打开目标超市、已登录/定位，并可正常看到商品列表。');
      return;
    }

    await exportSupermarketWorkbook({ products, outputPath: files.workbook });
    console.log(`商品数：${products.length}`);
    console.log(`Excel：${files.workbook}`);
  } catch (error) {
    await appendError(files.errors, {
      at: new Date().toISOString(),
      stage: 'fatal',
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function createResponseHandler({ page, files, menuContext, seenProducts, seenCategories, paginatedTags, options }) {
  let chain = Promise.resolve();
  const handler = (response) => {
    chain = chain.then(() => processResponse(response, {
      page,
      files,
      menuContext,
      seenProducts,
      seenCategories,
      paginatedTags,
      options,
    }))
      .catch(async (error) => {
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

async function processResponse(response, { page, files, menuContext, seenProducts, seenCategories, paginatedTags, options }) {
  if (!shouldParseResponse(response)) return;

  const url = response.url();
  let payload;
  try {
    payload = await response.json();
  } catch {
    return;
  }

  updateCategoryTreeContext(payload, menuContext);
  const requestContext = getRequestCategoryContext(response);
  await ingestPayload({
    payload,
    url,
    status: response.status(),
    page,
    files,
    menuContext,
    requestContext,
    seenProducts,
    seenCategories,
  });

  await paginateSputagProducts({
    response,
    payload,
    page,
    files,
    menuContext,
    seenProducts,
    seenCategories,
    paginatedTags,
    options,
  });
}

async function ingestPayload({ payload, url, status, page, files, menuContext, requestContext, seenProducts, seenCategories }) {
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
  if (shops.length > 0) await upsertJsonlRecords(files.shops, shops);

  const menu = extractMenuFromPayload(payload, {
    sourceUrl: url,
    pageUrl: page.url(),
    capturedAt,
    categoryById: menuContext.categoryById,
    categoryOrderById: menuContext.categoryOrderById,
    categoryContextById: menuContext.categoryContextById,
    requestedCategoryId: requestContext?.requestedCategoryId,
  });

  if (menu.categories.length > 0) {
    for (const category of menu.categories) {
      if (category.category_id && category.category_name) {
        menuContext.categoryById.set(category.category_id, category.category_name);
        menuContext.categoryOrderById.set(category.category_id, category.category_order);
        if (category.first_category_name || category.second_category_name) {
          menuContext.categoryContextById.set(category.category_id, {
            firstCategoryName: category.first_category_name ?? category.category_name,
            secondCategoryName: category.second_category_name ?? category.category_name,
          });
        }
      }
    }
    const unseen = menu.categories.filter((category) => !seenCategories.has(category._dedupe_key));
    await upsertJsonlRecords(files.categories, menu.categories);
    unseen.forEach((category) => seenCategories.add(category._dedupe_key));
  }

  if (menu.products.length > 0) {
    const unseen = menu.products.filter((product) => !seenProducts.has(product._dedupe_key));
    await upsertJsonlRecords(files.products, menu.products);
    unseen.forEach((product) => seenProducts.add(product._dedupe_key));
    console.log(`商品接口：新增/更新 ${menu.products.length}，来源 ${shortUrl(url)}`);

    const rawPath = path.join(files.rawDir, `${hash(url)}-${Date.now()}.json`);
    await writeFile(rawPath, `${JSON.stringify({ url, page_url: page.url(), captured_at: capturedAt, payload }, null, 2)}\n`, 'utf8');
  }

  if (menu.products.length > 0 || menu.categories.length > 0 || shops.length > 0) {
    await upsertJsonlRecords(files.candidates, [{
      _dedupe_key: `interface:${hash(url)}`,
      at: capturedAt,
      url,
      page_url: page.url(),
      summary,
      status,
      extracted_shops: shops.length,
      extracted_categories: menu.categories.length,
      extracted_products: menu.products.length,
    }]);
  }
}

function updateCategoryTreeContext(payload, menuContext) {
  const tags = payload?.data?.food_spu_tags;
  if (!Array.isArray(tags)) return;
  tags.forEach((tag, index) => {
    const topId = stringifyLocal(tag?.tag ?? tag?.id);
    const topName = cleanLocal(tag?.name);
    if (!topId || !topName) return;
    menuContext.categoryById.set(topId, topName);
    menuContext.categoryOrderById.set(topId, index);
    menuContext.categoryContextById.set(topId, {
      firstCategoryName: topName,
      secondCategoryName: topName,
    });
    for (const child of Array.isArray(tag?.tags) ? tag.tags : []) {
      const childId = stringifyLocal(child?.tag ?? child?.id);
      const childName = cleanLocal(child?.name);
      if (!childId || !childName) continue;
      menuContext.categoryById.set(childId, childName);
      menuContext.categoryOrderById.set(childId, index);
      menuContext.categoryContextById.set(childId, {
        firstCategoryName: topName,
        secondCategoryName: childName,
      });
    }
  });
}

function getRequestCategoryContext(response) {
  const body = response.request().postData();
  if (!body) return null;
  const params = new URLSearchParams(body);
  const requestedCategoryId = params.get('spu_tag_id');
  return requestedCategoryId ? { requestedCategoryId } : null;
}

async function paginateSputagProducts({
  response,
  payload,
  page,
  files,
  menuContext,
  seenProducts,
  seenCategories,
  paginatedTags,
  options,
}) {
  const url = response.url();
  if (!/\/quickbuy\/v1\/poi\/sputag\/products/.test(url)) return;
  const data = payload?.data;
  if (!data?.has_next_page) return;

  const postBody = response.request().postData();
  if (!postBody) return;
  const params = new URLSearchParams(postBody);
  const tagId = params.get('spu_tag_id') || data.product_tag_id;
  if (!tagId || paginatedTags.has(tagId)) return;
  paginatedTags.add(tagId);

  const productCount = Number(data.product_count || 0);
  const pageSize = Math.max(1, Array.isArray(data.product_spu_list) ? data.product_spu_list.length : 20);
  const totalPages = productCount > 0 ? Math.ceil(productCount / pageSize) : options.maxPagesPerCategory;
  const maxPage = Math.min(totalPages - 1, options.maxPagesPerCategory - 1);
  if (maxPage < 1) return;

  console.log(`分页拉取：${tagId}，预计 ${maxPage + 1} 页，商品数 ${productCount}`);
  for (let pageIndex = 1; pageIndex <= maxPage; pageIndex += 1) {
    const body = updateFormField(
      updateFormField(postBody, 'page_index', pageIndex),
      'req_time',
      Date.now(),
    );
    let nextPayload;
    let status = 0;
    try {
      const apiResponse = await page.request.post(url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        data: body,
        timeout: 30000,
      });
      status = apiResponse.status();
      nextPayload = await apiResponse.json();
    } catch (error) {
      await appendError(files.errors, {
        at: new Date().toISOString(),
        stage: 'sputag-pagination',
        tag_id: tagId,
        page_index: pageIndex,
        message: error.message,
      });
      break;
    }

    await ingestPayload({
      payload: nextPayload,
      url,
      status,
      page,
      files,
      menuContext,
      requestContext: { requestedCategoryId: tagId },
      seenProducts,
      seenCategories,
    });

    const listLength = nextPayload?.data?.product_spu_list?.length ?? 0;
    console.log(`分页返回：${tagId} page=${pageIndex} 条数=${listLength}`);
    if (!nextPayload?.data?.has_next_page || listLength === 0) break;
    await sleep(options.pageRequestDelayMs);
  }
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
  await upsertJsonlRecords(files.shops, [{
    ...shop,
    source_url: snapshot.url,
    page_url: snapshot.url,
    _dedupe_key: fingerprintShop(shop),
  }]);
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

async function looksLikeManualActionRequired(page) {
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  return /登录|请登录|立即登录|验证码|安全验证|选择收货地址|定位|重新定位/.test(text);
}

async function waitForManualAction(page) {
  console.log('检测到页面可能需要登录、定位或验证。请在当前 Chrome 页面手动处理。');
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
      const candidates = [
        ...document.querySelectorAll('[id^="spu-list-"], [class*="scroll"], [class*="Scroll"], scroll-view'),
      ].filter((node) => node.scrollHeight > node.clientHeight + 50);
      const scroller = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (scroller) {
        scroller.scrollTop += Math.max(scroller.clientHeight * 0.8, 500);
        return;
      }
      window.scrollBy({ top: Math.max(window.innerHeight * 0.8, 600), left: 0, behavior: 'smooth' });
    });
    await sleep(delayMs);
  }
}

async function clickCategoriesCurrentPage(page, deadline, delayMs) {
  const initialCount = await waitForCategoryCount(page, deadline);
  if (!initialCount) return;
  console.log(`检测到 ${initialCount} 个页面分类，开始低频切换分类。`);

  const seenLabels = new Set();
  for (let index = 0; index < initialCount && Date.now() < deadline; index += 1) {
    const item = page.locator('.p-cat-box').nth(index);
    const label = normalizeLabel(await item.innerText({ timeout: 3000 }).catch(() => ''));
    if (!label || seenLabels.has(label)) continue;
    await item.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await item.click({ timeout: 5000 }).catch((error) => {
      console.log(`分类点击失败：${label}，${error.message}`);
    });
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      console.log(`切换分类：${label}`);
    }
    await sleep(delayMs);
  }
}

async function waitForCategoryCount(page, deadline) {
  let best = 0;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const count = await page.locator('.p-cat-box').count().catch(() => 0);
    if (count > best) {
      best = count;
      stableRounds = 0;
    } else {
      stableRounds += 1;
    }
    if (best >= 20 && stableRounds >= 2) return best;
    if (best > 0 && stableRounds >= 5) return best;
    await sleep(1000);
  }
  return best;
}

function normalizeLabel(value) {
  return (value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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
    else if (arg === '--category-click-delay-ms') parsed.categoryClickDelayMs = Number(next), index += 1;
    else if (arg === '--page-request-delay-ms') parsed.pageRequestDelayMs = Number(next), index += 1;
    else if (arg === '--max-pages-per-category') parsed.maxPagesPerCategory = Number(next), index += 1;
    else if (arg === '--page-index') parsed.pageIndex = Number(next), index += 1;
    else if (arg === '--no-goto') parsed.goto = false;
    else if (arg === '--reload') parsed.reload = true;
    else if (arg === '--no-click-categories') parsed.clickCategories = false;
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
  npm run supermarket -- [选项]

选项：
  --cdp-url <url>          已有 Chrome 的 CDP 地址，默认 ${CDP_ENDPOINT}
  --url <url>              在当前标签打开的美团超市链接
  --no-goto                不跳转，直接监听当前页面
  --out-dir <dir>          输出目录，默认 美团超市采集结果
  --listen-ms <ms>         监听时长，默认 180000
  --scroll-steps <n>       低频滚动次数，默认 30
  --scroll-delay-ms <ms>   每次滚动间隔，默认 2000
  --category-click-delay-ms <ms> 分类切换间隔，默认 1200
  --page-request-delay-ms <ms> 分类分页请求间隔，默认 500
  --max-pages-per-category <n> 每个分类最多分页数，默认 200
  --page-index <n>         使用已有页面索引，默认 0
  --reload                 监听启动后刷新当前页，重新触发商品接口
  --no-click-categories    不自动切换分类
`);
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function stringifyLocal(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function cleanLocal(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
