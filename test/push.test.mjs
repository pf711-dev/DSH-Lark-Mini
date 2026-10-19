// 单向推送器（push.mjs）的端到端测试：用替身 lark-cli，不碰网络。
// 运行：node --test test/unit.test.mjs test/e2e.test.mjs test/push.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, "..");
const FIXTURES = join(HERE, "fixtures");
const RUN = join(FIXTURES, "run-push");
const CONFIG = join(FIXTURES, "config.push.json");

function runPush(args, { record } = {}) {
  return spawnSync(process.execPath, [join(PROJECT, "push.mjs"), "--config", CONFIG, ...args], {
    cwd: PROJECT,
    env: { ...process.env, STUB_LARK_RECORD: record ?? "" },
    encoding: "utf8"
  });
}

function readLines(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("推送：别名解析成 chat_id 并把正文交给 lark-cli", () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const record = join(RUN, "record.jsonl");

  const result = runPush(["--to", "test群", "--text", "定时任务：巡检完成，一切正常"], { record });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已推送 → oc_push_target/);

  const calls = readLines(record);
  const send = calls.find((entry) => entry.kind === "+messages-send");
  assert.ok(send, "应当调用 +messages-send");
  assert.equal(send.chatId, "oc_push_target", "别名应解析为配置里的 chat_id");
  assert.equal(send.text, "定时任务：巡检完成，一切正常");
});

test("推送：直接用 oc_ chat_id 也可以", () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const record = join(RUN, "record.jsonl");

  const result = runPush(["--to", "oc_direct_id", "--text", "hi"], { record });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readLines(record).find((e) => e.kind === "+messages-send").chatId, "oc_direct_id");
});

test("推送：非 oc_ 目标直接报错退出（不调用 lark-cli）", () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const record = join(RUN, "record.jsonl");

  const result = runPush(["--to", "ou_someone", "--text", "hi"], { record });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /oc_ 开头/);
  assert.equal(existsSync(record), false, "参数不合法时不应调用 lark-cli");
});

test("推送：--dry-run 只打印不发送", () => {
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  const record = join(RUN, "record.jsonl");

  const result = runPush(["--to", "日报群", "--dry-run", "--markdown", "--title", "【今日日报】", "--text", "正文"], { record });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\] → oc_daily_report（markdown/);
  assert.match(result.stdout, /【今日日报】/);
  assert.equal(existsSync(record), false, "--dry-run 不应调用 lark-cli");
});

test("推送：没有内容时报错退出", () => {
  const result = runPush(["--to", "test群", "--text", "   "]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /没有要发送的内容/);
});

test("推送：--list 列出别名", () => {
  const result = runPush(["--list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test群 → oc_push_target/);
  assert.match(result.stdout, /日报群 → oc_daily_report/);
});

test("--add：parseChats 解析 +chat-list 输出，只留 oc_ 群", async () => {
  const { parseChats } = await import(join(PROJECT, "push.mjs"));
  const good = JSON.stringify({
    ok: true,
    data: { items: [
      { chat_id: "oc_group_a", name: "日报群" },
      { chat_id: "oc_group_b", name: "" },
      { chat_id: "om_not_a_chat", name: "不是群" }
    ] }
  });
  const chats = parseChats(good);
  assert.deepEqual(chats, [
    { id: "oc_group_a", name: "日报群" },
    { id: "oc_group_b", name: "" }
  ]);
  assert.equal(parseChats("not json"), null);
  assert.equal(parseChats(JSON.stringify({ ok: false })), null);
});
