# 独立工作回传实施计划

**目标** 用户可为独立工作开启回传。验收完成后，原会话收到原任务编号和交付摘要。处于空闲且仍有额度的普通聊天会自动续答。

**源码参考** OpenMausBot 的 `report_back` 通过同一助手的新线程派活，使用 `reply: "resume"` 将结果和继续回复送回原线程。Kada 沿用已有独立任务及其确认。两个任务各用自己的 Pi Durable 存储，回传用来源会话的稳定请求 ID 受理。[OpenMausBot 工具定义](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L273) · [派活入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L13898) · [原线程续答](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L3955) · [Pi 提交与回放](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#L509)

## 契约

- 终端 `/thread-report 标题 | 任务说明` 和普通聊天 `start_thread` 的 `report_back: true` 都固定同一个创建请求及来源。子任务在自己的会话取得确认。原 `/thread` 和旧任务采用原默认行为。
- 独立任务第一次通过验收时，同一个 Pi 事务保存归属、修订、候选编号、完成时间和交付摘要。进程恢复后从该记录向来源回传。来源和子任务都须为本机任务，且拥有同一个工作区。原文件从工作任务的交付入口读取。
- 忙碌的普通聊天完成原回合后接收自动续答。来源已归档、停止、待答、改为执行任务或耗尽额度时，仅保存一条可查回传。模型回合沿原聊天的 token 和费用额度，采用正常聊天的单轮时间窗口。独立结果内容属于资料，回传引发的模型回合只回复文字。

## 实施与验收

- [x] `src/task-threads.ts` 定义可选开关、回传记录和源工具约束。`src/runtime.ts` 在通过验收时保存原结果，并复用现有任务监督循环和 Pi 原请求回执投递。验证旧请求重放、忙碌、待答、确认之前和重复回传。
- [x] `src/chat.ts` 提供正常终端入口，并在来源会话显示回传与 `/attach`。`src/server.ts` 宣告能力，原 owner API 创建入口读取明确开关。验证未认证访问、原来源及父子状态。
- [x] 猛停覆盖验收保存后和原会话已受理后两处。恢复后核对同一子任务、同一原会话请求、相同摘要和一次报告。
- [x] 在硅基流动上用合成任务验证实际模型续答。最后一段由验收脚本指定子任务提交工具。

## 检查重点

- 来源在等待过程中改变控制状态或进入新的目标，回传仍属于原会话。
- 用户新的真实输入与回传同一时刻到达，原输入仍在自己的回合处理。
- 原候选已经确认但请求响应丢失，已受理回传维持原身份。

## 验收记录

- 终端与运行时聚焦回归 8 项通过。忙碌来源延后续答，之后收到的真实用户消息另开回合。待答的来源保留问题 ID 和用量。两处实际强杀分别在验收保存后、来源 Pi 已完成回传回合但尚未保存可见回执时发生。恢复后均保留一个回执和一次续答。[回归](../../../test/thread-reports.test.ts) · [终端入口](../../../test/local-threads.test.ts)
- 指定本机 Python 的整仓检查共 648 项，644 通过、4 项可选 Office 案例跳过。类型检查、构建、笔记校验和提交候选检查通过。
- 硅基流动 DeepSeek V3.2 首轮成功调用 `start_thread` 并保存 `report_back`。独立任务准备仍在进行时，100 秒观察窗口到限，首轮保留 5 次请求记录。[首轮记录](../../experiments/2026-11-26-thread-report-back-deepseek-attempt-1.json)
- 在原 Pi 会话补充准备预算后，模型进入待确认，并在确认后生成及核对了原文件。两次执行窗口分别在提交验收前到限，来源仍等待通过验收的结果。[续验记录](../../experiments/2026-11-26-thread-report-back-deepseek-attempt-2.json) · [再次恢复记录](../../experiments/2026-11-26-thread-report-back-deepseek-attempt-3.json)
- 最后一段沿原任务和确认恢复，验收脚本将子任务的下一次工具指定为 `task_submit`。随后两次真实模型请求分别完成交付提交和原会话续答。重启后原回执、候选和摘要保持一致，任务总数仍为二。四段共 18 次请求。模型自由运行的完整路径仍需重测，费用未知。[完成记录](../../experiments/2026-11-26-thread-report-back-deepseek.json)
- 独立复核通道未收到任务正文。本轮通过本地差异复核和上述回归检验实现。
