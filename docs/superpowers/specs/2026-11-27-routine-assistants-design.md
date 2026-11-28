# 指定命名助手执行例行任务

Status: implementation under verification. 基线为固定 Skill 分配提交 `2b57388`。独立可实施性检查未发现待决问题。

## 目标与证据

用户可以保存“每天由研究员检查这个项目”，让计划发生项使用所选助手的指令、模型、工具范围、私有记忆设置和固定 Skill。手动 Run now、定时触发和事件触发均沿同一受理路径，不再启动一个没有指定角色的通用任务。

在 `2b57388` 的合成试验中，RoutineInput 加入 assistant 字段后被静默忽略：规则没有保存引用，启动任务没有 assistant，模型也没有看到原角色指令。 [基线结果](../../experiments/2026-11-27-routine-assistant-baseline.json)。没有真实 API 调用。

## 固定源码参考

- [Rakazo 创建归属](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/tools/run-tools-tasks.ts#L210)：schedule_create 把 botId 与规则一起保存。
- [原 Bot 与归档检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-routines.ts#L202)：取得原 Bot、检查归档状态并在 Bot 或有效群组会话受理定时工作。
- [Run now 的原归属](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/routines/routines.ts#L289)：routineTestTarget 与 Run now 使用同一 Bot/Space 授权来源。
- [群组及成员复查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-thread.ts#L8)：这是后续群组投递的参考，本项只实现直接任务的助手选择。
- Kada 已安装 Pi 1.4.0：LocalRoutines 使用既有持久 task sleepUntil、发生项 ID 和 runNow 回执。LocalRuntime.create 已能固定所选助手、模型、权限、私有记忆及包副本，不添加新的循环、数据库或队列。

## 行为契约

RoutineInput 增加可选 assistant: { id, revision }。只允许 action=task 且显式 workspace。创建与更新时必须通过该工作区的 Assistants.select，外项目、归档、旧修订、无效模型和损坏引用在保存前失败。没有该字段的历史规则保持原行为。

更新接口仍是既有完整规则替换：传入新的引用重新选择，省略字段清除助手选择。无需新增 patch/null 语义。Owner API 与 CLI routines add/update/run 沿相同接口。普通聊天的 notification reminder 工具不获得定时执行或角色选择权限。

规则和发生项保存精确引用；每个新任务通过 LocalRuntime.create(..., { assistant }) 再次检查可选性。助手修订变化、归档、模型不可用或 Skill 不可用时，新的发生项失败，并在原例行历史保留有界错误说明。不能自动改选新修订或通用助手。原日程保留，用户更新规则后可继续；既有任务的接回只按原 taskId，不重新选择角色。

这个选择沿用 Kada 工作项 assignee 的现有固定修订语义。Rakazo 的当前 Bot 配置随 Bot 更新；Kada 为避免已授权的定时任务无声扩大工具范围，要求用户明确更新所选修订。本项不会把已经启动的任务换成新角色。

助手创建与归档可能在检查之后发生。至少在受理进入主运行队列后和元数据写入前复查助手引用；沿用 requireRoutineAdmission 防止已取消、已改修订规则在排队后启动。已有元数据的重放先读取原任务，不因后来的角色变更重复创建或拒绝原回执。

活动门槛、预算、重叠策略、预检查、Gmail 范围和事件去重继续沿既有发生项和执行路径。预检查属于用户的原例行配置；所选助手的工具范围约束后续模型执行，不改变已经明确配置的宿主预检查。

## 实现边界

- src/routines.ts：输入校验、选择验证、发生项携带 assistant；复用现有 Receipt.detail 保存失败原因；发生项公共历史包含助手引用。
- src/runtime.ts：向 LocalRoutines 传入现有 Assistants；执行时传给既有 create；必要的排队复查放在原受理路径。
- CLI/server 已透传完整 RoutineInput；只补准确的文档和入口验证，不新建路由或管理工具。
- CLI 保存分配助手的规则前核对 routine-assistants capability，避免同版本旧服务静默忽略新字段。
- 测试沿现有 faux 模型、fakeRoutineClock、强杀 worker；不需要凭据或新依赖。

## 验收

1. Owner API/CLI 保存和查回同一精确助手引用；无效、外项目、归档、旧修订及 notify 的引用在保存前失败。
2. Run now 与定时发生项均在原项目使用所选角色及 Skill；验证模型只看到原工具范围，不通过 bash 等替代路径执行。
3. 创建后重启仍产生同一发生项和一个 taskId；受理后保存原任务再重启，不重复效果。重放已有发生项不受后续角色编辑影响。
4. 所选角色编辑/归档或 Skill 失效后，新发生项明确失败且有说明，不启动通用任务；更新规则选择当前修订后恢复。
5. 已开始的旧任务即使角色编辑、方法更新或规则换人，仍可答复原问题并按原角色、方法与总预算完成。
6. 规则被取消或更新时，已排队的旧发生项不能借新参数启动；同一 requestId 的手动重试返回原回执。
7. 原有未选助手的规则、通知、预检查、活动门槛及事件行为不变。补充本项回归，运行相关类型检查和仓库 check。

## 未包含的后续差距

群组定时投递、跨主机助手路由、组织目录、普通聊天授权执行类例行任务是独立用户能力。这里不把它们标成完成；本项的直接任务选择先为它们复用现有入口打基础。

## 本地证据

新增七项回归与原例行任务手动/受理回归合计 21 项通过。覆盖所选 Skill、旧角色恢复、新修订的明确选择、配置回执、归档和跨项目拒绝、排队与受理时的角色变更、Owner CLI/API 及旧后台能力检查。实际 SIGKILL 在文件效果保存后改动目录角色，再重启确认同一原任务继续使用 revision 1，目录已为 revision 2，效果文件仅一行。全量回归和独立代码审查另行记录。
