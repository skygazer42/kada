# 本机助手群组会话实施计划

**目标**　从本机终端创建具名群组。用户指定一位成员答复，重新打开群组时可读到同一串有归属的消息。

**架构**　每个群组沿用本地任务的 Pi 存储。根会话保存共享消息，各成员在群组内有各自的 Pi 会话和固定助手版本。Pi 持久任务负责投递和接回原答复。

## 源码参考

- OpenMausBot 从群组成员中确定答复者，按阅读者生成群组记录窗口，再在选定助手的上下文运行。测试覆盖明确点名和偶然提及的区别。[成员路由](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L10687) · [群组记录](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/room-transcript.ts#L34) · [群组测试](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/room-coordination.e2e.test.ts#L210)
- Rakazo 校验当前成员及运行归属，给群内阶段固定单一执行者，并用持久投递键识别重试。[成员与回执检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L74)
- Rakazo 移除成员前核对旧成员列表，锁定原群组及会话，停止被移除成员的原运行。Kada 以群组修订校验并用 Pi 中止对应会话。[成员更新与运行收尾](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/spaces/groups.ts#L440)
- Kada 使用 Pi 1.4.0 的任务拥有会话、原提交请求 ID 和持久回传事务。已有协作测试证明站立会话在重启后仍保留原提交和用量。[Pi 后台会话](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L37) · [本机 Pi 回归](../../../test/pi-persistent-assistants.test.ts)

## 契约

- 本机 owner 选同一项目的 2 到 8 个当前助手版本创建群组。群组保存选定版本及实际模型。每条新消息显式指定一个成员 ID。只有一条成员回复可以执行，忙时返回冲突，用户可重试。
- 在同一 Pi 事务中保存用户消息、投递任务和请求回执。重发同一个请求 ID 和正文获得原回执。改投其他成员或改变正文时冲突。答复保存群组成员 ID、修订及原 Pi 答复条目，失败或中止给出原回执状态。
- 成员保留自己的会话及配置，共享上下文来自群组有限的近期公开正文。首版成员执行文本会话。会话列表、查看和定向发送通过本机 owner API 与终端。每个群组累积模型预算，每个已受理回合保留原截止时间。
- 本机 owner 可以按当前群组修订改名、调整成员或选择新助手版本。移除正在答复的成员版本时，先确认原回合已停止，再保存群组设置。已写入的公开记录随原群组保存，保存过的原消息可用请求 ID 查询。旧修订更新冲突，新增成员仍须属于原项目。
- 助手的固定工具名单包含 `room_handoff` 时，答复者可把同一轮依次交给尚未参与的原群组成员。目标接收原用户要求、近期群组背景及交棒说明，公开事件显示谁交给谁。每个成员版本在一轮内参与一次，共用原截止时间和模型预算。移除可接棒的版本会先停掉原回合。[Rakazo 原群内阶段、去重和投递](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L98)
- 配对手机获得 owner 授予的本群组查看权限后可读取同一段历史。发言使用独立授权，并绑定当前群组修订、接收成员和设备配对下的请求 ID。撤回查看会同时撤回发言。工作区路径、成员私有配置和其他群组只留在本机。 [Rakazo 移动群组入口](https://github.com/elie222/rakazo/blob/e64d73292179/apps/mobile/app/group-thread.tsx) · [原会话选择与展示](https://github.com/elie222/rakazo/blob/e64d73292179/apps/mobile/components/thread/thread-screen.tsx#L137) · [Codync 原任务入口](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/WorkThreadView.kt#L143)

## 实施与验证

- [x] 新增 `test/assistant-rooms.test.ts`，覆盖只唤醒指定成员、陌生成员、忙时冲突、原回执、超时和终端入口。两次 SIGKILL 分别在首位成员和接棒成员模型请求在途时终止进程，原 Pi 提交编号保持一致。
- [x] 在 `src/assistant-rooms.ts` 接入 Pi 持久投递、成员会话和共享历史，在 `src/runtime.ts` 复用原工作区、生命周期和预算。
- [x] 在 `src/server.ts` 和 `src/cli.ts` 接入 owner API、编组和定向发送。
- [x] 用 `test/assistant-room-members.test.ts` 核对旧修订拒绝、移除活跃成员、保留原回执及重启后加载新助手版本。
- [x] 用 `test/assistant-room-handoff.test.ts` 核对接棒身份、原群组答复、同一预算和已参与成员的排除。 [三成员真实交棒](../../experiments/2026-11-26-assistant-room-chain-siliconflow.json)
- [x] 复用配对设备权限，手机查看和发送走原群组 ID。接口回归覆盖查看与发送撤回和两个设备的独立重试。 [Chromium 390 × 844 验收](../../experiments/2026-11-26-shared-rooms-browser.json)
- [x] 硅基流动实测三轮文本回复，一次由 DeepSeek 交棒给 Qwen。重启重放没有增加用量，合计 1,686 token，金额未知。 [实测记录](../../experiments/2026-11-26-assistant-rooms-siliconflow.json)

群组覆盖逐位交棒、本机和配对手机。后续接入固定附件和消息排队。多级团队、群组审批及跨用户组织仍待验收。 [附件验收](2026-11-26-room-attachments.md) · [排队验收](2026-11-26-assistant-room-queue.md)
