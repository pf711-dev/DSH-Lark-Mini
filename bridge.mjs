#!/usr/bin/env node
// lark-dsh-mini —— 精简自用版「飞书 ⇄ 本机 DSH」桥（单文件、零第三方依赖）
//
// 为什么是「旁路进程」而不是 DSH 插件：
//   1. 零依赖：只用 Node 内置模块 + 本机已有的两个 CLI（lark-cli、dsh），
//      不往 DSH harness 里安装任何第三方代码；
//   2. 最小权限：桥只会把回答发回「消息来源会话」，不向模型暴露任何外发工具，
//      模型无法把本机内容推到别的群；
//   3. 默认拒绝：allowOpenIds 为空 = 谁都不处理；群聊默认关闭；
//   4. 可审计：单文件、无任何网络上报、日志脱敏、子进程一律不用 shell。
//
// 数据流：
//   lark-cli event consume im.message.receive_v1 --as bot   （飞书长连接，NDJSON）
//     → 归一化 → 允许列表 / 群聊 @ / 去重 判定
//     → dsh --profile headless --patch <overlay> --json [--session-id <sid>] -   （stdin 传 prompt）
//     → 事件流里取最终答复
//     → lark-cli im +messages-reply / +messages-edit 回原会话（bot 身份）
//
// 用法：
//   node bridge.mjs                 # 常驻（配合 launchd）
//   node bridge.mjs --dry-run       # 不真的发飞书消息，只打印将要发送的内容
//   node bridge.mjs --simulate "你好"   # 喂一条假消息，跑完整链路（仍然发飞书？否，dry-run 语义）
//   node bridge.mjs --once          # 消费一条事件后退出（调试用）
//   node bridge.mjs --help

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  // 飞书侧
  larkCli: "lark-cli",              // lark-cli 可执行文件
  larkProfile: "",                  // lark-cli --profile（空 = 用当前激活 profile）
  larkIdentity: "bot",              // consume/send 用的身份
  stripProxyEnvForLark: true,       // 给 lark-cli 剥掉代理变量（飞书国内直连更稳，见 README 排查）
  allowOpenIds: [],                 // 允许驱动 agent 的用户 open_id（ou_...）；空 = 全部拒绝
  allowChatIds: [],                 // 允许的会话 chat_id（oc_...）；空 = 不限制会话
  pushTargets: {},                  // 单向推送目标别名：{ "dsh群": "oc_xxx" }，供 push.mjs 使用
  allowGroups: false,               // 是否响应群聊（默认只响应单聊）
  botOpenId: "",                    // 机器人的 open_id，仅群聊 @ 判定需要
  groupRequireMention: true,        // 群聊必须 @ 机器人才响应
  ackEnabled: true,                 // 先回一条「⏳ 收到」并原地更新
  progressEnabled: true,            // 用消息编辑展示处理进度
  progressMinIntervalMs: 4000,      // 进度更新节流
  maxReplyChars: 6000,              // 回复截断上限
  maxPromptChars: 12000,            // 入站文本截断上限

  // DSH 侧
  dshBin: "",                       // dsh 可执行文件；空 = 自动探测（见 resolveDshBin）
  dshProfile: "headless",
  dshOverlay: "./dsh-overlay.yml",  // --patch 补丁层
  workspace: "./workspace",         // agent 工作目录（沙箱写入边界）
  permissionMode: "workspace-write", // workspace-write | read-only | danger-full-access
  telemetryMode: "DISABLED",        // DISABLED | FEEDBACK_ONLY
  turnTimeoutMs: 15 * 60 * 1000,    // 单次任务超时

  // 进程
  stateFile: "./state/state.json",
  logFile: "./state/bridge.log",
  restartDelayMs: 5000              // 事件消费进程异常退出后的重启间隔
};

const HELP = `lark-dsh-mini —— 飞书 ⇄ 本机 DSH 精简桥

用法：
  node bridge.mjs [--config <file>] [--dry-run] [--once] [--simulate "<文本>"]
                  [--discover [秒数]] [--help]

  （无参数）        常驻：消费飞书消息 → 跑 DSH → 回原会话
  --dry-run         不真的发飞书消息，只打印将要发送的内容
  --once            消费一条事件后退出（调试）
  --simulate "文本"  喂一条假消息走完整链路（默认干跑，不碰飞书）
  --discover [秒]    只打印来信者的 open_id / chat_id，不执行任何任务（初次配置用）

配置：默认读同目录 config.json；allowOpenIds 为空时桥拒绝启动（有意为之）。
`;

