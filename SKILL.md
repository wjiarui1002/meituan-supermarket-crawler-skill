---
name: meituan-supermarket-crawler
description: Use when the user gives a Meituan, Meituan Waimai, or Meituan Shangou supermarket/convenience-store link and wants 商品数据, 超市爬取, 美团超市导出, SKU补全, 库存为0商品补抓, or a fixed-schema Excel export.
---

# 美团超市商品导出

## Core Rule

Use the local crawler project:

`/Users/jerry/Desktop/单子/美团`

If that project is missing, use the bundled backup:

`/Users/jerry/.codex/skills/meituan-supermarket-crawler/crawler`

The export must keep the fixed workbook schema. Do not silently drop products just because SKU is missing, stock is 0, or the product only appears as a detail seed.

The final workbook must be named after the shop, include the export date, and be compressed in place. For example, `乐购达超市（云岗店）` exported on 2026-07-07 should be `乐购达超市（云岗店）_20260707.xlsx`. Do not create or report a separate `压缩版` workbook.

## Required Workflow

1. Enter the crawler project.

   ```bash
   cd /Users/jerry/Desktop/单子/美团
   ```

2. If code changed recently, run tests before crawling.

   ```bash
   npm test
   ```

3. Make sure controllable Chrome is running.

   ```bash
   open /Users/jerry/Desktop/单子/美团/启动可接管美团.command
   ```

   Default CDP is `http://127.0.0.1:9222`. Ask the user to complete login, location, captcha, or safety checks in Chrome when required. Do not bypass verification.

   If the user says “开一个新的 port”, “多开”, or another Chrome is already using 9222, pick a free port such as 9223, 9224, etc. Start Chrome with an isolated profile and use the matching CDP URL for the crawl:

   ```bash
   CDP_PORT=9223 zsh /Users/jerry/Desktop/单子/美团/启动可接管美团.command
   ```

   The startup script uses `open -na "Google Chrome"` and `chrome-profile-PORT` for non-9222 ports, so multiple controllable Chrome instances can run at the same time. After starting a new port, verify `curl http://127.0.0.1:PORT/json/version`, set `CDP_URL=http://127.0.0.1:PORT`, and use that exact URL in every crawl command. Do not accidentally crawl against 9222 when the user asked for a new port.

4. Run one crawl command for the store. Use a timestamped output directory unless the user requests another path.

   ```bash
   npm run supermarket -- \
     --cdp-url CDP_URL \
     --url "USER_SUPERMARKET_URL" \
     --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
     --listen-ms 600000 \
     --scroll-steps 8 \
     --scroll-delay-ms 2500 \
     --category-click-delay-ms 2200 \
     --page-request-delay-ms 800 \
     --detail-request-delay-ms 120 \
     --detail-batch-size 200 \
     --detail-concurrency 5 \
     --max-pages-per-category 200
   ```

5. If a previous export or reference workbook for the same store is available, include it in the same command. This is still one crawl producing one final Excel, not a separate manual second run.

   ```bash
   npm run supermarket -- \
     --cdp-url CDP_URL \
     --url "USER_SUPERMARKET_URL" \
     --seed-workbook "PREVIOUS_OR_REFERENCE_EXPORT.xlsx" \
     --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
     --listen-ms 600000 \
     --scroll-steps 8 \
     --scroll-delay-ms 2500 \
     --category-click-delay-ms 2200 \
     --page-request-delay-ms 800 \
     --detail-request-delay-ms 120 \
     --detail-batch-size 200 \
     --detail-concurrency 5 \
     --max-pages-per-category 200
   ```

6. If the current Chrome tab is already on the target store and the user asks to use it, use `--no-goto --reload`.

   ```bash
   npm run supermarket -- \
     --cdp-url CDP_URL \
     --no-goto \
     --reload \
     --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
     --listen-ms 600000 \
     --scroll-steps 8 \
     --scroll-delay-ms 2500 \
     --category-click-delay-ms 2200 \
     --page-request-delay-ms 800 \
     --detail-request-delay-ms 120 \
     --detail-batch-size 200 \
     --detail-concurrency 5 \
     --max-pages-per-category 200
   ```

7. After export, verify the workbook. Do not report success from command exit alone.

## Stock-0 Product Rule

The detail API can return a stock-0 product only when the crawler already knows the product ID.

Supported:

- Current list exposes the product ID and current stock is 0: keep it.
- `allSpuIds`, `allSortedSpuId`, or `allSpuIdsWithSaleType` exposes the product ID: backfill detail and keep it.
- A previous export/reference workbook has the product ID: pass it with `--seed-workbook` in the same crawl command, backfill detail, and keep it with current stock/price.

Not supported:

