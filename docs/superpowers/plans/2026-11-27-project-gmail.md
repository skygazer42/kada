# 项目 Gmail 搜索和原邮件读取

用户为项目绑定已测试的 Google Workspace MCP 连接和一个邮箱。终端支持查询、下一页和原邮件阅读。请求始终使用绑定的邮箱。每次调用都核对当前连接修订、项目许可及只读声明。原邮件正文以分页读取，后续页使用原正文的 SHA-256 防止混入编辑后的版本。

Rakazo 从连接账号发现并路由应用工具。Kada 复用 Pi 宿主已有的 MCP 授权和派发，使用 Google Workspace MCP 声明为只读的两个 Gmail 工具。 [连接工具路由](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/providers/integration/pipedream/pipedream-connector.ts#L224) · [Gmail 查询](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1748) · [原邮件页](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1987)

14 项相关回归与构建通过。验收覆盖原邮箱绑定、项目隔离、重启恢复、查询翻页、原正文签名校验、许可变更和终端入口。合成 MCP 夹具采用上游的文本查询和 JSON 正文页协议。真实 Google 账号仍需配置授权。 [回归](../../../test/project-gmail.test.ts) · [原正文分页契约](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_helpers.py#L397)

## 本机普通聊天

Rakazo 派发工具前按当前账号批准范围查找连接。Kada 在邮箱配置中提供 `allowAssistant`，由本机用户明确开启。新本机普通聊天固定项目、邮箱和连接修订，使用与终端相同的只读调用。搜索结果和正文可以进入当前聊天使用的模型。每次调用重新核对邮箱和权限，过期的邮箱绑定会报错。 [Rakazo 已批准账号选择](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/providers/integration/pipedream/pipedream-connector.ts#L264) · [Kada 邮箱工具](../../../src/project-gmail.ts)

脚本化 Pi 与合成 MCP 回归验证普通聊天查询和阅读、重启后的同一聊天读取、更换邮箱后的拒绝、旧聊天和远程聊天的工具范围。真实邮箱及远端模型的综合验收待完成。 [回归](../../../test/project-gmail.test.ts)