/** 展开 ./ 相对路径（相对配置文件所在目录）。 */
function resolveAgainst(baseDir, value) {
  if (typeof value !== "string" || value === "") return value;
  return value.startsWith(".") ? resolve(baseDir, value) : value;
}

/** 读取并校验配置；缺失文件用默认值。返回 { config, dir }。 */
export function loadConfig(configPath) {
  const file = resolve(configPath);
  const dir = dirname(file);
  let raw = {};
  if (existsSync(file)) {
    raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`配置文件不是对象：${file}`);
    }
  }
  const config = { ...DEFAULTS, ...raw };
  for (const key of ["dshOverlay", "workspace", "stateFile", "logFile", "dshBin", "larkCli"]) {
    config[key] = resolveAgainst(dir, config[key]);
  }
  if (!Array.isArray(config.allowOpenIds) || config.allowOpenIds.some((id) => typeof id !== "string" || !id.startsWith("ou_"))) {
    throw new Error("allowOpenIds 必须是 ou_ 开头的 open_id 数组（默认拒绝一切，这是有意的）");
  }
  if (config.allowGroups && config.botOpenId === "") {
    throw new Error("allowGroups=true 但没有配置 botOpenId：无法判断群里是否 @ 了机器人");
  }
  if (!["workspace-write", "read-only", "danger-full-access"].includes(config.permissionMode)) {
    throw new Error(`permissionMode 非法：${config.permissionMode}`);
  }
  return { config, dir };
}

/**
 * DSH Mac 客户端自带的 CLI 运行时（不需要另外 npm 安装 dsh）。
 * 客户端升级后若路径变化，可用 config.dshBin 或 DSH_BIN 覆盖。
 */
export function bundledDshCandidates(home = homedir()) {
  return [
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh",
    join(home, "Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh")
  ];
}

/** 探测 dsh 可执行文件：config.dshBin > DSH_BIN > 客户端内置 > PATH 上的 dsh。 */
export function resolveDshBin(config, home = homedir()) {
  if (config.dshBin) return config.dshBin;
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  for (const candidate of bundledDshCandidates(home)) {
    if (existsSync(candidate)) return candidate;
  }
  return "dsh";
}

// ---------------------------------------------------------------------------
// 纯逻辑（可单测，不碰网络/子进程）
// ---------------------------------------------------------------------------

/** 把 lark-cli event consume 输出的一条事件归一化。 */
export function normalizeMessage(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const messageId = raw.message_id ?? raw.id;
  const chatId = raw.chat_id;
  if (typeof messageId !== "string" || typeof chatId !== "string") return null;
  return {
    messageId,
    chatId,
    chatType: raw.chat_type === "group" ? "group" : "p2p",
    senderId: typeof raw.sender_id === "string" ? raw.sender_id : "",
    senderType: raw.sender_type === "bot" ? "bot" : "user",
    messageType: typeof raw.message_type === "string" ? raw.message_type : "text",
    text: cleanIncomingText(raw.content),
    mentions: Array.isArray(raw.mentions)
      ? raw.mentions.map((m) => (m && typeof m === "object" ? String(m.id ?? m.open_id ?? "") : "")).filter(Boolean)
      : []
  };
}