- First-time crawl discovers no product ID anywhere. The freshly generated Excel cannot reveal hidden stock-0 products that were absent from the current list, allSpuIds seeds, and any reference workbook. Running that same new Excel back through `--seed-workbook` only rechecks IDs already discovered.

When explaining this to the user, say it plainly: “有商品 ID 就能补库存 0；完全没有商品 ID，就不能凭空查到。”

## SKU And Detail Rules

- Do not rely only on list response `product_spu_list`.
- After list/page crawling, call `/quickbuy/v2/poi/product/info`.
- Merge every returned `skus` item by `sku_id`.
- Products without usable SKU must still be exported; write `sku_id` as `NA`.
- Use current detail API values for stock and price. Do not copy old stock/price from a seed workbook.
- Detail backfill default concurrency is `--detail-concurrency 5`. If the site rate-limits or failures rise, reduce to 4.

## Fixed Excel Contract

The output workbook must keep these sheets:

- 商品详情-多规格多行显示
- 商品详情
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

Do not enable Excel auto-filter on any sheet.

`商品详情-多规格多行显示` must be the first sheet and must be deduplicated by `sku_id`.

`销量排行总明细` must be deduplicated by `商品ID`.

Write the workbook with XLSX/ZIP compression immediately during export. The final filename should be the shop name plus `_YYYYMMDD.xlsx`; keep bracket characters such as `（云岗店）`, remove only filesystem separators/illegal filename characters, and do not rename it to include `压缩版`.

`商品详情` field order:

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

## Field Mapping Rules

Read `references/field-mapping.md` before changing crawler/export logic.

- 一级/二级分类: use `/poi/food` category tree plus request body `spu_tag_id`.
- 商品月售: parse `month_saled_content` / `sales_text`; do not treat `month_saled=0` as final when text has a real count.
- 三级类目名称/id: use `standardCategorys` item where `level=3`.
- 商品折扣: use `promotion_info` / `promotion.promotion_text`.
- 优惠券: use `dynamic_act_labels[].sub_tags[].text` and coupon text.
- 活动价: use `unify_price.activity_info.activity_price`.
- 到手价: use `unify_price.actual_price_info.actual_price`; leave blank when missing.
- upc码: prefer SKU `upccode` / `upc`.
- 想买的所有商品: use `want_to_Buy` / `want_to_buy_content`; put text like `130人想买` in the 商品月售 column.
- 商品图片ID: if the public H5 interface does not expose the reference image id, keep `0000`.

## Verification Commands

Run tests:

```bash
npm test
```

Verify the final workbook:

```bash
python3 - <<'PY'
import zipfile
from openpyxl import load_workbook
path = "OUTPUT_DIR/SHOP_NAME_YYYYMMDD.xlsx"
wb = load_workbook(path, read_only=False, data_only=True)
for sheet in ["商品详情", "商品详情-多规格多行显示"]:
    ws = wb[sheet]
    print(sheet, "rows", ws.max_row, "cols", ws.max_column)
ws = wb["商品详情"]
headers = [c.value for c in ws[1]]
idx = {h:i+1 for i,h in enumerate(headers)}
for col in ["sku_id","到手价","商品折扣","优惠券","商品月售","库存","三级类目名称","三级类目id"]:
    cnt = 0
    samples = []
    for r in range(2, ws.max_row+1):
        v = ws.cell(r, idx[col]).value
        if v not in (None, ""):
            cnt += 1
            if len(samples) < 5:
                samples.append(v)
    print(col, cnt, samples)
print("auto_filter", ws.auto_filter.ref)
with zipfile.ZipFile(path) as zf:
    compressed = any(info.compress_type != zipfile.ZIP_STORED for info in zf.infolist())
print("zip_compressed", compressed)
PY
```

Expected checks:

- `商品详情` and `商品详情-多规格多行显示` have product rows.
- `sku_id` may be `NA`, but rows must not be dropped only because SKU is missing.
- Stock-0 rows are allowed and should remain when their product ID is known.
- `一级分类` and `二级分类` should not be broadly empty.
- `商品月售` should not be all zero if `月售xx` text exists.
- `三级类目名称` and `三级类目id` should be populated when the interface provides standard categories.
- Workbook should not contain auto-filter; `ws.auto_filter.ref` should be `None`.
- Workbook should be compressed in place; `zip_compressed` should be `True`.
- Workbook filename should be `店铺名_YYYYMMDD.xlsx`, not a generic `超市商品导出.xlsx` and not a `压缩版` filename.

## Reporting Back

Final response should be short and concrete:

- Output workbook path.
- `商品详情` row count and `商品详情-多规格多行显示` row count.
- Whether `--seed-workbook` was used.
- Whether detail backfill finished and how many failures occurred.
- Test result if code changed.
- Any blocker such as login, captcha, location, access denied, or empty interface pages.
