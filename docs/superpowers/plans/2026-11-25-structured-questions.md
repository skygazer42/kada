# 结构化提问实现计划

> 在当前 Fork 功能分支内按 superpowers:executing-plans 和 TDD 执行；用户已授权持续对齐，不另建运行系统。

**目标：** 普通聊天、主任务与后台子任务提出 2–4 个选项，用户可选或补充文字；答复只接回原问题一次。

**参考与 Pi：** [源码研究](2026-11-25-structured-questions-research.md)包含 Rakazo 参数、原问题归属/答复事务及卡片实现、OpenMausBot 被动选项卡。Pi 1.4.0 提供工具 taskId、LiveDoc、doc/commit、control.terminate 与原提交恢复；问题为原会话的薄业务文档，不另建调度器、数据库或队列。

## 契约

- 新任务固定 `structuredQuestions: true`。旧会话维持工具范围。主会话注册 ask_user；同步子任务不继承它，后台子任务仅扩展原 delegation_ask 的选项字段。
- 问题 1–240 字，选项 2–4 个、每项 1–80 字，详情可选且不超过4,000字。trim 后空白、重复和 NUL 拒绝。问题工具必须单独调用，不能与外部动作在同轮并行；选项不是审批或任务确认。
- 主问题以原 Pi taskId 为 ID，conversation doc 保存原文本/选项/详情、原 asking submission 与可选 Goal 修订/epoch。工具重放返回原记录，不覆盖新问题。普通聊天无 Goal；准备阶段沿 clarifying，执行阶段沿 waiting_user。task_blocked 保留旧文本入口。
- owner `POST /v1/tasks/:id/questions/:questionId/answer` 接受 requestId/answer。宿主队列核对原输入提交、控制/预算，原保存事务再核对当前问题及 Goal 修订/epoch。相同请求同内容复用原回执，异内容或旧问题冲突。自由文本消息也可以回答当前问题；问题选择不调用 confirm，不批准 MCP。
- Goal 答复沿现有用户消息/修订/outbox，问题回执与该修改同一 Pi 事务。普通聊天答复在原问题文档保存输入及待受理标记，再以原 requestId 提交 Pi；重启先接回已保存输入，不再问模型重造答复。输入中的附件仍沿原 imageInput。
- root 状态、任务投影、通知、手机原会话与共享运行附 userQuestion；后台子任务的原 question 附选项/详情。手机新问题入口检查原配对工作区，已分享运行仍须原答复权限。
- 终端显示选项并可按 `/choose 问题ID 编号` 答复。手机与 macOS 显示选项及自由文本，发送失败保留原问题/输入，未知回执重试同一请求；新问题不能接收旧答案。原任务预算不因选择补充，普通聊天等待时间仍沿原聊天时限规则。

## 修改范围与验证

src/questions.ts 负责主问题和校验；src/runtime.ts 固定能力、恢复/投影和原 followUp 事务；src/goal.ts 的 changeGoal 允许回调读取原 Tx；src/delegation.ts 扩展原子问题。src/server.ts、src/remote.ts 接原答复权限；src/chat.ts、src/remote-page.ts 和 desktop 的既有界面展示并提交。

- [x] 主问题失败回归：普通聊天无 Goal、原 ID/选项、重复与异内容、旧问题、重启/暂停/预算、准备与执行；最小实现后通过。
- [x] 子任务、远程与共享运行范围回归；旧 schema 与同步子任务隔离。
- [x] 终端、手机页面与 Swift 投影/语法，真实 Chromium 验证选项与重试/草稿。
- [x] 实际 SIGKILL 覆盖问题已保存与答复已保存但未提交；旧问题不能被重放恢复。
- [x] DeepSeek 中文提出问题→重启→答复→同会话接回；保留请求/用量及无额外 Goal 证据。
- [x] 相关测试、类型、构建、提交检查、笔记与文档；推送 Fork，不创建上游 PR。

## 取舍

为每个选项创建新任务容易接线，却丢原对话、预算与权限；答复必须进入原提交。直接给普通 followUp 文本加按钮最少，但无法拒绝迟到问题和重放异内容；薄问题文档绑定原 ID，Goal 继续使用原 outbox，普通聊天只保存必要的待受理输入。新问题资料不是新执行授权。

## 验证记录

最终全量 `npm test` 为 470 通过、4 个可选 Office 跳过、0 失败；10 项结构化提问、3 项实际 SIGKILL 场景包含在内。补充被动写入跨 205 条记录的定位和手机答复后列表刷新，最终入口回归 49 项通过。类型、构建、提交候选、diff 空白及三项笔记检查通过。

开发中失败回归定位并修正了三条实际路径：保存问题后重启没有补完原工具回执；远程允许列表遗漏 ask_user；被动 Pi write 遮住原问题的输入身份。一次恢复夹具在保存答复前就拦住 dispatch，已按 outbox 是否存在修正，最终 3 个强杀场景通过。旧准备阶段清单同步新增只读 ask_user；手机真实页面发现的待处理列表滞后也有失败回归和修复。

硅基流动 DeepSeek V3.2 使用 2 次请求、11,962 总 token，中文提问→daemon 重启→原问题答复→同会话回复通过；重复答复没有新请求，无 Goal，金额未知。[脱敏实测](../../experiments/2026-11-25-structured-question-deepseek.json)。Chromium 390 × 844 经配对入口选择 CSV，原会话仅一条答复，草稿保留、待处理列表立即刷新；页面回归另覆盖未知回执的原请求重试。本机截图 `.harness/screenshot-1795670978077.png`。Swift 4 个相关文件已语法解析，macOS 编译与实机交互未验收。

独立 reviewer 的任务正文被网关省略，未审查代码。`autoreview --mode local --no-tools --no-web-search --output <临时文件>` 在调用 reviewer 前因 TruffleHog 缺失退出；没有独立审查通过结论。当前提交推送 Fork 的 codex/assistant-plan，不创建上游 PR；能力核对表仍保留完整对齐目标。
