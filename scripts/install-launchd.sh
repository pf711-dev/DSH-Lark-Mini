#!/usr/bin/env bash
# install-launchd.sh —— 把桥安装成 macOS 常驻服务（launchd）
#
# 用法：
#   bash scripts/install-launchd.sh install     # 安装并启动（开机自启 + 崩溃自动重启）
#   bash scripts/install-launchd.sh uninstall   # 停止并移除
#   bash scripts/install-launchd.sh status      # 查看运行状态
#   bash scripts/install-launchd.sh restart     # 重启
#
# 说明：
#   · plist 由本脚本按「当前目录」动态生成，不硬编码任何路径；
#     换位置后重新 install 即可。
#   · 刻意不注入 http_proxy 等代理变量：飞书是国内服务，直连更稳
#     （带着已失效的代理变量会让 lark-cli 报 proxyconnect ... connection refused）。
#   · ⚠️ 同一时间只能有一个实例：飞书每条事件只投递给一条长连接。
#     手动前台调试前先 uninstall（或 launchctl unload）。
set -euo pipefail

LABEL="ai.dsh.lark-mini"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

command -v launchctl >/dev/null || { echo "❌ 只支持 macOS（找不到 launchctl）"; exit 2; }

case "${1:-install}" in
  status)
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "✅ $LABEL 在运行："
      launchctl list | grep "$LABEL"
      echo "日志：tail -f $DIR/state/bridge.log"
    else
      echo "💤 $LABEL 未运行"
    fi
    ;;
  uninstall)
    launchctl unload -w "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ 已停止并移除 $LABEL"
    ;;
  restart)
    launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || echo "⚠️  服务未安装，先 install"
    echo "✅ 已重启"
    ;;
  install)
    # 探测 node 绝对路径（launchd 不走 shell 的 PATH）
    NODE_BIN="$(command -v node || true)"
    [ -n "$NODE_BIN" ] || { echo "❌ 找不到 node，请先安装 Node.js ≥ 20"; exit 2; }
    NODE_BIN="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"

    if [ ! -f "$DIR/config.json" ]; then
      echo "❌ $DIR/config.json 不存在：先 cp config.example.json config.json 并完成配置（见 README）"
      exit 2
    fi

    mkdir -p "$HOME/Library/LaunchAgents" "$DIR/state"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/bridge.mjs</string>
    <string>--config</string>
    <string>$DIR/config.json</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key>
    <string>zh_CN.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$DIR/state/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/state/launchd.err.log</string>
</dict>
</plist>
EOF
    launchctl unload -w "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
    echo "✅ 已安装并启动 $LABEL"
    echo "   日志：tail -f $DIR/state/bridge.log"
    echo "   状态：bash scripts/install-launchd.sh status"
    ;;
  *)
    echo "用法：bash scripts/install-launchd.sh [install|uninstall|status|restart]"
    exit 2
    ;;
esac
