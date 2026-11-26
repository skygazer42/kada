# 结构化提问源码研究与实现范围

研究日期 2026-11-25。本文件是下一项设计输入，尚未实现或验收。目标对应[能力核对表的 P0 结构化提问](../../specs/2026-11-25-reference-capability-matrix.md)，实现仍复用 Pi 1.4.0。

## 核对的源码

| 实现位置 | 实际机制 | Kada 应吸收的边界 |
| --- | --- | --- |
| [Rakazo ask_user](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/builtin-conversation.tool-definition.ts#L94) | 单个短问题、2–4 个唯一选项、可选详情。 | 只处理当前需要用户选择的问题；选项不承担审批含义。 |
| [Rakazo 可回答问题定位](https://github.com/elie222/rakazo/blob/e64d73292179/packages/core/src/asks/answerable-ask.ts#L14) | 卡片须属于相应用户的运行，状态仍为 waiting_input；按原 messageId 判断。 | 点击必须带原问题身份与版本，不能把迟到答复发给替换后的问题。 |
| [Rakazo 原事务接收答复](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/threads/thread-ask.ts#L214) | 锁原 thread/run，核对 space、thread、run、user 和 waiting_input；再找到原 message 的未答卡。 | 权限与原问题检查应在原受理事务中，不靠页面上的禁用状态保证。 |
| [Rakazo 保存等待状态](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/threads/thread-ask.ts#L767) | 保存 waiting_input、选项检查点、卡片与事件，再通知客户端。 | 用 Pi 原业务文档和提交；不能另造运行、消息队列或租约。 |
| [Rakazo AskCard](https://github.com/elie222/rakazo/blob/e64d73292179/apps/web/src/components/messages/AskCard.tsx#L190) | 选项和输入答复共用提交，发送中禁用，失败保留输入并显示错误。 | 手机与桌面都需保留草稿，未知回执重试同一请求。 |
| [OpenMausBot 被动卡片](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/options-card.ts#L33) | 卡片只有文本选项，不绑定 tool/requestId；点击不批准工具或外部动作。 | 正常问题答复不能替代 task brief 确认或 MCP 单项动作审批。 |
| [OpenMausBot 参数校验](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/packages/phone-protocol/src/options-card.ts#L43) | 文本 trim、长度限制、数量与唯一性校验后持久化。 | 模型 schema 验证之外仍拒绝空白或 trim 后重复选项。 |

Rakazo 的 [MCP 工具内提问](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/tools/run-tool-questions.ts#L42) 则是有时限的协议交互，涉及密封凭据与原网络调用；它不能直接替代普通聊天问题，也不在这项变更中实现。

## Kada 已有落点

- `src/goal.ts` 的 GoalDoc.question 与 task_blocked：已保存文本待答，工具结束当前回合；`src/runtime.ts` 的 followUp 保存原用户消息、修订与 outbox 后继续 Pi。确认仍走原 briefDigest/confirm。
- `src/delegation.ts` 的 ChildQuestions、delegation_ask 和 answerDelegation：已有原子会话、问题 ID、答复回执和定向恢复。同步 worker 无交互问答，后台 worker 可待答。
- `src/task-view.ts`、`src/chat.ts`、`src/remote-page.ts`、`desktop/PetHandoff.swift` 只展示文本问题。手机已分享运行另有单独答复权限与 answerVersion；不能从普通问题入口绕过它。
- Pi 1.4.0 提供工具任务、taskId、doc/commit、持久提交及 control.terminate；当前公开 API 没有可直接提供 Kada 多入口问题卡的产品状态。需要薄问题表示，不能替换 Pi 会话执行。

## 待实现的完整路径

1. 定义 2–4 个 1–80 字唯一选项、问题（至多 240 字）和可选详情（至多 4,000 字）；自由文本答复一直可用。新主会话显式记录工具能力，旧会话不因升级改变 schema。
2. 普通聊天询问不创建 Goal；问题作为 Pi conversation 业务文档，ID 来自原工具 taskId。执行任务沿 GoalDoc 保存对应问题，后台子任务沿原 ChildQuestions 保存。用户可以继续发送普通说明，不强制每条消息只选按钮。
3. 点击选项使用独立的原问题答复入口，携带问题 ID/版本与 requestId。原事务核对当前原会话、问题、预算与权限；保存答复摘要和原 Pi 提交/既有 outbox，重启及回执丢失不重复受理。不同内容复用 requestId 报冲突，旧问题或暂停/取消状态不接回。
4. 终端显示编号与文字，并提供选择命令；手机和 macOS 使用原生按钮及可编辑补充输入。答复失败保留原输入和请求身份；问题改变后不能复用旧草稿到新问题。共享工作项仍依靠原分享/答复权限。
5. 参数、隔离、旧会话、修订竞态、暂停/取消、过期预算、普通文本答复、回执丢失及实际 SIGKILL 都需验证。真实模型用中文在同一 Pi 会话提出选项并接回选择；真实浏览器验证手机视口，macOS 另做实机资格记录。

这是研究范围而非已批准的精确接口名；动手前需把原问题文档、答复提交与现有 followUp 的交互写成可执行计划。优先扩展原 owner 边界，不把问题选择和动作批准合并，也不另建通用工作流框架。
