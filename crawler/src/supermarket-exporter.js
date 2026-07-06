import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DETAIL_HEADERS = [
  '商品图片ID',
  '一级分类',
  '二级分类',
  '商品名称',
  '规格',
  'sku_id',
  '商品ID',
  'upc码',
  '现价',
  '原价',
  '商品预估价',
  '活动价',
  '到手价',
  '商品折扣',
  '优惠券',
  '商品月售',
  '库存',
  '包装费',
  '起订',
  '三级类目名称',
  '三级类目id',
  '属性',
  '商品类别',
  '重量',
  '商品详情内容',
  '描述',
  '图片链接',
];

export const RANK_HEADERS = [
  '商品图片ID',
  '一级分类',
  '二级分类',
  '商品名称',
  '商品ID',
  'upc码',
  '现价',
  '原价',
  '商品预估价',
  '活动价',
  '到手价',
  '商品折扣',
  '优惠券',
  '商品月售',
  '库存',
  '包装费',
  '起订',
  '规格',
  '属性',
  '描述',
  '图片链接',
];

export const SALES_AMOUNT_HEADERS = [
  '商品图片ID',
  '一级分类',
  '二级分类',
  '商品名称',
  '商品ID',
  'upc码',
  '现价',
  '原价',
  '商品月售',
  '销售额',
  '商品预估价',
  '活动价',
  '到手价',
  '商品折扣',
  '优惠券',
  '库存',
  '包装费',
  '起订',
  '规格',
  '属性',
  '描述',
  '图片链接',
];

const SUMMARY_HEADERS = [' ', '一级分类', 'sku', '月销售额', '销售占比', '不动销sku', '不动销率'];
const THIRD_SUMMARY_HEADERS = [' ', '三级类目', 'sku', '月销售额', '销售占比', '不动销sku', '不动销率'];
const SHEET_ORDER = [
  '商品详情',
  '商品详情-多规格多行显示',
  '数据汇总',
  '数据汇总1',
  '数据汇总2',
  '各个类目销量前十(店内分类)',
  '各个类目销量前十(三级类目)',
  '想买的所有商品',
  '销量排行总明细',
  '销售额排行总明细',
  '数据汇总2_三级类目',
  '数据汇总3_三级类目',
];

export function buildSupermarketSheets({ products = [] } = {}) {
  const detailRows = products.flatMap((product) => productToDetailRows(product, { expandSkus: false }));
  const expandedRows = products.flatMap((product) => productToDetailRows(product, { expandSkus: true }));
  const salesRankRows = [...detailRows].sort(compareSalesDesc);
  const amountRankRows = [...detailRows]
    .map((row) => ({ ...row, '销售额': round2(num(row['现价']) * num(row['商品月售'])) }))
    .sort((a, b) => num(b['销售额']) - num(a['销售额']));

  return {
    '商品详情': withHeaders(DETAIL_HEADERS, detailRows),
    '商品详情-多规格多行显示': withHeaders(DETAIL_HEADERS, expandedRows),
    '数据汇总': buildSummarySheet(detailRows, '一级分类', '表格逻辑说明:不同分类如果有多个商品重复，只计算最靠后的一个分类里的商品数据，其他分类重复的会自动删除掉', SUMMARY_HEADERS),
    '数据汇总1': buildSummarySheet(detailRows, '一级分类', '表格逻辑说明:不同分类如果有多个商品重复，只计算最靠前的一个分类里的商品数据，其他分类重复的会自动删除掉', SUMMARY_HEADERS),
    '数据汇总2': buildSummarySheet(expandedRows, '一级分类', '表格逻辑说明:不排除重复的商品，所有商品都计算在所属的分类里', SUMMARY_HEADERS),
    '各个类目销量前十(店内分类)': withHeaders(['类目名称', ...RANK_HEADERS], topByCategory(detailRows, '一级分类', RANK_HEADERS)),
    '各个类目销量前十(三级类目)': withHeaders(['类目名称', ...RANK_HEADERS], topByCategory(detailRows, '三级类目名称', RANK_HEADERS)),
    '想买的所有商品': withHeaders(['类型', ...RANK_HEADERS], []),
    '销量排行总明细': withHeaders(RANK_HEADERS, salesRankRows.map(toRankRow)),
    '销售额排行总明细': withHeaders(SALES_AMOUNT_HEADERS, amountRankRows.map(toAmountRankRow)),
    '数据汇总2_三级类目': buildSummarySheet(expandedRows, '三级类目名称', '表格逻辑说明:不排除重复的商品，所有商品都计算在所属的分类里', THIRD_SUMMARY_HEADERS),
    '数据汇总3_三级类目': buildSummarySheet(detailRows, '三级类目名称', '表格逻辑说明:不同分类如果有多个商品重复，只计算最靠前的一个分类里的商品数据，其他分类重复的会自动删除掉', THIRD_SUMMARY_HEADERS),
  };
}

