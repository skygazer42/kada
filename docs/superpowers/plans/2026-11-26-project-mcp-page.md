# 本机项目 MCP 工具设置页

参考 Rakazo 的项目内 MCP 工具目录和实际连接设置，Kada 用已有项目工具策略接入浏览器。用户可从终端打开绑定工作区的一次性链接，查询当前启用的连接与工具，再保存选择。 [连接和工具设置源码](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-server-tool.ts#L129)

- 设置页支持继承已启用工具及指定项目工具。指定模式中的空列表表示项目范围内没有可用 MCP 工具。
- 浏览器会话按原项目保存选择。服务复核实时可用的连接和工具，后续运行沿已有 MCP pin 规则。
- 回归覆盖同源项目范围、链接重用、非法工具、空列表和恢复继承。 [自动化测试](../../../test/mcp-tools.test.ts)

Chromium 通过终端生成的链接打开设置，验证 STDIO 连接的两个已启用工具。选定一个工具后重载保留范围，可清空范围或恢复继承。 [浏览器验收](../../experiments/2026-11-26-project-mcp-browser.json)
