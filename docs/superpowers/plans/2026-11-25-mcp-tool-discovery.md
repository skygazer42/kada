# MCP 工具按需加载实现计划

**目标：** 大型已授权 MCP 工具集先通过 Pi 原生工具检索加载所需 schema，避免初始模型请求一次携带完整目录。

**参考：** [Rakazo 超过 20 个工具切换目录](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-connector.ts#L440)、[目录参数与执行边界](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/lazy-tool-catalog.ts#L33)。Pi 1.4.0 已公开 `deferred`、`createToolSearchExtension()` 及 `AgentDoc.modelTools`；Pi 负责检索、control.addTools、压缩和恢复，不另建目录或加载状态。

**契约：**

- 新建本机任务的固定 MCP 工具总数超过 20 时，保存 `mcpDiscovery: deferred`。不超过 20 个、旧任务、远程任务保持原行为。
- 已固定的 MCP 工具注册为 deferred，只在执行阶段选中原 Pi tool-search 扩展；准备、普通聊天不自动得到 MCP 工具。搜索只访问当前已允许且固定修订的工具，服务新增或未启用的工具不进入目录。
- 工具加载后仍通过原 MCP 参数校验、修订、项目权限和单次审批。加载成功不代表实际执行或账户有效。
- configureStage 复用 Pi AgentDoc 中已加载的 MCP 名称，不能在重启或配置阶段覆盖掉它；不创建第二份加载状态。主会话排除仅供后台子任务的 delegation_ask，防止原生搜索加载不适用工具。
- 同步子 Agent 沿用原工具归属；后台子任务保持既有文件工具范围。旧会话不因升级切换目录。
- 不增加依赖、通用工具代理、网络服务或自动授权。初始 schema 缩减是结构事实，真实成功率及费用需另测。

**修改：** `src/mcp-tools.ts` 为原工具注册增加可选 deferred；`src/runtime.ts` 在新任务快照、执行扩展和 configureStage 中接入原生 Pi。`test/mcp-discovery.test.ts` 使用真实 stdio MCP 服务及 Pi 模型请求验证工具可见性、执行、重启/压缩、审批和旧任务。Spec、使用说明和原架构笔记同步。

- [x] 写失败回归：21 个工具初始隐藏 schema、搜索后使用原调用、未授权工具不加载。
- [x] 接入 Pi deferred/tool_search，保留原权限边界和原生加载状态。
- [x] 验证 20 个工具及旧任务保持直出；重启/压缩保留工具；单次审批和主/子会话范围。真实硅基流动模型通过。
- [x] 运行相关/全量测试、类型/构建、提交及笔记检查。
- [x] 提交推送 Fork 功能分支，不创建上游 PR。

## 验证记录

大目录缺少延迟注册先由失败回归证明。最终 7 项工具发现专项全部通过；既有审批及 MCP 连接相关 18 项回归通过。完整 `npm test` 共 428 项：424 通过、0 失败、4 项 Office 样例因可选依赖缺失跳过。全量进程读入测试文件后补充的后台子任务待答用例已单独通过，并包含在最终 7 项专项中。类型、构建、提交候选和三项笔记校验通过。

真实 stdio MCP 服务及原 Pi 回归覆盖 21 个工具初始隐藏、按原名加载及调用、原生压缩和重启保留、20 个工具及旧任务直出、逐次审批、撤权、未启用工具排除、同步子任务和后台待答工具范围。硅基流动 DeepSeek V3.2 用 3 次请求完成指定工具调用，初始 MCP schema 数为 0，21 个工具中只调用目标一次，重启后加载保留；共 18,113 总 token，金额未知。原始脱敏记录见 `docs/experiments/2026-11-25-mcp-discovery-deepseek.json`。

自动审查因缺少 TruffleHog 在模型审查前停止；独立审查任务正文不可读，未执行审查，没有独立审查通过结论。主会话检查完整生产差异及 Pi 公开 API。未测真实第三方大型工具服务、中文检索质量及相同任务成本收益对照。
