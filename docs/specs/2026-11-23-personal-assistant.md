# Kada Fork 个人助手功能 Spec

版本 v0.3，状态为 implemented，日期 2026-11-23。实现基线为 Fork 的 `6e6abcc`，功能方案提交为 `2a93e8f`。F01—F18 已实现首期终端和本地 API，用户选定的 agent-browser 已完成本地网页接管验收。下文源码参考保留固定快照，使用入口见[个人助手使用说明](../assistant-usage.md)。

待答交接、例行任务防重叠、手机增量历史和浏览器观察裁剪的具体实现、固定源码与验收结果见[后续优化记录](../experiments/2026-11-24-assistant-optimization-directions.md#本轮实现与验证)。

## 1. 目标与实现约束

在现有本地助手上补齐可管理的记忆、任务交接、模型与工具设置、例行任务和远程入口。首期以终端和现有本地 API 交付，macOS 客户端消费相同投影。参考优先级为 OpenMausBot、Rakazo、Suparagent，其余项目补充具体机制。

Pi 负责模型调用、Agent 循环、会话、工具执行、重试、压缩、等待及恢复。自定义文档保存必要的目标、归属、规则、引用和发生项进度。新增连接优先复用现有 SDK、extension 和薄适配。 [项目约束](../../AGENTS.md) · [现有产品范围](../../SPEC.md)

开发在 `skygazer42/kada` 的功能分支进行，阶段成果提交到 Fork。上游 PR 由用户后续安排。远程渠道和真实电脑驱动在对应阶段选择。

AppuBot 的公开仓库提供发布资料，P5 的代码实现依据采用 Codync、nanoMuse 和 Errand。参考机制按当前 Pi 接口独立落地，代码移植按相应文件许可处理。

## 2. 功能与代码参考

以下链接固定到已经读取的本地源码快照。每项都列出上游实现机制、Kada 落点和测试编号。调用流程是 Kada 的目标设计，参考项目的技术栈和部署形式按其实际源码解释。

### F01 · P1 · 项目记忆列表与来源

用户可按当前项目查看事实、来源摘录、确定性和有效状态。项目事实按规范化工作区身份过滤，全局偏好按既有适用规则并入。

实现流程为 认证请求 → 规范化 workspace → 现有 UserMemoryStore 过滤 → 来源投影 → /memory 与桌面记忆入口。

Kada 落点为 user-memory.ts、discovery.ts、server.ts、chat.ts。

源码参考为 [OpenMausBot · createBotMemoryRoutes](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/bot-memory.ts#L45) · [Rakazo · 运行记忆上下文组装](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/memory/memory-context.ts#L16)。

确定性验收为 M01 两个项目同名偏好互不串入。M02 每条可见事实能定位当前来源版本。

硅基流动测试为 在两个合成项目里使用相冲突的写作语言，分别检查最终答复和引用记录。

### F02 · P1 · 记忆纠正与并发更新

用户纠正事实时提交 expectedRevision 和 requestId。相同请求返回原结果，版本冲突返回 409 和最新版本，成功变更追加用户来源并关联被替代事实。

实现流程为 PATCH → 原请求查重 → 版本核对 → 现有独占写入与原子保存 → 返回当前事实。

Kada 落点为 UserMemoryStore.exclusive/save、server.ts、chat.ts。

源码参考为 [OpenMausBot · journalMemoryWrite](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/memory-journal.ts#L329) · [Rakazo · MarkdownMemoryStore.commit](https://github.com/elie222/rakazo/blob/e64d73292179/packages/memory/src/index.ts#L73)。

确定性验收为 M03 同一版本的两个并发修改只接受一项。M04 保存后强杀并重开仍能查回同一个结果。

硅基流动测试为 先记住中文，再由用户纠正为英文，新任务输出英文并引用纠正后的版本。

### F03 · P1 · 遗忘与重新扫描后的持续生效

显式遗忘停止事实的检索和自动注入，并保存归属及来源指纹。后续扫描同一来源保留遗忘决定。操作说明展示记忆索引、原始来源和历史记录各自的范围。

实现流程为 forget → 记忆操作查重 → 保存遗忘记录 → 重扫时按来源身份过滤 → 新任务重新选择记忆。

Kada 落点为 user-memory.ts 的既有状态过滤、refresh 与原子保存。

源码参考为 [OpenMausBot · botMemoryUpdate](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/memory-forget.ts#L92) · [Suparagent · remove_learned](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/about_me.py#L152)。

确定性验收为 M05 遗忘后重扫和重启都不重新导入同一事实。M06 一个项目的遗忘不影响另一个项目。

硅基流动测试为 遗忘一个随机合成偏好后新建会话，检查上下文注入清单和实际答复。

### F04 · P1 · 任务采用了哪些记忆

记录实际采用的 factId、revision、scope 和 sourceHash。普通聊天使用 Pi 会话级业务文档记录引用，交付请求沿用同一会话；记忆使用本身保持普通聊天语义。

实现流程为 记忆选择 → 固定引用版本 → Pi instructions → 会话使用记录 → 任务 memory 投影。

Kada 落点为 runtime.ts、discovery.ts、task-view.ts，Pi conversation doc。

源码参考为 [Rakazo · 运行记忆上下文组装](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/memory/memory-context.ts#L16) · [Rakazo · 记忆修订与 sourceRunId](https://github.com/elie222/rakazo/blob/e64d73292179/packages/memory/src/index.ts#L106)。

确定性验收为 M07 普通聊天的引用记录不创建 Goal。M08 改正来源后旧运行记录可追溯，新任务使用当前有效版本。

硅基流动测试为 核对回答依据与任务记录的引用 ID、来源版本，记录相关输入 token。

### F05 · P2 · 任务列表筛选与交接摘要

列表支持运行、待处理、已交付筛选。待处理项优先显示问题和原因，其余项显示当前步骤、预算与交付概况，选择后通过原任务 ID 接回。

实现流程为 已有 metadata/status → 列表投影与筛选 → /tasks → /attach → 原会话。

Kada 落点为 LocalRuntime.list/status、task-view.ts、chat.ts。

源码参考为 [OpenMausBot · /api/bots/:id/tasks](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/tasks.ts#L184) · [Errand · getConversation](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L312)。

确定性验收为 H01 一项等待、一项交付、一项运行时筛选正确。H02 重新进入终端后仍接回原任务。

硅基流动测试为 同时发起两个小任务，其中一个需要补充资料，检查交接摘要与实际终态。

### F06 · P2 · 完成、失败与待处理通知

通知由持久任务事件派生，绑定 taskId、revision、事件身份及已读状态。重复轮询或重新启动沿用同一通知身份，打开任务可标记已读。

实现流程为 状态事件 → 稳定通知 ID → 可见收件箱 → 标记已读 → 原任务。

Kada 落点为 GoalDoc.events、runtime.ts、server.ts、chat.ts。

源码参考为 [OpenMausBot · createNotificationRoutes](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/notifications.ts#L45) · [OpenMausBot · readThreadNotifications](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/notifications.ts#L13)。

确定性验收为 H03 同一事件重复投递只产生一个可见项。H04 已读状态在重启后保留。

硅基流动测试为 让模型完成或请求信息，检查通知与后台事件一一对应。

### F07 · P2 · 交付文件列表与打开

从已验收候选投影产物及实际检查范围，提供本地文件或目录打开入口。可读性、范围和最新文件版本均在打开时核对。

实现流程为 task_submit → 现有验收 → delivery.artifacts → 文件/目录入口。

Kada 落点为 checks.ts、verification.ts、task-view.ts、现有 desktop 客户端。

源码参考为 [Errand · listRunArtifacts](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L225) · [Errand · getConversation](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L312)。

确定性验收为 H05 空文件、目录和中文路径可打开。H06 待验收候选、越界路径和失效回执有明确状态。

硅基流动测试为 生成一个 JSON 和说明文件，独立核对其字节、字段及展示路径。

### F08 · P3 · 模型设置与连接检查

设置入口展示 provider、modelId、配置来源和连接结果。配置检测复用 Pi 模型与认证 API。新任务采用新选择，历史任务保留保存的模型引用。

实现流程为 选择模型 → Pi 解析认证 → 有界连接检查 → 保存选择 → 新建任务。

Kada 落点为 config.ts、models.ts、cli.ts、runtime.ts。

源码参考为 [OpenMausBot · checkEngine](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/engine-check.ts#L36) · [OpenMausBot · createConfigRoutes](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/config.ts#L125) · [DuskBot · 内置引擎清单](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/drivers/builtIn.ts#L24)。

确定性验收为 C01 缺凭据、401、429、超时和不存在的模型分别可识别。C02 切换模型后可重开原任务。

硅基流动测试为 使用 SILICONFLOW_API_KEY 验证目录、真实答复和工具调用，再核对当前配置引用。

### F09 · P3 · Skills 目录、选择和停用

列出已有 Skills 的来源、描述和版本，用户可选择适用方法。任务固定所采用版本，已停用方法从后续选择中排除。

实现流程为 现有发现 → 可选目录 → 版本固定 → Pi 原生 read → 实际使用记录。

Kada 落点为 discovery.ts、skills.ts、runtime.ts。

源码参考为 [OpenMausBot · listedImportedSkills](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/imported-skills.ts#L89) · [Suparagent · list_skills](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/agent_skills.py#L115)。

确定性验收为 C03 停用、同名和文件被修改时选择可解释。C04 原任务使用固定版本。

硅基流动测试为 从两份合成 Skill 中选择相关的一份，核对真实 read 记录与最终产物。

### F10 · P3 · 通用 MCP 连接与工具选择

连接先发现工具并展示清单，用户启用后挂入 Pi 扩展。记录测试所对应的连接版本，修改连接后重新核对工具与授权范围。

实现流程为 连接配置 → SDK 发现 → 版本化测试结果 → 启用 → Pi defineExtension/defineTool。

Kada 落点为 现有 @modelcontextprotocol/sdk 与 computer.ts 的薄适配经验。

源码参考为 [Suparagent · test_connection](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/custom_mcp.py#L464) · [Suparagent · enable_connection](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/custom_mcp.py#L522)。

确定性验收为 C05 本地假服务的发现、调用、断开和取消通过。C06 连接变更后的旧测试结果失效。

硅基流动测试为 让硅基流动模型调用一个本地加法 MCP 工具，断言调用参数、执行次数和结果。

### F11 · P4 · 单次提醒

支持创建、查看、修改和取消提醒。使用 Pi 持久 task 的 sleepUntil 保存等待，发生项 ID 同时关联提示、通知和任务。

实现流程为 用户明确时间 → 保存提醒业务状态 → Pi 睡眠 → 到期产生一次发生项 → 通知。

Kada 落点为 Pi 1.4.0 sleepUntil/onWake、现有 daemon 与任务存储。

源码参考为 [Pots · Timers.add 的 requestId 查重](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/gateway/timers.ts#L429) · [Rakazo · wakeRoutine](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-routines.ts#L168)。

确定性验收为 R01 假时钟下到期、取消和修改正确。R02 保存后强杀并重开只产生一次发生项。

硅基流动测试为 解析一条含明确时区的合成提醒，核对结构化结果后由假时钟验证触发。

### F12 · P4 · 每日/每周例行任务与补跑

首版支持每日、每周和明确时区。每个发生项有稳定身份、预算政策及执行状态。错过的发生项按保存的用户政策处理，效果不明的外部动作先核对结果。

实现流程为 规则与版本 → 发生项认领 → 现有任务执行 → 保存结果 → 计算下一次。

任务规则可配置固定脚本预检，复用 Pi 的本地执行环境。第一个成功样本和变化样本创建任务，相同样本跳过。预检中断后记录发生项和状态，已保存的检查结论可供恢复时使用。

Kada 落点为 Pi 原生等待与恢复，最少的例行规则/发生项业务状态。

源码参考为 [Rakazo · 例行发生项事务认领](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-routines.ts#L238) · [Amuse · recoveryDecision](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/robustness.ts#L100)。

确定性验收为 R03 重复投递、规则修改和预算停止可追溯。R04 夏令时重复时刻只执行一次，缺失时刻按明示策略处理。

硅基流动测试为 执行一次合成目录汇总，核对只在变化时通知及完整模型用量。

### F13 · P5 · 手机派活与请求查重

首版选择一个渠道，保留执行宿主的任务身份。远程用户、会话、消息 ID 和附件归属经过认证，受理后返回稳定 taskId。

实现流程为 已认证消息 → 持久受理与 requestId → 原任务 API → 受理状态。

Kada 落点为 server.ts、followUp 的 requestId 与现有 Pi 会话。

源码参考为 [Codync · send / clientNonce](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/bots.rs#L255) · [nanoMuse · PersistentTurns](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/harness/dsh-nanomuse/src/persistent-turns.ts#L28)。

确定性验收为 D01 同一消息 ID 连续重发只受理一次。D02 错误用户和错误会话无法接回任务。

硅基流动测试为 由测试渠道向硅基流动任务提交一次合成目标，重复请求后核对任务及用量。

### F14 · P5 · 断线重连与结果查询

重连先查询原请求状态，按原事件身份补发进度、有效问题和终态。执行结果不明时显示 unknown/interrupted 的含义，并保留原请求。

实现流程为 原消息身份 → 状态查询 → 事件补发 → 继续跟随原任务。

Kada 落点为 当前任务快照、Pi 事件和任务状态。

源码参考为 [nanoMuse · PersistentTaskEndpoint](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/harness/dsh-nanomuse/src/persistent-task-endpoint.ts#L42) · [Codync · events_stream](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/api/events.rs#L55)。

确定性验收为 D03 受理回复丢失、处理中断和终态丢失都接回原任务。D04 重连后的事件没有遗漏或重复可见项。

硅基流动测试为 在真实模型请求进行中断开测试客户端，恢复后核对最终答复和请求数。

### F15 · P5 · 远程附件与交付回传

输入和输出附件绑定 taskId、内容哈希及用途，回传已验收文件。校验大小、路径和归属，内容与描述对应。

实现流程为 附件受理 → 内容校验 → 工作区输入 → 任务产物 → 验收 → 附件回传。

Kada 落点为 Workspace、hashFiles、既有交付路径与选定渠道能力。

源码参考为 [Errand · sendMessage 与附件](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L330) · [Errand · listRunArtifacts](https://github.com/runta-dev/errand/blob/a20b925b740b/src/clients/http/RuntaCloudAgentsClient.ts#L225)。

确定性验收为 D05 超限、同名不同内容、路径穿越和附件失效有明确结果。D06 二进制文件回传哈希一致。

硅基流动测试为 用一份合成文本作输入并生成摘要附件，核对回传内容与任务引用。

### F16 · P6 · 应用观察、接管与回交

展示当前工作并允许用户接管。控制权交还或连接恢复后，重新观察再操作，结果由任务自己的验收方式核对。首个驱动由用户明确选为已安装的 agent-browser，仅验证合成本地网页；使用 CLI 薄适配，不自动启用日常配置。

实现流程为 任务获取租约 → 驱动观察/动作 → 用户接管 → 重新观察 → 回交与验收。

Kada 落点为 ComputerBridge、现成 MCP 驱动及原任务 Goal。

源码参考为 [OpenMausBot · ComputerControl](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/computer-control.ts#L41) · [Amuse · waitWhileUserControls](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/tools/browser.ts#L296)。

确定性验收为 U01 假驱动验证租约、超时和重新观察。U02 已选真实驱动完成一次接管回交流程。

硅基流动测试为 先在本地测试页面完成受限操作，再在同一任务内核对应用和文件结果。

### F17 · P6 · 按需分工与子任务结果回收

独立工序使用 Pi 子会话，记录职责、所属任务、状态、产物和费用。主任务基于结果检查完成条件，失败或中断有可继续的记录。

实现流程为 已确认目标 → delegate → Pi 子会话 → 保存结果 → 主任务检查与交付。

Kada 落点为 delegation.ts、Pi ownership、现有预算与验证。

源码参考为 [Pots · 子任务 anchor 与 reporter](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/children.ts#L345) · [Suparagent · Jobs.recover](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L303)。

确定性验收为 A01 取消父任务能终止所属工作。A02 双子任务强杀恢复保持归属及结果，子任务无法提交父目标。

硅基流动测试为 两个独立合成计算后汇总，核对两个子产物、总结果和全程用量。

### F18 · P7 · 方法保存、版本复用与回退

沿用现有 Skills 捕获与回退，显示来源、适用条件、固定版本和真实执行结果。用不同输入验证复用的质量、失败和全部费用。

实现流程为 已通过检查的工作 → 用户选择保存 → Skill 版本固定 → 新输入执行 → 核对与可选回退。

Kada 落点为 SkillStore.capture/rollback、pinSkills、settleSkills。

源码参考为 [Suparagent · save_learned](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/agent_skills.py#L177) · [Suparagent · draft](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/skill_learning.py#L15)。

确定性验收为 S01 产物变更使旧证明失效。S02 停用和回退保留运行的版本，独立新输入仍满足原检查。

硅基流动测试为 同类任务换输入再次执行，记录捕获、读取、执行、压缩和失败尝试的 token 与结果。

## 3. 数据与接口约定

### 3.1 记忆

- 复用当前 factId、scope、project、certainty、evidence、state 和来源快照。新增 revision 可由事实和来源版本的规范化哈希生成。
- 纠正以原事实版本为前置条件，形成新的用户来源，记录 supersedes。遗忘记录保存事实及来源身份，扫描时继续遵守。
- 记忆引用使用 Pi 会话级业务文档记录 `{factId, revision, scope, sourceHash}`，普通问答继续使用普通会话。
- 遗忘作用于记忆检索与自动注入。原始文件、历史对话和既有产物在各自入口管理，操作结果说明其具体范围。

| 提议接口 | 请求与结果 |
| --- | --- |
| `GET /v1/environment/memory?workspace=...` | 返回适用事实、版本和来源 |
| `PATCH /v1/environment/memory/:id?workspace=...` | `{text, expectedRevision, requestId}`，成功返回新版本，冲突返回 409 |
| `POST /v1/environment/memory/:id/forget?workspace=...` | `{expectedRevision, requestId}`，返回遗忘范围及结果 |
| `GET /v1/tasks/:id/memory` | 返回该会话实际采用的引用及来源版本 |

同一 requestId 的相同操作返回原结果，同一 ID 被用于不同内容时返回冲突。历史 schema 的读取、原有认证和确认边界需有兼容测试。

### 3.2 任务、通知与交付

`TaskView.progress` 继续提供步骤和活动工具，交付投影来自已验收候选。通知至少携带 `id, taskId, revision, event, readAt`，身份由已有持久事件派生。文件打开或下载时重新核对任务归属、范围和当前字节版本。

### 3.3 提醒与例行任务

业务规则至少包含 `id, revision, timezone, schedule, enabled, budgetPolicy, nextDueAt`。发生项至少包含 `routineId, ruleRevision, occurrenceKey, scheduledFor, taskId, state`。发生项认领和执行关联必须可恢复，时间等待使用 Pi 公开持久任务接口。

单次提醒先实现，每日/每周例行任务随后实现。等待触发与实际执行时限分别记录，执行时限从发生项开始执行时计算。费用和授权沿用明确保存的政策。

夏令时测试使用 America/Los_Angeles。不存在的本地时刻顺延到当天首个有效时刻并显示调整；重复的本地时刻采用第一次出现，并按本地日期和规则版本认领一次。离线错过按保存的补跑政策处理。

`nextTiming` 展示计划与实际本地时刻和调整原因，发生项回执保留所采用的调整。`GET /v1/routines/:id/occurrences` 与 `routines history ID` 从 Pi 持久条目回查记录；`claimed` 是未确认认领，不能等同实际启动或完成。旧版本的预算停止保留原政策用于追溯，但不改变新规则。

### 3.4 远程与协作

远程请求身份组合为 `channel, accountId, conversationId, messageId`，映射到当前 taskId/requestId。状态查询、问题回复和附件均核对这一归属。nanoMuse 的受理后宿主重启会报告 interrupted，Codync 的部分普通回合可发起原会话恢复，Kada 按已有 Pi 状态和实际结果选择接回动作。

Errand 的参考路径将 run 与 artifact 关联，其中已读到的输入处理路径针对图片。Kada 的通用文件回传属于本 Spec 的扩展需求，需单独完成 D05/D06。

子任务的执行、等待和取消使用 Pi ownership。长期具名助手属于 P6 后续角色扩展，先完成每个角色的记忆和任务归属定义。

## 4. 测试分层与执行

| 层级 | 方法 | 判断依据 |
| --- | --- | --- |
| 单元 | 固定输入、假时钟、可控版本和本地文件 | 范围过滤、revision、时间计算、路径和哈希的精确断言 |
| 集成 | 真实 Pi、SQLite、本地 HTTP/MCP 和脚本化模型 | 认证、确认、任务归属、恢复、查重和原始输入完整性 |
| 端到端 | 终端或已选客户端正常入口 | 接回、编辑、待答、文件打开及用户接管的实际结果 |
| 硅基流动 | 合成输入、真实模型和实际工具 | 模型请求成功、真实调用参数、产物检查、使用记录和 token |

F01—F18 的 M/H/C/R/D/U/A/S 编号由功能测试和选定入口验收覆盖。开发时优先扩展已有对应测试文件，按模块新增缺失用例。硅基流动测试与确定性检查一起核对，模型给出的“通过”需要有工具、状态或产物证据。

### 4.1 必须覆盖的公共失败路径

- 原件保持、中文及空路径、目录、空文件、二进制和合法零值。
- 401、429、超时、工具失败、取消和预算停止。
- 接收后回复丢失、同一请求重发、写入后进程中断、重新接回。
- 旧任务、旧配置、来源修订、遗忘重扫和并发修改冲突。
- 外部动作效果不明时，检查当前状态和已发生结果后继续。

### 4.2 硅基流动测试配置

在线凭据使用 `SILICONFLOW_API_KEY`。`SILICONFLOW_MODEL` 选择目录里实际可用的模型，默认基础烟测使用 `Qwen/Qwen2.5-7B-Instruct`，端点为 `https://api.siliconflow.cn/v1`。当前脚本可在终端无回显输入凭据。生产配置接入属于 F08。

基础烟测使用 Pi 的公开 `createProvider` 和 `openAICompletionsApi`，最多 4 次模型请求，每次输出上限 256 token，总超时 90 秒。只发送合成上下文。记录模型、请求数、token和断言结果，价格未知时费用字段保持 null。各功能的在线用例在实现时明确其请求、token和执行时限。

```sh
npm run test:live:siliconflow
npm run typecheck
npm run build
npm run check:commit
```

功能集成回归沿用项目 test/*.test.ts。当前环境的全量 Windows 失败与相关通过项分开记录，平台权限或缺失工具应提供实际失败依据。

## 5. 本次实际验证

已完成硅基流动模型目录认证、真实 Pi 工具调用往返、Kada 普通会话关闭重开后的上下文回忆，以及重复 follow-up 的查重。

模型为 Qwen/Qwen2.5-7B-Instruct，共 4 次模型请求。工具往返输入 286、输出 16 token，Kada 两轮会话累计 3573 token。当前自定义目录未配置价格，费用为未知。M01—S02 等未来功能验收将随各阶段实现执行。 [脱敏烟测结果](../experiments/2026-11-23-siliconflow-smoke.json) · [可执行测试](../../scripts/live-siliconflow-smoke.ts)

## 6. 分阶段完成条件

1. P1 完成 M01—M08 和真实记忆使用场景，交付可用的查看、纠正、遗忘入口。
2. P2 完成 H01—H06，用户能从列表找到待办并打开实际产物。
3. P3 完成 C01—C06，用户能确认模型和工具已经可用。
4. P4 完成 R01—R04，触发、取消、重启和发生项身份可追溯。
5. P5 完成 D01—D06，单个远程渠道能派活、接回和回传文件。
6. P6 完成 U01/U02、A01/A02，真实电脑接管与已有 Pi 子任务各有实际场景。
7. P7 完成 S01/S02，保留新输入复用的原始质量检查和完整成本。

每阶段交付都包含实现、原入口演示、测试结果和仍待验证的条件，再进入下一阶段。

## 7. 本轮实施状态

F01—F18 已接入首期终端和本地 API，并有确定性验收及硅基流动合成场景记录。U02 使用选定的 agent-browser 验证接管、回交、旧租约拒绝、重新观察及驱动中断恢复。H05 已观察到产物 API 打开的中文目录与空文件窗口。F12 固定脚本预检已验证未变化触发的模型请求数为零。F18 完成显式捕获、回退及原任务接回后的新输入交付。逐功能入口、Windows 回归和失败尝试见[实施验证记录](../experiments/2026-11-23-assistant-validation.md)。

P5 的首个渠道选为响应式 Web，远程首版限定工作区文件工具；原生 Shell、命令核验、宿主 MCP、全局记忆、Skills 与电脑能力不自动继承。手机历史使用持久 Pi EntryId，产物链接绑定交付版本及证明。完整远程执行能力等待现成隔离宿主。

真实模型验证发现普通聊天语言规则与保存的语言偏好有冲突，已在同一入口修正并复测。方法复用记录含失败尝试，自动学习和长期任务的成本改善待验证。合成记忆与交接复测中，原生 Pi 完整交付，Kada 写出正确报告后耗尽 token 预算。实体手机网络、任意桌面应用、macOS 编译与界面、真实用户对照及小时级交付仍待实测。
