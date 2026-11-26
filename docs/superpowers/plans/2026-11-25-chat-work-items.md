# 聊天待办管理实现计划

> 在现有 Fork 功能分支内使用 superpowers:executing-plans，沿用持续对齐的授权，先写失败测试再实现。

**目标：** 普通本机聊天可保存、分页查看、回读、修改、完成和归档当前项目工作项，不把保存待办理解成执行许可。

**源码：** [Rakazo 列表默认排除 done](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/scratchpad-tools.ts#L45)、[创建](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/scratchpad-tools.ts#L73)、[修改归属与完成](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/scratchpad-tools.ts#L131)、[Suparagent 状态规划与归档](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31)。独立实现，不复制数据库/运行系统；Kada 保留工作项及原运行，归档代替永久删除。

**Pi 核对：** 已安装 1.4.0 的 defineTool 负责参数验证，api.taskId 是原工具任务身份，replay=safe 在中断后重入原调用。WorkItems 继续用现有 JSON 及原子保存，操作回执与修改同一次保存，不新增数据库或执行层。

## 契约

- WorkItem 增加 open/parked/done、archived、completedAt。旧数组无这些字段时只在读取投影补 open/false/null，不自动改历史文件；修改保留原 ID、工作区、项目和运行关联。done 时间在首次进入 done 时保存，编辑 done 的文字保留时间，重开清除；归档不改完成状态。
- owner create/update/list/get/shared 沿用原入口，PATCH 增加 status/archived。工作项完成/归档不操作已存在运行。新运行拒绝 done 或 archived，原请求重试仍返回原运行。parked 工作项允许用户从原 owner run 入口明确执行。
- 新本机聊天保存 chatWorkItems 的原项目根，只在聊天阶段注册 work_items_list、work_item_read、work_item_create、work_item_update。远程、准备/执行任务、子任务和旧聊天不新增这些工具。
- list 默认排除 done 和 archived；includeDone/includeArchived 可分别打开。limit 1–50 默认20，offset 非负安全整数。按更新时间、ID 排序，返回 ID、修订、标题、状态和 500 字说明片段。read 用原 ID 回读最多8,000字并标注截断。
- create 接收标题、说明和可选初始状态；工作区固定原聊天工作区，不能由模型指定。update 需原 ID、修订及至少一个明确变更：标题/说明/status/archived。项目归属在原保存队列内复核，不能改归属、创建运行或删除历史。
- create/update 的原聊天及 Pi taskId 派生 requestId，规范输入摘要和当次公开结果与工作项一起保存。相同请求同内容在重启、后续编辑或归档后返回历史回执；变更请求内容冲突。无回执的旧修订不覆盖新内容。回执不从公开 API、共享手机或模型列表泄露。
- 原数组文件向后可读，内部 operations 可选；公有投影只返回 WorkItem 字段。该回执随原工作项保存，当前没有永久删除入口，也不截断尚可能重放的回执。
- 手机只展示已分享工作项的状态/归档信息，权限与运行控制不变；CLI edit 的 JSON 可管理生命周期。没有新增手机编辑权。

## 修改范围

src/work-items.ts 承担字段验证、生命周期和请求回执；src/chat-work-items.ts 为原服务加薄工具；src/runtime.ts 固定新聊天范围；src/conversation.ts 说明保存待办为普通聊天。src/remote.ts、src/remote-page.ts 展示原状态；src/cli.ts help 说明现有 edit 用法。同步 Spec、使用文档和原架构笔记。

- [x] WorkItems 失败测试：旧文件兼容、生命周期、原运行、新运行门槛、修订竞态、重放与异内容冲突；实现并通过。
- [x] Pi 聊天工具失败测试：创建→查→改→完成→归档、无 Goal、隔离、分页/截断、无效参数与旧范围；实现并通过。
- [x] 实际 SIGKILL 覆盖 create 已保存、update 保存前/后与后续编辑；原操作重入不重建或覆盖。
- [x] 手机共享 API 和页面状态展示回归，并从真实浏览器查看已完成/归档状态。
- [x] 硅基流动中文保存→重启→改名/完成/归档；核对原 ID、工具回执、无运行和无 Goal，保存脱敏证据。
- [x] 相关回归、类型、构建、提交候选、笔记校验；记录限制，提交推送 Fork，不创建上游 PR。

## 取舍与边界

另建聊天待办存储可以少改原服务，却造成待办与已有工作项/共享运行分叉，因此扩展 WorkItems。只在 Pi 工具结果记成功不能跨原子文件已保存而工具未回执的窗口恢复；同一次原子保存中保留回执。回执会增加文件体积，大规模性能与清理政策后续实测再决定，不静默删除历史。优先级、截止日期和看板排序仍是下一阶段，完成本计划不等于完整规划能力对齐。

## 验证记录

3 项原服务生命周期测试先失败后通过，5 项聊天工具覆盖普通管理、隔离/参数、分页/截断、旧范围以及聊天转 Goal 后主会话和 Pi 子任务均无管理工具。4 项独立进程 SIGKILL 验证已提交创建、修改前、修改后和归档后中断；后来的 owner 编辑保留，历史回执只返回原结果。相关回归首次 96/97，通过修复上一轮项目目录遗漏的准备阶段工具清单断言后，含该场景的 13 项回归通过；未把首次失败隐藏为全绿。

硅基流动 DeepSeek V3.2 的中文流程使用 8 次请求、53,405 总 token；原 ID、完成时间和无 Goal/运行断言通过，金额未知。[脱敏实测](../../experiments/2026-11-25-chat-work-items-deepseek.json)。Chromium 390 × 844 真实页面经原配对入口打开已分享待办，显示 Done/Archived，展开原 waiting_user 运行后原草稿不变；截图保存在本机 .harness/work-item-lifecycle-mobile.png，实体手机未验收。

最终全量 `npm test` 为 455 通过、4 个可选 Office 跳过、0 失败，包含 5 项聊天工具和 4 项强杀恢复。类型、构建、提交候选、diff 空白及三项笔记校验通过。独立 reviewer 的任务正文再次被网关省略，没有审阅代码，不能当作独立审查通过；autoreview 在 reviewer 调用前因必需 TruffleHog 缺失退出。功能提交推送到 Fork 的 codex/assistant-plan，不创建上游 PR。
