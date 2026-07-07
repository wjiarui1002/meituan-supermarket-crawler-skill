#!/usr/bin/env node
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { shouldParseResponse, summarizePayload } from './api-discovery.js';
import { CDP_ENDPOINT, OUTPUT_DIR, selectPreferredPage } from './config.js';
import { appendError, readSeenKeysFromJsonl, upsertJsonlRecords } from './jsonl-store.js';
import { extractMenuFromPayload, fingerprintProduct, normalizeProduct } from './product-normalizer.js';
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
  productDetail: true,
  detailSeedOnly: false,
  seedWorkbooks: [],
  detailRequestDelayMs: 120,
  detailBatchSize: 200,
  detailConcurrency: 5,
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
      productInfoTemplate: null,
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

    let products = await readJsonl(files.products);
    if (products.length === 0) {
      console.log('没有采集到商品。请确认当前 Chrome 页面已打开目标超市、已登录/定位，并可正常看到商品列表。');
      return;
    }

    if (options.productDetail) {
      await enrichProductsFromDetailApi({
        page,
        files,
        menuContext,
        options,
      });
      products = await readJsonl(files.products);
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

  rememberProductInfoTemplate(response, menuContext);
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

function rememberProductInfoTemplate(response, menuContext) {
  const url = response.url();
  if (!/\/quickbuy\/v1\/poi\/sputag\/products/.test(url)) return;
  const body = response.request().postData();
  if (!body) return;
  menuContext.productInfoTemplate = {
    url: url.replace('/quickbuy/v1/poi/sputag/products', '/quickbuy/v2/poi/product/info'),
    body,
  };
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
      const result = await requestJsonWithRetry(page, url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        data: body,
        timeout: 30000,
        attempts: 3,
        delayMs: Math.max(options.pageRequestDelayMs, 1000),
      });
      status = result.status;
      nextPayload = result.payload;
    } catch (error) {
      await appendError(files.errors, {
        at: new Date().toISOString(),
        stage: 'sputag-pagination',
        tag_id: tagId,
        page_index: pageIndex,
        message: error.message,
      });
      await sleep(options.pageRequestDelayMs);
      continue;
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

async function enrichProductsFromDetailApi({ page, files, menuContext, options }) {
  const template = menuContext.productInfoTemplate;
  if (!template?.url || !template?.body) {
    console.log('未发现商品详情接口模板，跳过详情规格补抓。');
    return;
  }

  const products = await readJsonl(files.products);
  const rowsByProductId = new Map();
  for (const product of products) {
    if (!product?.product_id) continue;
    if (!rowsByProductId.has(product.product_id)) rowsByProductId.set(product.product_id, []);
    rowsByProductId.get(product.product_id).push(product);
  }

  const seedByProductId = await collectProductIdSeeds({
    rawDir: files.rawDir,
    menuContext,
    products,
    seedWorkbooks: options.seedWorkbooks,
  });
  const representatives = options.detailSeedOnly
    ? [...seedByProductId].filter(([productId]) => !rowsByProductId.has(productId)).map(([, seed]) => seed)
    : [
        ...new Map([
          ...[...rowsByProductId.values()].map((rows) => [rows[0].product_id, rows[0]]),
          ...[...seedByProductId],
        ]).values(),
      ];
  console.log(`开始补抓商品详情/完整规格：${representatives.length} 个唯一商品。`);

  let fetched = 0;
  let updated = 0;
  let failed = 0;
  let pendingRows = [];

  const concurrency = Math.max(1, Math.min(Number(options.detailConcurrency) || 1, representatives.length || 1));
  console.log(`详情补抓并发：${concurrency}`);
  for (let index = 0; index < representatives.length; index += concurrency) {
    const chunk = representatives.slice(index, index + concurrency);
    const results = await Promise.all(chunk.map((product) => buildProductDetailRows({
      page,
      template,
      product,
      rowsByProductId,
      options,
      files,
    })));

    for (const result of results) {
      fetched += 1;
      if (result.failed) {
        failed += 1;
      } else {
        pendingRows.push(...result.rows);
      }
    }

    if (pendingRows.length >= options.detailBatchSize) {
      const upsertResult = await upsertJsonlRecords(files.products, pendingRows);
      updated += upsertResult.updated;
      pendingRows = [];
    }

    if (fetched % 100 < concurrency || fetched === representatives.length) {
      console.log(`详情补抓进度：${fetched}/${representatives.length}，更新商品行 ${updated}，失败 ${failed}`);
    }
    await sleep(options.detailRequestDelayMs);
  }

  if (pendingRows.length > 0) {
    const upsertResult = await upsertJsonlRecords(files.products, pendingRows);
    updated += upsertResult.updated;
  }

  console.log(`详情补抓完成：请求 ${fetched}/${representatives.length}，更新商品行 ${updated}，失败 ${failed}`);
}

async function buildProductDetailRows({ page, template, product, rowsByProductId, options, files }) {
  try {
    const result = await fetchProductInfo(page, template, product, options);
    const detail = result.payload?.data;
    const detailSkuCount = Array.isArray(detail?.skus) ? detail.skus.length : 0;
    if (!detail || detailSkuCount === 0) return { rows: [], failed: false };

    const sourceRows = rowsByProductId.get(product.product_id) ?? product._seed_rows ?? [product];
    const rows = sourceRows.map((row) => {
      const tag = {
        tag: row.category_id,
        id: row.category_id,
        name: row.category_name,
        first_category_name: row.first_category_name,
        second_category_name: row.second_category_name,
        sequence: row.category_order,
      };
      const normalized = normalizeProduct(detail, tag, row.category_order ?? 0, {
        shopName: row.shop_name,
        shopUrl: row.shop_url,
        pageUrl: row.shop_url,
        poiIdStr: row.poi_id_str,
        capturedAt: new Date().toISOString(),
        firstCategoryName: row.first_category_name,
        secondCategoryName: row.second_category_name,
      });
      return {
        ...normalized,
        _dedupe_key: row._dedupe_key ?? fingerprintProduct(normalized),
      };
    });

    return { rows, failed: false };
  } catch (error) {
    await appendError(files.errors, {
      at: new Date().toISOString(),
      stage: 'product-info-detail',
      product_id: product.product_id,
      product_name: product.product_name,
      message: error.message,
    });
    return { rows: [], failed: true };
  }
}

async function collectProductIdSeeds({ rawDir, menuContext, products, seedWorkbooks = [] }) {
  const seeds = await collectProductIdSeedsFromRaw(rawDir, menuContext, products);
  for (const seedWorkbook of seedWorkbooks) {
    const workbookSeeds = await collectProductIdSeedsFromWorkbook(seedWorkbook, products);
    for (const [productId, seed] of workbookSeeds) {
      if (!seeds.has(productId)) seeds.set(productId, seed);
    }
  }
  return seeds;
}

async function collectProductIdSeedsFromRaw(rawDir, menuContext, products) {
  const fallback = products.find(Boolean) ?? {};
  const seeds = new Map();
  let entries = [];
  try {
    entries = await readdir(rawDir);
  } catch {
    return seeds;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(rawDir, entry), 'utf8'));
    } catch {
      continue;
    }
    const data = parsed?.payload?.data;
    if (!data || typeof data !== 'object') continue;
    const productIds = extractSeedProductIds(data);
    if (productIds.length === 0) continue;

    const categoryId = stringifyLocal(data.product_tag_id ?? data.categoryId);
    const categoryContext = categoryId ? menuContext.categoryContextById.get(categoryId) : null;
    for (const productId of productIds) {
      if (!productId || seeds.has(productId)) continue;
      seeds.set(productId, {
        product_id: productId,
        shop_name: fallback.shop_name ?? null,
        shop_url: fallback.shop_url ?? parsed.page_url ?? null,
        poi_id_str: fallback.poi_id_str ?? readQueryParamLocal(parsed.page_url, 'poi_id_str'),
        category_id: categoryId,
        category_name: categoryContext?.secondCategoryName ?? (categoryId ? menuContext.categoryById.get(categoryId) : null),
        first_category_name: categoryContext?.firstCategoryName ?? null,
        second_category_name: categoryContext?.secondCategoryName ?? null,
        category_order: categoryId ? menuContext.categoryOrderById.get(categoryId) : null,
        sku_prices: [],
      });
    }
  }
  return seeds;
}

