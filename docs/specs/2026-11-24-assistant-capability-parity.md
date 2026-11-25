# 个人助手能力对照

以 `fe8e9b4` 为对照基线。沿用 Pi 1.4.0 的会话、任务、工具与持久化。参考项目以开发计划中的固定提交为准。每项按用户能否从正常入口完成场景来判断，源码或测试夹具只能证明各自覆盖的部分。 [产品 Spec](../../SPEC.md) · [参考项目与版本](../superpowers/plans/2026-11-23-personal-assistant.md#参考优先级)

## 已实现能力

| 能力 | Kada 契约与验收 | 参考实现 |
| --- | --- | --- |
| 本地 MCP 单次动作审批 | 终端展示脱敏参数与摘要，决定绑定工具、参数、连接和任务修订。实际派发前复核连接权限与期限。强杀测试覆盖待答恢复和已派发但结果未知，原动作最多派发一次。 | [Rakazo 审批预览](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-ask.ts#L74) · [批准参数执行](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L91) · [Suparagent 许可入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/permission.py#L60) · [审批回归](../../test/approvals.test.ts) · [强杀回归](../../test/approval-recovery.test.ts) |
| 项目持久工作项 | 工作项有独立 ID 和修订。新运行固定启动时的修订和任务设置，历史任务按原 ID 查阅。并发或重启重试返回原任务。 | [Suparagent 工作项与运行](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31) · [运行提交](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_execution.py#L74) · [工作项回归](../../test/work-items.test.ts) |
| 周期规则暂停与恢复 | 在本地管理入口暂停规则。重启后仍暂停，恢复从未来第一个时间点继续，保留原规则版本、历史、预检基线和已受理任务。验证持续暂停、快速切换时旧定时器失效、重复请求以及迟到预算事件。 | [OpenMausBot 规则开关](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L632) |
| 间隔与工作时间窗口 | `interval` 以固定时间锚点按 5–1440 分钟重复，可配置截止时间、星期和时段。有星期或时段限制时指定 IANA 时区。间隔按实际经过时间计算，本地窗口过滤时间点。验证跨夏令时、错过补跑、恢复后稳定身份及截止时间。 | [OpenMausBot 规则字段](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-schedules.ts#L7) · [间隔对齐与窗口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-intervals.ts#L23) |
| 手机控制正在执行的任务 | 设备通过原会话暂停或取消任务，可在原额度与时限内继续自己暂停的任务。核对设备归属、原任务与请求回执、状态过期、重启和本机管理员操作。 | [nanoMuse 停止原任务](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/harness/dsh-nanomuse/src/device-conversations.ts#L97) · [Codync 任务操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/bots.rs#L358) |
| 项目默认模型 | 以现有记忆项目根保存通过 Pi 连通性检查的默认模型。新建本地项目任务采用该模型，清除后恢复全局默认。核对不同工作区、子目录以及重启后继续使用旧任务的原模型。 | [Rakazo Bot](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1053) · [Rakazo Run](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1323) |
| 自动化规则手动运行 | 从现有规则立即受理一次独立发生项，保持原下次自动执行时间。验证相同请求 ID、重启、预检、防重叠和预算回执。 | [OpenMausBot runNow](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L738) · [手动执行沿用预检](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-checks-engine.test.ts#L376) |
| 手机上次草稿与待发恢复 | 用相同配对重新打开会话可恢复原文和待发消息。待发记录保留消息 ID 和已上传的附件引用。双标签发送时，同一草稿只会转换成一条待发消息。 | [Codync 发送与草稿 ID](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/AppStoreDrafts.kt#L63) · [远程页面回归](../../test/remote-pending-page.test.ts) |
| 本地项目工具子集 | 按项目从全局已启用的 MCP 工具中选择。任务创建时固定实际工具和连接修订。验证配置重开、原任务快照、空集、全局继承和实际模型可见工具。 | [Rakazo 组装运行工具](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-assembly-capabilities.ts#L734) · [MCP 回归](../../test/mcp-tools.test.ts) |
| 子任务异步回传 | 主任务收到回执后可继续独立工作。当前批次由 Pi 后台任务持有子会话，结果沿原 ID 回查，交付等待批次回传。验证重开、提前提交与取消。 | [Pi 后台委派](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/test/examples/23-subagent-background.ts#L57) · [Suparagent 委派回执与回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L378) · [委派回归](../../test/delegation.test.ts) |
| 本地子任务待答 | 终端待处理列表可定位父任务。问题和答复保存在原 Pi 子会话，用户可从终端回送。答复保存后重启仍按原身份受理，其他子任务可继续工作。 | [Suparagent 问题回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L416) · [继续原子任务](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L829) · [待答回归](../../test/delegation-input.test.ts) |
| 停止单个本地后台子任务 | 终端列出子会话 ID。停止决定保存后，中止原 Pi 子会话的在途工作。重启时先处理已停止子会话，同批其他任务仍可交付。 | [Pots 保存停止决定与恢复](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/agent.ts#L884) · [终端与同批任务回归](../../test/delegation.test.ts) · [强杀回归](../../test/delegation-recovery.test.ts) |
| 五字段 Cron | 显式 IANA 时区。Croner 计算前后时刻，Pi 定时任务负责等待、补跑和恢复。回归覆盖无效表达式、闰日、夏令时和重启。 | [OpenMausBot Cron 计算](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/packages/phone-protocol/src/routine-schedule.ts#L13) · [Cron 回归](../../test/routine-cron.test.ts) |
| 项目记忆采集开关 | 关闭后保留原召回与用户纠正、遗忘。采集端核对项目来源，组织记忆的工具也核对调用任务的项目。回归覆盖子目录、注册来源、Claude 项目镜像和重启。 | [Suparagent 采集设置](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/memory.py#L16) · [采集门槛](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/memory_capture.py#L895) · [记忆回归](../../test/memory-management.test.ts) |
| 原消息附件卡片 | 原消息通过 Pi 提交条目关联附件。设备在会话归属范围内预览图片和纯文本，下载前验证原件长度与哈希。 | [Errand 历史附件关联](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L312) · [附件预览](https://github.com/runta-dev/errand/blob/a20b925b740b/src/ui/components/AttachmentPreview.tsx#L46) · [手机 API 回归](../../test/remote.test.ts) |
| 本地事件触发 | 规则选择来源、类型和标量字段匹配条件，本地鉴权入口保存事件身份和内容摘要。匹配后复用 Pi 的立即执行流程。已接受和已过滤事件跨重启、规则编辑去重，事件内容只用于匹配。 | [DuskBot 过滤与去重](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [事件回归](../../test/routine-event.test.ts) |
| 纯事件规则与 GitHub Issue 同步 | 纯事件规则可手动运行、暂停和恢复。同步公开仓库的新 Issue，首次记录基线，之后沿原事件 ID 补投，受理后保存游标。集成测试模拟响应丢失和 daemon 重启，并核对原任务只创建一次。 | [DuskBot 受理后推进游标](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L451) · [GitHub 事件接口](https://docs.github.com/en/rest/activity/events#list-repository-events) · [同步回归](../../test/github-routine-events.test.ts) · [本机 API 集成](../../test/assistant-entry.test.ts) |
| 手机 Web 后台通知 | 已配置 HTTPS 的 daemon 可启用 Web Push。每个配对单独订阅，基于 Pi 持久事件发送通用待答或完成提醒。通知链接经配对和会话归属校验后打开原会话。本地回归覆盖订阅、丢失回执后的重试与设备撤销。 | [Codync 后台接收与会话跳转](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) · [推送回归](../../test/remote-push.test.ts) · [通知点击](../../test/remote-worker.test.ts) |
| 记忆候选审阅 | 项目可选择审阅模型写入的候选。候选保留来源和任务身份，接受时核对来源与旧记忆版本，拒绝后同一工具重放保留原决定。 | [Suparagent 候选处理](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/memory_proposals.py#L116) · [候选回归](../../test/memory-review.test.ts) |
| 手机图片模型输入 | Pi 的图片处理器按固定模型能力处理原件，首条消息和目标任务待发消息保存原件引用供重启恢复。请求钩子限制跨轮图片总数，原消息仍保留完整图片。纯文本模型和无法解码的图片给出说明及文件路径。 | [Errand 图片提交](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L332) · [Pi 图片处理](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/src/images/node.ts) · [图片恢复回归](../../test/input-images.test.ts) |

间隔调度回归覆盖夏令时跳过窗口、重复本地时段、含截止点的单一时间点和重启后的补跑。规则回归还覆盖手动请求重放、手动与定时同时触发、预检过程中强杀，以及原预算事件保留历史。有相同预检样本正在受理时，后来的触发保留 `pending` 跳过原因。前一次受理失败后，后续触发仍可使用相同样本。 [间隔回归](../../test/routine-interval.test.ts) · [手动回归](../../test/routine-manual.test.ts) · [强杀恢复](../../test/routine-precheck-recovery.test.ts)

手机控制在 Chromium 的 390 × 844 视口验证暂停、接回、取消确认以及原消息和草稿保留。服务端回归另外验证，取消已暂停的任务时 Pi 不会重新启动独立评审。项目模型的重启回归使用两个脚本化模型，重新打开旧会话后发新消息核对实际执行模型。 [手机 API 回归](../../test/remote.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) · [项目模型回归](../../test/assistant-entry.test.ts)

Chromium 双标签发送同一草稿时，拦掉首个回执后仍只有一次发送和一次 Pi 受理。重新配对同名设备时，其浏览器草稿独立。后台委派的强杀回归核对原子任务提交、一次父任务接回和一次交付。若父任务已进入待答或保存新修订，恢复会取消过期批次。规则暂停、取消和更新的强杀回归核对 Pi 清理旧定时器。 [草稿回归](../../test/remote-pending-page.test.ts) · [委派强杀回归](../../test/delegation-recovery.test.ts) · [定时器强杀回归](../../test/routines.test.ts)

## 已定位的能力差距

| 能力 | 基线与剩余工作 | 通过条件 | 参考实现 |
| --- | --- | --- | --- |
| 统一任务与审批工作台 | 已有本地工作项、运行历史和终端审批。手机 Web 的待处理列表可打开设备自己的原会话，已通过 Chromium 手机视口验收。macOS 任务卡使用本机审批接口，原生验证待运行。跨设备的工作项浏览与授权审批入口仍待实现。 | 用户可浏览工作项、直接定位待处理运行，且只能处置当前账户和设备获准的审批。 | [Suparagent 待处理视图](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/needs_you.py#L133) · [手机页面回归](../../test/remote-pending-page.test.ts) |
| 子任务控制入口 | 本地终端与 API 支持定向答复及停止单个后台子任务。桌面和手机的待答入口，以及协调者单独追加指令或中断当前工具，仍待实现。 | 答复和控制操作关联原子会话和当前批次，保留其他子任务的运行和结果。 | [Pots 子会话控制](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/children.ts#L501) |
| 应用连接器与主动检查 | 公开 GitHub Issue 采用单次命令轮询，可由系统计划任务启动。持续订阅、其他应用与按用户活动触发仍待实现。 | 连接器投递真实事件并在断线后接回，主动检查遵守用户选择和预算。 | [DuskBot 应用触发](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [Amuse 后台检查](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/scheduler.ts#L88) |
| 手机后台通知实机验收 | Web Push 与会话跳转已有本地回归。仍需通过真实推送服务，在实体 iOS 与 Android 设备验收。 | 订阅的手机在页面关闭时收到提醒，打开后进入具备访问权限的原会话。 | [Codync Android 通知](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) |

应用原生入口、渠道和更广义的桌面操作继续按项目源码核对。AppuBot 的公开仓库提供产品说明与发布资料，无法用它验证 Telegram 实现。 [AppuBot 公开资料](https://github.com/sarthakguptadev/appubot/blob/e0a25494a7c0/README.md)
