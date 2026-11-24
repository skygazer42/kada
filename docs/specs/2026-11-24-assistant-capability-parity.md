# 个人助手能力对照

以 `fe8e9b4` 为对照基线。沿用 Pi 1.4.0 的会话、任务、工具与持久化。参考项目以开发计划中的固定提交为准。每项按用户能否从正常入口完成场景来判断，源码或测试夹具只能证明各自覆盖的部分。 [产品 Spec](../../SPEC.md) · [参考项目与版本](../superpowers/plans/2026-11-23-personal-assistant.md#参考优先级)

## 当前开发批次

| 能力 | Kada 契约与验收 | 参考实现 |
| --- | --- | --- |
| 周期规则暂停与恢复 | 在本地管理入口暂停规则。重启后仍暂停，恢复从未来第一个时间点继续，保留原规则版本、历史、预检基线和已受理任务。验证持续暂停、快速切换时旧定时器失效、重复请求以及迟到预算事件。 | [OpenMausBot 规则开关](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L632) |
| 间隔与工作时间窗口 | `interval` 以固定时间锚点按 5–1440 分钟重复，可配置截止时间、星期和时段。有星期或时段限制时指定 IANA 时区。间隔按实际经过时间计算，本地窗口过滤时间点。验证跨夏令时、错过补跑、恢复后稳定身份及截止时间。 | [OpenMausBot 规则字段](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-schedules.ts#L7) · [间隔对齐与窗口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-intervals.ts#L23) |
| 手机控制正在执行的任务 | 设备通过原会话暂停或取消任务，可在原额度与时限内继续自己暂停的任务。核对设备归属、原任务与请求回执、状态过期、重启和本机管理员操作。 | [nanoMuse 停止原任务](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/harness/dsh-nanomuse/src/device-conversations.ts#L97) · [Codync 任务操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/bots.rs#L358) |
| 项目默认模型 | 以现有记忆项目根保存通过 Pi 连通性检查的默认模型。新建本地项目任务采用该模型，清除后恢复全局默认。核对不同工作区、子目录以及重启后继续使用旧任务的原模型。 | [Rakazo Bot](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1053) · [Rakazo Run](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1323) |
| 自动化规则手动运行 | 从现有规则立即受理一次独立发生项，保持原下次自动执行时间。验证相同请求 ID、重启、预检、防重叠和预算回执。 | [OpenMausBot runNow](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routines.ts#L738) · [手动执行沿用预检](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routine-checks-engine.test.ts#L376) |

间隔调度回归覆盖夏令时跳过窗口、重复本地时段、含截止点的单一时间点和重启后的补跑。规则回归还覆盖手动请求重放、手动与定时同时触发、预检过程中强杀，以及原预算事件保留历史。有相同预检样本正在受理时，后来的触发保留 `pending` 跳过原因。前一次受理失败后，后续触发仍可使用相同样本。 [间隔回归](../../test/routine-interval.test.ts) · [手动回归](../../test/routine-manual.test.ts) · [强杀恢复](../../test/routine-precheck-recovery.test.ts)

手机控制在 Chromium 的 390 × 844 视口验证暂停、接回、取消确认以及原消息和草稿保留。服务端回归另外验证，取消已暂停的任务时 Pi 不会重新启动独立评审。项目模型的重启回归使用两个脚本化模型，重新打开旧会话后发新消息核对实际执行模型。 [手机 API 回归](../../test/remote.test.ts) · [页面回归](../../test/remote-pending-page.test.ts) · [项目模型回归](../../test/assistant-entry.test.ts)

## 已定位的能力差距

| 能力 | 基线与剩余工作 | 通过条件 | 参考实现 |
| --- | --- | --- | --- |
| 精确到工具动作的允许一次 | 已有任务确认和 MCP 版本白名单。还缺独立的待审批信息及决定。 | 拒绝、参数变化、规则修订和过期均阻止调用。批准绑定原参数，一次请求最多触发一次动作。 | [Rakazo 审批预览](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-ask.ts#L74) · [已批参数执行](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L91) · [Suparagent 许可入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/permission.py#L60) |
| 项目工具配置与工作项 | 已有项目记忆、项目默认模型和任务工具清单。项目自己的默认工具和持久工作项仍待接入。 | 两个项目采用各自的工具配置，改动仅影响对应项目的新任务。用户能从持久工作项查看各次运行。 | [Rakazo Bot](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1022) · [Rakazo Run](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/prisma/schema.prisma#L1323) · [Suparagent 工作项](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31) |
| 子任务异步回传 | 已有 Pi 子会话归属和结果恢复。调用委派工具时仍等待各子任务结算。 | 子任务运行期间主任务能做独立工作，重启后按原子会话回传一次结果或待答问题。 | [Suparagent 委派回执与回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L378) · [Pots 子任务清单](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/children.ts#L560) |
| 记忆采集控制与候选审阅 | 已有带来源的记忆修改、遗忘和使用记录。还缺独立控制新增采集和审核候选。 | 关闭采集后仍可读已有记忆，候选按来源和范围审阅，拒绝后不再进入召回。 | [Suparagent 记忆设置](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/memory.py#L16) · [候选处理](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/memory_proposals.py#L116) |
| 应用事件与主动检查 | 已有时间触发和预检。还缺现有连接器的事件触发、过滤、去重与主动运行条件。 | 合成事件可重放，重复和不匹配事件均不启动任务，符合规则的事件受原规则预算约束。 | [DuskBot 应用触发](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L477) · [Amuse 后台检查](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/scheduler.ts#L88) |
| 手机后台通知与跳转 | 已有页面内的待处理列表、收件箱和增量续读。还缺关闭页面时的设备通知。 | 用户订阅的设备在页面关闭时收到待答或完成提醒，打开后跳回自己有权访问的原会话。 | [Codync Android 通知](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/PushService.kt#L179) |
| 手机草稿与附件体验 | 已有带稳定 ID 的待发内容和已验收文件下载。仍需验证普通草稿跨重开、消息旁附件预览及图片输入。 | 两个会话分别恢复本地草稿。附件在原消息可打开，图片以模型支持的形式送入且可追溯。 | [Codync 草稿](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/AppStoreDrafts.kt#L45) · [Errand 图片提交](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L332) · [附件预览](https://github.com/runta-dev/errand/blob/a20b925b740b/src/ui/components/AttachmentPreview.tsx#L46) |

应用原生入口、渠道和更广义的桌面操作继续按项目源码核对。AppuBot 的公开仓库提供产品说明与发布资料，无法用它验证 Telegram 实现。 [AppuBot 公开资料](https://github.com/sarthakguptadev/appubot/blob/e0a25494a7c0/README.md)