/** 清掉 @ 占位符、折叠空白。 */
export function cleanIncomingText(content) {
  return String(content ?? "")
    .replace(/@_user_\d+/g, " ")
    .replace(/<at\s+[^>]*>[\s\S]*?<\/at>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 定长去重（LRU-ish）：返回 true 表示这条消息已经见过。 */
export class Dedupe {
  constructor(limit = 500) {
    this.limit = limit;
    this.set = new Set();
  }

  seen(id) {
    if (this.set.has(id)) return true;
    this.set.add(id);
    if (this.set.size > this.limit) {
      const first = this.set.values().next().value;
      this.set.delete(first);
    }
    return false;
  }
}

/**
 * 准入判定：能不能处理这条消息。返回 { ok, reason }。
 * 默认拒绝——白名单为空、群聊未开启、@ 不到机器人，一律不处理。
 */
export function admit(msg, cfg, dedupe) {
  if (msg === null) return { ok: false, reason: "unparsable" };
  if (dedupe.seen(msg.messageId)) return { ok: false, reason: "duplicate" };
  if (msg.senderType === "bot") return { ok: false, reason: "bot-sender" };
  if (!cfg.allowOpenIds.includes(msg.senderId)) return { ok: false, reason: "sender-not-allowed" };
  if (cfg.allowChatIds.length > 0 && !cfg.allowChatIds.includes(msg.chatId)) return { ok: false, reason: "chat-not-allowed" };
  if (msg.chatType === "group") {
    if (!cfg.allowGroups) return { ok: false, reason: "groups-disabled" };
    if (cfg.groupRequireMention && !msg.mentions.includes(cfg.botOpenId)) return { ok: false, reason: "not-mentioned" };
  }
  if (msg.text === "") return { ok: false, reason: "empty-text" };
  return { ok: true, reason: "allowed" };
}

/** 解析桥内置命令；返回命令名或 null。 */
export function commandOf(text) {
  const first = String(text ?? "").trim().split(/\s+/)[0].toLowerCase();
  return ["/new", "/status", "/whoami", "/help"].includes(first) ? first : null;
}

/** 从 dsh --json 事件流累积进度与最终答复。 */
export class RunCollector {
  constructor(maxProgressLines = 12) {
    this.sessionId = undefined;
    this.finalText = undefined;
    this.errorText = undefined;
    this.progress = [];
    this.maxProgressLines = maxProgressLines;
    this.stepCount = 0;
    this.lastText = "";
    this.calls = new Map(); // callId -> 工具名（tool_call 与 tool_result 配对）
  }

  push(event) {
    if (event === null || typeof event !== "object") return;
    switch (event.type) {
      case "session":
        if (typeof event.sessionId === "string") this.sessionId = event.sessionId;
        break;
      case "status":
        if (event.phase === "step_start") {
          this.stepCount = Number(event.step ?? this.stepCount + 1);
          this.#line(`🔄 第 ${this.stepCount} 步`);
        } else if (event.phase === "turn_end" && event.reason?.kind && event.reason.kind !== "completed") {
          this.errorText = `turn ${event.reason.kind}`;
        }
        break;
      case "text":
        if (typeof event.text === "string" && event.text !== "") this.lastText = event.text;
        break;
      case "thinking":
        break;
      case "tool_call": {
        // 真实事件形如：{"type":"tool_call","callId":"call_x","tool":"bash","input":{"command":"echo hi"}}
        const name = String(event.tool ?? event.name ?? "工具");
        this.calls.set(String(event.callId ?? "?"), name);
        const brief = briefInput(event.input);
        this.#line(`🔧 ${name}${brief === "" ? "" : ` · ${brief}`}`);
        break;
      }
      case "tool_result": {
        const name = this.calls.get(String(event.callId ?? "?")) ?? String(event.tool ?? "工具");
        const ok = event.status === undefined || event.status === "completed" || event.status === "ok";
        const brief = briefText(event.result);
        this.#line(`${ok ? "✅" : "❌"} ${name}${brief === "" ? "" : ` · ${brief}`}`);
        break;
      }
      case "tool": {
        const name = event.name ?? event.tool ?? event.toolName ?? "工具";
        const status = event.status === "error" ? "❌" : event.status === "ok" ? "✅" : "🔧";
        this.#line(`${status} ${String(name).slice(0, 40)}`);
        break;
      }
      case "final":
        if (typeof event.text === "string") this.finalText = event.text;
        break;
      case "error":
        this.errorText = String(event.message ?? event.error ?? "unknown error");
        break;
      default:
        break;
    }
  }

  #line(text) {
    const last = this.progress[this.progress.length - 1];
    if (last === text) return;
    this.progress.push(text);
    if (this.progress.length > this.maxProgressLines) this.progress.shift();
  }

  /** 处理中的进度文本。 */
  progressText() {
    const lines = ["⏳ DSH 正在处理…", ""];
    if (this.progress.length === 0) lines.push("· 启动中…");
    else for (const line of this.progress) lines.push(`· ${line}`);
    if (this.lastText.trim() !== "") {
      lines.push("", "——草稿——", clip(this.lastText.trim(), 400));
    }
    return lines.join("\n");
  }
}

/**
 * 解析推送目标：支持 config.pushTargets 里的别名，也接受直接的 oc_ chat_id。
 * 只接受 oc_（本项目的推送场景是群/会话，不接受 open_id，避免误发单聊）。
 */
export function resolvePushTarget(target, pushTargets = {}) {
  const raw = String(target ?? "").trim();
  if (raw === "") throw new Error("缺少推送目标：--to <别名或 oc_ 开头的 chat_id>");
  const resolved = pushTargets[raw] ?? raw;
  if (!String(resolved).startsWith("oc_")) {
    throw new Error(`推送目标必须是 oc_ 开头的 chat_id（或 config.json pushTargets 里的别名）；收到：${resolved}`);
  }
  return String(resolved);
}

/** 截断文本并说明。 */
export function clip(text, max) {
  const t = String(text ?? "");
  if (!(max > 0) || t.length <= max) return t;
  return `${t.slice(0, max)}\n\n…（已截断，原文 ${t.length} 字）`;
}

/** 工具入参的一行摘要：优先展示命令/路径/查询词，其次压平的 JSON。 */
export function briefInput(input, max = 60) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return briefText(input, max);
  if (typeof input === "object") {
    const candidate = input.command ?? input.path ?? input.file_path ?? input.query ?? input.url;
    if (typeof candidate === "string") return briefText(candidate, max);
    try {
      return briefText(JSON.stringify(input), max);
    } catch {
      return "";
    }
  }
  return "";
}

