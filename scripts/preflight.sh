#!/usr/bin/env bash
# 新机器人应用接入自检（不打印任何密钥）
#
# 用法：bash scripts/preflight.sh [profile名]     默认 dsh-bot
#
# 检查 5 项：profile 存在 / bot 凭据 / im 权限 / 事件订阅（长连接）/ 机器人 open_id
# 与桥保持一致：给 lark-cli 剥掉代理变量（飞书国内直连更稳，见 README 排障）。
set -uo pipefail

PROFILE="${1:-dsh-bot}"
# 可选：用环境变量校验 profile 对应的 App ID（不设置则跳过比对）
EXPECT_APPID="${EXPECT_APPID:-}"

lark() {
  env -u http_proxy -u https_proxy -u all_proxy \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      -u NODE_USE_ENV_PROXY -u NODE_OPTIONS \
      lark-cli --profile "$PROFILE" "$@"
}

pass=0; fail=0
ok()  { echo "  ✅ $1"; pass=$((pass + 1)); }
bad() { echo "  ❌ $1"; fail=$((fail + 1)); }
warn(){ echo "  ⚠️  $1"; }

echo "== 1/5 profile：$PROFILE =="
if lark-cli profile list 2>/dev/null | grep -q "\"$PROFILE\""; then
  ok "profile 存在"
else
  bad "profile 不存在。先跑：lark-cli profile add --name $PROFILE --app-id $EXPECT_APPID --app-secret-stdin"
  echo; echo "自检中止（通过 ${pass}，失败 ${fail}）"; exit 2
fi

echo "== 2/5 bot 凭据 =="
status="$(lark auth status 2>&1)"
appid="$(echo "$status" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("appId",""))' 2>/dev/null)"
botstate="$(echo "$status" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("identities",{}).get("bot",{}).get("status",""))' 2>/dev/null)"
if [ "$botstate" = "ready" ]; then ok "bot 身份 ready"; else bad "bot 身份未就绪（status=${botstate:-读不到}）——检查 App ID / Secret 是否填错"; fi
if [ -n "$appid" ]; then
  if [ -z "$EXPECT_APPID" ]; then
    echo "  ℹ️  appId = ${appid}（设置 EXPECT_APPID=cli_xxx 可在自检时校验是否用对了应用）"
  elif [ "$appid" = "$EXPECT_APPID" ]; then ok "appId = $appid"; else warn "appId = ${appid}（与预期 ${EXPECT_APPID} 不同，确认是不是建错了应用）"; fi
fi

echo "== 3/5 凭据与权限 =="
# 探针用不需要任何 im 权限的接口，只验 tenant token 是否可用；
# 桥真正需要的三个 scope 只能在控制台确认（下面给出直接申请链接）。
probe="$(lark api GET /open-apis/bot/v3/info --as bot 2>&1)"
if echo "$probe" | grep -q '"ok": *true'; then
  ok "tenant token 可用，机器人能力已就绪"
elif echo "$probe" | grep -q 'app do not have bot'; then
  bad "这个应用还没添加「机器人」能力：开放平台 → 你的应用 → 添加应用能力 → 机器人"
elif echo "$probe" | grep -q 'app_scope_not_applied\|missing_scopes'; then
  bad "应用权限未开通（见下方缺失权限与申请链接）"
  echo "$probe" | python3 -c 'import json,sys
try:
    e=json.load(sys.stdin).get("error",{})
    print("     缺失：" + ", ".join(e.get("missing_scopes",[])))
    if e.get("console_url"): print("     申请：" + e["console_url"])
except Exception: pass' 2>/dev/null
else
  bad "tenant token 不可用：$(echo "$probe" | tr -d '\n' | head -c 220)"
fi
# 任何接口返回 missing_scopes 时，直接把申请链接打出来
if echo "$probe" | grep -q 'missing_scopes'; then
  echo "     缺失权限：$(echo "$probe" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(", ".join(d.get("error",{}).get("missing_scopes",[])))
