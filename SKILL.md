---
name: meituan-supermarket-crawler
description: Use this skill whenever the user gives a Meituan/Meituan Waimai/Meituan Shangou supermarket or convenience-store link and wants 商品数据, 超市爬取, 美团超市导出, or an Excel matching the fixed reference workbook fields. This skill should trigger even if the user only pastes a supermarket URL and says “爬一下”, “导出”, “按之前那个 Excel”, or “超市链接”. It runs the local crawler project, preserves the fixed Excel schema, and verifies key fields before reporting the output path.
---

# 美团超市商品导出 Skill

## Purpose

Turn a user-provided Meituan supermarket / flash-shopping store URL into a fixed-schema Excel export matching the reference workbook style and fields.

The local crawler project lives at:

`/Users/jerry/Desktop/单子/美团`

Use that project unless the user explicitly gives another project path. This skill also bundles a code snapshot in `crawler/`; use it to restore or inspect the crawler if the project directory is missing.

## Trigger Examples

Use this skill for prompts like:

- “这个美团超市链接帮我爬一下”
- “按之前那个 Excel 字段导出”
- “给你一个超市链接，爬商品”
- “美团闪购超市导出”
- “这个店的到手价、优惠券、月售、三级类目补全”

## Required Workflow

1. Go to the crawler project:

   ```bash
   cd /Users/jerry/Desktop/单子/美团
   ```

   If that path does not exist, copy or run the bundled project under this skill:

   ```bash
   cd /Users/jerry/.codex/skills/meituan-supermarket-crawler/crawler
   npm install
   ```

2. Confirm dependencies and tests if code changed recently:

   ```bash
   npm test
   ```

3. Ensure a controllable Chrome is running. Prefer the existing helper:

   ```bash
   open /Users/jerry/Desktop/单子/美团/启动可接管美团.command
   ```

   The crawler connects to `http://127.0.0.1:9222`.

4. Ask the user to complete login, location, captcha, or safety checks in Chrome if needed. Do not bypass verification or login.

5. Run the supermarket crawler with the user URL. Use a timestamped output directory unless the user requests a specific one:

   ```bash
   npm run supermarket -- \
     --cdp-url http://127.0.0.1:9222 \
     --url "USER_SUPERMARKET_URL" \
     --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
     --listen-ms 600000 \
     --scroll-steps 8 \
     --scroll-delay-ms 2500 \
     --category-click-delay-ms 2200 \
     --page-request-delay-ms 800 \
     --max-pages-per-category 80
   ```

6. If the current Chrome tab is already on the target store and the user asks to use the current page, use:

   ```bash
   npm run supermarket -- \
     --cdp-url http://127.0.0.1:9222 \
     --no-goto \
     --reload \
     --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
     --listen-ms 600000 \
     --scroll-steps 8 \
     --scroll-delay-ms 2500 \
     --category-click-delay-ms 2200 \
     --page-request-delay-ms 800 \
     --max-pages-per-category 80
   ```

7. After export, verify the workbook, not just the command exit code.

## Fixed Excel Contract

The output workbook must keep the same sheet names and fixed main detail fields. Do not add, delete, or reorder main fields.

Do not enable Excel auto-filter on any sheet. The user wants fixed headers plus color distinction only, because filters make the workbook heavier and are unnecessary for this workflow.

Main sheet: `商品详情`

Field order:

1. 商品图片ID
2. 一级分类
3. 二级分类
4. 商品名称
5. 规格
6. sku_id
7. 商品ID
8. upc码
9. 现价
10. 原价
11. 商品预估价
12. 活动价
13. 到手价
14. 商品折扣
15. 优惠券
16. 商品月售
17. 库存
18. 包装费
19. 起订
20. 三级类目名称
21. 三级类目id
22. 属性
23. 商品类别
24. 重量
25. 商品详情内容
26. 描述
27. 图片链接

Required sheets:

- 商品详情
- 商品详情-多规格多行显示
- 数据汇总
- 数据汇总1
- 数据汇总2
- 各个类目销量前十(店内分类)
- 各个类目销量前十(三级类目)
- 想买的所有商品
- 销量排行总明细
- 销售额排行总明细
- 数据汇总2_三级类目
- 数据汇总3_三级类目

## Field Mapping Rules

Read `references/field-mapping.md` before changing crawler/export logic.

Critical rules:

- 一级/二级分类: use `/poi/food` category tree plus request body `spu_tag_id`; do not rely only on response `product_tag_id`.
- 商品月售: parse `month_saled_content` / `sales_text`, such as `月售100+ -> 100`; do not treat `month_saled=0` as final when text has a real count.
- 三级类目名称/id: use `standardCategorys` item where `level=3`.
- 商品折扣: use `promotion_info` / `promotion.promotion_text`, such as `5.8折 限3份`.
- 优惠券: use `dynamic_act_labels[].sub_tags[].text` and coupon text, such as `满19减8`, `不参加神券优惠`.
- 活动价: use `unify_price.activity_info.activity_price`.
- 到手价: use `unify_price.actual_price_info.actual_price`; leave blank when missing.
- upc码: prefer SKU `upccode` / `upc`.
- 想买的所有商品: use `want_to_Buy` / `want_to_buy_content`. Build `想买的前10数据` and `想买的所有数据` sections sorted by want-to-buy count. In this sheet, the `商品月售` column should contain text like `130人想买`, matching the reference workbook.
- 商品图片ID: if the public H5 interface does not expose the reference image id, keep `0000` as the placeholder.

## Verification Commands

Run tests:

```bash
npm test
```

Verify final workbook key fields:

```bash
python3 - <<'PY'
from openpyxl import load_workbook
from collections import Counter
path = "OUTPUT_DIR/超市商品导出.xlsx"
wb = load_workbook(path, read_only=False, data_only=True)
ws = wb["商品详情"]
headers = [c.value for c in ws[1]]
idx = {h:i+1 for i,h in enumerate(headers)}
print("rows", ws.max_row, "cols", ws.max_column)
for col in ["到手价","商品折扣","优惠券","商品月售","三级类目名称","三级类目id"]:
    cnt = 0
    samples = []
    for r in range(2, ws.max_row+1):
        v = ws.cell(r, idx[col]).value
        if v not in (None, ""):
            cnt += 1
            if len(samples) < 5:
                samples.append(v)
    print(col, cnt, samples)
for cell in ["A1","M1","N1","O1","P1","T1","U1"]:
    c = ws[cell]
    print(cell, c.value, "bold", c.font.bold, "fill", c.fill.fgColor.rgb)
PY
```

Expected checks:

- `商品详情` has product rows.
- `一级分类` and `二级分类` should not be broadly empty.
- `商品月售` should not be all zero if `月售xx` text exists.
- `三级类目名称` and `三级类目id` should be populated for supermarket products.
- `想买的所有商品` should contain data when products have `want_to_Buy` / `want_to_buy_content`; only leave it header-only when the interface truly lacks want-to-buy data.
- Header row should be bold and colored.
- Workbook should not contain auto-filter; in `openpyxl`, `ws.auto_filter.ref` should be `None`.
- Report honest nonempty counts for 到手价/商品折扣/优惠券 because these depend on the store’s actual promotions.

## Reporting Back

Final response should include:

- Output workbook link.
- 商品详情 row count.
- Key field nonempty counts for 到手价、商品折扣、优惠券、商品月售、三级类目名称/id.
- Test result.
- Any blocker such as login, captcha, location, access denied, or an interface returning empty pages.

Keep the response short and concrete.