/** 工具结果的一行摘要：取第一行有效内容并压平。 */
export function briefText(value, max = 60) {
  if (value === null || value === undefined) return "";
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const firstLine = String(text).split("\n").find((line) => line.trim() !== "") ?? "";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * lark-cli 子进程的环境变量：默认剥掉代理相关变量。
 * 原因：飞书是国内服务，直连稳定；带着已失效的代理变量会让 lark-cli 报
 * `proxyconnect tcp: dial tcp 127.0.0.1:7897: connect: connection refused`。
 * 需要走代理访问飞书时，把 stripProxyEnvForLark 设为 false。
 */
export function larkChildEnv(base, stripProxy) {
  if (!stripProxy) return base;
  const env = { ...base };
  for (const key of [
    "http_proxy", "https_proxy", "all_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "NODE_USE_ENV_PROXY", "NODE_OPTIONS"
  ]) {
    delete env[key];
  }
  return env;
}

/** 日志/报错脱敏：抹掉疑似密钥、token、Bearer。 */
export function redact(text) {
  return String(text ?? "")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, "sk-***")
    .replace(/\b(cli_[A-Za-z0-9]{8,})/g, "cli_***")
    .replace(/\b([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})\b/g, "***")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1***")
    .replace(/("?(?:app_?secret|access_?token|refresh_?token|password)"?\s*[:=]\s*)"?[^"\s,}]+"?/gi, "$1\"***\"");
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export class Logger {
  constructor(file, echo = true) {
    this.file = file;
    this.echo = echo;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
  }

  write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${redact(message)}`;
    if (this.file) {
      try {
        appendFileSync(this.file, `${line}\n`);
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
    if (this.echo) (level === "error" ? console.error : console.log)(line);
  }

  info(message) { this.write("info", message); }
  warn(message) { this.write("warn", message); }
  error(message) { this.write("error", message); }
}

// ---------------------------------------------------------------------------
// 状态（chat → DSH session）
// ---------------------------------------------------------------------------

export class StateStore {
  constructor(file) {
    this.file = file;
    this.chats = {};
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object" && typeof parsed.chats === "object") this.chats = parsed.chats ?? {};
    } catch {
      /* 损坏的状态文件按空处理 */
    }
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ chats: this.chats }, null, 2)}\n`);
      renameSync(tmp, this.file);
    } catch {
      /* 状态写失败不致命：下次只是起新会话 */
    }
  }

  sessionFor(chatId) { return this.chats[chatId]; }

  setSession(chatId, sessionId) {
    this.chats[chatId] = sessionId;
    this.save();
  }

  clearSession(chatId) {
    delete this.chats[chatId];
    this.save();
  }
}

// ---------------------------------------------------------------------------
// lark-cli 封装：事件消费 + 发消息
// ---------------------------------------------------------------------------