except Exception: print("?")' 2>/dev/null)"
  echo "     一键申请：$(echo "$probe" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin); print(d.get("error",{}).get("console_url",""))
except Exception: print("")' 2>/dev/null)"
fi
echo "     桥需要这三个权限（控制台「权限管理」里搜名字开通，然后发布版本）："
echo "       · im:message.p2p_msg:readonly   收单聊消息（事件）"
echo "       · im:message:send_as_bot        以应用身份发消息（回复）"
echo "       · im:message:update             更新已发送消息（原地刷新）"
# 权威链接：由服务端在错误里返回（lark-cli 规范要求原样转发，不要手工拼接）
probe2="$(lark im +messages-edit --as bot --message-id om_preflight_probe --text "preflight" 2>&1)"
url="$(echo "$probe2" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("error",{}).get("console_url",""))
except Exception: print("")' 2>/dev/null)"
if [ -n "$url" ]; then
  echo "     一键申请（服务端返回，原样使用）："
  echo "     $url"
fi

echo "== 4/5 事件订阅（长连接）=="
# 4a) 连接级实测：能建立长连接并订阅成功（有界运行，5s 后自行退出）
conn="$(lark event consume im.message.receive_v1 --as bot --timeout 5s 2>&1)"
if echo "$conn" | grep -q "ready event_key"; then
  ok "长连接建立成功，已订阅 im.message.receive_v1（连接级）"
else
  bad "长连接没起来：$(echo "$conn" | tr -d '\n' | tail -c 200)"
fi
# 4b) 控制台级 precheck（需要 application:application:self_manage，读不到不算失败）
dry="$(lark event consume im.message.receive_v1 --as bot --dry-run 2>&1)"
python3 - "$dry" <<'PYEOF'
import json, sys
raw = sys.argv[1]
start = raw.find("{")
try:
    data = json.loads(raw[start:]) if start >= 0 else {}
except Exception:
    data = {}
decision = (data.get("data") or {}).get("decision") or {}
if not decision:
    print("  ⚠️  读不到控制台 precheck（不影响使用）")
    raise SystemExit(0)
for item in decision.get("preconditions", []):
    status = item.get("status")
    mark = "✅" if status in ("ready", "ok") else ("⚠️ " if status == "unknown" else "❌")
    print(f"  {mark} {item.get('name')}: {status} — {str(item.get('detail',''))[:110]}")
PYEOF
echo "     注：控制台级只有加了 application:application:self_manage 才读得到；"
echo "         最终判据是真实收发（node bridge.mjs --discover 120 后去飞书发一条消息）。"

echo "== 5/5 机器人自身 open_id（仅群聊 @ 判定需要）=="
echo "     用你的 user 身份搜应用名即可拿到（本机实测）："
echo "       lark-cli contact +search-bot --query \"<应用名或关键词>\" --as user"
echo "     把结果里的 open_id 填进 config.json 的 botOpenId，再把 allowGroups 设为 true。"

echo
echo "通过 $pass 项，失败 $fail 项"
if [ "$fail" -eq 0 ]; then
  allow="$(python3 -c 'import json;print(len(json.load(open("config.json")).get("allowOpenIds",[])))' 2>/dev/null || echo 0)"
  if [ "${allow:-0}" -gt 0 ]; then
    cat <<EOF
全部就绪（config.json 白名单已有 $allow 个 open_id）。直接起桥：
  cd $(pwd) && node bridge.mjs
要常驻（开机自启 + 退出自动重启）：
  bash scripts/install-launchd.sh install
EOF
  else
    cat <<EOF
下一步（白名单还是空的，桥会拒绝启动）：
  1) node bridge.mjs --discover 120   # 然后在飞书里给机器人发一条消息，记下打印的 open_id
  2) 把该 open_id 填进 config.json 的 allowOpenIds
  3) node bridge.mjs
EOF
  fi
else
  echo "先按上面的 ❌ 修完再继续"
fi
