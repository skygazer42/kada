# 工作项优先级与截止日期实现计划

> 当前 Fork 功能分支按 superpowers:executing-plans 与 TDD 实施。用户持续授权参考能力对齐，常规字段和展示选择沿源码研究收敛，不另开运行时。

**Goal:** 用户能通过现有聊天或 owner JSON 管理工作项优先级、日期/时刻截止，并在共享只读页看到正确日期及逾期状态。

**Architecture:** WorkItems 保存规划字段及原子回执；Pi 保留原工具 taskId、调用与恢复。日期截止按保存时区比较日历日，精确截止按同一瞬间比较；远程 API 负责投影逾期，浏览器保留日期原文。

**Tech Stack:** 现有 TypeScript、Node.js、Pi 1.4.0、Intl、原子 JSON，无新增依赖。

**Spec:** [固定源码、字段契约与验收](2026-11-26-work-item-planning-research.md)。

## Global Constraints

- 截止不是提醒或执行计划；保存不创建 Goal、任务、提醒或新预算。
- 旧记录读取不改磁盘；旧操作 fingerprint 与历史回执保持，重放不得覆盖后来的规划或运行。
- priority 为 low/normal/high/urgent；dueDate 与 dueAt 合并后互斥，timeZone 以 IANA 保存；旧值投影 normal/null/null/UTC。
- 只复用原 owner/聊天和已分享只读路径，不扩大手机、子任务与历史任务的编辑范围。
- 自定义列、排序编辑、日历拖拽及角色分配继续单列后续；不把本项称作完整看板。

## Review Focus

原回执缺少新字段、缺省字段改变旧摘要、切换截止种类覆盖旧值、客户端时区不同、午夜与 DST 变化。以下测试分别覆盖这些输入，独立审查仍需检查实际入口与范围。

### Task 1：存储、日期校验与兼容

修改 src/work-items.ts；新增 test/work-item-planning.test.ts。WorkItem 增加 priority/dueDate/dueAt/timeZone；导出纯函数 workItemOverdue(item, now?)。dueAt 复用现有 explicitInstant 校验，仅将该共享函数导出，不创建定时任务。

- [x] 先写失败测试：旧文件字节不变、旧 create/update/no-op fingerprint 回放、两种截止切换/清空、非法输入无写入、并发冲突及原运行快照。
- [x] 运行 `npx tsx --test test/work-item-planning.test.ts`，确认因字段/行为缺少失败；最小实现并运行原 work-items/lifecycle 测试。
- [x] 补纯函数测试：纽约日期午夜/DST、精确瞬间、done/archived；日期不依赖客户端时区。

### Task 2：原 Pi 聊天与恢复

修改 src/chat-work-items.ts、test/chat-work-items.test.ts 及现有 SIGKILL 夹具；优先在现有恢复场景增加规划字段，不另写运行器。

- [x] 先写失败测试：普通聊天创建→重启→修改/清空→列表回读，无 Goal/运行/提醒；输入 schema 接受可选规划字段，跨项目仍拒绝。
- [x] 增加 create/update schema 与有界列表/详情字段，提示日期类型互斥、原修订与时区补齐。原无规划字段的 fingerprint 逐字节保持；新字段只在实际提供时参与摘要。
- [x] 跑聊天、原运行与 SIGKILL 回归，确认重放历史规划结果而不覆盖后来修改。

### Task 3：共享展示与实际验收

修改 src/remote.ts、src/remote-page.ts、src/cli.ts；扩展既有共享 API/页面测试。共享 API 投影字段和 workItemOverdue，页面只显示，无编辑权限。

- [x] 先写页面/共享失败测试：相同原 ID/修订，日期原文、时区、优先级及逾期；完成/归档不显示逾期，普通聊天草稿保留。
- [x] 最小接入现有卡片和详情，不改列表默认排序；CLI 继续原 JSON 编辑，仅补帮助。
- [x] 本地真实浏览器检查窄屏日期展示与草稿，真实模型用合成明确日期完成保存/重启/修改并独立回读。实际设备和费用未知时明确记录。
- [x] 聚焦回归、类型/构建及全量；更新使用说明、能力矩阵与现有架构笔记，运行笔记/提交检查。集成策略为提交推送 Fork，无上游 PR。

## 验收结果与裁定

聚焦 62 项通过，全量 503 项中 499 通过、4 项可选 Office 跳过，类型/构建、三项笔记与提交候选检查通过。日期校验复用实际导出的 explicitInstant，避免为取一次校验构造例行任务 schema；没有改变原日期校验行为。

本地真实 Chromium 已验证 Tokyo 页面显示 New York 日期/EST 时刻、草稿和完成后去掉逾期。硅基流动首轮观察过早到限但修改已经提交，失败样本保留；在原 Pi 会话续验通过，原记录一次创建、两次修改。不是修正观察时限后的不中断新样本，金额未知。具体记录见[源码研究与验收](2026-11-26-work-item-planning-research.md)。

独立审查受模型通道和任务投递故障影响而未审阅代码；自动审查缺少 TruffleHog。作者已另行检查当前 diff 和调用路径，不声称独立审查通过。完整看板与实际手机/macOS 仍是后续差距。