export class LarkCli {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.env = larkChildEnv(process.env, config.stripProxyEnvForLark);
  }

  #args(rest) {
    const profile = this.config.larkProfile ? ["--profile", this.config.larkProfile] : [];
    return [...profile, ...rest];
  }

  #spawn(rest, { input } = {}) {
    const child = spawn(this.config.larkCli, this.#args(rest), {
      env: this.env,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    if (input !== undefined) {
      child.stdin.end(input);
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    return new Promise((done) => {
      child.on("error", (error) => done({ code: -1, out, err: `${err}${error.message}` }));
      child.on("close", (code) => done({ code, out, err }));
    });
  }

  /** 启动事件消费子进程；onEvent 收到归一化前的事件对象。 */
  consume(eventKey, { onEvent, onExit, once = false }) {
    const args = this.#args(["event", "consume", eventKey, "--as", this.config.larkIdentity]);
    if (once) args.push("--max-events", "1");
    // 注意：lark-cli 的 consume 把「stdin EOF」当成关闭信号（它会打印
    // "[event] stdin closed — shutting down" 然后退出）。所以这里必须用 pipe
    // 且**永不写、永不 end**，进程才会一直挂着收事件；停止靠 SIGTERM。
    const child = spawn(this.config.larkCli, args, { env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => { /* 子进程先退出时忽略 EPIPE */ });
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.startsWith("{")) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.logger.warn(`事件行不是合法 JSON，已跳过：${trimmed.slice(0, 120)}`);
        return;
      }
      // lark-cli 可能包一层 { event: {...} } / { data: {...} }
      onEvent(parsed.event ?? parsed.data ?? parsed);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text !== "") this.logger.info(`[lark-cli] ${text.slice(0, 400)}`);
    });
    child.on("error", (error) => this.logger.error(`事件消费进程启动失败：${error.message}`));
    child.on("close", (code) => onExit(code));
    return child;
  }

  /** 发一条消息到会话（供异常提示用）。 */
  async sendText(chatId, text) {
    return this.#run(["im", "+messages-send", "--as", this.config.larkIdentity, "--chat-id", chatId, "--text", text], "send");
  }

  /** 发一条 markdown 消息（post 富文本；失败退回纯文本）。 */
  async sendMarkdown(chatId, text) {
    const result = await this.#run(
      ["im", "+messages-send", "--as", this.config.larkIdentity, "--chat-id", chatId, "--markdown", text],
      "send-markdown"
    );
    if (result.ok) return true;
    return (await this.#run(
      ["im", "+messages-send", "--as", this.config.larkIdentity, "--chat-id", chatId, "--text", text],
      "send-text"
    )).ok;
  }

  /** 回复某条消息；返回新消息 id（拿不到就是 undefined）。 */
  async reply(messageId, text) {
    const result = await this.#run(
      ["im", "+messages-reply", "--as", this.config.larkIdentity, "--message-id", messageId, "--markdown", text],
      "reply"
    );
    if (result.ok) return result.messageId;
    // markdown 失败（内容里可能有畸形标记）时退回纯文本
    const fallback = await this.#run(
      ["im", "+messages-reply", "--as", this.config.larkIdentity, "--message-id", messageId, "--text", text],
      "reply-text"
    );
    return fallback.ok ? fallback.messageId : undefined;
  }

  /** 编辑自己发过的消息（原地更新进度/终稿）。 */
  async edit(messageId, text) {
    const result = await this.#run(
      ["im", "+messages-edit", "--as", this.config.larkIdentity, "--message-id", messageId, "--markdown", text],
      "edit"
    );
    if (result.ok) return true;
    const fallback = await this.#run(
      ["im", "+messages-edit", "--as", this.config.larkIdentity, "--message-id", messageId, "--text", text],
      "edit-text"
    );
    return fallback.ok;
  }

  async #run(args, label) {
    const { code, out, err } = await this.#spawn(args);
    if (code !== 0) {
      this.logger.warn(`lark-cli ${label} 失败（exit ${code}）：${(err || out).slice(0, 300)}`);
      return { ok: false, out, err };
    }
    return { ok: true, messageId: extractMessageId(out), out, err };
  }
}

/** 从 lark-cli 的 JSON/文本输出里捞 message_id。 */
export function extractMessageId(output) {
  const text = String(output ?? "");
  try {
    const parsed = JSON.parse(text);
    const found = deepFindMessageId(parsed);
    if (found !== undefined) return found;
  } catch {
    /* 不是 JSON，走正则 */
  }
  const match = text.match(/om_[A-Za-z0-9]+/);
  return match ? match[0] : undefined;
}

