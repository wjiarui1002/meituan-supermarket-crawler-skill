# 美团超市字段映射参考

This reference captures the field decisions made from the working crawler in:

`/Users/jerry/Desktop/单子/美团`

## Category Mapping

Do not map first/second category only from product response `product_tag_id`.

For `/quickbuy/v1/poi/sputag/products`, the response often returns a parent tag id in `data.product_tag_id`, while the request body contains the real clicked category id:

- request body: `spu_tag_id=1374600273_27`
- response: `product_tag_id=1374600273`

Correct mapping:

1. Read `/poi/food` category tree.
2. Build context by tag id:
   - parent tag -> first category
   - child tag -> first category + second category
3. When ingesting `/sputag/products`, read request body `spu_tag_id`.
4. Use that requested tag context for 商品详情 row `一级分类` and `二级分类`.

Examples:

- `1374600273_27` -> `水 | 饮料 / 全部`
- recommendation category -> `推荐 / 推荐`
- special promo category -> `神价 / 神价`

## Sales

Meituan can set numeric `month_saled` to `0` while text has the visible count:

```json
{
  "month_saled": 0,
  "month_saled_content": "月售100+"
}
```

Use the text when available:

- `月售46` -> `46`
- `月售100+` -> `100`
- `月售1.2万+` -> `12000`

## Third-Level Category

Use product detail field:

```json
"standardCategorys": [
  {"id": 400000855, "name": "彩妆香水", "level": 1},
  {"id": 200001337, "name": "美妆工具/服务", "level": 2},
  {"id": 200004860, "name": "化妆棉/洗脸巾", "level": 3}
]
```

Export:

- `三级类目名称`: level 3 `name`
- `三级类目id`: level 3 `id`

## Price and Promotion

### 现价

Use SKU discount price if present, otherwise product current/min price or SKU price.

### 原价

Use SKU `origin_price` / `show_origin_price`, then product origin price.

### 活动价

Use:

```json
unify_price.activity_info.activity_price
```

### 到手价

Use:

```json
unify_price.actual_price_info.actual_price
unify_price.actual_price_info.actual_price_str
```

Leave blank if missing.

### 商品折扣

Use:

```json
promotion_info
promotion.promotion_text
```

Examples:

- `5.8折 限3份`
- `6.01折 限1份`
- `买1份赠送...`

### 优惠券

Use:

```json
dynamic_act_labels[].sub_tags[].text
promotion.coupon.*
promotion.delivery_discount
```

Join multiple coupon labels with `#`.

Examples:

- `满19减8`
- `满10减1`
- `不参加神券优惠`
- `全店任选1件`

## Header Styling

The export uses `xlsx-js-style` because the plain `xlsx` package does not reliably write cell styles.

Header row should be bold and colored:

- General fields: blue `#1F4E78`
- Price/promotion fields (`到手价`, `商品折扣`, `优惠券`): purple `#7030A0`
- Sales field (`商品月售`): orange `#C65911`
- Third category fields (`三级类目名称`, `三级类目id`): green `#548235`

Do not add workbook auto-filter. Keep only fixed headers, colors, widths, and normal cell values.

## Want-To-Buy Sheet

The reference workbook's `想买的所有商品` sheet is not a blank placeholder.

Use product fields:

```json
{
  "want_to_Buy": 396,
  "want_to_buy_content": "396人想买"
}
```

Build the sheet with:

1. Header row: `类型` + rank headers.
2. Section row: `想买的前10数据`.
3. Top 10 products sorted by want-to-buy count descending.
4. Separator row: `类型` = single blank space.
5. Section row: `想买的所有数据`.
6. All products with want-to-buy data sorted by count descending.

For this sheet only, the `商品月售` column should contain the want-to-buy text, such as `396人想买`, matching the reference workbook.
