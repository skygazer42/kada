# 聊天提醒周期与修改实现计划

**目标：** 本机新聊天可保存每日/每周通知提醒、查看和修改本项目已有提醒，继续使用原 Pi 定时与通知入口。

**源码参考：** [Rakazo 日程工具](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L52)、[修改前核对归属](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L1030)、[修改竞态检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L1197)、[OpenMausBot 原触发器创建](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call-triggers.ts#L453)。独立实现通知工具，不复制执行系统。

**Pi 核对：** 原 LocalRoutines 已支持 once/daily/weekly、IANA 时区、夏令时调整、错过补跑、修改和取消；Pi 工具 taskId 提供稳定请求身份。只扩展薄工具和修改回执。

**契约：**

- 新本机聊天固定 `chatReminders: managed`；原 `true` 聊天保留单次提醒接口，远程、准备、执行和子任务不获得聊天提醒工具。
- `reminder_create` 保留 `at` 单次入口，另支持 `schedule` 的 once/daily/weekly，必须二选一。循环提醒要求明确 IANA 时区；每日 HH:MM、每周星期 0–6。创建只固定 action=notify，不能创建执行任务、预检或事件触发。
- `reminders_info` 在 managed 模式展示本项目单次/每日/每周通知及原修订和下次时间。其他项目、事件和执行型规则排除。`reminder_cancel` 沿用原修订保护，managed 可取消这些周期提醒。
- `reminder_update` 固定提醒 ID、info 展示的原修订、完整新文字和 schedule；原工作区不能由模型指定。只允许改本项目当前可见通知，按用户要求改时间、周期或文字，不授权未来任务执行。
- 原 update 事务核对 expectedRevision，并把 tool taskId 派生的 requestId、输入摘要与原结果追加到 Pi 回执。同请求同内容重放返回原结果，即使之后被编辑或取消；不同内容冲突。无回执时旧修订冲突，不覆盖后来修改。
- 修改前读到的原工作区、验收和补跑政策在原 Pi 工具任务固定，重放不从新规则重组请求；后续改项目或政策不影响原回执。回执是历史操作结果，当前状态须再查 info。
- 更新不清空历史。原 CLI/API 两参数 update 保留行为；不新增数据库、调度器、定时线程或依赖。取消后原工具重放与后续新安排不能混淆。
- 聊天编辑暂停规则时保留暂停，不创建新定时任务；暂停周期改为单次前须从原入口明确恢复。原未带请求身份的 CLI/API 修改行为保留。

**修改：** `src/reminders.ts` 的 managed schema/范围/更新工具；`src/runtime.ts` 和 `src/conversation.ts` 固定新聊天策略；`src/routines.ts` 原 update 的可选修订、请求回执。测试覆盖日期/时区、周期通知、编辑竞态、回执重放和实际 SIGKILL。Spec、使用文档和原架构笔记同批同步。

- [x] 写失败回归：聊天创建每周提醒、修改时间/文字、再次到期和取消；无 Goal。
- [x] 为原 update 增加可选期望修订和持久请求回执；确认重放不覆盖后续修改。
- [x] 扩展新聊天 managed 工具，保留旧 true 接口；验证无效时间、冲突、项目/规则类型范围。
- [x] 实际 SIGKILL 验证更新前/更新后中断、原结果重放；真实模型验证日常中文流程。
- [x] 相关/全量回归、类型/构建、提交候选、笔记检查；提交推送 Fork，不创建上游 PR。

**验证记录：** 最终全量 `npm test` 为 436 通过、4 个可选 Office 用例跳过、0 失败；8 项提醒管理与 6 个 SIGKILL 场景包含在内。`typecheck`、`build`、`check:commit`、`git diff --check` 及三项笔记校验通过。硅基流动 DeepSeek V3.2 的中文每周创建、重启后改每日/文字及取消使用 9 次模型请求、52,054 总 token，无 Goal，实际金额未知。独立 reviewer 的任务分派未生效，autoreview 因缺少 TruffleHog 未运行，不能声称独立审查通过。
