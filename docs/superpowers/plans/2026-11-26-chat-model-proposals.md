# 聊天中的项目默认模型建议

OpenMausBot 从原对话接收 `propose_model`，确认卡固定当前值和所提模型，申请处理时复核默认模型是否已变更。Kada 用同样的原会话关系、项目范围与版本检查，将建议落到已有 Pi 模型目录和项目默认模型设置。[工具调用](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L707) · [确认与冲突](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/model-requests.ts#L271) · [Kada 设置](../../../src/provider-settings.ts)

- 新本机普通聊天可提议当前项目的默认模型。建议保存模型目录中的 provider 和 modelId、原会话、原 Pi 工具 ID、理由及当前有效的项目默认值。建议提交后在终端有可核对的入口。
- 用户从原会话用 `/model-proposals` 查阅，再用 `/apply-model ID` 或 `/decline-model ID` 决定。应用时调用当前连通性检查，并在原设置事务复核项目默认值与建议状态。只有检查通过且原默认值仍相符时，才保存新项目默认值及应用回执。
- 检查失败可再次核对连接。拒绝及重复应用沿原回执。新任务读取当前项目默认值，已存在会话沿已有模型快照执行。验收包含旧会话、跨项目和远程隔离，重启、过期决定及两个并发用户请求。[验收](../../../test/model-proposals.test.ts)

## 验证

回归覆盖探测前和探测期间更改设置、连接不可用后的重试、请求丢失、建议理由脱敏及跨会话隔离。真实 SIGKILL 停在已应用但用户尚未收到回执时。重启后先手工变更默认模型，再重放已确认请求，返回原回执并保存后来选择。[回归](../../../test/model-proposals.test.ts)

硅基流动实测用了 5 次请求。DeepSeek 提出将后续会话切换为 Qwen 的建议。用户确认后，Kada 探测 Qwen 并设置项目默认值。原会话沿用 DeepSeek，新会话使用 Qwen，另一个项目保持原默认值。[真模型测试](../../experiments/2026-11-26-model-proposals-deepseek.json)

全量 634 项通过。最终修改的 69 项相关回归、类型与构建均通过。编译后的 CLI 验证了建议显示、一次连通性探测以及新旧会话模型归属。
