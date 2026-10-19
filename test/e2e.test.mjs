// 端到端测试：用替身（stub-lark-cli / stub-dsh）跑完整链路，不碰网络与模型。
//   假飞书事件 → 准入判定 → 调用 dsh（替身）→ 事件流 → 回复/编辑飞书消息（替身）
// 运行：node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");
const FIXTURES = join(HERE, "fixtures");
const RUN = join(FIXTURES, "run");

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`等待超时：${label}`);
}

test("端到端：白名单消息被处理、陌生人被忽略、答复回原会话", { timeout: 30000 }, async () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const larkRecord = join(RUN, "lark-record.jsonl");
  const dshRecord = join(RUN, "dsh-record.jsonl");

  const child = spawn(process.execPath, [join(PROJECT, "bridge.mjs"), "--config", join(FIXTURES, "config.e2e.json")], {
    cwd: PROJECT,
    env: {
      ...process.env,
      STUB_LARK_EVENTS: join(FIXTURES, "events.json"),
      STUB_LARK_RECORD: larkRecord,
      STUB_DSH_RECORD: dshRecord,
      http_proxy: "http://127.0.0.1:1",
      all_proxy: "socks5://127.0.0.1:1",
      NODE_OPTIONS: "--use-env-proxy"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(
      () => readLines(larkRecord).some((entry) => String(entry.text ?? "").includes("E2E-答复")),
      20000,
      "最终答复未写回飞书"
    );

    const larkCalls = readLines(larkRecord);
    const dshCalls = readLines(dshRecord);

    // 1) 白名单内的人：先回「⏳」，最后原地编辑成答复
    const ack = larkCalls.find((entry) => entry.kind === "+messages-reply" && entry.text.includes("⏳"));
    assert.ok(ack, "应当先回一条 ⏳ 确认");
    assert.equal(ack.messageId, "om_e2e_1", "确认消息要回复到用户那条消息上");

    const sealed = larkCalls.find((entry) => entry.kind === "+messages-edit" && entry.text.includes("E2E-答复"));
    assert.ok(sealed, "最终答复应当通过编辑原地呈现");
    assert.equal(sealed.messageId, "om_reply_stub_1", "编辑的是桥自己发的那条消息");
    assert.match(sealed.text, /你好，帮我回个话/, "prompt 应当原样送达 agent");

    // 2) 白名单外的人：整条链路都不该出现他的内容
    assert.equal(
      larkCalls.some((entry) => JSON.stringify(entry).includes("陌生人")),
      false,
      "陌生人的消息不得触发任何飞书发送"
    );
    assert.equal(
      dshCalls.some((call) => JSON.stringify(call).includes("陌生人")),
      false,
      "陌生人的消息不得进入 agent"
    );

    // 3) dsh 调用参数：走 headless + --json + 补丁层，权限与遥测由桥下发
    assert.equal(dshCalls.length, 1, "只应有一次 agent 调用");
    const call = dshCalls[0];
    assert.deepEqual(call.args.slice(0, 2), ["--profile", "headless"]);
    assert.ok(call.args.includes("--patch"), "必须带 --patch 补丁层");
    assert.ok(call.args.includes("--json"), "必须用 --json 事件流");
    assert.equal(call.args.at(-1), "-", "prompt 从 stdin 传入");
    assert.equal(call.permissionMode, "workspace-write");
    assert.equal(call.telemetryMode, "DISABLED");
    assert.equal(call.cwd, join(RUN, "workspace"), "agent 的工作目录应当是隔离 workspace");

    // 4) 非文本消息：回提示、不进 agent
    assert.ok(
      larkCalls.some((entry) => entry.kind === "+messages-reply" && String(entry.text).includes("只处理文本消息")),
      "图片消息应收到提示"
    );

    // 5) 事件消费进程的 stdin 必须保持打开（真实 lark-cli 把 stdin EOF 当关闭信号）
    assert.equal(
      larkCalls.some((entry) => entry.kind === "stdin-eof"),
      false,
      "桥不能关闭消费进程的 stdin，否则消费进程会立刻退出、永远收不到事件"
    );

    // 6) 代理变量必须被剥掉（否则失效代理会让 lark-cli 连不上飞书）
    const consume = larkCalls.find((entry) => entry.kind === "consume");
    assert.ok(consume, "应当启动事件消费");
    assert.equal(consume.proxy, null, "http_proxy 应被剥掉");
    assert.equal(consume.allProxy, null, "all_proxy 应被剥掉");
    assert.equal(consume.nodeOptions, null, "NODE_OPTIONS 应被剥掉");

    // 7) 会话号落盘，供下次续跑
    const state = JSON.parse(readFileSync(join(RUN, "state.json"), "utf8"));
    assert.equal(state.chats["oc_e2e_chat"], "session-stub-0001");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (existsSync(RUN)) rmSync(RUN, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("unhandled"), false, stderr);
});

test("端到端：/new 清掉会话、/whoami 回 open_id", { timeout: 30000 }, async () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const larkRecord = join(RUN, "lark-record.jsonl");
  const events = join(RUN, "events.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(events, JSON.stringify([
    { type: "im.message.receive_v1", message_id: "om_cmd_1", chat_id: "oc_cmd", chat_type: "p2p", sender_id: "ou_test_user", sender_type: "user", message_type: "text", content: "/whoami" },
    { type: "im.message.receive_v1", message_id: "om_cmd_2", chat_id: "oc_cmd", chat_type: "p2p", sender_id: "ou_test_user", sender_type: "user", message_type: "text", content: "/new" }
  ]));

  const child = spawn(process.execPath, [join(PROJECT, "bridge.mjs"), "--config", join(FIXTURES, "config.e2e.json")], {
    cwd: PROJECT,
    env: { ...process.env, STUB_LARK_EVENTS: events, STUB_LARK_RECORD: larkRecord, STUB_DSH_RECORD: join(RUN, "dsh.jsonl") },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitFor(() => readLines(larkRecord).filter((e) => e.kind === "+messages-reply").length >= 2, 15000, "命令未回复");
    const calls = readLines(larkRecord);
    const textOf = (entry) => String(entry.text ?? "");
    assert.ok(calls.some((e) => textOf(e).includes("ou_test_user")), "/whoami 应回 open_id");
    assert.ok(calls.some((e) => textOf(e).includes("已开启新会话")), "/new 应确认");
    assert.equal(readLines(join(RUN, "dsh.jsonl")).length, 0, "命令不应触发 agent 调用");
    const statePath = join(RUN, "state.json");
    const chats = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).chats : {};
    assert.deepEqual(Object.keys(chats), [], "/new 后不应留下会话映射");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (existsSync(RUN)) rmSync(RUN, { recursive: true, force: true });
  }
});
