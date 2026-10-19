// 单元测试：桥的纯逻辑（准入判定、解析、脱敏、事件收集）。
// 运行：node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DEFAULTS,
  bundledDshCandidates,
  Dedupe,
  RunCollector,
  admit,
  briefInput,
  briefText,
  cleanIncomingText,
  clip,
  commandOf,
  extractMessageId,
  larkChildEnv,
  loadConfig,
  normalizeMessage,
  redact,
  resolveDshBin
} from "../bridge.mjs";

const CFG = { ...DEFAULTS, allowOpenIds: ["ou_me"], botOpenId: "ou_bot" };

function event(overrides = {}) {
  return {
    type: "im.message.receive_v1",
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "p2p",
    sender_id: "ou_me",
    sender_type: "user",
    message_type: "text",
    content: "你好",
    ...overrides
  };
}

test("归一化：抽取字段并清洗 @ 占位符", () => {
  // 飞书文本里的 <at ...>名字</at> 只是提及标记，提及时整段抹掉
  const msg = normalizeMessage(event({ content: "@_user_1 帮我 <at id=x>机器人</at>  看下 日志" }));
  assert.equal(msg.messageId, "om_1");
  assert.equal(msg.chatId, "oc_1");
  assert.equal(msg.senderId, "ou_me");
  assert.equal(msg.chatType, "p2p");
  assert.equal(msg.text, "帮我 看下 日志");
});

test("归一化：缺 message_id / chat_id 时返回 null", () => {
  assert.equal(normalizeMessage({ chat_id: "oc_1" }), null);
  assert.equal(normalizeMessage({ message_id: "om_1" }), null);
  assert.equal(normalizeMessage(null), null);
});

test("准入：白名单外的人被拒绝", () => {
  const msg = normalizeMessage(event({ sender_id: "ou_stranger" }));
  assert.deepEqual(admit(msg, CFG, new Dedupe()), { ok: false, reason: "sender-not-allowed" });
});

test("准入：白名单为空时谁都不放行（默认拒绝）", () => {
  const msg = normalizeMessage(event());
  const verdict = admit(msg, { ...CFG, allowOpenIds: [] }, new Dedupe());
  assert.equal(verdict.ok, false);
});

test("准入：机器人自己发的消息被忽略", () => {
  const msg = normalizeMessage(event({ sender_type: "bot" }));
  assert.equal(admit(msg, CFG, new Dedupe()).reason, "bot-sender");
});

test("准入：重复消息只处理一次", () => {
  const dedupe = new Dedupe();
  assert.equal(admit(normalizeMessage(event()), CFG, dedupe).ok, true);
  assert.equal(admit(normalizeMessage(event()), CFG, dedupe).reason, "duplicate");
});

test("准入：群聊默认关闭；开启后必须 @ 机器人", () => {
  const group = normalizeMessage(event({ chat_id: "oc_g", chat_type: "group" }));
  assert.equal(admit(group, CFG, new Dedupe()).reason, "groups-disabled");
  const groupCfg = { ...CFG, allowGroups: true };
  assert.equal(admit(group, groupCfg, new Dedupe()).reason, "not-mentioned");
  const mentioned = normalizeMessage(event({ chat_id: "oc_g", chat_type: "group", mentions: [{ id: "ou_bot" }] }));
  assert.equal(admit(mentioned, groupCfg, new Dedupe()).ok, true);
});

test("准入：空文本不触发任务", () => {
  const msg = normalizeMessage(event({ content: "   @_user_1 " }));
  assert.equal(admit(msg, CFG, new Dedupe()).reason, "empty-text");
});

test("准入：allowChatIds 非空时限定会话", () => {
  const cfg = { ...CFG, allowChatIds: ["oc_other"] };
  assert.equal(admit(normalizeMessage(event()), cfg, new Dedupe()).reason, "chat-not-allowed");
});

test("命令解析", () => {
  assert.equal(commandOf("/new"), "/new");
  assert.equal(commandOf("  /status now"), "/status");
  assert.equal(commandOf("/unknown"), null);
  assert.equal(commandOf("普通消息"), null);
});

