# MCP 单次动作审批

当前实现以 `4f423be` 为基线，沿用 Pi 1.4.0。使用者可为已启用的 MCP 工具选择逐次审批。模型调用时保存固定参数、连接修订和目标修订，并进入原待答入口。宿主接受用户的决定后创建同一 Pi 会话所有的持久执行任务，结果通过固定请求 ID 回交主会话。参数预览脱敏，决定绑定所展示的 SHA-256。

参考 Rakazo 的[批准参数与修订](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L91)和 Suparagent 的[审批查询与答复](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/permission.py#L60)。

- [x] MCP 选择审批工具并固定到任务，实际派发时核对当前许可和期限。
- [x] Pi 业务文档保存动作和用户决定，审批列表展示脱敏参数。
- [x] 允许动作在派发前持久记录意图，派发后中断记为结果未知。
- [x] 本地 API、终端查询及答复接入原任务身份和预算。
- [x] 覆盖拒绝、精确参数、重复答复、修订变化、撤销、重启和结果未知。

普通问答和子 Agent 不创建宿主动作审批。首版入口为本地终端和认证 API。电脑动作继续使用原控制权机制。