async function collectProductIdSeedsFromWorkbook(filePath, products) {
  const fallback = products.find(Boolean) ?? {};
  const seeds = new Map();
  const xlsxModule = await import('xlsx');
  const xlsx = xlsxModule.default ?? xlsxModule;
  let workbook;
  try {
    workbook = xlsx.readFile(filePath, { cellDates: false });
  } catch (error) {
    console.log(`历史种子 Excel 读取失败：${filePath}，${error.message}`);
    return seeds;
  }

  const sheet = workbook.Sheets['商品详情'] ?? workbook.Sheets['商品详情-多规格多行显示'];
  if (!sheet) {
    console.log(`历史种子 Excel 缺少 商品详情 sheet：${filePath}`);
    return seeds;
  }

  const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  for (const row of rows) {
    const productId = cleanLocal(row['商品ID']);
    if (!productId) continue;
    const skuId = cleanLocal(row.sku_id);
    const categoryName = cleanLocal(row['二级分类'] ?? row['二级类目名称']);
    const firstCategoryName = cleanLocal(row['一级分类'] ?? row['一级类目名称']);
    const secondCategoryName = categoryName;
    const seedRow = {
      product_id: productId,
      product_name: cleanLocal(row['商品名称']),
      shop_name: fallback.shop_name ?? null,
      shop_url: fallback.shop_url ?? null,
      poi_id_str: fallback.poi_id_str ?? null,
      category_id: null,
      category_name: categoryName,
      first_category_name: firstCategoryName,
      second_category_name: secondCategoryName,
      category_order: null,
      sku_prices: skuId && skuId !== 'NA' && skuId !== '#N/A' ? [{ sku_id: skuId }] : [],
      _seed_source: filePath,
    };
    if (seeds.has(productId)) {
      seeds.get(productId)._seed_rows.push(seedRow);
      continue;
    }
    seeds.set(productId, {
      ...seedRow,
      _seed_rows: [seedRow],
    });
  }

  console.log(`历史种子 Excel：${filePath}，读取商品 ID ${seeds.size} 个`);
  return seeds;
}

