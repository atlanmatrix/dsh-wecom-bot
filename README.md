# DSH Wecom Bot

在 DeepSeek Harness 左侧菜单显示 **Wecom Bot**。点击后配置企业微信智能机器人，连接后在企微聊天，并随时回到 DSH 原生会话页 review 完整消息、模型回复和工具调用。

采用企业微信官方 SDK 的 WebSocket 长连接，无需公网回调地址。支持 DSH **0.2.2-rc.1**、Node.js **24.9+**。

## 安装与配置

1. 在仓库根目录运行：

   ```sh
   npm ci
   npm run build
   ```

2. 在 Harness 插件管理器中安装本地仓库绝对路径。例如，在提供 `plugin_manager` 的 Harness 会话中，使用 `action: install_bundle`、`target: /workspace/dsh-wecom-bot`。在其他机器上替换为实际路径。
3. 更新时先卸载旧插件再安装新版本，避免包管理器保留旧来源链接。安装或更新后重启 Harness，左侧将出现 **Wecom Bot**。
4. 点击菜单，填写企业微信 **API 模式 / 长连接**智能机器人的 **Bot ID**、**Secret**，填写工作目录；模型沿用 DSH 自己的会话设置。可填写允许访问机器人的企微用户 ID，每行一个；留空允许所有能联系机器人的用户。
5. 点击 **保存配置**，再点击 **连接机器人**。状态变为“已连接”后即可在企微中单聊或群内 @机器人。

**尚未配置时插件也会正常加载。** 不再要求设置 `WECOM_BOT_ID` 和 `WECOM_BOT_SECRET` 环境变量。Secret 由 Harness 凭据服务持久化，页面只显示“已配置”，不会回传原值；修改其他字段时 Secret 留空即可保留。更换 Bot ID 时必须同时输入新的 Secret。

机器人通过与 DSH UI 相同的 Session Controller 接口创建、恢复会话并提交消息，不再单独配置 Provider 或模型。新会话继承 DSH 默认模型、预设、工具与权限；已有会话保留其模型选择。在对应 DSH 会话中切换模型后，后续企微消息使用该选择，插件不会重置。模型凭据始终由 DSH 管理。

## 在 DSH 中 review 对话

打开 **Wecom Bot → 机器人对话**，每个条目显示用户、群组和 DSH session ID。点击 **在 DSH 中 review**，打开 DSH 原生会话界面，查看完整上下文、模型回复和工具调用。页面每 3 秒更新会话列表，也可手动刷新。

生成的 session 是普通 DSH 根会话，使用所选工作目录，并通过 DSH 的 session title 服务命名为 `Wecom · 用户 ID · 群 ID`。会话创建与 Workspace 关联由 DSH 原生会话接口处理，相应工作目录也会注册为 Workspace，因此可以从 DSH 常规会话列表浏览它们。

### Session 隔离规则

| 企微使用场景 | Session |
| --- | --- |
| 用户 A 与机器人单聊 | 独立 session A |
| 用户 B 与机器人单聊 | 独立 session B |
| 用户 A 在群 X 中聊天 | 独立 session A/X |
| 用户 A 在群 Y 中聊天 | 独立 session A/Y |
| 用户 B 在群 X 中聊天 | 独立 session B/X |

完整路由键包含 **Bot ID、会话类型、群 ID、用户 ID**。同一路由按顺序处理，不同路由不会共用模型历史。插件持久化路由到 DSH session 的映射，断开、重新连接或 Harness 重启后仍使用原 session。会话日志由 profile 的标准 Session Persistence 保存，恢复历史需要该服务；默认 Web/Desktop profile 已提供。

切换到不同机器人后会使用不同路由，已有对话仍保留在列表中供 review。不要在同一台机器的不同 profile 中复用自定义 `dataDir`。

## 配置保存与连接状态

- Bot 配置与 Secret 使用 DSH 官方 credential record，按 profile 隔离。连接状态保存在该记录中；正常重启后会自动重连先前已启用的机器人。主动断开后保持断开。
- 会话映射保存于 `<DSH_PROFILE_DIR>/wecom-bot/sessions.json`，不包含 Secret。未使用 profile 启动时，使用 `<DSH_HOME>/profiles/default/wecom-bot/`。
- 插件普通 Config 仅提供 `dataDir`、`timeoutMs`（默认 120000，最大 240000）、`maxSessions`（默认 100 个活跃会话）、`maxPending`（默认每会话 10 条待处理消息）。Bot 信息从菜单页配置。
- 保存配置会先停止旧连接，需要点击“连接机器人”应用新配置。没有认证成功前不会显示“已连接”。
- 只有 Harness owner 可读取机器人配置、查看会话目录或修改连接。非 owner 的共享客户端不能调用该插件控制接口。Secret 不进入模型工具参数或返回值。

