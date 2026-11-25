# 个人助手能力对照

以 `fe8e9b4` 为对照基线。沿用 Pi 1.4.0 的会话、任务、工具与持久化。参考项目以开发计划中的固定提交为准。每项按用户能否从正常入口完成场景来判断，源码或测试夹具只能证明各自覆盖的部分。 [产品 Spec](../../SPEC.md) · [参考项目与版本](../superpowers/plans/2026-11-23-personal-assistant.md#参考优先级)

## 已实现能力

| 能力 | Kada 契约与验收 | 参考实现 |
| --- | --- | --- |
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

## 已定位的能力差距

| 能力 | 基线与剩余工作 | 通过条件 | 参考实现 |
| --- | --- | --- | --- |
| macOS 子任务控制实机验收 | macOS 任务卡已接入定向答复、单独停止和指定调用的中断。Windows 已验证本地 API 和 Swift 语法，原生交互待运行。 | 在运行和待答时打开任务卡，停止一个子任务，或中断指定调用并观察原子会话继续。 | [Pots 工具中断](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/agent.ts#L823) · [本地 API 回归](../../test/delegation.test.ts) · [任务卡解码回归](../../desktop/PetCoreTests.swift) |
| 应用连接器与主动检查 | 公开 GitHub Issue 已支持后台轮询；MCP 可做只读变更预检，HTTP OAuth 支持动态及预注册客户端。具体第三方账户实测、原生事件订阅与按用户活动触发仍待实现或验收。 | 连接器投递真实事件并在断线后接回，主动检查遵守用户选择和预算。 | [Rakazo 连接器预检](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L735) · [DuskBot 应用触发](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [Amuse 后台检查](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/scheduler.ts#L88) |
| 手机后台通知实机验收 | Web Push 与会话跳转已有本地回归。仍需通过真实推送服务，在实体 iOS 与 Android 设备验收。 | 订阅的手机在页面关闭时收到提醒，打开后进入具备访问权限的原会话。 | [Codync Android 通知](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) |

应用原生入口、渠道和更广义的桌面操作继续按项目源码核对。AppuBot 的公开仓库提供产品说明与发布资料，无法用它验证 Telegram 实现。 [AppuBot 公开资料](https://github.com/sarthakguptadev/appubot/blob/e0a25494a7c0/README.md)
