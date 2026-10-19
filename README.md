# dsh-lark-mini

dsh-lark-mini 是一个飞书和本地电脑 DeepSeek Harness 的极简连接工具。

## 实现方式
dsh-lark-mini 不直接连飞书，而是在飞书官方的 lark-cli 和 DeepSeek Harness 之间建立连接，对外将飞书事件流翻译成受控制的任务队列，对内管理 DeepSeek Harness 子进程的生命周期，并将执行进度以有限的方式传达给飞书消息。

## 安装

### 1. 环境要求

- macOS + Node.js ≥ 20
- [lark-cli](https://github.com/larksuite/cli)：`npm i -g @larksuite/cli`
- DeepSeek Harness 客户端（自动使用其内置 CLI，无需另装 dsh）

### 2. 创建飞书机器人

到 [open.feishu.cn/app](https://open.feishu.cn/app)：

方式一：一键创建飞书智能体应用（优选）
![创建飞书智能体应用](image.png)

方式二：创建企业自建应用
1. 创建企业自建应用，添加「机器人」能力
2. 开通权限：`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:message:update`
3. 事件订阅选「长连接」，添加事件 `im.message.receive_v1`
4. 创建版本并发布——此后应用的每次改动都要重新发布才生效


### 3. 快捷安装

```bash
bash scripts/setup.sh
```

向导会完成：
1. 环境检查：缺什么给安装命令；
2. 应用登记：密钥只存本机 lark-cli；
3. 生成 config；
4. 五项接入自检；
5. 你在飞书给机器人发一条消息，它自动把你的 open_id 写入白名单；
6. 可选装成开机自启的常驻服务。中途出错，修复后重跑即可续上。

### 4. 手动安装

```bash
lark-cli profile add --name dsh-bot --app-id cli_你的AppID --app-secret-stdin
bash scripts/preflight.sh dsh-bot        # 五项自检，缺什么它会直说
cp config.example.json config.json       # 编辑 larkProfile 与 allowOpenIds
node bridge.mjs --discover 120           # 去飞书发条消息，把打印的 ou_ 填进白名单
node bridge.mjs                          # 启动
```

## 使用

在飞书里直接发文本消息即可，每个飞书会话对应一个持久的 DSH session，桥重启不丢，`/new` 重置。

| 命令 | 作用 |
|------|------|
| `/new` | 清空上下文，开新会话 |
| `/status` | 查看会话、工作目录、权限 |
| `/whoami` | 查看你的 open_id / chat_id |
| `/help` | 帮助 |

常驻服务：`bash scripts/install-launchd.sh install`（开机自启、崩溃自动重启）。同一时间只能跑一个实例，跑两个会表现为「有时不回」。

## 推送（可选）

让 Mac 主动把消息发到飞书：定时任务跑完发个通知、脚本执行完报个结果。安装向导已把你的私聊登记为别名 `me`，无需配置：

```bash
node push.mjs --to me --text "任务跑完了"
echo "脚本输出" | node push.mjs --to me      # 管道读入，适合定时任务
```

想让结果发到群里（比如每日巡检日报），把机器人拉进群后再跑一条命令：

```bash
node push.mjs --add       # 列出机器人所在的群，选一个、起个别名，自动写入配置
node push.mjs --to 群别名 --markdown --title "【今日巡检】" --text "**全部正常**"
```

> 推送只用已开通的发消息权限，不用发新版本；群成员 @ 机器人不会有任何反应（它进群只为发结果）。`--add` 列群需要一次性开通「群信息只读」权限，命令会给出申请链接；不开也可以手动把群的 chat_id 填进 `config.json` 的 `pushTargets`。

## 边界

- 只处理**文本**消息，图片 / 文件 / 语音暂不支持
- 写入限制在 `workspace/` 目录，读取不受限（DSH 沙箱语义）
- 只回复消息来源会话，模型没有任何外发工具
- 白名单（`allowOpenIds`）之外的人发消息，不回复、不执行
- 需要人工审批的操作在 headless 下直接失败，不会挂起等人
- 每个会话内串行执行，没有全局并发上限


配置项说明见 `config.example.json`；

## 许可证

[MIT](LICENSE)