test("RunCollector：收集最终答复、会话号与进度", () => {
  const collector = new RunCollector(5);
  // 事件形状取自真实 `dsh --profile headless --json` 输出
  collector.push({ type: "session", sessionId: "session-abc", cwd: "/tmp" });
  collector.push({ type: "status", phase: "turn_start", turn: 1 });
  collector.push({ type: "status", phase: "step_start", turn: 1, step: 1 });
  collector.push({ type: "tool_call", callId: "call_1", tool: "bash", input: { command: "echo hi", description: "Echo hi" } });
  collector.push({ type: "tool_result", callId: "call_1", status: "completed", result: "hi\n" });
  collector.push({ type: "text", text: "草稿" });
  collector.push({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
  collector.push({ type: "final", text: "最终答复" });
  assert.equal(collector.sessionId, "session-abc");
  assert.equal(collector.finalText, "最终答复");
  const progress = collector.progressText();
  assert.match(progress, /第 1 步/);
  assert.match(progress, /🔧 bash · echo hi/);
  assert.match(progress, /✅ bash · hi/);
  assert.match(progress, /草稿/);
});

test("工具摘要：命令优先、结果取首行、超长截断", () => {
  assert.equal(briefInput({ command: "ls -la" }), "ls -la");
  assert.equal(briefInput({ path: "/tmp/a.txt" }), "/tmp/a.txt");
  assert.equal(briefInput({ foo: "bar" }), '{"foo":"bar"}');
  assert.equal(briefInput(undefined), "");
  assert.equal(briefText("第一行\n第二行"), "第一行");
  assert.equal(briefText("x".repeat(80)).length, 61);
});

test("RunCollector：turn 异常退出会记录错误", () => {
  const collector = new RunCollector();
  collector.push({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error" } });
  assert.equal(collector.errorText, "turn error");
});

test("lark-cli 环境：剥掉代理变量，但不动其他变量", () => {
  const base = {
    PATH: "/usr/bin",
    http_proxy: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    all_proxy: "socks5://127.0.0.1:7897",
    NODE_OPTIONS: "--use-env-proxy",
    HOME: "/Users/x"
  };
  const stripped = larkChildEnv(base, true);
  assert.deepEqual(Object.keys(stripped).sort(), ["HOME", "PATH"]);
  assert.equal(larkChildEnv(base, false), base);
});

test("dsh 可执行文件探测：config > 客户端内置 > PATH 回退", () => {
  const fakeHome = "/tmp/fake-home";
  assert.deepEqual(bundledDshCandidates(fakeHome), [
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    "/tmp/fake-home/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  ]);
  assert.equal(resolveDshBin({ dshBin: "/custom/dsh" }, fakeHome), "/custom/dsh");
  const auto = resolveDshBin({ dshBin: "" }, fakeHome);
  assert.ok(
    auto === "dsh" || auto.endsWith("runtime/cli/bin/dsh"),
    `自动探测结果异常：${auto}`
  );
});

test("截断与脱敏", () => {
  assert.equal(clip("abcdef", 10), "abcdef");
  assert.match(clip("abcdef", 2), /已截断/);
  assert.equal(redact("key sk-abcdefghijkl"), "key sk-***");
  assert.equal(redact("app_secret=abcdef123456"), 'app_secret="***"');
  assert.match(redact("Authorization: Bearer abc.def-ghi"), /Bearer \*\*\*/);
});

test("extractMessageId：从 JSON 与纯文本里取 message_id", () => {
  assert.equal(extractMessageId('{"ok":true,"data":{"message_id":"om_abc123"}}'), "om_abc123");
  assert.equal(extractMessageId("sent: om_xyz789 done"), "om_xyz789");
  assert.equal(extractMessageId("no id here"), undefined);
});

test("配置校验：白名单必须是 ou_ 数组、群聊必须有 botOpenId", () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-mini-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ allowOpenIds: ["bad-id"] }));
  assert.throws(() => loadConfig(file), /allowOpenIds/);

  writeFileSync(file, JSON.stringify({ allowOpenIds: ["ou_me"], allowGroups: true }));
  assert.throws(() => loadConfig(file), /botOpenId/);

  writeFileSync(file, JSON.stringify({ allowOpenIds: ["ou_me"], permissionMode: "yolo" }));
  assert.throws(() => loadConfig(file), /permissionMode/);

  writeFileSync(file, JSON.stringify({ allowOpenIds: ["ou_me"], workspace: "./ws", stateFile: "./s.json" }));
  const { config } = loadConfig(file);
  assert.equal(config.workspace, resolve(dir, "ws"));
  assert.equal(config.stateFile, resolve(dir, "s.json"));
});
