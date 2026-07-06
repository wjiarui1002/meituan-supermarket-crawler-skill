# Meituan Supermarket Crawler Skill

This repository contains a complete Codex Skill and bundled crawler for exporting Meituan / Meituan Shangou supermarket product data into the fixed Excel workbook format used by the reference file.

## Contents

- `SKILL.md`: Skill trigger rules and operating procedure.
- `references/field-mapping.md`: Field mapping rules for prices, coupons, sales, categories, and header styling.
- `crawler/`: Full Node.js crawler implementation, tests, command files, and package lock.

## Output Contract

The crawler exports `超市商品导出.xlsx` with fixed sheets and fixed `商品详情` fields. The main requirements are:

- Keep the reference Excel field order.
- Keep bold, colored headers.
- Do not add Excel auto-filter.
- Fill key fields from Meituan H5 interface data:
  - `到手价`
  - `商品折扣`
  - `优惠券`
  - `商品月售`
  - `三级类目名称`
  - `三级类目id`
- Populate `想买的所有商品` when `want_to_Buy` / `want_to_buy_content` exists, including both `想买的前10数据` and `想买的所有数据` sections.

## Install

```bash
cd crawler
npm install
npm test
```

## Run

Start a controllable Chrome:

```bash
open ./启动可接管美团.command
```

Then run the supermarket crawler:

```bash
npm run supermarket -- \
  --cdp-url http://127.0.0.1:9222 \
  --url "MEITUAN_SUPERMARKET_URL" \
  --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
  --listen-ms 600000 \
  --scroll-steps 8 \
  --scroll-delay-ms 2500 \
  --category-click-delay-ms 2200 \
  --page-request-delay-ms 800 \
  --max-pages-per-category 80
```

The user must manually complete login, location, captcha, or safety verification in Chrome. The crawler does not bypass verification or access controls.
