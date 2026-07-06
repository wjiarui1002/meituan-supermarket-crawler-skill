import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DETAIL_HEADERS,
  buildSupermarketSheets,
  exportSupermarketWorkbook,
  productToDetailRows,
  updateFormField,
} from '../src/supermarket-exporter.js';

describe('supermarket exporter', () => {
  const product = {
    category_name: '推荐',
    product_id: '20614293344',
    product_name: '娃哈哈 饮用纯净水 596ml12瓶',
    product_image: 'http://p0.meituan.net/water.jpg',
    sales_count: 200,
    sales_text: '月售200',
    original_price: 22.5,
    current_price: 9.9,
    discount_info: '满10减1',
    coupon_info: '不参加神券优惠',
    hand_price: 8.9,
    want_to_buy_count: 130,
    want_to_buy_text: '130人想买',
    third_category_name: '包装饮用水',
    third_category_id: '200000159',
    sold_out: false,
    sku_prices: [
      {
        sku_id: '35861528621',
        spec: '596ml*12瓶/份',
        price: 22.5,
        original_price: 22.5,
        discount_price: 9.9,
        stock: 5,
        promotion_info: '满10减1',
        upc: '6902083892104',
      },
      {
        sku_id: '35861528622',
        spec: '596ml*24瓶/份',
        price: 43,
        original_price: 45,
        discount_price: 19.8,
        stock: 3,
        promotion_info: '第二件优惠',
      },
    ],
    product_detail_json: {
      upc: '6902083892104',
      third_category_name: '包装饮用水',
      third_category_id: 200000159,
      description: '日常饮用纯净水',
    },
  };

  it('keeps detail headers identical to the reference export', () => {
    assert.deepEqual(DETAIL_HEADERS, [
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
    ]);
  });

  it('maps one product to a collapsed 商品详情 row and expanded 多规格 rows', () => {
    const collapsed = productToDetailRows(product, { expandSkus: false });
    const expanded = productToDetailRows(product, { expandSkus: true });

    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]['规格'], '596ml*12瓶/份#596ml*24瓶/份');
    assert.equal(collapsed[0].sku_id, '35861528621');
    assert.equal(collapsed[0]['商品ID'], '20614293344');
    assert.equal(collapsed[0]['upc码'], '6902083892104');
    assert.equal(collapsed[0]['现价'], 9.9);
    assert.equal(collapsed[0]['原价'], 22.5);
    assert.equal(collapsed[0]['活动价'], 9.9);
    assert.equal(collapsed[0]['到手价'], 8.9);
    assert.equal(collapsed[0]['商品折扣'], '满10减1');
    assert.equal(collapsed[0]['优惠券'], '不参加神券优惠');
    assert.equal(collapsed[0]['商品月售'], 200);
    assert.equal(collapsed[0]['库存'], 5);
    assert.equal(collapsed[0]['三级类目名称'], '包装饮用水');
    assert.equal(collapsed[0]['三级类目id'], '200000159');
    assert.equal(collapsed[0]['描述'], '日常饮用纯净水');
    assert.equal(collapsed[0]['图片链接'], 'http://p0.meituan.net/water.jpg');

    assert.equal(expanded.length, 2);
    assert.equal(expanded[1]['规格'], '596ml*24瓶/份');
    assert.equal(expanded[1].sku_id, '35861528622');
    assert.equal(expanded[1]['现价'], 19.8);
    assert.equal(expanded[1]['库存'], 3);
    assert.equal(expanded[1]['商品折扣'], '第二件优惠');
    assert.equal(expanded[1]['优惠券'], '不参加神券优惠');
  });

  it('writes styled header rows so fixed fields are easy to distinguish', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'supermarket-export-'));
    const outputPath = path.join(tmpDir, 'out.xlsx');
    try {
      await exportSupermarketWorkbook({ products: [product], outputPath });
      const xlsxModule = await import('xlsx-js-style');
      const xlsx = xlsxModule.default ?? xlsxModule;
      const workbook = xlsx.readFile(outputPath, { cellStyles: true });
      const sheet = workbook.Sheets['商品详情'];
      const fillColor = (cell) => cell.s?.fill?.fgColor?.rgb ?? cell.s?.fgColor?.rgb;
      assert.equal(sheet.A1.v, '商品图片ID');
      assert.equal(fillColor(sheet.A1), '1F4E78');
      assert.equal(fillColor(sheet.M1), '7030A0');
      assert.equal(fillColor(sheet.T1), '548235');
      assert.equal(sheet['!autofilter'], undefined);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to raw Meituan detail json for coupons and activity prices', () => {
    const [row] = productToDetailRows({
      category_name: '推荐',
      product_id: '23866431067',
      product_name: '八宝粥',
      sales_count: 0,
      sales_text: '月售41',
      current_price: 5,
      original_price: 5,
      sku_prices: [{ sku_id: '43975091586', spec: '360g*1罐', price: 5, original_price: 5, stock: 37 }],
      product_detail_json: {
        month_saled_content: '月售41',
        standardCategorys: [{ id: 200002402, name: '即食粥', level: 3 }],
        skus: [{
          id: 43975091586,
          upccode: '6902083880781',
          unify_price: { activity_info: { activity_price: 4.29 } },
          dynamic_act_labels: [{ sub_tags: [{ text: '满10减1' }] }],
        }],
      },
    }, { expandSkus: false });

    assert.equal(row['商品月售'], 41);
    assert.equal(row['活动价'], 4.29);
    assert.equal(row['优惠券'], '满10减1');
    assert.equal(row['upc码'], '6902083880781');
    assert.equal(row['三级类目名称'], '即食粥');
  });

  it('builds 想买的所有商品 with top 10 and all want-to-buy products', () => {
    const products = Array.from({ length: 12 }, (_, index) => ({
      ...product,
      product_id: String(1000 + index),
      product_name: `想买商品${index}`,
      want_to_buy_count: 12 - index,
      want_to_buy_text: `${12 - index}人想买`,
      sku_prices: [{ ...product.sku_prices[0], sku_id: String(2000 + index) }],
    }));

    const sheets = buildSupermarketSheets({ products });
    const wantRows = sheets['想买的所有商品'];

    assert.equal(wantRows[0][0], '类型');
    assert.equal(wantRows[1]['类型'], '想买的前10数据');
    assert.equal(wantRows[2]['商品名称'], '想买商品0');
    assert.equal(wantRows[2]['商品月售'], '12人想买');
    assert.equal(wantRows[11]['商品名称'], '想买商品9');
    assert.equal(wantRows[12]['类型'], ' ');
    assert.equal(wantRows[13]['类型'], '想买的所有数据');
    assert.equal(wantRows.length, 26);
    assert.equal(wantRows[14]['商品名称'], '想买商品0');
    assert.equal(wantRows[25]['商品名称'], '想买商品11');
  });

  it('builds the expected workbook sheet set and sales rankings', () => {
    const sheets = buildSupermarketSheets({
      products: [
        product,
        {
          ...product,
          product_id: '2',
          product_name: '低销量商品',
          sales_count: 1,
          current_price: 100,
          original_price: 100,
          sku_prices: [],
        },
      ],
    });

    assert.deepEqual(Object.keys(sheets), [
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
    ]);
    assert.equal(sheets['商品详情'].length, 3);
    assert.equal(sheets['商品详情-多规格多行显示'].length, 4);
    assert.equal(sheets['销量排行总明细'][1]['商品名称'], '娃哈哈 饮用纯净水 596ml12瓶');
    assert.equal(sheets['销售额排行总明细'][1]['销售额'], 1980);
  });

  it('updates form encoded pagination fields without losing existing request context', () => {
    const body = 'wm_appversion=9.25.6&spu_tag_id=1374552547_27&tag_type=27&page_index=0&req_time=100';

    const updated = updateFormField(updateFormField(body, 'page_index', 3), 'req_time', 200);

    assert.equal(updated.includes('spu_tag_id=1374552547_27'), true);
    assert.equal(updated.includes('tag_type=27'), true);
    assert.equal(updated.includes('page_index=3'), true);
    assert.equal(updated.includes('req_time=200'), true);
  });
});
