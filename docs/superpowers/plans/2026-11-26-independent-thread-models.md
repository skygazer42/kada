# 独立工作模型选择

OpenMausBot 让 `list_models` 和 `start_thread` 共用引擎与权限校验，并将第二意见会话固定在用户选中的模型。Kada 使用已安装 Pi 的 `getAvailable` 查询有完整认证配置的模型，创建时复核精确模型。模型路由使用原任务的 Pi 会话入口。 [参考源码](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/own-threads.ts#L25) · [工具调用](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L446)

## 使用与数据契约

- 终端 `/thread` 和 `/thread-report` 接受可选的 `--model provider/modelId`。API 收 `modelSelection`。普通本机聊天用 `list_models` 查目录，按用户明确请求向 `start_thread` 传 `model_selection`。目录按搜索与页码返回精确 ID 和当前会话模型。
- 独立任务在准备之前保存选中的模型，同时保存原角色修订和工具范围。模型选择参与原创建请求的摘要。相同请求重试沿原任务，改选模型属于新的请求。省略参数时按原入口选模型和角色。
- 创建时不可用的模型返回错误。已经保存的选择交给 Pi 运行，供应商拒绝表现为原任务失败。原会话的续答使用它自己的模型，回传记录保留独立结果的模型来源。

## 实施与验收

- [x] 扩展 `src/task-threads.ts` 的工具和原模型选择。`src/runtime.ts` 在新任务入口复核可用性和固定版本，保留原 Pi 恢复入口。用两套模拟模型验证角色、准备和执行路由、回传、重启和请求冲突。[模型和角色回归](../../../test/thread-models.test.ts)
- [x] 扩展 `src/chat.ts` 的终端命令及模型回显。终端通过 owner API 验证选模型请求响应丢失后的重试和原任务展示。运行时回归核对错误 ID、供应商不可用与撤权后的原模型失败。[终端回归](../../../test/local-threads.test.ts)
- [x] 用硅基流动的两种真实模型完成一个短合成任务。核对原会话回答、独立任务准备和交付、原会话收到报告各自实际使用的模型。[实测](../../experiments/2026-11-26-independent-thread-models-siliconflow.json)

## 验证

- 27 项聚焦回归通过，覆盖终端响应丢失、原创建 ID、固定角色、认证状态变化、报告来源和回传恢复。
- 整仓检查共 650 项，646 项通过，4 项可选 Office 案例跳过。类型检查、构建、笔记校验和提交候选检查通过。
- 硅基流动验收共四次实际请求。DeepSeek V3.2 处理原会话，Qwen2.5 7B 准备和交付独立任务，DeepSeek V3.2 接收报告。子任务的准备与提交工具由验收脚本指定，用户确认仍走正常入口。重启保留两边的模型和同一条回传。首次试跑修正了脚本传给 Pi 工具目录的参数。[实测](../../experiments/2026-11-26-independent-thread-models-siliconflow.json) · [初次试跑](../../experiments/2026-11-26-independent-thread-models-siliconflow-attempt-1.json)
- 普通聊天路径共七次实际请求。DeepSeek 先调用 `list_models`，再按目录 ID 调用 `start_thread`，Qwen 准备及交付确认后的任务，DeepSeek 在来源会话接收报告。两种入口的验收用例分别为 `T09-thread-models` 和 `T09-thread-models-chat`，在 `KADA_LIVE_CASES` 中选择后运行现有硅基流动脚本。[聊天实测](../../experiments/2026-11-26-independent-thread-models-siliconflow-chat.json) · [验收脚本](../../../scripts/live-assistant-memory.ts)