function extractSeedProductIds(data) {
  const ids = new Set();
  for (const value of [
    data.allSpuIds,
    data.allSortedSpuId,
    data.all_spu_ids,
    data.all_sorted_spu_id,
    data.allSpuIdsWithSaleType,
  ]) {
    collectSeedIds(value, ids);
  }
  return [...ids];
}

function collectSeedIds(value, ids) {
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'string' || typeof value === 'number') {
    const id = stringifyLocal(value);
    if (id && /^\d+$/.test(id)) ids.add(id);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectSeedIds(item, ids));
    return;
  }
  if (typeof value === 'object') {
    for (const key of ['spu_id', 'spuId', 'id', 'product_id']) collectSeedIds(value[key], ids);
  }
}

async function fetchProductInfo(page, template, product, options) {
  return requestJsonWithRetry(page, template.url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    data: buildProductInfoBody(template.body, product),
    timeout: 30000,
    attempts: 3,
    delayMs: Math.max(options.detailRequestDelayMs, 1000),
  });
}

function buildProductInfoBody(templateBody, product) {
  const params = new URLSearchParams(templateBody || '');
  const skuId = findPrimarySkuId(product) ?? '0';
  params.delete('spu_tag_id');
  params.delete('tag_type');
  params.delete('page_index');
  params.set('req_time', String(Date.now()));
  params.set('client_id', '38');
  params.set('biz_id', '1137');
  if (!params.get('wm_uuid') && params.get('uuid')) params.set('wm_uuid', params.get('uuid'));
  if (!params.get('wm_poi_id')) params.set('wm_poi_id', '-100');
  if (product.poi_id_str) params.set('poi_id_str', product.poi_id_str);
  params.set('spu_id', product.product_id);
  params.set('sku_id', skuId);
  params.set('share_activity_uuid', 'null');
  params.set('spu_tag', 'undefined');
  params.set('activity_tag', 'undefined');
  params.set('extra', JSON.stringify({ unionId: '', salesId: '', agencyId: '' }));
  params.set('wm_ctype', 'sg_wxapp');
  return params.toString();
}