function deepFindMessageId(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (key === "message_id" && typeof child === "string" && child !== "") return child;
    const nested = deepFindMessageId(child, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// dsh 封装：跑一个 turn，读 --json 事件流
// ---------------------------------------------------------------------------

export class DshRunner {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.bin = resolveDshBin(config);
  }

  /**
   * 跑一次任务。返回 { collector, code, stderr, timedOut }。
   * prompt 通过 stdin 传入（`-`），不走 shell，避免注入与长度限制。
   */
  async run(prompt, { sessionId, onProgress, signal } = {}) {
    const args = ["--profile", this.config.dshProfile];
    if (this.config.dshOverlay && existsSync(this.config.dshOverlay)) {
      args.push("--patch", this.config.dshOverlay);
    }
    // 后面都是 headless app 自己的参数：--json 输出事件流，末位 "-" 表示任务从 stdin 读
    args.push("--json");
    if (sessionId) args.push("--session-id", sessionId);
    args.push("-");

    const collector = new RunCollector();
    const child = spawn(this.bin, args, {
      cwd: this.config.workspace,
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: this.config.permissionMode,
        DSH_TELEMETRY_MODE: this.config.telemetryMode
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdin.end(prompt);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.startsWith("{")) return;
      try {
        collector.push(JSON.parse(trimmed));
      } catch {
        /* 非 JSON 行忽略 */
      }
      onProgress?.(collector);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.logger.warn(`任务超时（${this.config.turnTimeoutMs}ms），终止 dsh 子进程`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
    }, this.config.turnTimeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    const code = await new Promise((done) => {
      child.on("error", (error) => {
        stderr += `\nspawn error: ${error.message}`;
        done(-1);
      });
      child.on("close", (value) => done(value ?? -1));
    });
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    return { collector, code, stderr, timedOut };
  }
}

// ---------------------------------------------------------------------------
// 桥主体
// ---------------------------------------------------------------------------

export class Bridge {
  constructor({ config, logger, lark, state, dsh }) {
    this.config = config;
    this.logger = logger;
    this.lark = lark;
    this.state = state;
    this.dsh = dsh;
    this.dedupe = new Dedupe();
    this.queues = new Map(); // chatId -> { running, pending: [] }
    this.consumer = null;
    this.stopping = false;
    this.dryRun = false;
    this.discoverOnly = false;
    this.lastSendPreview = [];
  }

  /** 干跑：把「将要发送的内容」记下来并打印，不真发。 */
  async #deliver(kind, target, text) {
    if (this.dryRun) {
      this.lastSendPreview.push({ kind, target, text });
      this.logger.info(`[dry-run] ${kind} → ${target}\n${text}`);
      return `dry-${this.lastSendPreview.length}`;
    }
    if (kind === "reply") {
      const messageId = await this.lark.reply(target, text);
      this.logger.info(`已回复 msg=${target} → ${messageId ?? "?"}（${text.length} 字）`);
      return messageId;
    }
    if (kind === "edit") {
      const ok = await this.lark.edit(target, text);
      this.logger.info(`已更新消息 msg=${target}（${text.length} 字，${ok ? "成功" : "失败→补发新消息"}）`);
      return ok ? target : undefined;
    }
    const sent = await this.lark.sendText(target, text);
    this.logger.info(`已发送 chat=${target}（${text.length} 字）`);
    return sent ? target : undefined;
  }

  handleEvent(raw) {
    const msg = normalizeMessage(raw);
    if (this.discoverOnly) {
      if (msg !== null && !this.dedupe.seen(msg.messageId) && msg.senderType === "user") {
        this.logger.info(`来信 sender=${msg.senderId} chat=${msg.chatId} type=${msg.chatType} 内容="${msg.text.slice(0, 40)}"`);
      }
      return Promise.resolve();
    }
    const verdict = admit(msg, this.config, this.dedupe);
    if (!verdict.ok) {
      if (verdict.reason !== "duplicate" && verdict.reason !== "bot-sender") {
        this.logger.info(`忽略消息（${verdict.reason}）chat=${msg?.chatId ?? "?"} sender=${msg?.senderId ?? "?"}`);
      }
      return Promise.resolve();
    }
    if (msg.messageType !== "text" && msg.messageType !== "post") {
      // 目前只实现文本：图片/文件的消息体不是可执行的任务描述，直接回提示更清楚
      this.logger.info(`忽略非文本消息：${msg.messageType} chat=${msg.chatId}`);
      return this.#deliver(
        "reply",
        msg.messageId,
        `📭 当前只处理文本消息（收到：${msg.messageType}）。图片/文件/语音还没做，请把需求写成文字发我。`
      ).then(() => undefined);
    }
    const command = commandOf(msg.text);
    if (command !== null) return this.#handleCommand(msg, command);
    return this.#enqueue(msg);
  }

  async #handleCommand(msg, command) {
    switch (command) {
      case "/new":
        this.state.clearSession(msg.chatId);
        await this.#deliver("reply", msg.messageId, "✅ 已开启新会话，下一条消息会从全新上下文开始。");
        return;
      case "/whoami":
        await this.#deliver("reply", msg.messageId, `👤 open_id: \`${msg.senderId}\`\n💬 chat_id: \`${msg.chatId}\`\n（把 open_id 填进 config.json 的 allowOpenIds 即可授权）`);
        return;
      case "/status": {
        const session = this.state.sessionFor(msg.chatId) ?? "（尚无，下一条消息创建）";
        const queue = this.queues.get(msg.chatId)?.pending.length ?? 0;
        await this.#deliver("reply", msg.messageId, [
          "📊 桥状态",
          `· 会话: \`${session}\``,
          `· 排队: ${queue}`,
          `· 工作目录: \`${this.config.workspace}\``,
          `· 权限模式: ${this.config.permissionMode}`,
          `· dsh: \`${this.dsh.bin}\``
        ].join("\n"));
        return;
      }
      case "/help":
      default:
        await this.#deliver("reply", msg.messageId, [
          "🤖 飞书 ⇄ DSH 精简桥",
          "",
          "直接发消息即可，任务会交给本机 DSH agent 执行，结果回到这里。",
          "",
          "命令：",
          "  /new     开新会话（清空上下文）",
          "  /status  查看会话与工作目录",
          "  /whoami  查看我的 open_id / chat_id",
          "  /help    本帮助",
          "",
          "限制：只处理文本消息；只回复本会话；不会向其他会话推送内容。"
        ].join("\n"));
        return;
    }
  }

  #enqueue(msg) {
    let queue = this.queues.get(msg.chatId);
    if (queue === undefined) {
      queue = { running: false, pending: [] };
      this.queues.set(msg.chatId, queue);
    }
    queue.pending.push(msg);
    return this.#drain(msg.chatId);
  }

  async #drain(chatId) {
    const queue = this.queues.get(chatId);
    if (queue === undefined || queue.running) return;
    queue.running = true;
    try {
      while (queue.pending.length > 0 && !this.stopping) {
        const msg = queue.pending.shift();
        try {
          await this.#runTurn(msg);
        } catch (error) {
          this.logger.error(`turn 异常：${error instanceof Error ? error.message : String(error)}`);
          await this.#deliver("reply", msg.messageId, `💥 处理失败：${redact(String(error?.message ?? error))}`);
        }
      }
    } finally {
      queue.running = false;
    }
  }

  async #runTurn(msg) {
    const startedAt = Date.now();
    this.logger.info(`turn 开始 chat=${msg.chatId} msg=${msg.messageId} 字符=${msg.text.length}`);
    const prompt = clip(msg.text, this.config.maxPromptChars);

    let holder;
    if (this.config.ackEnabled) {
      holder = await this.#deliver("reply", msg.messageId, "⏳ DSH 正在处理…");
    }

    let lastEdit = Date.now(); // 第一条进度也要等满节流窗口
    const onProgress = (collector) => {
      if (!this.config.progressEnabled || holder === undefined) return;
      const now = Date.now();
      if (now - lastEdit < this.config.progressMinIntervalMs) return;
      lastEdit = now;
      void this.#deliver("edit", holder, collector.progressText());
    };

    const sessionId = this.state.sessionFor(msg.chatId);
    const { collector, code, stderr, timedOut } = await this.dsh.run(prompt, { sessionId, onProgress });

    if (collector.sessionId !== undefined && collector.sessionId !== sessionId) {
      this.state.setSession(msg.chatId, collector.sessionId);
    }

    let answer;
    if (timedOut) {
      answer = `⏰ 任务超时（${Math.round(this.config.turnTimeoutMs / 1000)}s）已终止。可以换个更小的任务，或调大 config.json 的 turnTimeoutMs。`;
    } else if (typeof collector.finalText === "string" && collector.finalText.trim() !== "") {
      answer = clip(collector.finalText, this.config.maxReplyChars);
    } else if (code === 0 && collector.lastText.trim() !== "") {
      answer = clip(collector.lastText, this.config.maxReplyChars);
    } else {
      const detail = redact(stderr.split("\n").filter((l) => l.trim() !== "" && !l.includes("node_main.cc")).slice(-3).join(" | "));
      answer = `💥 任务未产出结果（exit ${code}${collector.errorText ? `, ${collector.errorText}` : ""}）${detail ? `\n\`${detail.slice(0, 400)}\`` : ""}`;
    }

    if (holder !== undefined) {
      const ok = await this.#deliver("edit", holder, answer);
      if (ok === undefined) await this.#deliver("reply", msg.messageId, answer); // 编辑失败退回新消息
    } else {
      await this.#deliver("reply", msg.messageId, answer);
    }
    this.logger.info(`turn 结束 chat=${msg.chatId} 用时=${Date.now() - startedAt}ms exit=${code}`);
  }

  async start({ once = false } = {}) {
    mkdirSync(this.config.workspace, { recursive: true });
    this.logger.info(`启动：larkProfile=${this.config.larkProfile || "(激活 profile)"} workspace=${this.config.workspace} dsh=${this.dsh.bin} allow=[${this.config.allowOpenIds.join(",")}] groups=${this.config.allowGroups} permission=${this.config.permissionMode}`);
    const loop = () => {
      this.consumer = this.lark.consume("im.message.receive_v1", {
        once,
        onEvent: (event) => {
          void this.handleEvent(event).catch((error) => {
            this.logger.error(`事件处理异常：${error instanceof Error ? error.message : String(error)}`);
          });
        },
        onExit: (code) => {
          if (this.stopping) return;
          this.logger.warn(`事件消费进程退出（code ${code}），${once ? "单次模式结束" : `${this.config.restartDelayMs}ms 后重启`}`);
          if (!once) setTimeout(loop, this.config.restartDelayMs).unref?.();
        }
      });
    };
    loop();
  }

  stop() {
    this.stopping = true;
    try {
      this.consumer?.kill("SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = { config: "config.json", dryRun: false, once: false, simulate: undefined, discover: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") options.config = argv[++i];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--simulate") options.simulate = argv[++i] ?? "你好";
    else if (arg === "--discover") {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) { options.discover = Number(next); i += 1; }
      else options.discover = 120;
    }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

export function buildBridge({ configPath, dryRun }) {
  const { config, dir } = loadConfig(configPath);
  const logger = new Logger(config.logFile);
  const state = new StateStore(config.stateFile);
  const lark = new LarkCli(config, logger);
  const dsh = new DshRunner(config, logger);
  const bridge = new Bridge({ config, logger, lark, state, dsh });
  bridge.dryRun = dryRun;
  bridge.projectDir = dir;
  return { bridge, config, logger };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { bridge, config, logger } = buildBridge({ configPath: options.config, dryRun: options.dryRun });

  if (options.discover !== undefined) {
    bridge.discoverOnly = true;
    logger.info(`观察模式：${options.discover}s 内只打印来信者信息，不执行任何任务（现在去飞书里给机器人发一条消息）`);
    await bridge.start({});
    setTimeout(() => { bridge.stop(); process.exit(0); }, options.discover * 1000);
    return;
  }

  if (options.simulate !== undefined) {
    // 干跑：喂一条假消息，走完整链路，且不发任何飞书消息 —— 因此不受白名单守卫限制
    bridge.dryRun = true;
    const senderId = config.allowOpenIds[0] ?? "ou_simulated";
    if (config.allowOpenIds.length === 0) config.allowOpenIds = [senderId];
    await bridge.handleEvent({
      type: "im.message.receive_v1",
      message_id: `om_sim_${randomUUID().slice(0, 8)}`,
      chat_id: "oc_sim_chat",
      chat_type: "p2p",
      sender_id: senderId,
      sender_type: "user",
      message_type: "text",
      content: options.simulate
    });
    await new Promise((r) => setTimeout(r, 200));
    logger.info(`模拟完成，共 ${bridge.lastSendPreview.length} 条待发送内容`);
    return;
  }

  if (config.allowOpenIds.length === 0) {
    logger.error("allowOpenIds 为空：为避免任何人都能驱动本机 agent，桥拒绝启动。先跑 `node bridge.mjs --discover 60` 在飞书里给机器人发一条消息，把打印出的 open_id 填进 config.json 再启动。");
    process.exitCode = 2;
    return;
  }


  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      logger.info(`收到 ${signal}，正在退出…`);
      bridge.stop();
      setTimeout(() => process.exit(0), 300).unref?.();
    });
  }
  await bridge.start({ once: options.once });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
  });
}

export { HELP, main };
