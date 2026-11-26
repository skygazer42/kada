# 聊天内会话管理

OpenMausBot 在列目录时按助手归属和原开立者限制可见范围，改名只针对当前会话。归档前核对实际运行、队列和待答，然后保存关闭标记。Kada 复用本机任务元数据、原 Pi 会话检查和终端已有的归档与恢复入口。 [目录源码](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/internal-threads.ts#L39) · [改名源码](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/internal-threads.ts#L89) · [归档校验](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/internal-threads.ts#L111)

## 行为

- 普通本机聊天可以调用 `list_threads`，返回当前会话和已分页的关联工作。关联工作须是从当前会话打开的任务，或由当前工作区的同一命名助手负责。机器生成的例行任务和工作项运行沿各自的管理入口。
- `rename_thread` 使用当前会话和列表显示的修订号。`close_thread` 使用列表中的关联任务 ID 和修订号。两者都来自原用户输入。归档前检查原 Pi 任务、排队输入、待答和待确认。已归档会话通过终端 `/unarchive` 恢复。
- 用户仍可直接查看历史与结果。助手的修改写入原任务元数据。来源、Pi 工具任务 ID 和参数摘要保存于同次原子写入，重放读取当次回执。并发改名、归档或恢复沿目标原修订执行。

## 实施与验证

- [x] 在原线程扩展加入目录、改名、归档工具。验证目录范围、只读、当前会话改名、关联任务归档和待答拒绝。
- [x] 在原 `editThread` 入口固定来源与重放回执，覆盖真实强杀后恢复、同时 owner 编辑，以及列表和任务状态的公开投影。[回归](../../../test/chat-thread-management.test.ts)
- [x] 用硅基流动从普通聊天完成改名和归档，验证用户恢复入口、原结果和模型用量。[实测](../../experiments/2026-11-26-chat-thread-management-siliconflow.json)

## 验收结果

- 15 项聚焦回归通过。已结清的关联目标可归档，当前会话、无关目标以及仍在等待确认的工作保留。暂停后仍有待确认事项也会拒绝归档。对改名与归档分别在写入后、Pi 回执前强杀，恢复都返回旧回执并保留用户后来的修改。 [回归源码](../../../test/chat-thread-management.test.ts)
- 整仓检查共 653 项，649 项通过、4 项可选 Office 案例跳过。类型检查、构建、笔记校验与提交候选检查通过。
- 首轮实测中，Qwen 在指定准备工具后尝试了不存在的校验文件，最终交付通过时用完十次请求的试跑额度。使用同一份已交付任务重开来源会话，DeepSeek V3.2 用四次请求调用 `list_threads`、`rename_thread` 和 `close_thread` 并回复。重启后从终端恢复原任务，交付编号和用量一致。 [初次试跑](../../experiments/2026-11-26-chat-thread-management-siliconflow-attempt-1.json) · [续验](../../experiments/2026-11-26-chat-thread-management-siliconflow.json)
- 独立审查任务未收到正文，代码由当前会话复核。
