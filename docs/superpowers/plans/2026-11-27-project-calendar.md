# 项目看板的 Google 日历读取

用户为项目选择一条已测试的 Google Calendar MCP 连接，固定连接修订、账号别名、日历和显示时区。打开看板日历时读取所选月份，并在同一天显示外部日程和工作项截止日期。MCP 权限变更后，重新选择当前启用的来源。

Rakazo 为获得授权的账号读取即将发生的日程。Google Calendar MCP 的 `list-events` 接受单个账号及日历，按时区解析时间窗口，并返回包含 `events` 的 JSON 文本。Kada 复用 MCP 项目范围检查和派发前校验。日历只投影标题及起止时间。 [Rakazo 的读取服务](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/meetings/calendar/calendar-service.ts#L80) · [工具规范](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L272) · [响应实现](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/ListEventsHandler.ts#L95)

回归覆盖本机入口与项目归属、重启后的来源记录、月边界、全天与精确时间、撤销后的读权限和其他账号过滤。Pi 任务的工具范围沿现有 MCP 配置保存。真实 Chromium 通过看板浏览当前月和上个月，并验证权限调整后外部日程清除而原工作项可继续查看。浏览器使用合成的 Calendar MCP 响应。真实 Google 账号需要可用的连接授权，上游单次响应数量仍由 `list-events` 决定。 [回归](../../../test/project-calendar.test.ts)
