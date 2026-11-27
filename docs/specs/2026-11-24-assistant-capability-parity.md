# 个人助手能力对照

以 `fe8e9b4` 为对照基线。沿用 Pi 1.4.0 的会话、任务、工具与持久化。参考项目以开发计划中的固定提交为准。每项按用户能否从正常入口完成场景来判断，源码或测试夹具只能证明各自覆盖的部分。 [产品 Spec](../../SPEC.md) · [参考项目与版本](../superpowers/plans/2026-11-23-personal-assistant.md#参考优先级)

## 已实现能力

| 能力 | Kada 契约与验收 | 参考实现 |
| --- | --- | --- |
| 原会话结构化提问与答复 | 新任务固定 structuredQuestions，主会话 ask_user 保存 2–4 个选项与详情；普通聊天无 Goal，准备/执行沿原 Goal 等待阶段。ID 为 Pi 工具 taskId，答复核对原问题及任务修订，重放同内容复用原输入。后台子任务扩展原 delegation_ask；终端、手机与 macOS 提供选项与自由文字，原共享权限和预算继续生效。 | [Rakazo ask_user](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/builtin-conversation.tool-definition.ts#L94) · [原答复事务](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/threads/thread-ask.ts#L214) · [OpenMausBot 被动卡片](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/options-card.ts#L33) · [Pi 回归](../../test/structured-questions.test.ts) · [强杀恢复](../../test/question-recovery.test.ts) |
| 聊天项目待办与生命周期 | 新本机聊天在原项目内保存、分页查询、回读和修改 WorkItem，支持 open/parked/done、完成时间及归档。保存待办不创建 Goal/运行，完成/归档不取消原运行；原请求回执与文件同次原子保存，重启不重复或覆盖后来编辑。旧数组只在读取投影补默认字段；内部回执不进入公开/共享投影。 | [Rakazo 列表与创建](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/scratchpad-tools.ts#L45) · [修改归属与完成](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/scratchpad-tools.ts#L131) · [Suparagent 工作项](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31) · [生命周期回归](../../test/work-item-lifecycle.test.ts) · [聊天工具](../../test/chat-work-items.test.ts) · [强杀恢复](../../test/chat-work-item-recovery.test.ts) |
| 聊天查询当前项目任务 | 新本机主会话用 project_tasks 查询同项目其他原任务，待处理优先并分页，返回原 ID、状态、目标/摘要/问题/步骤的有限投影。排除远程私有会话、其他项目和调用者；历史和子会话不扩权。沿原 status/taskHandoff 读取，查询不提交模型工作、修改预算或创建 Goal。 | [OpenMausBot list_threads](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L236) · [Rakazo 实际目录](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/task-catalog.ts#L22) · [回归](../../test/project-tasks.test.ts) |
| 聊天周期提醒与修改 | 新本机聊天可保存、查询、修改和取消本项目 once/daily/weekly 通知。原 Pi 计算 IANA 时区、夏令时和补跑；编辑保留工作区与原政策。修改固定原修订，并在原事务保存请求摘要和结果；强杀后返回原回执，不覆盖后续编辑或取消。旧 true 聊天保留单次接口，其他项目、混合事件和执行型规则排除。 | [Rakazo 日程工具](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L52) · [修改归属](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L1030) · [修改竞态](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/schedule-tools.ts#L1197) · [工具与回执回归](../../test/chat-reminder-management.test.ts) · [强杀恢复](../../test/chat-reminder-recovery.test.ts) |
| 大型 MCP 工具集按需加载 | 本机新任务固定的 MCP 工具总数超过 20 时，使用 Pi deferred/tool_search 加载所需 schema；原 Pi 会话保留已加载工具，压缩和重启后可继续使用。加载后的调用仍通过原修订、允许列表与单次审批。主会话排除子任务待答工具；准备、聊天和旧任务保持原范围。 | [Rakazo 目录切换](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-connector.ts#L440) · [目录边界](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/lazy-tool-catalog.ts#L33) · [Pi 工具发现](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/src/tool-search/tool-search.ts) · [Pi/stdio 回归](../../test/mcp-discovery.test.ts) |
| 项目原对话检索与回读 | 本机新主会话可检索同项目其他任务的原用户输入与最终助手正文，返回 taskId、entryId、时间和片段，再按 ID 回读原文。原 Pi 分页和压缩后记录保持来源；其他项目、远程私有会话、自动初始输入及内部流量排除。旧任务和子 Agent 不自动获得能力。 | [OpenMausBot session_search](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L568) · [工具与回读](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L807) · [归属边界](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L13390) · [Unicode 匹配](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/message-search-query.ts#L14) · [Pi 集成回归](../../test/project-history.test.ts) |
| 本机聊天内单次提醒 | 新聊天的主会话以原 Pi 工具保存、查询和取消同项目单次通知。先读机器时间/时区，创建 ID 固定原聊天及工具任务；取消绑定工具参数中的修订并在原事务复核。强杀后不重复创建，不取消后来编辑的新提醒，不创建 Goal。远程、准备及旧聊天不自动扩权。 | [OpenMausBot 时间与触发器查询](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L596) · [创建路径](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call-triggers.ts#L453) · [Pots 请求 ID 防重](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/gateway/timers.ts#L429) · [工具与隔离回归](../../test/chat-reminders.test.ts) · [强杀恢复](../../test/chat-reminder-recovery.test.ts) |
| 例行任务账户拒绝降频 | 循环项目任务显式开启 accountBackoff 后，原 Pi 最终账户拒绝按 5 分钟倍增至 24 小时跳过后续自动预检和模型请求。原任务/提交 ID 防止重复累计，截止时间使用原消息时间。手动成功任务在下次检查清除降频，暂停/编辑和 SIGKILL 保留状态。临时错误仍由 Pi 重试。 | [Rakazo 拒绝分类](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L37) · [倍增间隔](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L60) · [成功后清除](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L119) · [回归](../../test/routine-account-backoff.test.ts) · [强杀恢复](../../test/routine-account-recovery.test.ts) |
| 本地 MCP 单次动作审批 | 终端展示脱敏参数与摘要，决定绑定工具、参数、连接和任务修订。实际派发前复核连接权限与期限。强杀测试覆盖待答恢复和已派发但结果未知，原动作最多派发一次。 | [Rakazo 审批预览](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-ask.ts#L74) · [批准参数执行](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L91) · [Suparagent 许可入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/permission.py#L60) · [审批回归](../../test/approvals.test.ts) · [强杀回归](../../test/approval-recovery.test.ts) |
| 配对手机处理单项审批 | 本机用户按原任务、动作、摘要和配对设备分享审批。手机展示脱敏参数并提交决定，沿用原任务的权限和期限检查。回归覆盖设备重配、撤回分享、重复决定和动作只派发一次。 | [Suparagent 待处理审批](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/needs_you.py#L155) · [Rakazo 批准参数执行](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L91) · [服务端回归](../../test/approvals.test.ts) · [手机页面回归](../../test/remote-pending-page.test.ts) |
| 项目持久工作项 | 工作项有独立 ID 和修订。新运行固定启动时的修订和任务设置，历史任务按原 ID 查阅。并发或重启重试返回原任务。 | [Suparagent 工作项与运行](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31) · [运行提交](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_execution.py#L74) · [工作项回归](../../test/work-items.test.ts) |
| 手机共享工作项与原运行 | 本机用户分享指定工作项后，配对手机可查看其目标、修订和历史运行。展开运行时核对它的工作项归属，再从原 Pi 任务读取目标、步骤和待答。撤回分享和重新配对会使旧链接失效。 | [Suparagent 运行详情](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_execution.py#L25) · [服务端回归](../../test/work-items.test.ts) · [手机页面回归](../../test/remote-pending-page.test.ts) |
| 手机答复共享工作项的原运行 | 本机单独授予答复权限后，手机可回答原运行的主任务待答。版本绑定原任务、目标修订、执行轮次与问题，Pi 在同一事务保存答复摘要、用户消息和 outbox。响应丢失或重启后重试沿用原回执。撤回查看同时撤回答复，重新配对不继承权限。 | [Suparagent 原任务答复](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L829) · [服务端回归](../../test/work-items.test.ts) · [手机页面回归](../../test/remote-pending-page.test.ts) |
| 共享运行的子任务答复与控制 | 答复权限允许回答原运行当前批次的子任务问题，Pi 核对原子会话、问题和批次修订，并保存原答复回执。独立的控制权限允许暂停、沿原预算继续及取消。控制版本绑定原提交、任务状态和目标轮次，手机不能接回本机暂停或补充预算。 | [Suparagent 原子任务答复](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L829) · [原运行取消](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_execution.py#L115) · [Codync 定向操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/bots.rs#L358) · [服务端回归](../../test/work-items.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) |
| 周期规则暂停与恢复 | 在本地管理入口暂停规则。重启后仍暂停，恢复从未来第一个时间点继续，保留原规则版本、历史、预检基线和已受理任务。验证持续暂停、快速切换时旧定时器失效、重复请求以及迟到预算事件。 | [OpenMausBot 规则开关](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L632) |
| 间隔与工作时间窗口 | `interval` 以固定时间锚点按 5–1440 分钟重复，可配置截止时间、星期和时段。有星期或时段限制时指定 IANA 时区。间隔按实际经过时间计算，本地窗口过滤时间点。验证跨夏令时、错过补跑、恢复后稳定身份及截止时间。 | [OpenMausBot 规则字段](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-schedules.ts#L7) · [间隔对齐与窗口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-intervals.ts#L23) |
| 手机控制正在执行的任务 | 设备通过原会话暂停或取消任务，可在原额度与时限内继续自己暂停的任务。核对设备归属、原任务与请求回执、状态过期、重启和本机管理员操作。 | [nanoMuse 停止原任务](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/harness/dsh-nanomuse/src/device-conversations.ts#L97) · [Codync 任务操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/bots.rs#L358) |
| 项目默认模型 | 以现有记忆项目根保存通过 Pi 连通性检查的默认模型。新建本地项目任务采用该模型，清除后恢复全局默认。核对不同工作区、子目录以及重启后继续使用旧任务的原模型。 | [Rakazo Bot](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1053) · [Rakazo Run](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1323) |
| 自动化规则手动运行 | 从现有规则立即受理一次独立发生项，保持原下次自动执行时间。验证相同请求 ID、重启、预检、防重叠和预算回执。 | [OpenMausBot runNow](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L738) · [手动执行沿用预检](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-checks-engine.test.ts#L376) |
| 已连接应用的 MCP 变更预检 | 规则可用固定版本、参数的 MCP 工具做无模型预检。工具须在当前项目启用、由服务声明只读且无需单次审批；实际派发前再次核对。只保存内容指纹，不注入外部工具正文；结果未变时不启动任务。Pi 保留预检、基线和发生项恢复。 | [Rakazo 连接器预检与权限](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L735) · [稳定结果指纹](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L792) · [原 MCP 边界](../../src/mcp-tools.ts) · [API 与恢复回归](../../test/routine-mcp-precheck.test.ts) |
| 例行任务的近期活动与运行间隔 | 项目循环任务可显式设置活动门槛；无近期用户活动或仍在运行间隔时，在命令/MCP 预检前跳过，不请求模型。原 Pi 发生项保存判断与原因，重启沿原受理身份继续。手动运行跳过活动门槛，仍遵守预算、预检和防重叠，并更新后续自动运行间隔。 | [Amuse 心跳门槛](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/scheduler.ts#L97) · [Rakazo 先做免费检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/strategic-initiative.ts#L175) · [活动与 API 回归](../../test/routine-activity.test.ts) · [强杀恢复](../../test/routine-activity-recovery.test.ts) |
| MCP 应用账户 OAuth 登录 | 本机用户显式开启 HTTP OAuth，取得授权 URL 并在浏览器登录。SDK 负责 PKCE、发现、动态客户端注册、issuer 绑定与令牌刷新。一次性 state 有效期 10 分钟，回调绑定原尝试及端点。登录完成后重新测试和启用工具；后台不会打开授权页面。退出清除本机凭据、停用工具并取消旧调用。 | [Rakazo SDK provider](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L605) · [原尝试回调](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L1518) · [Suparagent owner 连接入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/integrations.py#L116) · [协议与恢复回归](../../test/mcp-oauth.test.ts) |
| MCP 预注册客户端 | 不支持动态注册的服务可配置客户端 ID、指定 issuer 和可选 secret 环境变量。SDK 按服务声明选择 public、Basic 或 POST 认证，并检查 issuer。预注册模式不提供动态注册回退，secret 不写入连接配置或 OAuth 材料。修改客户端配置使旧回调和工具修订失效。 | [Rakazo 预注册客户端绑定](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L369) · [provider 采用原客户端](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L674) · [协议回归](../../test/mcp-oauth.test.ts) |
| 手机上次草稿与待发恢复 | 用相同配对重新打开会话可恢复原文和待发消息。待发记录保留消息 ID 和已上传的附件引用。双标签发送时，同一草稿只会转换成一条待发消息。 | [Codync 发送与草稿 ID](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/AppStoreDrafts.kt#L63) · [远程页面回归](../../test/remote-pending-page.test.ts) |
| 本地项目工具子集 | 按项目从全局已启用的 MCP 工具中选择。任务创建时固定实际工具和连接修订。验证配置重开、原任务快照、空集、全局继承和实际模型可见工具。 | [Rakazo 组装运行工具](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-assembly-capabilities.ts#L734) · [MCP 回归](../../test/mcp-tools.test.ts) |
| 子任务异步回传 | 主任务收到回执后可继续独立工作。当前批次由 Pi 后台任务持有子会话，结果沿原 ID 回查，交付等待批次回传。验证重开、提前提交与取消。 | [Pi 后台委派](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/test/examples/23-subagent-background.ts#L57) · [Suparagent 委派回执与回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L378) · [委派回归](../../test/delegation.test.ts) |
| 主助手追加子任务指令 | 主助手给当前批次的原子会话追加指令，Pi 按固定请求 ID 在回合边界接收。已登记的用户问题先处理答复。重开后原子会话只收到一次追加指令，其他子任务继续，父任务等待更新后的结果。 | [Pots 追加指令](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/children.ts#L578) · [重启与回传回归](../../test/delegation.test.ts) · [待答顺序回归](../../test/delegation-input.test.ts) |
| 本地子任务待答 | 终端待处理列表可定位父任务。问题和答复保存在原 Pi 子会话，用户可从终端回送。答复保存后重启仍按原身份受理，其他子任务可继续工作。 | [Suparagent 问题回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L416) · [继续原子任务](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L829) · [待答回归](../../test/delegation-input.test.ts) |
| 手机 Web 子任务待答 | 经确认的手机任务可在其工作区内派出后台子任务。配对设备从待处理列表打开原会话，按问题卡答复。验收覆盖跨设备拒绝、父子会话归属、回执重试、重启后一次派发和工作区文件隔离。 | [Suparagent 待处理问题](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/needs_you.py#L201) · [继续原子任务](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L829) · [服务端回归](../../test/remote.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) |
| 停止单个后台子任务 | 终端按子会话 ID 停止。配对手机可在原会话按名称停止。决定保存在原 Pi 子会话，重启后重试返回同一停止结果，同批其他任务仍可交付。 | [Pots 保存停止决定与恢复](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/agent.ts#L884) · [手机与同批任务回归](../../test/remote.test.ts) · [本地强杀回归](../../test/delegation-recovery.test.ts) |
| 手机 Web 中断子任务工具 | 在原会话任务卡选择正在运行的工具调用。服务端核对设备、工作区、当前批次和 Pi 工具任务 ID。旧请求返回冲突，原子会话可继续执行后续调用。 | [Pots 工具中断](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/agent.ts#L823) · [Pi 会话集成回归](../../test/remote.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) |
| 五字段 Cron | 显式 IANA 时区。Croner 计算前后时刻，Pi 定时任务负责等待、补跑和恢复。回归覆盖无效表达式、闰日、夏令时和重启。 | [OpenMausBot Cron 计算](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/packages/phone-protocol/src/routine-schedule.ts#L13) · [Cron 回归](../../test/routine-cron.test.ts) |
| 项目记忆采集开关 | 关闭后保留原召回与用户纠正、遗忘。采集端核对项目来源，组织记忆的工具也核对调用任务的项目。回归覆盖子目录、注册来源、Claude 项目镜像和重启。 | [Suparagent 采集设置](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/memory.py#L16) · [采集门槛](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/memory_capture.py#L895) · [记忆回归](../../test/memory-management.test.ts) |
| 原消息附件卡片 | 原消息通过 Pi 提交条目关联附件。设备在会话归属范围内预览图片和纯文本，下载前验证原件长度与哈希。 | [Errand 历史附件关联](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L312) · [附件预览](https://github.com/runta-dev/errand/blob/a20b925b740b/src/ui/components/AttachmentPreview.tsx#L46) · [手机 API 回归](../../test/remote.test.ts) |
| 本地事件触发 | 规则选择来源、类型和标量字段匹配条件，本地鉴权入口保存事件身份和内容摘要。匹配后复用 Pi 的立即执行流程。已接受和已过滤事件跨重启、规则编辑去重，事件内容只用于匹配。 | [DuskBot 过滤与去重](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [事件回归](../../test/routine-event.test.ts) |
| 纯事件规则与 GitHub Issue 同步 | 纯事件规则可手动运行、暂停和恢复。对公开仓库的新 Issue 支持单次同步和按规则启用后台轮询。两种入口共用游标，受理后推进。集成回归覆盖响应丢失、daemon 重启、任务去重和分页限流。 | [DuskBot 游标处理](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L451) · [DuskBot 轮询](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L557) · [同步回归](../../test/github-routine-events.test.ts) · [本机 API 集成](../../test/assistant-entry.test.ts) |
| GitHub Issue Webhook | 按规则显式开启签名入口，对原始字节验证 HMAC-SHA256，严格限制大小及 JSON。只接收新 Issue，并从原 Pi 事件流程受理。正文哈希作为事件身份，改换 delivery header、丢失响应或 daemon 重启不会重复启动同一投递。原任务保存已校验的仓库和编号供助手使用；标题、正文和外部 URL 不进入指令。 | [Rakazo 原始字节验签](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L15) · [正文去重](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L232) · [Suparagent ingress](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/ingress.py) · [HTTP 集成回归](../../test/github-webhook.test.ts) |
| GitHub PR Webhook | 同一签名入口支持 PR 打开、重开、更新、关闭及转为可评审。规则选择一种事件及固定仓库，可匹配 draft/merged。原发生项和任务保留已校验的仓库、编号、headSha/baseSha 及状态；更新提交有独立发生项，相同正文重投仍指向原任务。标题、正文、分支名及 URL 不进入指令。 | [Rakazo PR 动作](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L25) · [PR 机器字段投影](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L93) · [数据提示边界](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/messaging/inbound-delivery.prompt.ts#L43) · [HTTP 回归](../../test/github-webhook.test.ts) |
| 手机 Web 后台通知 | 已配置 HTTPS 的 daemon 可启用 Web Push。每个配对单独订阅，基于 Pi 持久事件发送通用待答、子任务待答或完成提醒。通知链接经配对和会话归属校验后打开原会话。本地回归覆盖订阅、重复轮询、回执重试与设备撤销。 | [Suparagent 子任务待答通知](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L483) · [Codync 通知跳转](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) · [子任务回归](../../test/remote.test.ts) · [通知点击](../../test/remote-worker.test.ts) |
| 记忆候选审阅 | 项目可选择审阅模型写入的候选。候选保留来源和任务身份，接受时核对来源与旧记忆版本，拒绝后同一工具重放保留原决定。 | [Suparagent 候选处理](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/memory_proposals.py#L116) · [候选回归](../../test/memory-review.test.ts) |
| 手机图片模型输入 | Pi 的图片处理器按固定模型能力处理原件，首条消息和目标任务待发消息保存原件引用供重启恢复。请求钩子限制跨轮图片总数，原消息仍保留完整图片。纯文本模型和无法解码的图片给出说明及文件路径。 | [Errand 图片提交](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L332) · [Pi 图片处理](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/src/images/node.ts) · [图片恢复回归](../../test/input-images.test.ts) |

本机先用 `work-items share 工作项ID 账户ID 设备ID` 分享查看，再用 `work-items share-replies 工作项ID 账户ID 设备ID` 单独授权答复。`unshare-replies` 保留查看，`unshare` 同时撤回答复。手机向 `/remote/api/work-items/{itemId}/runs/{runId}/answers` 提交 `{ requestId, answer, version }`；`version` 取自原运行详情的 `answerVersion`。无权限、跨工作项和旧问题均不受理；已暂停或耗尽预算的任务需要本机处理。重试同一请求 ID、原文和版本只返回原回执，不能借重试更换答复。

共享答复在 Chromium 的 390 × 844 视口验证了只读状态、单独授权、刷新后输入保留、原任务完成与普通聊天草稿保留。Pi 集成回归另覆盖撤权、重新配对、暂停与旧问题、时限过期、保存答复后中断及 daemon 重启。

本机用 `work-items share-controls 工作项ID 账户ID 设备ID` 授予独立控制权限，用 `unshare-controls` 撤回，答复权限保持不变。手机向原运行的 `/control` 提交 `{ action, version }`，操作为 `pause`、`continue` 或 `cancel`，版本取自详情的 `controlVersion`。子任务答复向原运行的 `/child-answers` 提交 `{ childId, questionId, requestId, answer }`，有答复权限的详情才提供子会话和问题 ID。两个端点先核对共享工作项与原任务归属，再调用原 Pi 接口，均不创建替代运行。

共享子任务与控制在 Chromium 390 × 844 验证了分开授权、暂停后继续、原答复草稿和聊天草稿保留、子任务答复后原任务完成，以及取消确认后原运行和子任务停止。服务端回归补充 daemon 重启、控制版本冲突、撤权、原预算保留和答复只派发一次；页面回归覆盖控制回执未返回时刷新页面，以及取消确认被拒绝的情况。

间隔调度回归覆盖夏令时跳过窗口、重复本地时段、含截止点的单一时间点和重启后的补跑。规则回归还覆盖手动请求重放、手动与定时同时触发、预检过程中强杀，以及原预算事件保留历史。有相同预检样本正在受理时，后来的触发保留 `pending` 跳过原因。前一次受理失败后，后续触发仍可使用相同样本。 [间隔回归](../../test/routine-interval.test.ts) · [手动回归](../../test/routine-manual.test.ts) · [强杀恢复](../../test/routine-precheck-recovery.test.ts)

MCP 预检在已有 `task` 规则中使用以下字段替换命令预检。连接 ID、修订和工具名取自 `mcp list`、`mcp test` 与 `mcp enable` 的结果；项目需允许该工具。历史发现缓存不推测只读性质，需要重新测试并启用当前修订。

```json
{
  "precheck": {
    "mcp": {
      "id": "connected-app",
      "revision": "mcp test 返回的修订",
      "tool": "list_unread",
      "arguments": {}
    }
  }
}
```

规则必须有工作区，命令与 MCP 两种预检只能选一个。MCP 参数对象上限 16,000 字符，调用限时 30 秒，用于计算指纹的结果上限 1 MB。指纹覆盖 `content` 和 `structuredContent`，忽略 `_meta`，稳定对象键顺序；文本和数组按原结果比较。无变化不会启动任务，工具错误不会更新基线。只读声明来自已连接服务，不构成独立沙箱保证；账号和凭据继续由原连接管理。本地回归使用实际 stdio MCP 协议，验证指纹、无模型跳过、重启、权限撤回及连接期间撤权，没有验证具体第三方账号。

HTTP MCP 连接可设置 `oauth: true`，与环境变量凭据头互斥。例如用 `mcp add` 加入 `{ "id": "connected-app", "transport": "http", "url": "https://服务地址/mcp", "oauth": true }`，再运行 `mcp login connected-app`，在本机浏览器打开返回的 `authorizationUrl`。回调成功后运行 `mcp test connected-app`，用新修订启用所需工具。`mcp list` 只返回凭据是否保存和是否有待完成登录，不能用于验证服务端账号仍有效。`mcp logout connected-app` 清除本机授权材料并停用工具；它不代替应用服务端撤销授权。

OAuth 材料保存在数据目录的 `mcp-oauth/`，沿用原子写入和适用平台的受限文件权限，不经过模型。该目录默认被 Git 忽略，强制暂存也会被提交检查拒绝。登录与回调使用 SDK 的网络流程，不引入新授权服务。授权码交换结果未知时要求重新登录，已持久化令牌但尚未完成本机受理时可用原回调恢复；过期、重放、退出和端点编辑后的回调均不恢复旧凭据。同一连接的 OAuth 操作串行，关闭会等待凭据加载、网络及清理完成。

本地合成 OAuth/MCP 服务验收了 owner CLI 登录、Chromium PKCE 回调、测试、启用和退出。回归另覆盖重启、并发刷新、迟到回调不影响新账号、错误 state、拒绝登录、未知交换结果、损坏材料安全报错、client secret/令牌回显拦截和关闭竞态。真实第三方服务及设备码授权尚未验收。

对于已在服务端注册的客户端，使用以下连接定义，仍通过原 `mcp add/login/test/enable/logout` 操作。public client 省略 `clientSecretEnv`；需要 secret 时，daemon 的该环境变量必须存在。`scope` 为可选后备值，SDK 优先使用服务返回的 scope；应用注册时须允许本机 daemon 端口对应的 `/v1/settings/mcp/oauth/callback` 地址。

```json
{
  "id": "connected-app",
  "transport": "http",
  "url": "https://service.example/mcp",
  "oauth": {
    "clientId": "registered-client-id",
    "issuer": "https://auth.example/oauth",
    "clientSecretEnv": "APP_CLIENT_SECRET",
    "scope": "read"
  }
}
```

预注册对象仅接受上述字段，issuer 必填且不能包含查询、凭据或片段。secret 只在原 MCP 操作生命周期内从环境解析并登记脱敏，不复制到持久文件或公开状态。回归用不提供注册端点的合成服务分别验证 public、Basic、POST 登录、跨重启回调、刷新和退出；还验证 issuer 不匹配不派发令牌/注册请求、末尾 `/` 兼容、缺失环境变量、配置变更、回调补齐环境后恢复以及 secret 回显拦截。退出仍不修改环境变量或撤销服务端客户端注册。

预注册 POST 客户端另通过 owner CLI 与 Chromium 合成验收，完成加连接、登录回调、发现、启用及退出，动态注册请求数为零。此证据限于本机合成服务，不能替代具体第三方账号的兼容性验证。

手机控制在 Chromium 的 390 × 844 视口验证暂停、接回、取消确认以及原消息和草稿保留。服务端回归另外验证，取消已暂停的任务时 Pi 不会重新启动独立评审。项目模型的重启回归使用两个脚本化模型，重新打开旧会话后发新消息核对实际执行模型。 [手机 API 回归](../../test/remote.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) · [项目模型回归](../../test/assistant-entry.test.ts)

Chromium 双标签发送同一草稿时，拦掉首个回执后仍只有一次发送和一次 Pi 受理。重新配对同名设备时，其浏览器草稿独立。后台委派的强杀回归核对原子任务提交、一次父任务接回和一次交付。若父任务已进入待答或保存新修订，恢复会取消过期批次。规则暂停、取消和更新的强杀回归核对 Pi 清理旧定时器。 [草稿回归](../../test/remote-pending-page.test.ts) · [委派强杀回归](../../test/delegation-recovery.test.ts) · [定时器强杀回归](../../test/routines.test.ts)

GitHub Webhook 默认关闭。先创建 `event: { source: "github", type: "issues.opened", equals: { repository: "owner/repo" } }` 的规则；可使用 `schedule: { kind: "event" }`，规则目标、工作区、工具和预算由本机用户配置。daemon 配置示例：

```json
{
  "githubWebhooks": [
    { "routineId": "triage", "secretEnv": "GITHUB_TRIAGE_WEBHOOK_SECRET" }
  ]
}
```

在 daemon 环境设置对应 secret，GitHub 仓库 Webhook 使用相同 secret、`application/json` 和 Issues 事件，投递到已有 HTTPS 代理的 `/hooks/github/triage`。代理只转发所需 Webhook 路径到本机 daemon，Kada 仍监听 loopback；这轮没有自动部署代理或修改 GitHub 配置。配置最多 64 项，同一规则只能配置一次；删除配置并重启使入口返回 404，缺失 secret 返回 503，签名无效返回 401。

正文上限 1 MiB，分块请求也执行相同上限；必须是有效 UTF-8、未压缩 JSON。验签后仅投影小写仓库和正整数 Issue 编号。规则修订在投递受理前再次核对，暂停和预算策略沿用原 Pi 规则。返回的 `{ accepted }` 仅说明是否已受理该投递，不能证明任务已完成。受理回执丢失时用原始正文和签名重试，不更换投递内容。正文哈希不信任未签名的 `X-GitHub-Delivery`，但轮询和 Webhook 的事件身份不同；同一规则选择一种自动渠道，当前不保证两种渠道间防重复。

仓库与编号以 `routineIssue` 保存到原任务，作为数据提供给模型；重启、后续追加消息和原任务受理重试均保留原身份及目标。轮询入口也沿用相同字段。其他事件正文仍只用于匹配，GitHub 标题、正文、URL 和 secret 不进入模型。HTTP 回归覆盖验签、并发重放、默认关闭、过滤、分块上限、响应丢失、规则修改、暂停、secret 轮换和重启；具体 GitHub 外部投递及 HTTPS 代理未验收。

循环 `task` 规则可增加以下字段，配合现有工作区、计划、预算和可选预检使用。两个分钟数均为 1–43,200 的整数，默认没有活动门槛；通知、单次、纯事件或同时接收事件的规则不接受该字段。

```json
{
  "activity": {
    "withinMinutes": 4320,
    "minIntervalMinutes": 360
  }
}
```

自动发生项先核对原任务是否仍在执行，再检查距上次受理是否已满 `minIntervalMinutes`，以及同项目最近的用户请求是否在 `withinMinutes` 内。活动范围复用项目记忆的项目根：本机直接创建任务、确认任务和向原会话追加消息计入，子目录归同一项目。自动任务首次输入、监督消息、后台委派回传、压缩和手机私有工作区不计入。该功能不采集键鼠、其他应用或外部聊天，不能表示用户当前在电脑前。

`routines history` 中的 `activity.status` 区分 `allowed`、`inactive`、`cooldown` 和 `failed`。无活动或间隔未满记录跳过；读取失败记录失败，均不执行预检和模型。成功受理才推进间隔，预检无变化或受理失败不推进。手动 `routines run` 表示用户直接要求，活动门槛不拦截它，原预算、预检和防重叠仍生效；手动受理也更新间隔。暂停/恢复和编辑规则保留原受理时间；回执保存前暂停的任务，在恢复检查时从原任务找回创建时间。已保存的活动判断随原 Pi claim 恢复，不重新判定或补预算。

活动来源使用已有任务元数据及 Pi 用户提交/目标状态。目标状态保存最新用户受理时间，避免内部进度超过日志保留上限后忘记用户活动；历史任务可从原确认及仍保留的用户事件读取。普通聊天仍从 Pi 的用户提交读取。回归覆盖不活跃时零预检、间隔、手动行为、项目隔离、日志滚动、查询时暂停和并发手动受理、daemon 重启及实际 SIGKILL。该策略的真实任务质量和净成本收益尚未作对照验证。

GitHub PR 规则沿用 `githubWebhooks` 和 `/hooks/github/{routineId}`，例如：

```json
{
  "id": "pr-review",
  "action": "task",
  "objective": "按已批准的项目评审清单检查该次 PR 提交并保存本地报告",
  "workspace": "E:/project",
  "schedule": { "kind": "event" },
  "event": {
    "source": "github",
    "type": "pull_request.opened",
    "equals": { "repository": "owner/repo", "draft": false }
  }
}
```

支持 `pull_request.opened`、`pull_request.reopened`、`pull_request.synchronize`、`pull_request.closed` 和 `pull_request.ready_for_review`。签名正文中的编号须为正整数；同时提供顶层编号时须一致。head/base SHA 为 40 或 64 位十六进制，draft/merged 为布尔值。原任务的 `routinePullRequest` 保留规范化机器字段及该次 SHA，追加消息和重启不替换为后续提交。实际读取 PR 内容仍需已有工具与权限；接收事件不隐含评论或修改仓库的授权。公开 feed 轮询保持只处理新 Issue，外部 GitHub 投递与 HTTPS 代理仍待实测。

循环项目任务可显式设置 `accountBackoff: true`，默认关闭。它沿用 `overlapPolicy: skip`：在预检前从上次原任务读取最终 Pi 回执，只对明确的非临时模型账户拒绝按 5、10、20 分钟倍增，最多 24 小时。规则的 `accountCooldown` 展示 `failures`、毫秒时间戳 `until` 和通用分类 `auth/access/quota/model`，间隔内发生项记为 `skipped` 并保存该原因，不运行命令/MCP 预检或模型。

判定要求原提交为 `model_error` 且对应原生助手错误：明确的 401、403、402、`invalid_api_key`、`authentication_error`、`permission_denied`、`insufficient_quota`、`insufficient credits`、余额过低、`out of budget`、`model_not_found` 或 404 的模型不存在。Pi 的 `isRetryableAssistantError` 判为临时错误时不降频。普通 429、网络故障、上下文/输出错误、不可信工具正文和未知报错均保持 Pi 原重试/失败处理。

截止时间使用原 Pi 助手消息的请求开始时间戳，原任务/提交身份防止重复累计，重启不会重算截止时间。手动运行跳过降频，但仍遵守预算、预检和防重叠；仅受理成功不清除失败，下一次检查确认原任务已完成才清除。暂停/恢复和编辑保留已有间隔，旧修订的迟到结果不追加失败。此字段仅用于有工作区的循环任务，不用于通知、单次、纯事件或混合事件规则。移除字段关闭门槛；不解析供应商自然语言重置时间，不自动解锁其他规则。配置及恢复回归见[账户降频](../../test/routine-account-backoff.test.ts)与[强杀恢复](../../test/routine-account-recovery.test.ts)。

本机聊天提醒的实现与使用见[聊天提醒计划](../superpowers/plans/2026-11-25-chat-reminders.md)和[使用入口](../assistant-usage.md#提醒与例行任务)。硅基流动 DeepSeek V3.2 在中文请求中完成纽约时间换算、原工具保存、daemon 重启后取消，共 6 次请求、24,018 总 token（含缓存），无 Goal。Qwen2.5 7B 的独立尝试产生无效工具参数，没有保存提醒。两次结果分别保留，不能从较强模型通过推断所有模型可用；实际金额未知，不声称成本改善。 [通过记录](../experiments/2026-11-25-chat-reminder-deepseek.json) · [7B 失败记录](../experiments/2026-11-25-chat-reminder-qwen.json)

历史工具仅绑定调用任务已有的本机项目根。`history_search` 接受 1–200 字查询、最多 12 个空白分隔的词及 1–20 条结果（默认 8），Unicode 小写后每词须命中。按命中次数、原消息时间排序，片段最多 400 字。`history_read` 重新验证来源任务和消息，最多返回 8,000 字并标注截断。原提交初始用户输入及 `user:` 请求对应的用户消息、最终助手正文是来源，工具/系统/压缩/监督条目不作为对话结果。检索直接读原 Pi Storage，不重启旧任务的运行时，不新增索引或数据库。扫描按原分页完成；大量历史的性能与语义检索尚未验证。

DeepSeek V3.2 经硅基流动完成两段中文对话：先保存讨论，daemon 重启后由新对话搜索并读取原消息，正确回答 SQLite；4 次模型请求、16,533 总 token，无 Goal。该样本只验证所列讨论，金额未知。 [实测记录](../experiments/2026-11-25-project-history-deepseek.json)

MCP 工具总数取新任务已经固定的 `mcpPins`，大于 20 时保存 `mcpDiscovery: deferred`。原 MCP 工具仅增加 deferred 注册，原有参数、实际调用、权限与单次审批流程继续生效。Pi 的 `tool_search` 按其原生 BM25 匹配工具元数据，返回后加载工具并由原 `modelTools` 持久化；搜索结果不能自动启用未授权或新发现的工具。配置执行阶段时保留已加载 MCP 工具，主会话从 enabled tools 排除 `delegation_ask`，仅供后台子任务的待答入口不能被搜索重新开放。同步子任务可在原范围内搜索，后台子任务仍只用既有文件工具。

硅基流动 DeepSeek V3.2 在本地合成 21 个 MCP 工具中，初始请求未带任何 MCP schema，随后搜索、加载并实际调用指定工具一次，重启后加载保留。3 次模型请求、18,113 总 token；实际金额未知，未作同任务原生 Pi 成本对照。搜索采用 Pi 当前分词，优先使用工具名或英文元数据，中文查询效果不由本例保证。 [实测记录](../experiments/2026-11-25-mcp-discovery-deepseek.json)

新本机聊天的 `chatReminders: managed` 增加通知型日程管理；原 `true` 保留旧单次工具 schema。`reminder_create` 的 `at` 与 `schedule` 二选一，schedule 支持带明确 UTC 偏移的 once、IANA 时区和 HH:MM 的 daily，以及另带 0–6 星期的 weekly。工具不接受执行任务、事件、预检或模型自选工作区。`reminder_update` 接受 info 返回的 ID、修订、完整新文字及 schedule，首次取得的原工作区、验收和补跑政策固定在原 Pi 工具任务，实际更新在原规则事务再次校验修订。聊天修改暂停规则保留暂停；暂停周期改为单次前须从原入口明确恢复，原 CLI/API 两参数修改行为保持。

修改请求使用原聊天和工具 taskId 派生的身份，摘要及原结果写入 Pi 被动回执。相同请求同内容重放返回当次结果；请求内容改变或无回执的旧修订返回冲突。后来的编辑或取消保持当前状态，历史回执不能被当作最新安排。6 种实际 SIGKILL 场景验证原创建、取消及更新的未知结果恢复。DeepSeek V3.2 经硅基流动完成中文每周创建、重启后改为每日及新文字、取消，共 9 次请求、52,054 总 token，无 Goal，金额未知。 [周期提醒实测](../experiments/2026-11-25-chat-reminder-management-deepseek.json)

### 应用 API 凭据

新本机主会话固定 `credentialProject`。聊天/准备可用 `credentials_list` 与 `request_credential` 保存名称、origin、认证方式及 expectedRevision 到原 Questions；只有执行阶段增加非安全重放工具 `credential_request`。工具再次核对 working Goal 和原确认。旧任务、远程与子任务不自动继承能力，保存凭据不创建 Goal。 [Rakazo 请求入口](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/builtin-conversation.tool-definition.ts#L27) · [完整计划](../superpowers/plans/2026-11-26-application-credentials.md)

owner 专用 POST `/v1/tasks/:id/credentials/:questionId` 仅接受 `{ value }` 或 `{ decline: true }`，普通消息/answer 拒绝凭据问题。终端无回显输入与 macOS SecureField 沿此入口；手机共享卡引导本机。原子本地文件同时保存值及 HMAC 提供回执，原请求原值重放只返回当次结果，不能覆盖后来轮换或复活删除。提供后用固定身份回传通用确认；4 项实际 SIGKILL 验证保存/答复之间和外部请求未知结果恢复。存储复用 proper-lockfile、atomicJson，不依赖 Pi 未公开的 AuthStorage；文件为受限明文，不能称加密密钥库。

认证支持 Bearer、自定义头和 Basic，仅绑定原 HTTPS origin 与指定修订；全部 DNS 地址须 public，实际连接固定到已通过的地址且保留 TLS 主机名校验。轮换或删除发生在解析期间会阻止发出请求。拒绝重定向、认证覆盖及私有/映射/特殊地址；请求最多 64 KiB、30 秒，响应最多 1 MB、模型预览最多 20,000 字符。先检查原值、认证值及支持的 JSON/percent/base64 形式，命中则隐藏整段，任意服务变换后的秘密不保证识别。取消关闭实际连接，错误不带原取消原因，未知外部结果不自动重试。 [Rakazo 站点校验](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/secrets/bot-secret-destination.ts#L33) · [请求注入](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/secrets/bot-secret-request.ts#L201) · [安全地址与有界响应](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/web/web-ssrf.ts#L166)

硅基流动 DeepSeek V3.2 完成中文请求保护字段、宿主提供合成值、daemon 重启、新授权执行任务引用并调用合成 API 一次；实际模型上下文与原 Pi 文件断言没有值，设置聊天无 Goal。共 5 次模型请求、33,461 总 token，金额未知；合成 HTTP transport 不能证明真实第三方 TLS/API 兼容性。macOS 仅解析语法，网页登录/OTP、系统密钥库、远程输入仍待补。 [实测记录](../experiments/2026-11-26-application-credential-deepseek.json)

本地临时 CA 补验保留证书验证，正确主机名完成一次 TLS 请求，错误主机名在 HTTP 前被拒绝；测试注入仅负责本地路由与信任该 CA。Windows PTY 验证无回显、取消后重输与编辑缓存隔离，凭据输入完成/取消后重建 readline，避免私密文本经后续消息、undo 或 Ctrl+Y 泄露。全量 490 通过、4 项可选 Office 跳过，收尾相关 24 项再次通过；外部服务和 macOS 实机不由这些结果替代。[本地 TLS 记录](../experiments/2026-11-26-application-credential-local-tls.json)

### 工作项优先级与截止日期

原 WorkItems 增加 `priority`（low/normal/high/urgent）、`dueDate`、`dueAt` 和 `timeZone`。日期保留 YYYY-MM-DD，时刻通过原 `explicitInstant` 校验后保存规范 ISO；时区由 Intl 校验和规范化，合并当前记录后两种截止互斥，切换须明确清空旧字段。截止不创建提醒、Goal 或任务；原运行要求和 workItem 修订继续保留。[Suparagent schema](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/schemas/work_item.py#L7) · [实际更新](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L96) · [Rakazo 实际优先级保存](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/ticket-tools.ts#L160)

旧记录读为 normal、无截止、UTC，不写回磁盘。没有新字段时保留原 fingerprint 数组，旧 create/update/no-op 回执仍返回当次结果并投影新字段缺省值。原队列核对 revision，操作回执与修改原子提交，恢复不会覆盖后来规划。聊天复用原四个待办工具和安全重放，准备、执行、远程与子任务仍不自动获得编辑工具。

已分享的手机列表与详情只增加规划投影；逾期由服务端按保存时区判断，日期在当地跨天后才逾期，时刻按同一瞬间比较；done/archived 不显示逾期。Chromium 390 × 844 的 Tokyo 页面验证纽约日期与 EST 时刻、原草稿和完成后更新，无横向溢出。API/原运行与真实 SIGKILL 回归覆盖原 ID、修订和恢复；完整看板、自定义列、排序编辑及日历拖拽尚未实现。[浏览器记录](../experiments/2026-11-26-work-item-planning-browser.json)

DeepSeek V3.2 经硅基流动保存日期截止，重启后读回并改为精确时刻；首轮 90 秒观察在修改已提交、模型仍生成最终答复时结束，保留失败。随后续接原 Pi 会话的过期合成聊天窗口，完成确认及清空截止；合计 8 次请求、56,332 已知 token，原记录只有一次创建、两次修改，没有 Goal、运行或提醒，金额及中断请求账单未知。观察时限改为每轮配置时限加 5 秒，未声称重新完成了不中断的全新样本。[首轮失败](../experiments/2026-11-26-work-item-planning-deepseek-attempt-1.json) · [原会话续验](../experiments/2026-11-26-work-item-planning-deepseek-continuation.json)

### 命名助手与固定范围

owner 的 Assistants 目录保存项目身份、名称、完整指令、模型引用、明确动作工具名单与修订；保存不创建任务。原 chat/run 可用 `--assistant ID@REVISION`，TaskMeta 保存完整必要快照和解析后的模型。缺省模型沿新任务的原项目设置；归档阻止新选择，旧任务仍保留原配置。模型和会话、工具执行、预算、恢复及压缩继续由 Pi 1.4.0 承担。[OpenMausBot 实际创建](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/bots-create.ts#L212) · [Rakazo 创建事务](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/bots/bot-repository.ts#L429) · [完整契约](2026-11-26-named-assistants.md)

动作范围与原阶段工具求交集。固定 ToolTask.beforeTool 逐次检查，afterTool 过滤越界 addTools；后台显式工具集合同时取交集并保留策略。当前 acceptance 只允许机械文件检查；真正的命令核验 criterion.verification 和 task_verify 需要 bash，后者的嵌套调用再受同一范围约束。原默认、远程、工作项和例行任务不自动获得角色。named-assistants capability 握手阻止同版本旧服务忽略角色参数，原消息接口拒绝换角色。

25 项聚焦及全量 524 项通过，另 4 项可选 Office 跳过；真实 SIGKILL 覆盖元数据已保存和原读取待执行，目录后来获得写权限也不扩大原任务。原生压缩、后台待答后重启、原角色模型与指令、实际 21 项 MCP 中只提供并调用一个工具均有验证。工具范围是本机工具名单约束，不能解释为系统沙箱或完整 Bot 隔离。

硅基流动 DeepSeek V3.2 首轮模型提出 30 秒预算，测试确认后在计划阶段正确到限，无产物；该失败保留。第二轮明确 180 秒/100,000 token 配置并跳过可选计划后，验证旧会话重启保留 v1、新会话使用 v2、确认前无文件/写工具、确认后只写一次并交付精确字节，bash 始终不提供。两轮 12 次请求、41,924 已知 token，实际金额及中断请求账单未知，不据此声称净收益。[首轮](../experiments/2026-11-26-named-assistant-deepseek-attempt-1.json) · [完整通过](../experiments/2026-11-26-named-assistant-deepseek.json)

### 聊天内助手配置管理

新本机普通聊天固定 `chatAssistants.project`，五个薄工具复用原Assistants：`assistants_list`、`assistant_read`、`assistant_catalog`、`assistant_create`、`assistant_update`。配置保存无Goal、新会话或运行，原角色pin保持；旧/远程/准备/执行及子任务不自动获得管理能力。聊天转Goal移除工具，命名角色的原允许表仍决定是否能调用管理动作。[OpenMausBot实际创建请求](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L511) · [Rakazo原角色版本检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/fleet-tools.ts#L837) · [完整契约](2026-11-26-chat-assistants.md)

创建/更新将原chat ID与Pi taskId派生的请求身份、SHA-256摘要和当次公开角色结果，与配置变更同时atomicJson保存。相同请求重放只返回历史结果，不覆盖后来的编辑、归档或无修改操作；异内容冲突。实际写入前重检原项目，外项目ID不可修改，公开入口显式剥离operations。模型移除不影响已提交原结果重放，新选模型仍按现有目录校验。

列表元数据分页并标注说明截断，完整指令及名单从read取得；模型与工具目录只读原已安装模型及原任务阶段元数据，不启动新服务或隐含授权。多字节50条元数据与16,000字符原指令使用有界256KiB原生输出，避免默认50KiB截成无效JSON。服务6项、聊天8项和5个实际SIGKILL场景覆盖重放、归档恢复、范围与后续owner编辑。

首轮全量捕获了多字节分页的修复前失败，修复后完整重跑539通过、4项可选Office跳过、零失败，相关组合28项通过，类型/构建及笔记/提交检查通过。独立只读审查任务正文未送达，未审阅代码，限制保留。

硅基流动DeepSeek V3.2实际查询工具目录、保存一个默认模型的只读助手，daemon重启后完整读回并追加原指令，归档、恢复和再次读回；同一ID最终修订4，一次创建/三次修改，无Goal、角色切换或额外任务。13次请求、136,859总token含缓存，金额未知；该样本为合成配置，未证明净成本或所有模型的配置质量收益。[实测记录](../experiments/2026-11-26-chat-assistants-deepseek.json)

## 已定位的能力差距

定时规则的任务或通知在离开本机队列时，复核原 Pi 发生项是否仍获受理。规则取消已保存而中止信号仍在传递时，排队中的产生动作会停止。回归用可控时钟和独立信号等待点证明两个队列的行为。 [Rakazo 发生项事务认领](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-routines.ts#L238) · [两类队列回归](../../test/routine-admission.test.ts)

更广的任务规划、结构化提问、安全凭据、命名助手、跨助手协作、撤销及语音等差距见[参考能力核对表](2026-11-25-reference-capability-matrix.md)。下表保留原来已经定位的具体兼容性与实测缺口，不能视为所有剩余能力。

| 能力 | 基线与剩余工作 | 通过条件 | 参考实现 |
| --- | --- | --- | --- |
| 账户拒绝的具体供应商与重置时间 | 已实现 opt-in 的循环项目任务降频，复用 Pi 最终回执与临时错误分类。真实供应商的错误措辞、明确重置时间以及其他自动事件仍需逐项核对；未识别错误保留原失败。 | 按服务验证密钥失效/余额耗尽，依据公开机器字段支持重置，不能靠猜测扩展错误分类。 | [Rakazo 账户拒绝分类](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L37) · [规则降频与原计划](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-backoff.ts#L82) |
| macOS 子任务控制实机验收 | macOS 任务卡已接入定向答复、单独停止和指定调用的中断。Windows 已验证本地 API 和 Swift 语法，原生交互待运行。 | 在运行和待答时打开任务卡，停止一个子任务，或中断指定调用并观察原子会话继续。 | [Pots 工具中断](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/agent.ts#L823) · [本地 API 回归](../../test/delegation.test.ts) · [任务卡解码回归](../../desktop/PetCoreTests.swift) |
| 应用连接器与主动检查 | GitHub Issue 已支持轮询及签名 Webhook，PR 已支持签名事件及提交身份投影；MCP 可做变更预检及 OAuth 登录；循环项目任务可按近期活动和运行间隔跳过。具体第三方账户、外部投递实测与其他应用事件接入仍待实现或验收。 | 连接器投递真实事件并在断线后接回，主动检查遵守用户选择和预算。 | [Rakazo GitHub Webhook](https://github.com/elie222/rakazo/blob/e64d73292179/apps/api/src/webhooks/github-webhook.ts#L15) · [DuskBot 应用触发](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [Amuse 后台检查](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/scheduler.ts#L88) |
| 手机后台通知实机验收 | Web Push 与会话跳转已有本地回归。真实 Chromium 通过 DevTools 投递合成推送，验证服务工作线程接管已打开的门户、通用提醒和原会话标识。脚本触发通知事件后，原标签页跳到同一配对的原会话 URL。已有标签页关闭或导航失败时会继续查找，已导航的标签页失去焦点时保持同一页面。 | 订阅的实体 iOS 与 Android 手机在页面关闭时经真实推送服务收到提醒，点击后进入有权限的原会话。 | [Codync Android 通知](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) · [接管与导航回归](../../test/remote-worker.test.ts) |

Windows Chrome 在独立测试配置中通过 HTTPS 配对并建立真实 FCM 订阅。关闭门户后，daemon 经当前网络代理发出合成任务待答通知，FCM 返回受理，Chrome GCM 日志记录入站。测试未观察到系统通知卡片。撤销浏览器订阅后，页面可识别本机缺少订阅，用户重新开启后恢复 FCM 订阅。 [订阅恢复回归](../../test/remote-pending-page.test.ts)

应用原生入口、渠道和更广义的桌面操作继续按项目源码核对。AppuBot 的公开仓库提供产品说明与发布资料，无法用它验证 Telegram 实现。 [AppuBot 公开资料](https://github.com/sarthakguptadev/appubot/blob/e0a25494a7c0/README.md)