网络需允许 `wss://openws.work.weixin.qq.com` 和所选模型的 API 域名。支持继承的 `HTTPS_PROXY` / `https_proxy`，保留 TLS 校验。企微 WebSocket 认证使用实际 Secret，不支持仅替换 HTTPS 请求头的代理密钥占位符。

## 消息行为

- 目前接收文本消息；不接入图片、语音、文件和卡片。
- 先回复“正在处理”，模型完成后在同一 stream 中发送最终 Markdown，暂不逐 token 转发。
- 超时会取消 agent 当前工作；错误回复不包含内部异常、消息内容或凭据，不自动重试模型执行。
- 使用 `msgid` 在内存中去重 10 分钟，最多 10000 条；去重状态在进程重启后清空。
- 超过企微 20480 UTF-8 字节的回复安全截断并提示；完整回复仍可在 DSH 中 review。
- 不处理原生斜杠控制命令或人工审批交互，输入作为普通用户消息交给模型。

## 可选群 Webhook 通知

`dsh-wecom-bot/webhook` 是独立、默认不启用的 Cordis 插件，提供 `wecom_send` 工具，仅向旧式群机器人发送文本和 Markdown。它与本页的智能机器人双向聊天无关。配置其 `webhookEnv` 指向 Webhook URL 的进程变量即可；文本支持 @成员。文本最多 2048 UTF-8 字节，Markdown 最多 4096 字节，不自动重试。

## 开发与验证

```sh
npm ci
npm run build
npm run check
npm test
npm run test:browser
npm pack --dry-run
```

`DSH_CLI=/absolute/path/to/dsh npm run test:dsh` 可运行完整 DSH Web 验收：在临时 profile 中加载真实侧栏、插件和确定性模型，验证菜单、会话隔离及原生 transcript review，并在结束后清理进程与文件。未设置 `DSH_CLI` 时此可选测试跳过。

`test:browser` 使用本机 Chromium，默认 `/usr/bin/chromium`，其他位置可设置 `CHROMIUM_PATH`。

测试覆盖官方企微 SDK、本地 WebSocket、真实 DSH AgentLoop、配置 RPC、凭据落盘与 Secret 脱敏、用户权限、五种隔离路由、真实 JSONL session 恢复、标题、超时、配置页表单和 review 导航。模型使用确定性测试适配器，不调用真实模型，也不向企业微信联系人发送测试消息。已用 DSH Web 的实际侧栏检查菜单与页面加载；真实机器人认证仍需用户自己的 Bot ID 和 Secret。

## 0.2.2：凭据 ID 修复与恢复

0.2.1 及之前版本直接把目录哈希作为 DSH 凭据 ID。哈希可能以数字开头，而 DSH 要求 ID 以字母开头，可能导致凭据加载失败、DSH 无法重启。0.2.2 使用官方 `credentialKey()` 和合法的 `profile-` 前缀；仍可读取的旧记录会自动迁移。

如果旧版本已经写入非法记录，凭据服务会先于插件启动失败，因此仅更新插件不能修复磁盘上的旧记录。请停止 DSH，在插件仓库中执行：

```sh
# 使用 credentials-local 实际配置的文件路径；默认是 $DSH_HOME/.credentials.yaml。
npm run repair:credentials -- --check /absolute/path/to/.credentials.yaml
npm run repair:credentials -- /absolute/path/to/.credentials.yaml
```

修复只重命名本插件旧格式的记录 ID，不修改 Secret、其他插件记录或模型凭据。写入前会生成权限为 `0600` 的备份；存在新旧记录冲突时会拒绝覆盖。命令只输出修改条数和备份路径，不输出凭据值。安装包也包含 `scripts/repair-credentials.mjs`，可在已安装插件目录中用 Node 运行同一个脚本。

已增加安装包级别的浏览器回归：

```sh
DSH_CLI=/absolute/path/to/dsh npm run test:installed
```

此测试在全新 profile 通过官方 CLI 安装 `.tgz`，通过浏览器保存配置，模拟不可写的凭据存储，最后完整重启 DSH 验证配置恢复。测试特意选择旧哈希以数字开头的路径，不使用源码软链接或模拟 Host。设置 `DSH_TEST_ARTIFACTS` 可保留截图与不含密钥的报告。临时环境只配置一个可写的 Documents 目录，机器人不连接真实企业微信。

## 从 0.2.0 升级

更新插件后，菜单不再显示 Provider 和模型字段。旧 Bot 配置中的这两个字段会自动移除，Bot ID、Secret、连接状态与 session 映射保留。已经写入 DSH session 的模型选择保持不变，可在 DSH 原生会话页修改。断开机器人不会销毁 DSH 会话。

## 从 0.1.0 升级

重新构建并更新插件后重启 Harness，点击 **Wecom Bot** 重新保存 Bot 信息。0.1.0 的进程变量和插件配置中的 `botIdEnv` / `secretEnv` 不再用于启动连接。旧版本没有保存路由映射，因此其历史 session 不会自动绑定到新机器人的路由；历史日志仍由 DSH 保留。
