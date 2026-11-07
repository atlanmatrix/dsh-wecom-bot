# DSH 企业微信智能机器人

通过企业微信**智能机器人长连接模式**与 DeepSeek Harness 双向对话：企微文本消息 → 当前 DSH 的 AgentLoop → 企微流式消息回复。使用企业微信官方 `@wecom/aibot-node-sdk`，无需公网域名、回调服务器、Token 或 EncodingAESKey。

## 安装

需要 Node.js **24.9+**、DeepSeek Harness **0.2.2-rc.1**，以及已配置模型适配器的 DSH profile。该版本的运行时 API 已通过测试；其他版本尚未验证。

1. 在企业微信管理端创建智能机器人，选择 **API 模式 / 长连接**，取得 Bot ID 和 Secret。群 Webhook key 不能用于智能机器人认证。
2. 在**启动 DSH 的进程环境**中设置 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET`。通过部署环境的安全变量设置注入真实值，不要将 Secret 写入仓库、聊天或配置补丁。
3. 若使用 DeepSeek，配置 profile 的 DeepSeek 适配器及其 `DEEPSEEK_API_KEY`。机器人复用 DSH 模型服务，不直接调用模型 API。
4. 在本目录执行 `npm ci`；通过 Harness 的插件管理器安装本地目录 `/workspace/dsh-wecom-bot`。在支持 `plugin_manager` 的 Harness 会话中，使用 `action: install_bundle`、`target: /workspace/dsh-wecom-bot`。在其他机器上使用实际仓库绝对路径。
5. `cordis.patch.yml` 会注册 `wecom-bot`。根据 profile 中实际的 provider ID 和 model 修改该插件的配置，然后启用插件。修改进程环境变量后需重启 DSH。
6. 日志出现 `[wecom-bot] WeCom authenticated.` 后，在企业微信中单聊机器人或在群聊中 @机器人发送文本。

不要将本插件再次安装进它自己创建的子进程：插件直接使用当前 Harness 的 `ctx.agents`，不会启动另一个 DSH。

## 配置

默认值见 `cordis.patch.yml`：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `botIdEnv` | `WECOM_BOT_ID` | 存放 Bot ID 的环境变量名 |
| `secretEnv` | `WECOM_BOT_SECRET` | 存放 Secret 的环境变量名 |
| `provider` | `deepseek` | 当前 DSH 中已配置的模型 provider ID |
| `model` | `deepseek-chat` | 模型名称 |
| `cwd` | DSH 进程工作目录 | 新会话的工作目录，可指定绝对路径 |
| `timeoutMs` | `120000` | 每轮模型处理时限，1–240000 ms |
| `maxSessions` | `100` | 本次插件生命周期内最多创建的会话数 |
| `maxPending` | `10` | 每个会话待处理消息上限（含正在处理的消息） |
| `allowedUsers` | `[]` | 允许访问的企微 userid；空数组表示允许所有能联系机器人的用户 |

生产部署建议设置 `allowedUsers`。机器人创建的 agent 使用该 profile 的全局工具、权限和模型配置；请在 profile 中按用途限制文件、Shell 等能力。插件不接收原生斜杠控制命令，文本作为普通用户消息交给模型处理。

网络需允许 `wss://openws.work.weixin.qq.com`，模型请求还需适配器的 API 域名。插件通过 `HTTPS_PROXY` / `https_proxy` 使用部署提供的代理，保留 TLS 验证。WebSocket Secret 是认证帧内容，需要实际进程变量；仅能替换 HTTPS 请求头的代理占位凭据不适用。

## 行为

- 单聊按用户、群聊按“群 + 用户”隔离历史，同一会话串行执行，不同会话可并行。
- 使用 `msgid` 在内存中去重 10 分钟，最多保留 10000 项。
- 收到文本后先发送“正在处理”，模型执行结束后使用同一个 stream ID 发送最终 Markdown；目前不逐 token 转发。
- 超时取消 agent 当前工作；错误回复不暴露模型异常、消息内容或凭据。不自动重试模型执行或回复。
- SDK 负责认证、心跳和断线重连。插件卸载时断开连接，取消并释放所创建的 agent。
- 超过企微 20480 UTF-8 字节的回复安全截断并加提示。

## 可选：群 Webhook 通知工具

`dsh-wecom-bot/webhook` 是独立的 Cordis 插件，注册模型工具 `wecom_send`，**默认不启用**。它只用于向旧式群机器人发通知，不用于双向对话。

配置此子路径插件的 `webhookEnv: WECOM_BOT_WEBHOOK`、`timeoutMs: 10000`，并在对应进程变量中设置企业微信群机器人 Webhook URL。工具参数为 `content`、可选的 `msgtype: text | markdown`、文本专用的 `mentioned_list` / `mentioned_mobile_list`。文本上限 2048 UTF-8 字节，Markdown 上限 4096 字节。不会自动重试；请遵守企微的机器人频率限制。

## 开发与验证

```sh
cd /workspace/dsh-wecom-bot
npm ci
npm run check
npm test
npm pack --dry-run
```

测试包含本地 WebSocket 服务、企业微信官方 SDK 和**真实 DSH AgentLoop**，模型适配器使用确定性测试实现，不需要密钥，也不会连接真实企业微信或模型服务。另有会话隔离、历史保留、串行处理、去重、用户限制、错误和 Webhook 本地 HTTP 测试。

## 当前限制

仅处理文本消息，暂不接入图片、语音、文件、卡片和人工审批交互。会话映射和去重数据存放在内存，插件或进程重启后开始新的会话；DSH 原有日志是否持久化取决于 profile，但插件不会自动恢复旧会话映射。达到 `maxSessions` 后拒绝创建新会话，可重启插件释放。真实企业微信认证、真实模型推理和插件管理界面仍需使用部署凭据联调。

实现参考官方 DeepSeek Harness 源码提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` 的 `ctx.agents.create`、`Agent.followup`、`Agent.whenIdle`、`session/event` 接口，以及企业微信官方 Node SDK 1.0.7。