export function productToDetailRows(product, { expandSkus = false } = {}) {
  const skus = Array.isArray(product?.sku_prices) ? product.sku_prices.filter(Boolean) : [];
  const rows = expandSkus && skus.length > 0 ? skus : [skus[0] ?? null];
  return rows.map((sku) => makeDetailRow(product, sku, { collapseSpecs: !expandSkus }));
}

export async function readJsonl(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export function updateFormField(body, key, value) {
  const params = new URLSearchParams(body || '');
  params.set(key, String(value));
  return params.toString();
}

export async function exportSupermarketWorkbook({ products, outputPath }) {
  const xlsxModule = await import('xlsx-js-style');
  const xlsx = xlsxModule.default ?? xlsxModule;
  const sheets = buildSupermarketSheets({ products });
  const workbook = xlsx.utils.book_new();
  for (const sheetName of SHEET_ORDER) {
    const rows = sheets[sheetName] ?? [[]];
    const worksheet = xlsx.utils.json_to_sheet(rows.slice(1), { header: rows[0], skipHeader: false });
    worksheet['!cols'] = rows[0].map((header) => ({ wch: estimateWidth(header, rows) }));
    applyHeaderStyle(worksheet, rows[0], xlsx);
    xlsx.utils.book_append_sheet(workbook, worksheet, sheetName);
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  xlsx.writeFile(workbook, outputPath);
  return outputPath;
}

function makeDetailRow(product, sku, { collapseSpecs }) {
  const raw = product?.product_detail_json ?? {};
  const rawSku = findRawSku(raw, sku);
  const skus = Array.isArray(product?.sku_prices) ? product.sku_prices.filter(Boolean) : [];
  const specs = collapseSpecs ? skus.map((item) => clean(item.spec)).filter(Boolean).join('#') : clean(sku?.spec);
  const currentPrice = firstNumber([sku?.discount_price, product?.current_price, sku?.price]);
  const originalPrice = firstNumber([sku?.original_price, product?.original_price, sku?.price]);
  const activityPrice = firstNumber([
    sku?.activity_price,
    rawSku?.unify_price?.activity_info?.activity_price,
    product?.activity_price,
    raw?.unify_price?.activity_info?.activity_price,
    sku?.discount_price,
    product?.current_price,
  ]);
  const handPrice = firstNumber([
    sku?.hand_price,
    rawSku?.unify_price?.actual_price_info?.actual_price,
    rawSku?.unify_price?.actual_price_info?.actual_price_str,
    product?.hand_price,
    raw?.unify_price?.actual_price_info?.actual_price,
    raw?.unify_price?.actual_price_info?.actual_price_str,
    raw.hand_price,
    raw.handPrice,
  ]);
  const salesCount = pickSalesCount(product?.sales_count, product?.sales_text, raw.month_saled, raw.month_saled_content);

  return {
    '商品图片ID': clean(raw.picture_id ?? raw.pictureId ?? raw.pic_id) ?? '0000',
    '一级分类': clean(product?.first_category_name ?? product?.category_name) ?? null,
    '二级分类': clean(product?.second_category_name ?? product?.category_name) ?? null,
    '商品名称': clean(product?.product_name),
    '规格': specs || clean(raw.spec),
    'sku_id': clean(sku?.sku_id ?? raw.sku_id ?? raw.skuId),
    '商品ID': clean(product?.product_id ?? raw.spu_id ?? raw.id),
    'upc码': clean(sku?.upc ?? rawSku?.upccode ?? rawSku?.upc ?? rawSku?.upc_code ?? rawSku?.upcCode ?? raw.upc ?? raw.upc_code ?? raw.upcCode),
    '现价': currentPrice,
    '原价': originalPrice,
    '商品预估价': firstNumber([raw.estimated_price, raw.predict_price]),
    '活动价': activityPrice,
    '到手价': handPrice,
    '商品折扣': clean(sku?.promotion_info ?? product?.discount_info ?? product?.discount_label ?? raw.discount_label ?? raw.discount_text),
    '优惠券': clean(product?.coupon_info ?? collectCouponText(raw, rawSku) ?? raw.coupon_info ?? raw.coupon_text),
    '商品月售': salesCount,
    '库存': firstNumber([sku?.stock, raw.stock]),
    '包装费': firstNumber([raw.box_price, raw.package_fee]) ?? 0,
    '起订': firstNumber([raw.min_order_count, raw.min_order_quantity, raw.min_count]) ?? 1,
    '三级类目名称': clean(product?.third_category_name ?? raw.third_category_name ?? raw.thirdCategoryName ?? getStandardCategory(raw, 3)?.name ?? raw.category_name),
    '三级类目id': clean(product?.third_category_id ?? raw.third_category_id ?? raw.thirdCategoryId ?? getStandardCategory(raw, 3)?.id),
    '属性': clean(raw.attributes_text ?? raw.attribute ?? raw.attrs),
    '商品类别': clean(raw.product_type ?? raw.product_category),
    '重量': clean(raw.weight),
    '商品详情内容': clean(raw.detail_content ?? raw.detailContent),
    '描述': clean(raw.description ?? product?.product_review),
    '图片链接': clean(product?.product_image ?? raw.picture),
  };
}

function applyHeaderStyle(worksheet, headers, xlsx) {
  const baseStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { patternType: 'solid', fgColor: { rgb: '1F4E78' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: {
      top: { style: 'thin', color: { rgb: 'D9E2F3' } },
      bottom: { style: 'thin', color: { rgb: 'D9E2F3' } },
      left: { style: 'thin', color: { rgb: 'D9E2F3' } },
      right: { style: 'thin', color: { rgb: 'D9E2F3' } },
    },
  };
  const highlightByHeader = new Map([
    ['到手价', '7030A0'],
    ['商品折扣', '7030A0'],
    ['优惠券', '7030A0'],
    ['商品月售', 'C65911'],
    ['三级类目名称', '548235'],
    ['三级类目id', '548235'],
  ]);
  headers.forEach((header, columnIndex) => {
    const cellRef = xlsx.utils.encode_cell({ r: 0, c: columnIndex });
    if (!worksheet[cellRef]) return;
    const fillColor = highlightByHeader.get(header) ?? baseStyle.fill.fgColor.rgb;
    worksheet[cellRef].s = {
      ...baseStyle,
      fill: { patternType: 'solid', fgColor: { rgb: fillColor } },
    };
  });
  worksheet['!rows'] = [{ hpt: 24 }];
}

function buildSummarySheet(rows, categoryField, note, headers) {
  const groups = new Map();
  for (const row of rows) {
    const category = row[categoryField] || '未分类';
    if (!groups.has(category)) groups.set(category, { category, sku: 0, amount: 0, inactive: 0 });
    const group = groups.get(category);
    group.sku += 1;
    group.amount += num(row['现价']) * num(row['商品月售']);
    if (num(row['商品月售']) === 0) group.inactive += 1;
  }
  const totalAmount = [...groups.values()].reduce((sum, group) => sum + group.amount, 0);
  const dataRows = [...groups.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((group) => ({
      ' ': null,
      [headers[1]]: group.category,
      'sku': group.sku,
      '月销售额': round2(group.amount),
      '销售占比': totalAmount > 0 ? `${round2((group.amount / totalAmount) * 100)}%` : '0%',
      '不动销sku': group.inactive,
      '不动销率': group.sku > 0 ? `${round2((group.inactive / group.sku) * 100)}%` : '0%',
    }));
  return [
    headers,
    { ' ': null, [headers[1]]: note },
    Object.fromEntries(headers.map((header) => [header, null])),
    ...dataRows,
  ];
}

function topByCategory(rows, categoryField, headers) {
  const groups = new Map();
  for (const row of rows) {
    const category = row[categoryField] || '未分类';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(row);
  }
  const output = [];
  for (const [category, categoryRows] of groups) {
    const sorted = [...categoryRows].sort(compareSalesDesc).slice(0, 10);
    output.push(Object.fromEntries(['类目名称', ...headers].map((header) => [header, header === '类目名称' ? category : null])));
    for (const row of sorted) output.push({ '类目名称': category, ...toRankRow(row) });
  }
  return output;
}

function toRankRow(row) {
  return {
    '商品图片ID': row['商品图片ID'],
    '一级分类': row['一级分类'],
    '二级分类': row['二级分类'],
    '商品名称': row['商品名称'],
    '商品ID': row['商品ID'],
    'upc码': row['upc码'],
    '现价': row['现价'],
    '原价': row['原价'],
    '商品预估价': row['商品预估价'],
    '活动价': row['活动价'],
    '到手价': row['到手价'],
    '商品折扣': row['商品折扣'],
    '优惠券': row['优惠券'],
    '商品月售': row['商品月售'],
    '库存': row['库存'],
    '包装费': row['包装费'],
    '起订': row['起订'],
    '规格': row['规格'],
    '属性': row['属性'],
    '描述': row['描述'],
    '图片链接': row['图片链接'],
  };
}

function toAmountRankRow(row) {
  return {
    ...toRankRow(row),
    '销售额': row['销售额'],
  };
}

function withHeaders(headers, rows) {
  return [
    headers,
    ...rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] ?? null]))),
  ];
}

