#!/bin/zsh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/美团超市采集结果"
CDP_PORT="9222"
CDP_ENDPOINT="http://127.0.0.1:${CDP_PORT}"

mkdir -p "$OUT_DIR"
cd "$SCRIPT_DIR"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [[ -x /opt/homebrew/bin/node ]]; then
    echo /opt/homebrew/bin/node
    return 0
  fi
  if [[ -x /usr/local/bin/node ]]; then
    echo /usr/local/bin/node
    return 0
  fi
  if [[ -x /usr/bin/node ]]; then
    echo /usr/bin/node
    return 0
  fi
  return 1
}

echo "美团超市商品采集"
echo "结果目录：$OUT_DIR"
echo "输出：字段对齐参考 Excel 的 超市商品导出.xlsx"
echo ""

if ! NODE_BIN="$(find_node)"; then
  echo "没有找到 Node.js，无法启动采集。"
  echo "请先安装 Node.js 18 或更高版本。"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi
echo "Node.js：$("$NODE_BIN" -v)"
echo ""

if [[ ! -d "$SCRIPT_DIR/node_modules/playwright" || ! -d "$SCRIPT_DIR/node_modules/xlsx" ]]; then
  echo "首次运行或依赖缺失，正在安装依赖..."
  npm install
fi

echo -n "请输入美团超市链接（留空则监听当前标签）："
read TARGET_URL

echo -n "请输入监听秒数（默认 180）："
read LISTEN_SECONDS
if [[ -z "$LISTEN_SECONDS" ]]; then
  LISTEN_SECONDS="180"
fi
if ! [[ "$LISTEN_SECONDS" =~ '^[0-9]+$' ]]; then
  echo "监听秒数必须是正整数。"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi
LISTEN_MS="$((LISTEN_SECONDS * 1000))"

if ! curl -fsS "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
  echo "无法连接 Chrome CDP：$CDP_ENDPOINT"
  echo "请先双击：启动可接管美团.command"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi

echo ""
echo "检测到已有可接管浏览器，复用当前浏览器窗口。"
echo "如果网页要求登录、定位或验证，请先在当前 Chrome 标签中处理。脚本检测到时会暂停等待。"
echo ""

if [[ -z "$TARGET_URL" ]]; then
  MEITUAN_SUPERMARKET_OUTPUT_DIR="$OUT_DIR" \
  MEITUAN_CDP="$CDP_ENDPOINT" \
  "$NODE_BIN" "$SCRIPT_DIR/src/supermarket-cli.js" --cdp-url "$CDP_ENDPOINT" --no-goto --reload --out-dir "$OUT_DIR" --listen-ms "$LISTEN_MS" --scroll-steps 30 --scroll-delay-ms 2000 --category-click-delay-ms 1500
else
  MEITUAN_SUPERMARKET_OUTPUT_DIR="$OUT_DIR" \
  MEITUAN_CDP="$CDP_ENDPOINT" \
  "$NODE_BIN" "$SCRIPT_DIR/src/supermarket-cli.js" --cdp-url "$CDP_ENDPOINT" --url "$TARGET_URL" --reload --out-dir "$OUT_DIR" --listen-ms "$LISTEN_MS" --scroll-steps 30 --scroll-delay-ms 2000 --category-click-delay-ms 1500
fi

echo ""
echo "采集结束。结果在：$OUT_DIR"
echo "按 Enter 关闭窗口。"
read _
