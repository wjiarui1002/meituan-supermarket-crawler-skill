#!/bin/zsh
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="$SCRIPT_DIR/chrome-profile"
CDP_PORT="9222"
CDP_ENDPOINT="http://127.0.0.1:${CDP_PORT}"
HOME_URL="https://h5.waimai.meituan.com/waimai/mindex/home?type=main_page&utm_source=60030&channel=mtib"
UA="Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

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

echo "启动/复用可接管美团浏览器"
echo "CDP：$CDP_ENDPOINT"
echo "入口：$HOME_URL"
echo ""

if [[ ! -x "$CHROME" ]]; then
  echo "未找到 Google Chrome：$CHROME"
  echo "请先安装 Google Chrome。"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi

if ! NODE_BIN="$(find_node)"; then
  echo "没有找到 Node.js。"
  echo "请先安装 Node.js 18 或更高版本。"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi
echo "Node.js：$("$NODE_BIN" -v)"
echo ""

mkdir -p "$PROFILE_DIR"

if ! curl -fsS "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
  "$CHROME" \
    --user-data-dir="$PROFILE_DIR" \
    --remote-debugging-port="$CDP_PORT" \
    --disable-blink-features=AutomationControlled \
    --disable-infobars \
    --window-size=390,844 \
    --window-position=160,100 \
    --user-agent="$UA" \
    "$HOME_URL" &

  for i in {1..40}; do
    if curl -fsS "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
else
  echo "检测到 9222 Chrome 已运行。"
fi

if ! curl -fsS "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
  echo "无法连接 Chrome CDP：$CDP_ENDPOINT"
  echo "请关闭占用 9222 的其它 Chrome 后重试。"
  echo "按 Enter 关闭窗口。"
  read _
  exit 1
fi

PAGE_COUNT="$(curl -fsS "$CDP_ENDPOINT/json" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);console.log(a.filter(x=>x.type==='page').length)})")"
if [[ "$PAGE_COUNT" -eq 0 ]]; then
  curl -fsS -X PUT "$CDP_ENDPOINT/json/new?${HOME_URL}" >/dev/null
else
  HAS_MEITUAN="$(curl -fsS "$CDP_ENDPOINT/json" | "$NODE_BIN" -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const a=JSON.parse(d);console.log(a.some(x=>/waimai\\.meituan\\.com|i\\.waimai\\.meituan\\.com|meituan\\.com/.test(x.url))?'1':'0')})")"
  if [[ "$HAS_MEITUAN" != "1" ]]; then
    curl -fsS -X PUT "$CDP_ENDPOINT/json/new?${HOME_URL}" >/dev/null
  fi
fi

echo ""
echo "浏览器已准备好。请在 Chrome 标签里完成登录、定位或验证。"
echo "请确认当前页面已经显示目标店铺、商品或评论页面；必要时刷新或向下滚动一次。"
echo "完成后双击：开始采集美团评论.command"
echo ""
echo "按 Enter 关闭这个提示窗口，Chrome 浏览器会继续保持打开。"
read _
