# GitHub PR 事件实现计划

> 按 superpowers:executing-plans 在当前 Fork 功能分支逐项实施。

**目标：** 本机保存的例行任务可由签名 GitHub PR 事件触发，并让原任务准确取得仓库、编号和该次提交身份。

**架构：** 扩展现有 `/hooks/github/{routineId}`，继续由原 Pi `receiveEvent` 保存匹配、发生项和去重回执。只投影已校验的机器字段；不引入连接器服务、运行时或新依赖。

**技术：** Node.js 原生 HTTP/crypto、TypeScript、Pi 1.4.0。

**Spec：** [个人助手能力对照](../../specs/2026-11-24-assistant-capability-parity.md)。现有 Issue 行为保持。

**源码参考：** [Rakazo PR 事件与动作列表](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L25)、[PR 编号、状态及 SHA 投影](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L93)、[机器字段数据边界](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/messaging/inbound-delivery.prompt.ts#L43)。只独立实现该机制，不复制外部运行时。

## 契约与修改范围

- 原签名入口允许 `pull_request.opened`、`pull_request.reopened`、`pull_request.synchronize`、`pull_request.closed`、`pull_request.ready_for_review`；规则仍固定一种事件及小写仓库，可用 `merged`、`draft` 等标量作已有精确匹配。
- 原始正文的 HMAC、1 MiB、严格 UTF-8/JSON、配置授权和正文哈希去重继续生效。事件类型不匹配返回未接受，不借用 Issue 规则触发 PR。
- 从签名正文校验仓库、正整数编号、40 或 64 位十六进制 `headSha`/`baseSha`、布尔 `draft`/`merged`。编号来自 `pull_request.number`，如顶层也有编号则必须一致；规范化 SHA 和仓库为小写。缺失或错误字段返回 400，不能降为普通无元数据任务。
- 元数据为 `{ repository, number, headSha, baseSha, draft, merged }`，保存在 Pi 事件身份及任务的可选 `routinePullRequest`。事件类型仍由原发生项保留。标题、正文、分支名及 URL 不进入模型指令或本机路径。
- 原任务创建哈希包含此元数据，响应丢失、追加消息和 daemon 重启保留它。更新 SHA 的新正文形成新发生项；相同正文重投不得重复任务。
- 只接收入站事件，不评论 PR、不推代码、不更改 GitHub 设置。公开 feed 轮询仍只处理 Issue；不声称跨投递渠道去重或真实外网验收。

**文件：** `src/github-routine-events.ts` 放最小投影类型与校验；`src/github-webhook.ts` 扩展解析及规则选择；`src/routines.ts` 在原事件身份固定元数据；`src/runtime.ts` 在原创建、哈希和提示路径传递；`src/cli.ts` 更新提示。测试沿用 `test/github-webhook.test.ts` 的真实 HTTP/daemon 夹具，Spec 与既有架构笔记同批同步。

## 实施与验证

- [x] 写失败 HTTP 集成回归：PR 打开受理、已校验字段进入原模型提示、正文等不进入；重投及重启沿用同一任务。
- [x] 覆盖更新 SHA 的新事件、关闭/合并过滤、未知动作忽略、Issue 与 PR 规则不混用。
- [x] 覆盖错误 SHA/布尔/编号、跨仓库过滤、签名不通过、暂停和修订竞态。复用原入口的共享边界测试。
- [x] 实现最小字段校验和原 Pi 任务传递，不改变旧创建哈希或旧 Issue 元数据。
- [x] 运行 GitHub、事件和任务相关回归、类型及构建；完整 `npm test`、凭据和笔记检查。
- [x] 记录实际验证与限制，提交推送 Fork 功能分支，不创建上游 PR。

## 评审关注

同编号不同提交不能沿用旧任务；同正文不同未签名 header 不能绕过去重；规则编辑后不能受理旧修订；外部字段不得变成本机路径或授权；新增可选字段不得改变历史任务恢复。

## 验证记录

新增前三项 PR HTTP 回归先在未实现时分别因未受理或未校验失败。实现后 GitHub、事件和原入口 28 项通过；补充不可信分支/URL 和本机直投错误元数据断言后，5 项 PR 场景再次通过。完整 `npm test` 共 399 项：395 通过、0 失败、4 项 Office 样例因可选依赖缺失跳过。类型检查、构建、CLI 帮助、提交候选检查和三项笔记校验通过。

主会话检查生产差异及原创建/恢复路径。独立审查任务正文不可读，审查未执行，没有独立审查结论；自动审查依赖的 TruffleHog 在本机缺失。真实 GitHub、HTTPS 代理、外部账号及实际模型任务效果未验收；测试使用本地签名 HTTP 和脚本化模型，不发送外部消息。