function findPrimarySkuId(product) {
  const skus = Array.isArray(product?.sku_prices) ? product.sku_prices : [];
  for (const sku of skus) {
    if (sku?.sku_id && sku.sku_id !== 'NA') return String(sku.sku_id);
  }
  const rawSkus = Array.isArray(product?.product_detail_json?.skus) ? product.product_detail_json.skus : [];
  for (const sku of rawSkus) {
    if (sku?.id) return String(sku.id);
  }
  return null;
}

export async function requestJsonWithRetry(page, url, {
  headers,
  data,
  timeout,
  attempts = 3,
  delayMs = 1000,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let apiResponse;
    try {
      apiResponse = await page.request.post(url, { headers, data, timeout });
      return {
        status: apiResponse.status(),
        payload: await apiResponse.json(),
      };
    } catch (error) {
      let bodyPreview = '';
      if (apiResponse) {
        bodyPreview = await apiResponse.text().catch(() => '');
      }
      lastError = new Error(bodyPreview
        ? `${error.message}; body=${bodyPreview.slice(0, 120)}`
        : error.message);
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw lastError;
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
    else if (arg === '--detail-request-delay-ms') parsed.detailRequestDelayMs = Number(next), index += 1;
    else if (arg === '--detail-batch-size') parsed.detailBatchSize = Number(next), index += 1;
    else if (arg === '--detail-concurrency') parsed.detailConcurrency = Number(next), index += 1;
    else if (arg === '--seed-workbook') parsed.seedWorkbooks.push(next), index += 1;
    else if (arg === '--max-pages-per-category') parsed.maxPagesPerCategory = Number(next), index += 1;
    else if (arg === '--page-index') parsed.pageIndex = Number(next), index += 1;
    else if (arg === '--no-goto') parsed.goto = false;
    else if (arg === '--reload') parsed.reload = true;
    else if (arg === '--no-click-categories') parsed.clickCategories = false;
    else if (arg === '--no-product-detail') parsed.productDetail = false;
    else if (arg === '--detail-seed-only') parsed.detailSeedOnly = true;
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
  --detail-request-delay-ms <ms> 商品详情/规格补抓间隔，默认 120
  --detail-batch-size <n>   商品详情合并批量大小，默认 200
  --detail-concurrency <n>   商品详情并发请求数，默认 5
  --seed-workbook <xlsx>   读取历史 Excel 的商品ID作为详情补抓种子，可重复传
  --max-pages-per-category <n> 每个分类最多分页数，默认 200
  --page-index <n>         使用已有页面索引，默认 0
  --reload                 监听启动后刷新当前页，重新触发商品接口
  --no-click-categories    不自动切换分类
  --no-product-detail      不补抓商品详情/完整规格接口
  --detail-seed-only       只补抓 allSpuIds 种子里当前未入表的商品
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

function readQueryParamLocal(url, key) {
  try {
    return new URL(url).searchParams.get(key);
  } catch {
    return null;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
