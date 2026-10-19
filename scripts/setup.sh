#!/usr/bin/env bash
# setup.sh —— lark-dsh-mini 一键安装向导
#
# 用法：bash scripts/setup.sh
#
# 做什么（每步先检测现状，已完成的自动跳过，可反复重跑续上）：
#   1. 环境检查：node ≥ 20 / lark-cli / DSH 客户端（缺什么给一键安装命令）
#   2. 生成 config.json
#   3. 登记 lark-cli profile（引导填 App ID / App Secret，密钥只进 lark-cli）
#   4. 五项接入自检（复用 scripts/preflight.sh）
#   5. 观察模式取 open_id 并【自动写入白名单】——你只需去飞书发一条消息
#   6. 可选：装成 macOS 常驻服务（复用 scripts/install-launchd.sh）
#
# 本脚本不改动 bridge.mjs / push.mjs 的任何实现；discover 自动回填是通过
# 解析其日志输出完成的（外围脚本，不侵入）。
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PROFILE_DEFAULT="dsh-bot"

say()  { printf "\n==> %s\n" "$1"; }
ok()   { printf "  ✅ %s\n" "$1"; }
bad()  { printf "  ❌ %s\n" "$1"; }
info() { printf "  ℹ️  %s\n" "$1"; }
ask()  { # ask <提示> <默认值>；结果进 $ANSWER
  local prompt="$1" def="$2" input
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " input; ANSWER="${input:-$def}"
  else read -r -p "$prompt: " input; ANSWER="$input"; fi
}

# 用 node 安全编辑 config.json（读写 JSON 不用 sed，避免格式/转义问题）
json_set() { # json_set <文件> <key> <value>
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c[process.argv[2]]=process.argv[3];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$1" "$2" "$3"
}
json_allow() { # json_allow <文件> <ou_...>... 追加去重
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.allowOpenIds=Array.isArray(c.allowOpenIds)?c.allowOpenIds:[];for(const id of process.argv.slice(2))if(!c.allowOpenIds.includes(id))c.allowOpenIds.push(id);fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$@"
}
json_set_me() { # json_set_me <文件> <oc_...> 把单聊登记为推送别名 me（不覆盖已有值）
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.pushTargets=c.pushTargets||{};if(!c.pushTargets.me)c.pushTargets.me=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n");' "$@"
}

echo "=============================================="
echo " lark-dsh-mini 安装向导"
echo "=============================================="

# ---------------------------------------------------------------------------
say "第 1/6 步：环境检查"
# ---------------------------------------------------------------------------
fail_env=0

if command -v node >/dev/null 2>&1; then
  major="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${major:-0}" -ge 20 ]; then ok "node $(node -v)"; else bad "node 版本过低（$(node -v)，需 ≥ 20）：brew upgrade node"; fail_env=1; fi
else
  bad "未安装 node：brew install node（或到 nodejs.org 下载）"; fail_env=1
fi

if command -v lark-cli >/dev/null 2>&1; then
  ok "lark-cli $(lark-cli --version 2>/dev/null | head -1 | awk '{print $NF}')"
else
  if command -v npm >/dev/null 2>&1; then
    ask "未安装 lark-cli，现在帮你执行 npm i -g @larksuite/cli 吗？" "y"
    if [ "$ANSWER" = "y" ]; then npm i -g @larksuite/cli && ok "lark-cli 已安装" || { bad "安装失败，请手动：npm i -g @larksuite/cli"; fail_env=1; }
    else bad "请先安装：npm i -g @larksuite/cli"; fail_env=1; fi
  else
    bad "未安装 lark-cli（也没找到 npm）：先装 node，再 npm i -g @larksuite/cli"; fail_env=1
  fi
fi

dsh_found=""
for cand in "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
            "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"; do
  [ -x "$cand" ] && dsh_found="$cand" && break
done
if [ -n "$dsh_found" ]; then
  ok "DSH 客户端 CLI：$dsh_found"
elif command -v dsh >/dev/null 2>&1; then
  ok "PATH 上的 dsh：$(command -v dsh)"
else
  info "未找到 DSH（客户端或 CLI）。不影响后面的配置，但跑任务前需要："
  info "  · 安装 DSH macOS 客户端（自动探测），或"
  info "  · 在 config.json 的 dshBin / 环境变量 DSH_BIN 指定 dsh 路径"
fi

[ "$fail_env" -eq 1 ] && { echo; bad "环境未就绪，修完重跑：bash scripts/setup.sh"; exit 2; }

# ---------------------------------------------------------------------------
say "第 2/6 步：飞书机器人应用"
# ---------------------------------------------------------------------------
if [ -f config.json ]; then
  ask "检测到已有 config.json，重新走一遍配置流程吗？（白名单会保留）" "n"
  [ "$ANSWER" = "y" ] || { info "跳过配置，直接进入自检"; SKIP_CFG=1; }
fi

if [ "${SKIP_CFG:-0}" != "1" ]; then
  if [ ! -f config.json ]; then cp config.example.json config.json; ok "已生成 config.json（来自模板）"; fi

  cat <<'CHECKLIST'
  如果还没建飞书机器人应用，照这 5 步做（约 10 分钟，全程网页操作）：
    1. https://open.feishu.cn/app 创建「企业自建应用」，记下 App ID / App Secret
    2. 添加应用能力 → 机器人
    3. 权限管理开通：im:message.p2p_msg:readonly / im:message:send_as_bot / im:message:update
    4. 事件与回调 → 订阅方式选「长连接」→ 添加事件 im.message.receive_v1（回调配置留空）
    5. 版本管理与发布 → 创建版本 → 发布（⚠️ 每次改动都要发布新版本才生效）
