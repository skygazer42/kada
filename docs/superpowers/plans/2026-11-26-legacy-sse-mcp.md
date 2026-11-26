# 旧版 SSE MCP 连接

Rakazo 根据连接设置选择 Streamable HTTP 或旧 SSE。Kada 把 `sse` 加到原连接类型，沿用 MCP SDK、连通性检查、连接修订、工具名单、项目范围与认证入口。普通聊天建议中可注明传输类型，原有建议按 HTTP 解释。[Rakazo 传输选择](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-transport.ts#L435) · [Kada 连接](../../../src/mcp-tools.ts)

本地测试分别验证旧 SSE 流与消息发送、环境变量认证、同源消息地址、工具发现及真实调用。连接登记、测试与启用继续经过现有本机流程。[测试](../../../test/mcp-sse.test.ts)

本地 OAuth 服务验证了实际登录、后台重启后的回调、工具发现和令牌刷新。旧建议缺少传输字段时沿 Streamable HTTP 受理，同一 SSE 建议重放时保留原传输类型。[OAuth 回归](../../../test/mcp-oauth.test.ts) · [旧建议兼容](../../../test/mcp-proposals.test.ts)

相关 52 项回归、生产与回归代码的类型检查、构建均通过。SSE 测试使用真实本地协议服务。
