# GitHub Issue Webhook 实现计划

**目标：** 已授权的 GitHub 仓库可直接投递新 Issue 事件，触发本机既有规则，不依赖轮询。

**实现边界：** 配置 `githubWebhooks: [{ routineId, secretEnv }]` 显式开启，secret 只从 daemon 环境变量读取。入口为 `POST /hooks/github/{routineId}`，由已配置 HTTPS 代理仅转发该路径；Kada 仍只监听 loopback。默认关闭，不修改部署或 GitHub 仓库设置。

**参考：** [Rakazo GitHub 原始字节验签](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L15)、[正文去重](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L232)、[Suparagent 单独 ingress](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/ingress.py)。安装的 Pi 1.4.0 使用持久任务、事务和固定请求 ID，Kada 的 `receiveEvent` 已在同一事务记录回执和任务受理。

**契约：**

- 按原始正文验证 `X-Hub-Signature-256`，不接受 daemon 令牌作为 Webhook 签名。
- 仅接收 JSON，正文最多 1 MiB，UTF-8 必须有效；校验后读取 `issues/opened`，正文、标题和 URL 不作为 Agent 指令。
- 规则必须匹配 `github`、`issues.opened` 和固定仓库；投影只有小写仓库名、正整数 Issue 编号。更新期间核对规则修订。
- 事件 ID 来自原始正文的 SHA-256，未签名的 delivery ID 不参与去重。相同正文跨重启及丢失响应后仍使用原回执。轮询与 Webhook 是不同投递源，本轮不宣称两种渠道间去重。
- 重放返回简短结果，不泄露规则目标、工作区或 task ID；暂停/撤销/秘钥轮换生效，预算和防重叠继续由原规则处理。

**修改：** 新增 `src/github-webhook.ts` 薄 HTTP 适配和 `test/github-webhook.test.ts`；扩展 `src/config.ts` 与 `src/server.ts`，在原事件受理与任务元数据传递已校验的仓库和编号；更新 Spec 和既有架构笔记，不增加依赖或存储。

- [x] 先写失败集成测试：真实 HTTP 验签、默认关闭、字段过滤、上限、重复投递与 daemon 重启。
- [x] 实现配置和入口，复用原 `receiveEvent`。
- [x] 验证受理后回执丢失、修改 header 的重放、规则暂停、秘钥撤换及越权端点。
- [x] 通过类型、构建、相关/全量测试和提交/笔记校验，提交推送 Fork 功能分支，不创建上游 PR。

**未验证边界：** 外部 GitHub 实际投递、HTTPS 代理部署和跨渠道去重需单独验收。用户后续选择具体仓库与部署方式后，再接真实服务。

## 验证记录

23 项相关回归通过。最终完整 `npm test` 使用现有 `CASE_PYTHON` 指向本机 Python，383 项中 379 项通过、0 失败，4 项 Office 样例因缺少可选依赖跳过。类型检查、构建、凭据扫描和笔记校验通过。

owner CLI 加入并读取合成规则，签名 HTTP 投递返回 202，原任务完成且保留 `team/repo` 的 Issue 42 和原目标。临时服务及数据已通过夹具关闭流程移除。模型协议回归验证原始正文、标题和 secret 不进入提示，原任务重启后追加消息仍能读取对应仓库和编号；公开 feed 的集成回归也验证同一投影。

独立只读审查覆盖初版入口验签、大小、过滤、重放、恢复、secret 轮换和规则修订竞态，未发现可操作问题。之后补充的 Issue 元数据传递经主会话与相关/全量回归验证；独立复核未收到可读任务正文，上一轮结论不覆盖该补充。
## GitHub 事件流可选认证

显式设置 `githubIssueTokenEnv` 后，CLI 同步与后台轮询按原配置读取该环境变量，向固定 GitHub API 发送授权头。匿名请求继续按原事件游标和限流退避处理。已配置的空值或无效值在发请求前报错。 [DuskBot 的 GitHub Bearer 认证](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-tokens/vendors.ts#L73) · [GitHub REST 认证](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)

真实验收从 Rakazo 公开事件中选取较早游标，再用 Kada 的正常 Node 请求同步。Issue #6904 只产生一次本机通知。认证头与凭据轮换使用合成环境变量回归。 [真实公开事件](../../experiments/2026-11-26-github-public-feed.json) · [同步回归](../../../test/github-routine-events.test.ts)
