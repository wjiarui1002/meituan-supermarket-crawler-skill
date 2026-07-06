# 美团超市商品导出爬虫

这个目录是 `meituan-supermarket-crawler` Skill 打包的完整爬虫代码。主要用途是：用户给美团/闪购超市链接后，采集商品接口并导出固定字段 Excel。

超市导出命令：

```bash
npm install
npm test
npm run supermarket -- \
  --cdp-url http://127.0.0.1:9222 \
  --url "美团超市链接" \
  --out-dir "美团超市采集结果_YYYYMMDD_HHMMSS" \
  --listen-ms 600000 \
  --scroll-steps 8 \
  --scroll-delay-ms 2500 \
  --category-click-delay-ms 2200 \
  --page-request-delay-ms 800 \
  --max-pages-per-category 80
```

导出要求：

- Excel 主字段顺序固定。
- 表头加粗并用颜色区分字段组。
- 不启用 Excel 筛选功能。
- `到手价`、`商品折扣`、`优惠券`、`商品月售`、`三级类目名称/id` 必须按接口字段映射补齐。

下面保留早期评论采集说明，当前 Skill 默认使用超市商品导出流程。

# 美团网页版评论爬虫（旧功能）

## 运行方式

默认按交付包方式使用美团外卖 H5 页面：

- 入口：`https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page&utm_source=60030&channel=mtib`
- CDP：`http://127.0.0.1:9222`
- Chrome profile：`chrome-profile/`
- 手机 UA：Pixel 8 Pro / Chrome Mobile
- 窗口：`390x844`

双击：

```text
启动可接管美团.command
```

Chrome 打开后，在里面完成登录、定位、验证，并进入目标评论页面。

然后双击：

```text
开始采集美团评论.command
```

## 终端运行方式

也可以手动启动可接管 Chrome：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="/Users/jerry/Desktop/单子/美团/chrome-profile" \
  --remote-debugging-port=9222 \
  --disable-blink-features=AutomationControlled \
  --disable-infobars \
  --window-size=390,844 \
  --window-position=160,100 \
  --user-agent="Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36" \
  "https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page&utm_source=60030&channel=mtib"
```

然后运行：

```bash
npm install
npm start -- --cdp-url http://127.0.0.1:9222 --no-goto --out-dir 美团评论采集结果
```

如果你已经在当前标签打开了目标美团页面，不想跳转到官网：

```bash
npm start -- --cdp-url http://127.0.0.1:9222 --no-goto --listen-ms 180000 --out-dir 美团评论采集结果
```

## 重要边界

- 程序只连接已有浏览器和已有标签页。
- 程序不会主动新开浏览器或新建标签。
- 需要登录、定位、验证码时，会提示你在当前页面手动处理。
- 程序主要监听当前页面的接口响应并提取评论，不做高频 UI 点击。
- 采集过程串行处理响应，并及时写入文件。

## 输出文件

- `美团评论采集结果/shops.jsonl`：每行一个店铺，包含评分、月售、电话、地址、营业/配送时间、公告、起送价、配送费等页面或接口可见字段。
- `美团评论采集结果/categories.jsonl`：每行一个菜单分类，包含分类名、分类顺序、商品数量等字段。
- `美团评论采集结果/products.jsonl`：每行一个商品，包含所属分类、商品名、图片 URL、商品月售、现价、原价、优惠、评价、售罄状态和完整商品详情 JSON。
- `美团评论采集结果/comments.jsonl`：每行一条评论，实时追加。
- `美团评论采集结果/interface-candidates.jsonl`：发现的疑似评论接口和摘要。
- `美团评论采集结果/raw/`：含评论接口的原始响应。
- `美团评论采集结果/state.json`：断点续爬状态。
- `美团评论采集结果/errors.jsonl`：错误记录。

## 常用参数

```bash
npm start -- \
  --cdp-url http://127.0.0.1:9222 \
  --no-goto \
  --listen-ms 300000 \
  --scroll-steps 20 \
  --scroll-delay-ms 2000
```
