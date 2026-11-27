# Agent Note: 助手群组保留原消息并按接收顺序投递

Status: implemented

## Problem

一位成员正在回复时，终端和配对手机无法发送下一条。重启和重发也需要保留原接收顺序、发言目标和附件版本。

## Decision

接收事务将用户消息、请求身份、成员修订和固定附件一起保存到原 Pi 群组。投递事务读取已提交的消息和已发生的会话上下文，创建原群组的 `Deliver`，并在同一事务认领该条消息。Pi 要求表读出现在表写之前。现有 Runtime 在重启和上一条结清时接回队列。 [群组原结构](2026-11-26-assistant-rooms.md) · [实现与验收](../../../../docs/superpowers/plans/2026-11-26-assistant-room-queue.md)

## Alternatives considered

Pi `followUp` 能在单个 conversation 内维持消息顺序。群组后续消息可以指向不同 conversation，逐人分开等候会失去群组顺序。队列只保存群组消息的顺序，执行和恢复沿原 Pi 任务。

## Consequences

同一群组最多八条等待消息。等待阶段只保存原输入，投递时才开始该条的时限，并检查剩余额度及成员权限。重启、取消和成员撤回均保留原消息身份。独立的接收和投递事务之间允许进程中断，恢复从尚未投递的原消息开始。
