# 助手群组消息排队

同一群组一次执行一条用户消息。当前成员回复时，本机和获授权的手机仍可发送。群组最多保留八条等待消息，按接收顺序处理。重发同一请求返回该消息的原记录。

接收时固定成员修订和附件字节，开始回复时读取已发生的群组上下文、启动该条时限并核对群组剩余额度。处理到已移除的成员修订时保留该条记录并标记中断。当前消息超时后继续有效的排队消息。群组取消或额度耗尽时结清队列，保留全部消息记录。

Rakazo 在同一事务保存群组消息和 `queued` run，并通过原线程和客户端键去重。Kada 将等待记录放在已有 Pi 群组文档，沿现有 Runtime 检查推进原 `Deliver`。Pi 的 `followUp` 面向单个会话，群组中下一条可以送给另一位成员。 [Rakazo 去重](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L98) · [事务提交](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L179) · [Pi 排队行为](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#submissions)

自动化回归覆盖当前成员继续回复、按接收顺序投递、重复请求、进程强杀恢复、成员修订移除、超时、上限和取消，以及手机发送权限。第二条回复读取第一条答复，仍在等待的第三条消息不会进入第二条的上下文。 [本机回归](../../../test/assistant-rooms.test.ts) · [成员撤回](../../../test/assistant-room-members.test.ts) · [配对回归](../../../test/shared-assistant-rooms.test.ts)

390 像素宽的 Chromium 验证手机 Web 在首位成员回复期间可发送并看到 `Queued`。重载后仍显示同一条消息，第一位完成后第二位再回复。模型使用本机夹具。 [浏览器记录](../../experiments/2026-11-26-room-queue-browser.json)
