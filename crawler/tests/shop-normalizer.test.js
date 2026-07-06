import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractShopFromPageSnapshot,
  extractShopsFromPayload,
  fingerprintShop,
  normalizeShop,
} from '../src/shop-normalizer.js';

test('normalizeShop maps common Meituan shop fields', () => {
  const shop = normalizeShop(
    {
      wm_poi_id: -100,
      poi_id_str: 'abc123',
      poi_name: '测试店',
      wm_poi_score: 4.8,
      month_sales_tip: '月售1000+',
      phone: '021-12345678',
      address: '上海市浦东新区测试路1号',
      shipping_fee_tip: '配送 约¥3.9',
      min_price_tip: '起送 ¥15',
      delivery_time_tip: '15分钟',
      bulletin: '公告：欢迎光临',
      scheme: 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=abc123',
    },
    { capturedAt: '2026-07-06T10:00:00.000Z' },
  );

  assert.equal(shop.shop_id, '-100');
  assert.equal(shop.poi_id_str, 'abc123');
  assert.equal(shop.shop_name, '测试店');
  assert.equal(shop.shop_rating, 4.8);
  assert.equal(shop.monthly_sales, '月售1000+');
  assert.equal(shop.shop_phone, '021-12345678');
  assert.equal(shop.shop_address, '上海市浦东新区测试路1号');
  assert.equal(shop.delivery_fee, '配送 约¥3.9');
  assert.equal(shop.min_order_amount, '起送 ¥15');
  assert.equal(shop.business_hours, '15分钟');
  assert.equal(shop.shop_notice, '公告：欢迎光临');
  assert.equal(shop.shop_url, 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=abc123');
  assert.equal(shop.crawled_at, '2026-07-06T10:00:00.000Z');
  assert.equal(shop.raw.poi_name, '测试店');
});

test('normalizeShop maps poi info phone arrays and service time arrays', () => {
  const shop = normalizeShop(
    {
      shopName: '港式烧腊饭',
      shopPhone: ['15522133422'],
      shopAddress: '中国（上海）自由贸易试验区碧波路889号2幢G座1层01-08室',
      serTime: ['10:00-21:00'],
      shopStar: 46,
      sold: 0,
    },
    { capturedAt: '2026-07-06T10:00:00.000Z' },
  );

  assert.equal(shop.shop_name, '港式烧腊饭');
  assert.equal(shop.shop_phone, '15522133422');
  assert.equal(shop.shop_address, '中国（上海）自由贸易试验区碧波路889号2幢G座1层01-08室');
  assert.equal(shop.business_hours, '10:00-21:00');
  assert.equal(shop.shop_rating, 4.6);
  assert.equal(shop.monthly_sales, null);
});


test('extractShopsFromPayload reads nested JSON strings from Meituan modules', () => {
  const payload = {
    data: JSON.stringify({
      module_list: [
        {
          module_list: [
            {
              string_data: JSON.stringify({
                poi_id_str: 'nested-id',
                poi_name: '嵌套店',
                wm_poi_score: 5,
                month_sales_tip: '月售600+',
                min_price_tip: '起送 ¥20',
              }),
            },
          ],
        },
      ],
    }),
  };

  const shops = extractShopsFromPayload(payload, { capturedAt: '2026-07-06T10:00:00.000Z' });

  assert.equal(shops.length, 1);
  assert.equal(shops[0].shop_name, '嵌套店');
  assert.equal(shops[0].poi_id_str, 'nested-id');
  assert.equal(shops[0].monthly_sales, '月售600+');
});

test('extractShopFromPageSnapshot recovers visible shop fields from current page text', () => {
  const shop = extractShopFromPageSnapshot({
    url: 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=abc123',
    title: '香碗锅巴煲仔饭（碧波路店）',
    text: [
      '香碗锅巴煲仔饭（碧波路店）',
      '4.8',
      '配送约15分钟',
      '公告：顾客您好，感谢您在这么多店铺中选择我们家，如有问题可以联系商家',
      '预估加配送费 ¥3.9',
      '¥15起送',
    ].join('\n'),
  }, { capturedAt: '2026-07-06T10:00:00.000Z' });

  assert.equal(shop.shop_name, '香碗锅巴煲仔饭（碧波路店）');
  assert.equal(shop.shop_rating, 4.8);
  assert.equal(shop.delivery_fee, '预估加配送费 ¥3.9');
  assert.equal(shop.min_order_amount, '¥15起送');
  assert.equal(shop.business_hours, '配送约15分钟');
  assert.equal(shop.shop_notice, '公告：顾客您好，感谢您在这么多店铺中选择我们家，如有问题可以联系商家');
  assert.equal(shop.shop_phone, null);
  assert.equal(shop.shop_url, 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=abc123');
});

test('extractShopFromPageSnapshot recognizes 400 service hotline as shop phone', () => {
  const shop = extractShopFromPageSnapshot({
    url: 'https://h5.waimai.meituan.com/waimai/mindex/menu?poi_id_str=abc123',
    title: '客服电话店',
    text: [
      '客服电话店',
      '4.9',
      '公告：如有任何疑问，请致电4001616777，会有电话客服为您服务',
      '配送时间：09:00-21:00',
    ].join('\n'),
  }, { capturedAt: '2026-07-06T10:00:00.000Z' });

  assert.equal(shop.shop_phone, '4001616777');
});

test('fingerprintShop prefers stable shop identifiers', () => {
  assert.equal(fingerprintShop({ shop_id: '-100', poi_id_str: 'abc' }), 'poi:abc');
  assert.equal(fingerprintShop({ shop_id: '-100' }), 'shop:-100');
  assert.match(fingerprintShop({ shop_name: '店', shop_address: '地址' }), /^hash:/);
});