CHECKLIST
  ask "应用准备好了吗？" "y"
  [ "$ANSWER" = "y" ] || { bad "先建好应用再回来重跑本向导"; exit 2; }

  # -------------------------------------------------------------------------
  say "第 3/6 步：登记 lark-cli profile"
  # -------------------------------------------------------------------------
  ask "profile 名（= 哪个飞书应用；已存在则直接复用）" "$PROFILE_DEFAULT"
  PROFILE="$ANSWER"

  if lark-cli profile list 2>/dev/null | grep -q "\"$PROFILE\""; then
    ok "profile「${PROFILE}」已存在，复用"
  else
    ask "新 profile 对应的 App ID（cli_ 开头）" ""
    APPID="$ANSWER"
    case "$APPID" in
      cli_*) : ;;
      "") bad "App ID 不能为空（开放平台 → 你的应用 → 凭证与基础信息）"; exit 2 ;;
      *)  bad "App ID 应以 cli_ 开头，收到：$APPID"; exit 2 ;;
    esac
    printf "粘贴 App Secret（输入不回显）："
    read -r -s APPSECRET; printf "\n"
    if [ -z "$APPSECRET" ]; then bad "App Secret 不能为空"; exit 2; fi
    printf '%s' "$APPSECRET" | lark-cli profile add --name "$PROFILE" --app-id "$APPID" --app-secret-stdin \
      && ok "profile「${PROFILE}」已登记（密钥只存在 lark-cli 里）" \
      || { bad "登记失败：检查 App ID / Secret 是否正确后重跑"; exit 2; }
    unset APPSECRET
  fi
  json_set config.json larkProfile "$PROFILE"
  ok "config.json → larkProfile = $PROFILE"
fi

# ---------------------------------------------------------------------------
say "第 4/6 步：接入自检（五项）"
# ---------------------------------------------------------------------------
if [ "${SKIP_CFG:-0}" = "1" ]; then
  PROFILE="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).larkProfile||"")')"
  [ -n "$PROFILE" ] || PROFILE="$PROFILE_DEFAULT"
fi
EXPECT_APPID="$(lark-cli --profile "$PROFILE" auth status 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("appId",""))
except Exception: print("")' 2>/dev/null || true)"
if [ -n "$EXPECT_APPID" ] && [ "$EXPECT_APPID" != "null" ]; then
  export EXPECT_APPID
fi
if ! bash scripts/preflight.sh "$PROFILE"; then
  echo; bad "自检有未通过项，按上面提示修复后重跑：bash scripts/setup.sh"; exit 2
fi

# ---------------------------------------------------------------------------
say "第 5/6 步：取你的 open_id 并自动写入白名单"
# ---------------------------------------------------------------------------
existing="$(node -e 'const c=JSON.parse(require("fs").readFileSync("config.json","utf8"));console.log((c.allowOpenIds||[]).length)')"
if [ "$existing" -gt 0 ]; then
  ask "白名单已有 $existing 个 open_id，还要再添加吗？" "n"
  [ "$ANSWER" = "y" ] || { info "跳过（现有白名单够用）"; SKIP_DISCOVER=1; }
fi

if [ "${SKIP_DISCOVER:-0}" != "1" ]; then
  SECONDS_WAIT=120
  echo "  现在去飞书里给机器人发一条消息（任意内容，比如「你好」）。"
  echo "  观察模式运行 $SECONDS_WAIT 秒，捕获到你的 open_id 会自动写进 config.json："
  mkdir -p state
  node bridge.mjs --discover "$SECONDS_WAIT" 2>&1 | tee state/setup-discover.log | sed 's/^/    /'
  ids="$(grep -oE 'sender=ou_[A-Za-z0-9]+' state/setup-discover.log | cut -d= -f2 | sort -u)"
  my_chat="$(grep -oE 'chat=oc_[A-Za-z0-9]+' state/setup-discover.log | cut -d= -f2 | sort -u | head -1)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    json_allow config.json $ids
    ok "已自动写入白名单：$(echo "$ids" | tr '\n' ' ')"
    if [ -n "$my_chat" ]; then
      json_set_me config.json "$my_chat"
      ok "已把你的私聊登记为推送别名 me（试：node push.mjs --to me --text hi）"
    fi
    info "open_id 是按应用分配的——换飞书应用必须重新 discover"
  else
    bad "没有捕获到来信。检查：应用可用范围是否包含你、事件订阅是否长连接+im.message.receive_v1、是否发布了新版本"
    bad "也可稍后手动：node bridge.mjs --discover 120，把打印的 ou_ 填进 config.json 的 allowOpenIds"
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
say "第 6/6 步：启动方式"
# ---------------------------------------------------------------------------
ask "装成 macOS 常驻服务吗？（开机自启 + 崩溃自动重启）" "y"
if [ "$ANSWER" = "y" ]; then
  bash scripts/install-launchd.sh install && ok "已常驻。日志：tail -f $DIR/state/bridge.log"
else
  cat <<EOF
  手动启动：cd $DIR && node bridge.mjs
  之后想常驻：bash scripts/install-launchd.sh install
EOF
fi

echo
echo "=============================================="
echo " ✅ 安装完成！去飞书给机器人发条消息试试"
echo "    命令：/help 看帮助，/status 看状态"
echo "    推送：node push.mjs --to me --text "你好"  （发到你的私聊）"
echo "=============================================="
