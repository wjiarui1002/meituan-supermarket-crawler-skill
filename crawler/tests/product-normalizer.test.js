import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractMenuFromPayload,
  fingerprintCategory,
  fingerprintProduct,
  normalizeProduct,
} from '../src/product-normalizer.js';

describe('product normalizer', () => {
  it('extracts categories and products from food_spu_tags payload', () => {
    const payload = {
      data: {
        poi_info: { poi_name: '海底捞外送', poi_id_str: 'poi-x' },
        food_spu_tags: [{
          tag: 'cat-1',
          name: '新品推荐',
          sequence: 2,
          product_count: 1,
          spus: [{
            id: 123,
            name: '番茄捞饭',
            picture: 'http://p0.meituan.net/a.jpg',
            month_saled: 88,
            month_saled_content: '月售88',
            min_price: 19.9,
            full_discount_price: -1,
            praise_content: '赞5',
            praise_num: 5,
            description: '番茄汤底',
            skus: [{
              id: 456,
              spec: '1份',
              price: 19.9,
              origin_price: 29.9,
              show_origin_price: 29.9,
              stock: 20,
              full_discount_price: 16.9,
              promotion_info: '限时折扣',
            }],
          }],
        }],
      },
    };

    const result = extractMenuFromPayload(payload, {
      pageUrl: 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=poi-x',
      capturedAt: '2026-07-06T12:00:00.000Z',
    });

    assert.equal(result.categories.length, 1);
    assert.equal(result.products.length, 1);
    assert.equal(result.categories[0].category_name, '新品推荐');
    assert.equal(result.categories[0].category_order, 2);
    assert.equal(result.products[0].shop_name, '海底捞外送');
    assert.equal(result.products[0].category_name, '新品推荐');
    assert.equal(result.products[0].category_id, 'cat-1');
    assert.equal(result.products[0].product_name, '番茄捞饭');
    assert.equal(result.products[0].product_image, 'http://p0.meituan.net/a.jpg');
    assert.equal(result.products[0].sales_count, 88);
    assert.equal(result.products[0].sales_text, '月售88');
    assert.equal(result.products[0].current_price, 16.9);
    assert.equal(result.products[0].original_price, 29.9);
    assert.equal(result.products[0].discount_info, '限时折扣');
    assert.equal(result.products[0].product_review, '赞5');
    assert.equal(result.products[0].product_rating, 5);
    assert.deepEqual(result.products[0].product_tags, ['限时折扣']);
    assert.equal(result.products[0].product_url.includes('dishId=123'), true);
    assert.equal(result.products[0].product_detail_json.description, '番茄汤底');
  });

  it('parses nested JSON strings', () => {
    const payload = {
      body: JSON.stringify({
        data: {
          food_spu_tags: [{ name: '卤味小吃', spus: [{ id: 1, name: '鸭脖', month_saled: 3 }] }],
        },
      }),
    };

    const result = extractMenuFromPayload(payload, { shopName: '店', pageUrl: 'https://x.test/' });

    assert.equal(result.categories[0].category_name, '卤味小吃');
    assert.equal(result.products[0].product_name, '鸭脖');
    assert.equal(result.products[0].sales_count, 3);
  });

  it('extracts paged menu products from menuproducts payload', () => {
    const categoryById = new Map([['1620528499', '一口嗦虾']]);
    const categoryOrderById = new Map([['1620528499', 12]]);
    const payload = {
      data: {
        product_tag_id: '1620528499',
        product_count: 5,
        product_spu_list: [{
          id: 25666963134,
          name: '麻麻辣辣小龙虾',
          picture: 'http://p1.meituan.net/wmproduct/x.jpg',
          month_saled: 13,
          month_saled_content: '月售13',
          min_price: 59.9,
          skus: [{ id: 1, price: 59.9, origin_price: 62.9, stock: 10 }],
        }],
      },
    };

    const result = extractMenuFromPayload(payload, {
      categoryById,
      categoryOrderById,
      poiIdStr: 'poi-x',
    });

    assert.equal(result.categories.length, 1);
    assert.equal(result.products.length, 1);
    assert.equal(result.categories[0].category_name, '一口嗦虾');
    assert.equal(result.products[0].category_id, '1620528499');
    assert.equal(result.products[0].category_name, '一口嗦虾');
    assert.equal(result.products[0].category_order, 12);
    assert.equal(result.products[0].product_name, '麻麻辣辣小龙虾');
    assert.equal(result.products[0].sales_text, '月售13');
    assert.equal(result.products[0].original_price, 62.9);
  });

  it('keeps first and second shop categories from requested sub tag context', () => {
    const categoryContextById = new Map([
      ['1374600273', { firstCategoryName: '水 | 饮料', secondCategoryName: '水 | 饮料' }],
      ['1374600273_27', { firstCategoryName: '水 | 饮料', secondCategoryName: '全部' }],
      ['1422422311', { firstCategoryName: '杜蕾斯', secondCategoryName: '杜蕾斯' }],
    ]);
    const payload = {
      data: {
        product_tag_id: '1374600273',
        product_count: 1,
        product_spu_list: [{ id: 1, name: '农夫山泉', skus: [{ id: 2, price: 3 }] }],
      },
    };

    const result = extractMenuFromPayload(payload, {
      categoryById: new Map([['1374600273', '水 | 饮料']]),
      requestedCategoryId: '1374600273_27',
      categoryContextById,
    });

    assert.equal(result.products[0].category_name, '全部');
    assert.equal(result.products[0].first_category_name, '水 | 饮料');
    assert.equal(result.products[0].second_category_name, '全部');
  });

  it('extracts supermarket sales, coupons, hand price, and third-level standard category', () => {
    const product = normalizeProduct({
      id: 10,
      name: '舒客牙刷',
      month_saled: 0,
      month_saled_content: '月售100+',
      min_price: 12.6,
      standardCategorys: [
        { id: 1, name: '个护清洁', level: 1 },
        { id: 2, name: '口腔护理', level: 2 },
        { id: 200000030, name: '牙刷', level: 3 },
      ],
      dynamic_act_labels: [{
        sub_tags: [{ text: '满19减8' }, { type: 1, url: 'https://example.test/icon.png' }],
      }],
      skus: [{
        id: 20,
        spec: '2支/卡',
        price: 12.6,
        origin_price: 15.9,
        stock: 8,
        promotion_info: '7.92折 限1份',
        upccode: '6920123456789',
        unify_price: {
          actual_price_info: { actual_price: 10.6, actual_price_str: '10.6' },
          activity_info: { activity_price: 12.6, quota_per_order: 1 },
        },
      }],
    }, { name: '推荐' }, 0, {});

    assert.equal(product.sales_count, 100);
    assert.equal(product.sales_text, '月售100+');
    assert.equal(product.third_category_name, '牙刷');
    assert.equal(product.third_category_id, '200000030');
    assert.equal(product.discount_info, '7.92折 限1份');
    assert.equal(product.coupon_info, '满19减8');
    assert.equal(product.hand_price, 10.6);
    assert.equal(product.sku_prices[0].upc, '6920123456789');
  });

  it('does not mistake category or product names for shop name', () => {
    const payload = {
      data: {
        food_spu_tags: [{
          tag: 'cat-1',
          name: '卤味小吃',
          spus: [{ id: 1, name: '五香花生', skus: [{ price: 9.9 }] }],
        }],
      },
    };

    const result = extractMenuFromPayload(payload, { poiIdStr: 'poi-x' });

    assert.equal(result.categories[0].shop_name, null);
    assert.equal(result.products[0].shop_name, null);
  });

  it('marks sold out only when all sku stock is unavailable', () => {
    const product = normalizeProduct({
      id: 1,
      name: '虾',
      status: 0,
      realStatus: 0,
      skus: [{ stock: 0, real_stock: 0, price: 1 }],
    }, { name: '一口嗦虾' }, 0, {});

    assert.equal(product.sold_out, true);
  });

  it('creates stable fingerprints', () => {
    assert.equal(
      fingerprintCategory({ poi_id_str: 'p', category_id: 'c', category_name: '分类' }),
      fingerprintCategory({ poi_id_str: 'p', category_id: 'c', category_name: '分类' }),
    );
    assert.equal(
      fingerprintProduct({ poi_id_str: 'p', product_id: '1', product_name: '商品' }),
      fingerprintProduct({ poi_id_str: 'p', product_id: '1', product_name: '商品' }),
    );
  });

  it('keeps the same product when it appears under different categories', () => {
    assert.notEqual(
      fingerprintProduct({ poi_id_str: 'p', category_id: 'a', product_id: '1', product_name: '商品' }),
      fingerprintProduct({ poi_id_str: 'p', category_id: 'b', product_id: '1', product_name: '商品' }),
    );
  });
});
