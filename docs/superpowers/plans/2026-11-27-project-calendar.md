# 项目看板的 Google 日历读取

用户为项目选择一条已测试的 Google Calendar MCP 连接，固定连接修订、账号别名、日历和显示时区。打开看板日历时读取所选月份，并在同一天显示外部日程和工作项截止日期。MCP 权限变更后，重新选择当前启用的来源。

Rakazo 为获得授权的账号读取即将发生的日程。Google Calendar MCP 的 `list-events` 接受单个账号及日历，按时区解析时间窗口，并返回包含 `events` 的 JSON 文本。Kada 复用 MCP 项目范围检查和派发前校验。日历只投影标题及起止时间。 [Rakazo 的读取服务](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/meetings/calendar/calendar-service.ts#L80) · [工具规范](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L272) · [响应实现](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/ListEventsHandler.ts#L95)

回归覆盖本机入口与项目归属、重启后的来源记录、月边界、全天与精确时间、撤销后的读权限和其他账号过滤。Pi 任务的工具范围沿现有 MCP 配置保存。真实 Chromium 通过看板浏览当前月和上个月，并验证权限调整后外部日程清除而原工作项可继续查看。浏览器使用合成的 Calendar MCP 响应。真实 Google 账号需要可用的连接授权，上游单次响应数量仍由 `list-events` 决定。 [回归](../../../test/project-calendar.test.ts)

## 聊天查询及审批写入

项目用户启用 `allowAssistant` 后，新本机普通聊天可查询当天或 31 天内的一段日期。查询按绑定日历的时区解释本地日期，输出该账号的标题和起止时间。读权限撤回或切换日历后，旧聊天的下一次读取会失败。 [Rakazo 读取实现](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/meetings/calendar/calendar-service.ts#L98) · [项目回归](../../../test/project-calendar.test.ts)

项目许可包含只读 `get-freebusy` 时，普通聊天与执行任务可查询满足指定会议时长的空档。宿主使用一个已绑定的账号和日历，按时间次序合并相叠的忙碌段，再返回达到最小时长的空档。日历单独报错或忙碌区间异常时，查询显示失败。 [Calendar MCP 的查询和归并](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/FreeBusyEventHandler.ts#L16) · [合成忙碌和错误回归](../../../test/project-calendar.test.ts)

执行任务按创建时的项目配置获得日历写入工具。创建、更新和取消分别对应当前连接已开启逐次审批的工具。模型提供日程参数，宿主固定账号、日历及原事件 ID，保存含邀请选项的原审批。重启后继续处理同一审批。派发时复核当前绑定、工具许可、任务修订和时限。创建操作携带由原工具调用生成的 Google Calendar 事件 ID。 [Suparagent 应用审批](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/composio_actions.py#L136) · [Rakazo 审批参数与路由](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L119) · [Calendar MCP 创建](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L358) · [更新](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L586) · [取消](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L705)

合成 MCP 回归核对普通聊天确认计划后启动创建、三种写入的准确参数、审批前的零派发、重启后的重复决定以及换绑后的停止。实际 Google 账号还需验收写入和邀请投递。 [回归](../../../test/project-calendar.test.ts)

普通日程更新只使用事件 ID 和修改字段。创建周期日程可提交 RFC 5545 规则。读取周期实例时保留原系列 ID 和原开始时间，编辑可选单次、从指定实例起的后续日程或整个系列。审批保存所选范围及该范围要求的时间。合成服务按上游规则拒绝缺少原开始时间的单次范围及缺少分界的后续范围。 [Calendar MCP 规则](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/tools/registry.ts#L622) · [更新分派](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/UpdateEventHandler.ts#L125) · [回归](../../../test/project-calendar.test.ts)

创建审批可包含 Google Meet 请求，会议请求使用原工具调用的稳定事件 ID。日程列表可返回 Google Meet 链接。邀请回复沿用所选账号和原日程，审批保存回复状态、备注、周期范围和通知选项。合成回归核对 Meet 请求及原账号回复邀请的准确参数。 [会议创建](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/CreateEventHandler.ts#L142) · [邀请回复实现](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/RespondToEventHandler.ts#L22) · [回归](../../../test/project-calendar.test.ts)

## 即将开始的日程提醒

Rakazo 从授权日历读取未来窗口，以会议和开始时间生成稳定预约 ID。Kada 将这个机制用于本地例行提醒。用户指定提前分钟数，Pi 定时读取绑定日历，按原日程 ID 和起始时刻识别同一场日程。匹配结果进入当前例行任务的已保存发生项，再沿原通知回执进入本机收件箱。 [未来日程筛选](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/meetings/calendar/calendar-service.ts#L911) · [预约身份](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/meetings/calendar/calendar-rules.ts#L17)

- 用假时钟验收具体窗口、同一预约的去重、重启和权限撤回。
- 在原项目日历适配器复用只读权限检查、事件投影和账号匹配。提醒适用于有开始时刻的日程。
- 在现有 Pi 例行任务落盘本次日历身份、事件和通知决策。本机通知展示原标题及开始时间。

提醒需要当前项目的只读日历工具，提前量可设为 1 至 1440 分钟。每次检查进入未来窗口的有时刻日程，每一轮最多通知 100 条。收件箱写入前再次检查日历绑定和规则状态。回归通过合成 Calendar MCP 验证精确窗口、daemon 重启后的去重、权限撤回及日程范围。 [回归](../../../test/project-calendar.test.ts)

## 浏览器项目绑定

项目 MCP 设置页显示当前 Gmail 与 Google 日历绑定。候选连接按项目已启用的只读工具及其修订计算。页面持原项目授权，保存与解除复用终端的来源配置，储存失败时保留表单输入。真实 Chromium 在合成连接上验证两种绑定、无效时区恢复、刷新后读回配置及单独解除 Gmail。 [Rakazo 的已连接应用列表](https://github.com/elie222/rakazo/blob/e64d73292179/apps/mobile/components/integrations/connected-apps.tsx#L58) · [项目范围 API 回归](../../../test/mcp-tools.test.ts)

日历连接允许只读 `list-calendars` 时，设置页可请求所填账号的日历列表。列表只投影日历 ID、标题和时区。真实 Chromium 验证从列表选择、填入 ID 和时区、保存及刷新后读回。API 回归验证限制在当前项目以及撤去工具权限后的拒绝。 [原日历列表](https://github.com/nspady/google-calendar-mcp/blob/29a7090d17175745c2b3a9aa10d0ff464432f3ca/src/handlers/core/ListCalendarsHandler.ts#L8) · [回归](../../../test/mcp-tools.test.ts)
