# 例行任务账户拒绝降频实现计划

**目标：** 用户显式启用 `accountBackoff: true` 后，循环项目任务遇到明确的模型账户拒绝不在每个自动时间点继续请求；手动运行可核对账户修复结果。

**源码参考：** [Rakazo 账户拒绝边界](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L37)、[5 分钟倍增至 24 小时](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L60)、[成功后恢复](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L119)。

**Pi 核对：** 安装的 Pi 1.4.0 `ConversationRetryPolicy` 与 `isRetryableAssistantError` 已管理临时错误重试。原提交在失败后保存 `status: unanswered, reason: model_error`；原 `AssistantEntry` 保存最终错误消息和时间。Kada 只读这些回执，不拦截单次请求、不补重试、不另存供应商正文。

**契约：**

- `accountBackoff` 只允许 `true`，只用于有工作区的循环 `task`，不用于 once、event 或混合事件规则。默认关闭，沿用 `overlapPolicy: skip`。
- 在命令/MCP 预检前核对上个原任务。只把 Pi 的最终 `model_error` 且不属于 Pi 可重试错误、并具有明确账户拒绝标识的响应分类为 auth/access/quota/model。普通 429、网络故障、上下文/输出错误、工具正文和未识别错误不触发降频。
- 原规则保存可见 `accountCooldown`（拒绝次数、截止时间、通用分类），以原任务和提交 ID 防止重启或反复检查重复累计。截止时间由原助手消息的请求开始时间戳计算，不能从重启时间重算。
- 从 5 分钟倍增，最大 24 小时；仍按原日程判断发生项。间隔内发生项保存 `skipped` 及降频原因，零预检、零模型请求，不改变已运行任务和预算。
- 手动运行跳过降频，仍检查原预检、预算和防重叠。下次检查发现已完成的原任务时清除降频；只受理任务不代表账户修复。
- 暂停/恢复与编辑保留已有降频记录；旧任务结果不得污染新修订的归属。原任务和原发生项仍使用 Pi，不新增调度器或数据库。
- 此版不解析供应商自然语言重置时间，不自动释放其他规则，不改变模型设置。供应商错误文本只在现有 Pi 原件中保留；规则历史仅记录通用分类和数字。

**修改范围：** `src/routine-account-backoff.ts` 仅放明确拒绝分类；`src/runtime.ts` 的 `taskOverview` 读取原 Pi 消息；`src/routines.ts` 复用上次任务查询及 claim 前门槛，保存必要业务进度。`test/routine-account-backoff.test.ts` 覆盖分类、跨次受理、重开、编辑、手动恢复及本机真实 Pi 错误。CLI、Spec、已有架构笔记同步。

- [x] 写失败回归：明确/临时错误分类；间隔内跳过在预检前；不重复累计；手动成功恢复。
- [x] 最小实现原 Pi 错误投影和规则活动门槛，不改 Pi 重试。
- [x] 验证重启、暂停编辑、旧版本归属及无故障原规则。实际 SIGKILL 和原 Pi 429 重试均已验证。
- [x] 完成聚焦/全量回归、类型/构建/提交和笔记检查。
- [x] 提交并推送 Fork 功能分支，不创建上游 PR。

**限制：** 只识别列明的明确拒绝；未知供应商报错保持原失败行为。降频只影响自动发生项，不能保证真实成本或任务成功率提升。

## 验证记录

明确拒绝分类和降频行为先经失败回归证明缺失。最终专项 8 项通过，另有既有活动、防重叠及手动受理等相关 26 项回归通过；最终完整 `npm test` 共 407 项，403 通过、0 失败、4 项 Office 样例因可选依赖缺失跳过。类型、构建、提交候选凭据检查、CLI 帮助和三项笔记检查通过。

真实本机鉴权 HTTP API 验证创建规则、未鉴权拒绝、降频原因读取、daemon 重启与手动修复。实际 SIGKILL 发生在原任务失败后、下次检查前，恢复从原 Pi 时间计算间隔，保持两个原任务且不新增模型请求。普通规则保持原节奏；启用规则的临时 429 仍由 Pi 原生重试后完成。分类仅查看最终 model_error 的助手消息，不读取工具正文。

主会话检查完整生产差异及原受理调用。`autoreview --mode local` 因缺少 TruffleHog 在模型审查前停止；独立审查的任务正文被省略，未执行审查，没有独立审查通过结论。未测试真实供应商拒绝、明确重置时间、实际费用收益及大量历史压力。