function compareSalesDesc(a, b) {
  return num(b['商品月售']) - num(a['商品月售']);
}

function estimateWidth(header, rows) {
  const samples = rows.slice(0, 100).map((row) => row?.[header]);
  const max = Math.max(String(header).length, ...samples.map((value) => String(value ?? '').length));
  return Math.min(Math.max(max + 2, 10), 48);
}

function firstNumber(values) {
  for (const value of values) {
    const number = numberOrNull(value);
    if (number !== null) return number;
  }
  return null;
}

function parseSalesText(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/月售\s*([0-9]+(?:\.[0-9]+)?)(万)?\+?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  return Math.round(base * (match[2] ? 10000 : 1));
}

function pickSalesCount(...values) {
  let firstDirect = null;
  for (const value of values) {
    const parsed = typeof value === 'string' ? parseSalesText(value) : numberOrNull(value);
    if (parsed === null) continue;
    if (firstDirect === null) firstDirect = parsed;
    if (parsed !== 0) return parsed;
  }
  return firstDirect;
}

function getStandardCategory(raw, level) {
  if (!Array.isArray(raw?.standardCategorys)) return null;
  return raw.standardCategorys.find((category) => numberOrNull(category?.level) === level) ?? null;
}

function findRawSku(raw, sku) {
  if (!Array.isArray(raw?.skus) || raw.skus.length === 0) return null;
  const skuId = clean(sku?.sku_id);
  if (!skuId) return raw.skus[0];
  return raw.skus.find((item) => clean(item?.id) === skuId) ?? raw.skus[0];
}

function collectCouponText(raw, rawSku) {
  const texts = new Set();
  for (const source of [raw, rawSku]) {
    for (const label of Array.isArray(source?.dynamic_act_labels) ? source.dynamic_act_labels : []) {
      for (const subTag of Array.isArray(label?.sub_tags) ? label.sub_tags : []) {
        const text = clean(subTag?.text);
        if (text) texts.add(text);
      }
    }
    for (const value of [
      source?.promotion?.coupon?.coupon_text,
      source?.promotion?.coupon?.text,
      source?.promotion?.coupon?.name,
      source?.promotion?.delivery_discount,
    ]) {
      const text = clean(value);
      if (text) texts.add(text);
    }
  }
  return [...texts].join('#') || null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join('，') || null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function num(value) {
  const number = numberOrNull(value);
  return number ?? 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
