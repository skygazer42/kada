# 持久跨助手协作：固定源码研究

状态：研究材料，尚未实现或确定完整产品接口。承接[能力矩阵](../../specs/2026-11-25-reference-capability-matrix.md)的持久协作；现有命名角色和临时 workers 不等于参考项目的助手团队。

## 已核对的调用与实际运行路径

| 项目、固定版本 | 已读源码 | 对应机制 |
| --- | --- | --- |
| OpenMausBot 3aec210054cd | [coordinate_bots 调用](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L291) | 规范 teammate IDs、standing/new/原 thread、consult、rework、reply、files 后交给原接口。不是单纯切换一句角色指令。 |
| OpenMausBot | [Coordinator 契约](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/coordinator.ts#L9) · [实际 enqueue](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/runtime-coordinator.ts#L258) | 原请求必须仍运行并属于原说话者；沿祖先链防循环，检查用户此前停止决定，重复请求返回已有工作，返工有单独条件；执行与请求数量沿原树限制。 |
| Rakazo e64d73292179 | [handoffToGroupBot](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L25) · [原运行与成员重检](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L74) | 来源运行/群组/成员必须仍有效，锁定原来源与目的线程；群内一阶段一个 owner，群外可送独立工作。 |
| Rakazo | [deliveryKey 与原结果复用](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L99) · [目标、hop 和文件](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L139) | 不向自己转交，继承原链路 hop 并设上限，消息携带已保存文件；原交接重复回传同一 run。 |
| Rakazo | [事务创建下一运行，事务后唤醒](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L179) | 同时保存交接消息、任务、原 run 与事件，再通知/唤醒；先声明接手但未持久保存并不等于已经交接。 |

OpenMausBot 的 Coordinator 接口明确 standing/new/原线程、结果回传、待答和文件语义；实际RuntimeCoordinator也实现祖先与停止检查。Rakazo使用数据库/队列持久交接，机制可借鉴，但Kada不能据此引入第二套调度/消息总线。

## 当前 Kada 的对应基础

- 命名配置由 Assistants 保存，原任务固定 AssistantPin；普通聊天配置管理不会启动目标助手。
- 当前 delegate/delegate_background 为单目标内的 Pi task-owned 子会话，职责、结果、用户问题和后续指令可追溯，主目标预算包含子会话。
- 当前角色范围在主/子任务、嵌套/加载、压缩及重启保持；目标角色的更大名单不能自动扩大来源任务权限。
- 原 Runtime.create 已有稳定任务ID和creationHash，原工作项及消息已有回执身份；Pi有conversation配置、task ownership与持久工具意图。先核对这些原语如何承载来源/目的和恢复，不能先设计新的运行器。

## 下一项必须明确的产品语义

1. 用户指定的目标助手及版本，与原来源任务/会话、目的会话和交接工作身份分开。角色模板存在不证明持久同事会话已经存在。
2. standing会话、一次性新工作和对原工作的返工分别确定；不能用一次临时delegate结果冒充完整持久团队。共享项目背景也不等于共享目标助手全部私人历史。
3. 来源和目的的实际权限/模型/预算如何固定，必须与用户原授权相容。只读来源不能把写入转给更大权限角色来绕过限制；任务总额度不因转交补充。
4. 对“来源已取消”“目标归档或版本变化”“结果迟到”“同一工作重复转交”“用户已停止目标工作”的处理，需要具体状态断言和实际副作用计数。
5. 文件传递需要原路径/哈希、大小和变更时的明确处理；不把模型输出的路径字符串当作已成功复制的附件。接收方得到的资料是任务数据，不构成新的工具授权。
6. 用户补充答复、完成结果和失败/返工沿原交接身份回传；重启和结果回执丢失不能重新派发未知副作用。单向通知和等待返回也应区分。

下一份实施Spec需覆盖以上完整路径与测试，并明确仍未实现的群组、站立会话/记忆或平台能力。研究不等于功能已交付；优先复用Pi，若公开接口不足，先用实际原生实验给出证据。

## Pi 1.4.0 的实际扩展点验证

已核对官方tag `v1.4.0`解析为提交`4a080252f06caf63a525d7873c5d94d3c23887e0`，与本机安装版本一致。官方[持久后台子助手示例23](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/test/examples/23-subagent-background.ts#L37)使用原Pi文档保存同事会话映射，以已完成的后台锚点任务作为conversation owner，再用原生持久任务的deliver/report阶段投递消息和回传结果；稳定requestId避免恢复后重投。可复用此机制，不需要新的调度器或消息总线。

本机已安装Pi上的四个原生回归通过，测试使用合成模型和真实SQLite：[验证代码](../../../test/pi-persistent-assistants.test.ts)。

- 同一同事会话在关闭/重开后保留前一次用户消息，第二次工作复用同一conversation；重开没有模型调用，重复原来源requestId没有新请求或用量，原结果回传各一次。
- 第二次投递在第一份工作未完成时保持queued，在第一份最终答复后才执行；保留两个不同submission/answer和两份原结果回执，没有用steer覆盖原工作。
- 普通root.abort跳过后台边界，完整`abort({background:true})`能够越过已完成锚点，停止同事实际工具及持久回传任务；取消后不回传结果。原用量文档的非零子会话token包含在同一Harness汇总，未给同事另加预算。
- 同一个registry使用同一扩展，从每个同事自己的已提交conversation文档读取提示和权限；读/写角色并行执行及重启后不串配置，只有写角色产生合成效果。由`input.read.snapshot`和原`ToolTask`钩子实现，不需要给每个角色复制registry或运行时。

测试另外按公开类型做独立严格检查（ES2024，对应本机Node24支持Promise.withResolvers）；锚点定义补齐公开API必需的abort处理。与原Pi hooks、临时委派及固定角色回归合并的22项通过。没有产品代码改动，这些结果不能冒充Kada已支持命名同事派活。[验收摘要](../../experiments/2026-11-26-pi-persistent-assistants.json)

官方示例中的普通Esc继续后台工作，不直接作为Kada默认停止政策。当前Kada的abortAll已调用完整background子树停止，产品接入还须覆盖暂停、预算到限、目标修订、用户停止后不被自动重派及迟到报告处理。正式产品契约见[持久协作Spec](../../specs/2026-11-26-assistant-collaboration.md)，该Spec的验收清单尚未实现。
