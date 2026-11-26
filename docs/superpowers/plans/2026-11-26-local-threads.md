# 独立工作会话与归档

OpenMausBot 的 `start_thread` 从原会话打开带标题的独立会话，并放回可追溯的线程引用。关闭入口核对归属、正在运行的工作及未答问题，随后仅保存关闭标记。Pi Durable 的会话 API 支持独立会话和继承条目的 fork。Kada 使用已有的每任务 Pi 会话入口创建独立工作，并保存来源任务 ID。[创建与来源](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L13865) · [关闭入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/internal-threads.ts#L111) · [关闭状态](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/store.ts#L2186) · [Pi 会话 API](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#more-conversations-and-forks)

- 本机终端用 `/thread 标题 | 任务说明` 从当前任务打开一项独立工作。新会话保存首条任务说明、来源 ID 和当前工作区，使用原有任务说明与预算确认。模型在新本机普通聊天收到用户的开会话请求时，可用 `start_thread` 创建同样的待确认工作。工具使用当前原 Pi 用户输入的稳定身份，每条输入可打开一项工作。终端从已保存的工具回执显示 `/attach` 入口，模型创建的工作沿用源模型及固定角色。[原会话中的引用消息](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L13904)
- `/title` 更新显示标题。`/archive` 归档已结清或停止的工作，`/tasks archived` 查询，`/attach` 查看原会话，`/unarchive` 恢复显示。标题和归档用同一个版本检查和原子元数据写入。原任务 ID、对话、交付与已耗预算随原会话保存。
- 原列表和项目目录默认显示未归档工作。按来源 ID 查阅时，项目目录仍使用原项目范围。终端在已归档会话显示恢复入口；发送新消息前先恢复。归档检查实际 Pi 活动和原用户待处理项。
- 端到端验证同一请求重试、冲突参数、原会话来源、用户确认前零执行、终端归档及重开、未认证请求、旧任务兼容。恢复测试在保存新会话身份后强杀进程，再核对原 Pi 首条输入只受理一次。

## 验证

终端回归覆盖创建响应丢失后的重复提交、原 Pi 输入重复派活、标题版本冲突、待确认时拒绝归档、归档筛选和后台重启后恢复。强杀发生在元数据已保存、子会话尚未启动时，恢复保留 ID、父会话回执和唯一首条输入。[回归](../../../test/local-threads.test.ts)

硅基流动 DeepSeek V3.2 最终用了 9 次请求。用户从原会话的回执打开独立工作，确认前文件不存在，确认后验证原文件。改名与归档后重启后台，再打开同一个已交付会话并核对原用量。前两次分别停在预算和父会话回复超时，均保留记录。[实测](../../experiments/2026-11-26-local-threads-deepseek.json)

全量 624 项通过。最终会话版本的定向回归、类型与构建，以及编译后 CLI 的创建、确认、归档列表和恢复路径均通过。独立复核通道未收到任务内容，当前记录来自实际运行及本地检查。
