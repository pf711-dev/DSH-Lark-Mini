#!/usr/bin/env node
// push.mjs —— 单向推送器：把（定时任务的）结果发到飞书群 / 会话。
//
// 设计要点：
//   · **只发不收**：它不启动事件长连接，不订阅任何事件，跑完即退；
//     所以它和常驻的 bridge.mjs 可以共存，不会出现"双长连接抢事件"。
//   · **不经过 agent**：直接把文本发给指定会话，模型没有任何参与。
//   · 复用 bridge.mjs 的 lark-cli 封装（同一个 profile、同样给 lark-cli 剥代理）。
//
// 用法：
//   node push.mjs --to <别名|oc_xxx> --text "内容"
//   node push.mjs --to <别名> --markdown --text "**粗体** 与 [链接](https://…)"
//   echo "内容" | node push.mjs --to <别名>              # 从 stdin 读（适合管道）
//   node push.mjs --add                                 # 交互式选群并登记别名
//   node push.mjs --list                                # 列出已配置的别名
//   node push.mjs --to <别名> --dry-run --text "内容"    # 只打印不发
//
// 退出码：0 成功；2 参数/配置错误；1 发送失败 —— 便于定时任务据此告警。

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { Logger, LarkCli, larkChildEnv, loadConfig, resolvePushTarget } from "./bridge.mjs";

const HELP = `push.mjs —— 单向推送（定时任务 → 飞书群）

用法：
  node push.mjs --to <别名|oc_xxx> [--markdown] --text "内容"
  echo "内容" | node push.mjs --to <别名> [--markdown]
  node push.mjs --add          交互式：列出机器人所在的群，选一个登记为推送别名
  node push.mjs --list
  node push.mjs --help

选项：
  --to <target>     目标会话：config.json 的 pushTargets 别名，或 oc_ 开头的 chat_id
  --text <内容>      要发送的文本（省略则读 stdin）
  --markdown        以 markdown/post 富文本发送（失败自动退回纯文本）
  --config <file>   配置文件（默认同目录 config.json）
  --title <前缀>     在正文前加一行标题（可选）
  --add             把机器人所在的群登记为推送别名（写回 config.json）
  --dry-run         只打印将发送的内容，不真的发送
`;

/** 读取 stdin（管道用法）。 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function parseArgs(argv) {
  const options = { config: "config.json", to: undefined, text: undefined, markdown: false, dryRun: false, list: false, add: false, help: false, title: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--to") options.to = argv[++i];
    else if (arg === "--text") options.text = argv[++i];
    else if (arg === "--title") options.title = argv[++i];
    else if (arg === "--config") options.config = argv[++i];
    else if (arg === "--markdown") options.markdown = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--add") options.add = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

/** 解析 +chat-list 的 JSON 输出，返回 [{id, name}]；解析失败返回 null。 */
export function parseChats(output) {
  try {
    const parsed = JSON.parse(String(output ?? ""));
    const items = parsed?.data?.items ?? parsed?.items;
    if (!Array.isArray(items)) return null;
    const chats = items
      .map((item) => ({ id: String(item?.chat_id ?? ""), name: String(item?.name ?? "").trim() }))
      .filter((chat) => chat.id.startsWith("oc_"));
    return chats;
  } catch {
    return null;
  }
}

