# 关联会话留言与唤醒

OpenMausBot 的 `post_to_thread` 沿目录归属投递带来源的留言，默认把资料留给下次运行，也可显式唤醒接收会话。投递身份在原记录中去重。Kada 复用关联会话目录、Pi 原生会话记录与提交回执。 [工具定义](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-thread-post-tool.ts) · [来源与下轮读取](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/thread-posts.ts#L24) · [投递与唤醒](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/thread-posts.ts#L81)

## 行为

- 本机普通聊天按原用户请求，用 `post_to_thread` 向目录中的关联会话发送留言。目标记录来源 ID、标题、正文和时间。重开目标可查看同一份留言，模型在留言之后开始的用户回合看到带来源的资料。
- 省略 `wake` 时仅保存。显式 `wake: true` 可在空闲普通聊天或已交付任务中生成文字回复。它使用目标的原模型和剩余 token、费用额度，回复采用目标的单轮时限。普通聊天正忙时等待原回合结算。目标待答、待确认、暂停或正在执行目标时只保存资料。
- 留言和唤醒沿来源任务及 Pi 工具 ID 去重，也可用同一个 `delivery_id` 重试。保存身份后改正文、目标或唤醒选项时报冲突。目标归档或越界时拒绝新投递。
- 接收侧展示和投递用 Pi 保存的原记录。留言不作为用户输入答复问题，唤醒工具权限收窄到文本。已交付任务保留原交付、确认和实际用量，新的真实用户输入仍沿原入口进入。
- 下一轮模型输入包含当轮开始前的最近完整留言，正文合计最多 16,000 字符。目标记录保留全部原文及来源。

## 实施与验收

- [x] 覆盖留言、待答、来源隔离、原请求重放和下一轮模型读取。
- [x] 覆盖同一接收会话唤醒、忙碌时等待、原交付保留、权限、用量和强杀恢复。[回归](../../../test/thread-posts.test.ts)
- [x] 在硅基流动上验证普通聊天发送与接收，保存原任务证据。[实测](../../experiments/2026-11-26-thread-posts-siliconflow.json)

## 验收结果

- 29 项聚焦回归通过。强杀发生在目标已受理 Pi 唤醒、来源工具尚未回执时。重启后只保留一个唤醒和一条留言，目标原交付编号一致。
- 整仓检查共 657 项，653 项通过、4 项可选 Office 案例跳过。类型检查、构建、笔记校验与提交候选检查通过。
- 首轮五次真实请求完成留言保存，接收方在用户下一轮误把已到达的资料当作外部会话查询，未读出代号。续验沿用同一条原留言，让上下文明确写出资料已在当前会话，并核对送达模型的正文和来源 ID。DeepSeek 用四次请求完成读取、发起唤醒和目标回复，重启后仍显示原资料与来源。 [首轮记录](../../experiments/2026-11-26-thread-posts-siliconflow-attempt-1.json) · [续验](../../experiments/2026-11-26-thread-posts-siliconflow.json)
