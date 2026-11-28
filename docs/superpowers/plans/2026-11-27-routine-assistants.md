# 命名助手执行例行任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让指定命名助手以固定修订执行原例行任务，定时与 Run now 共用执行和恢复路径。

**Architecture:** 在现有 RoutineInput 和发生项中保留 AssistantRef。保存时由现有 Assistants 验证，任务启动继续调用 LocalRuntime.create 的角色固定逻辑。复用 Pi 的发生项、预算和原任务身份，不另建调度器。

**Tech Stack:** TypeScript、Node 24、已安装 Pi 1.4.0 和原测试工具。

**Spec:** [行为与源码参考](../specs/2026-11-27-routine-assistants-design.md)

## Global Constraints

- 只允许 action=task 且显式 workspace 的规则选择助手。
- 使用精确 ID 和修订；旧规则缺省不改变行为。
- 不自动切换新修订，不扩大模型工具范围，不替换已开始任务的原快照。
- 不增加依赖、执行循环、数据库或消息队列。

## Review Focus

- 创建、更新重放先返回原回执，不因后来的角色编辑或归档重新写入。
- 无效、外项目、归档或旧修订不能成为无人值守的通用任务。
- 规则改动或取消在排队期间生效，原发生项不能用新角色偷偷执行。
- 原任务已写入后重启，重放不得因当前角色变化而另开任务。
- 后续角色编辑、源 Skill 修改与预算变化不能重写已开始任务。

## Task 1: 保存助手引用并沿原发生项执行

**Files:** `src/routines.ts`、`src/runtime.ts`、`test/routine-assistants.test.ts`。

**Interfaces:** `RoutineInput.assistant?: AssistantRef`；`LocalRoutineOptions.assistants?: Pick<Assistants, 'select'>`；发生项与历史保存可选引用。执行调用既有 `create(..., { assistant })`。

- [x] 先写并运行失败测试：保存精确引用；notify、无工作区、外项目、旧修订拒绝；首次 Run now 模型获得原角色及方法。
- [x] 使用 `assistantRef` 规范化引用；创建/更新在原回执检查之后验证所选助手；在 occurrenceFor 与原历史中保留引用。
- [x] runtime 向 LocalRoutines 提供现有 Assistants；原执行路径传给 create，保存元数据前重新验证当前助手。已有 taskId 的恢复先回读原任务。
- [x] 运行相关例行任务、权限和角色回归。预期新断言与历史未分配规则均通过。

## Task 2: 恢复、失效和实际入口验收

**Files:** `test/routine-assistants.test.ts`、既有 recovery worker（需要时）、`docs/assistant-usage.md`、能力矩阵和既有决策记录。

**Interfaces:** 复用 Task 1 的引用与现有回执；失败历史保存有界说明，后续规则替换可选择新修订。

- [x] 测试定时发生项和重启；编辑/归档后新工作失败、更新规则后恢复；已开始任务继续使用原角色、原 Skill 与预算。
- [x] 覆盖创建/更新回执重放及取消/排队竞态。原 taskId 保存后中断和重试不能重复模型效果。
- [x] 从 Owner API/CLI 保存、列出、手动运行并读取发生项；历史包含原助手引用。
- [x] 更新使用说明和矩阵，区分直接任务分配与尚未实现的群组定时投递。
- [x] 运行聚焦测试、typecheck、check:commit 和仓库 check；有效独立静态审查通过。Fork 推送结果由 Git 远端核对，额外结构化模型审查的认证失败保留在验收记录。