/** 调 lark-cli im +chat-list --as bot，返回 { code, out, err }。 */
function chatListViaCli(config) {
  const args = [];
  if (config.larkProfile) args.push("--profile", config.larkProfile);
  args.push("im", "+chat-list", "--as", config.larkIdentity ?? "bot");
  return new Promise((done) => {
    const child = spawn(config.larkCli ?? "lark-cli", args, {
      env: larkChildEnv(process.env, config.stripProxyEnvForLark !== false),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => done({ code: -1, out, err: `${err}${error.message}` }));
    child.on("close", (code) => done({ code: code ?? -1, out, err }));
  });
}

async function ask(rl, question, fallback = "") {
  const answer = (await rl.question(question)).trim();
  return answer === "" ? fallback : answer;
}

/** --add：列出机器人所在的群 → 选一个 → 起别名 → 写回 config.json。 */
async function addGroupChat({ config, configPath, logger }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("正在获取机器人所在的群…\n");
    const { code, out, err } = await chatListViaCli(config);
    const chats = code === 0 ? parseChats(out) : null;
    if (chats === null || chats.length === 0) {
      const combined = `${out}\n${err}`;
      const reason = code === 0 && chats !== null ? "机器人还不在任何群里" : "调用失败";
      process.stdout.write(`没有获取到群列表（${reason}）。\n`);
      // 从返回体里找缺权限线索，给一键申请链接（lark-cli 把错误 JSON 放在 stderr）
      const missing = combined.match(/"console_url"\s*:\s*"([^"]+)"/);
      if (missing) {
        process.stdout.write("\n这通常是因为应用还没开通「群信息只读」权限（im:chat:readonly）。\n");
        process.stdout.write("用应用管理员身份打开下面的链接，一键申请并发布新版本后重试：\n");
        process.stdout.write(`  ${missing[1]}\n`);
      } else if (code !== 0) {
        process.stdout.write(`lark-cli 报错：${(err || out).slice(0, 300)}\n`);
      }
      process.stdout.write("\n不想开权限也可以手动登记：把群的 chat_id（oc_ 开头）填进 config.json 的 pushTargets。\n");
      process.exitCode = 2;
      return;
    }

    process.stdout.write("\n机器人所在的群：\n");
    chats.forEach((chat, index) => process.stdout.write(`  ${index + 1}. ${chat.name || "（未命名群）"}  ${chat.id}\n`));
    const pick = Number(await ask(rl, "选择要登记的群（输数字）：", ""));
    const chat = Number.isInteger(pick) && pick >= 1 && pick <= chats.length ? chats[pick - 1] : null;
    if (chat === null) {
      process.stdout.write("没有选择任何群，已退出（配置未修改）。\n");
      return;
    }
    const alias = await ask(rl, `推送别名（回车默认用群名「${chat.name || chat.id}」）：`, chat.name || chat.id);

    // 写回 config.json（只改 pushTargets，其他字段原样保留）
    const file = resolve(configPath);
    const disk = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    disk.pushTargets = { ...(disk.pushTargets ?? {}), [alias]: chat.id };
    writeFileSync(file, `${JSON.stringify(disk, null, 2)}\n`);
    process.stdout.write(`\n✅ 已登记：${alias} → ${chat.id}\n`);
    process.stdout.write(`试一下：node push.mjs --to ${alias} --text "hello"\n`);
    logger.info(`pushTargets 登记：${alias} → ${chat.id}`);
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const configPath = options.config;
  const { config } = loadConfig(configPath);
  const logger = new Logger("", false); // 推送器不写日志文件，只回显错误

  if (options.list) {
    const entries = Object.entries(config.pushTargets ?? {});
    if (entries.length === 0) process.stdout.write("（config.json 里还没配置 pushTargets。运行 node push.mjs --add 可以交互式登记群）\n");
    else for (const [alias, chatId] of entries) process.stdout.write(`${alias} → ${chatId}\n`);
    return;
  }

  if (options.add) {
    await addGroupChat({ config, configPath, logger });
    return;
  }

  let chatId;
  try {
    chatId = resolvePushTarget(options.to, config.pushTargets);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  let body = options.text ?? (process.stdin.isTTY ? "" : await readStdin());
  body = String(body).trim();
  if (body === "") {
    process.stderr.write("没有要发送的内容：用 --text \"…\" 或从 stdin 管道传入\n");
    process.exitCode = 2;
    return;
  }
  const text = options.title ? `${options.title}\n${body}` : body;

  if (options.dryRun) {
    process.stdout.write(`[dry-run] → ${chatId}（${options.markdown ? "markdown" : "text"}，${text.length} 字）\n${text}\n`);
    return;
  }

  const lark = new LarkCli(config, logger);
  const ok = options.markdown
    ? await lark.sendMarkdown(chatId, text)
    : (await lark.sendText(chatId, text)).ok === true;
  if (!ok) {
    process.stderr.write(`推送失败 → ${chatId}（看上面的 lark-cli 报错；可用 --dry-run 先自查）\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`已推送 → ${chatId}（${text.length} 字）\n`);
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main };
