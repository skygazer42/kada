# 本机 MCP 连接管理页面

Kada 将现有连接定义、发现工具、全局启用、单次批准与 OAuth 操作接到本机浏览器。入口单独绑定本机管理范围。 [Rakazo 连接设置实现](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-server-tool.ts#L129)

- 浏览器用现有连接定义保存连接，列表显示安全的状态与工具元数据。现有 OAuth 流程从该页发起。
- 测试连接、启用或禁止工具和调整批准仍走 CLI 使用的同一服务操作。启用和批准以已测试的版本保存。
- 自动化覆盖链接权限、一次性兑换、项目权限隔离、跨源拒绝、登记、工具发现、旧版本、启用、批准、停用及 OAuth 授权完成。 [连接回归](../../../test/mcp-tools.test.ts) · [OAuth 回归](../../../test/mcp-oauth.test.ts)

Chromium 使用终端发放的链接打开连接页，登记合成 OAuth 连接，跟随登录链接完成本机回调。随后测试并启用工具，验证逐次批准在重载后保留，再停用和退出。登录链接在同一测试标签页打开，外部账号和新标签页行为待测。 [浏览器验收](../../experiments/2026-11-26-mcp-connections-browser.json)
