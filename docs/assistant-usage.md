# 个人助手使用入口

实现范围和逐功能参考代码见[功能 Spec](specs/2026-11-23-personal-assistant.md)。当前通过 Fork 功能分支迭代。用户已选择 agent-browser 验证本地网页；日常配置仍按需启用，跨设备访问需要现成 HTTPS 代理。

## 终端与交接

运行 `npm run chat`。普通问答直接回复；交付请求先展示任务说明、核验方式和预算，确认后执行。

新会话需要选择时，助手可用 `ask_user` 保存 2–4 个选项。终端显示问题 ID、编号和内容，输入 `/choose 问题ID 编号`，也可直接补充其他答复。手机与 macOS 提供选项按钮和文字入口；后台子任务的选择仍回到原子会话。普通问题不创建 Goal，准备阶段的选择仍须经过原任务说明确认；选择不代替动作审批。

答复绑定原问题与请求 ID。回执丢失时重试原答复，旧问题、不同内容重用请求、暂停/取消或耗尽的执行预算会报错；原任务预算不会因选择补充。普通聊天重启保留待答问题，已保存答复沿原 Pi 提交接回一次。旧会话保留原工具范围。手机已分享运行仍需本机单独授予答复权限。

新建本机聊天和主任务可询问“这个项目之前讨论过什么”或“查一下我们以前选择的数据库”。助手通过 `history_search` 查同项目其他本机对话，再用 `history_read` 读取原文。结果带任务和消息 ID；检索按实际词串匹配，中文词可直接使用。子目录归同一项目，其他项目和远程私有会话不在范围内。旧任务不会自动获得此能力，历史正文也不构成新的授权。

也可以询问“这个项目还有哪些任务在等我答复”或“有哪些已交付任务”。新本机主会话通过 `project_tasks` 查询同项目其他任务的当前状态、原 ID、待答和交付摘要，待处理优先。查询不开始或恢复工作，也不创建 Goal。每页默认 20 项、最多 50 项，助手可按返回的 `nextOffset` 继续查；摘要有长度限制并标记截断。远程私有会话、其他项目与子任务不获得此目录，完整能力差距见[源码核对表](specs/2026-11-25-reference-capability-matrix.md)。

在本机新聊天询问“这个项目现在有哪些任务、待办、规则和可用 Skills”可读取综合目录。`project_catalog` 各类默认显示 5 条，助手可以按类别继续翻页。查询直接读取原记录，原任务和规则继续按已有状态执行。[参考实现与验收](superpowers/plans/2026-11-25-project-task-catalog.md#综合目录)

在当前会话输入 `/thread 独立核对 | 核对这一份材料`，可在同一个工作区打开独立工作。也可以在新本机普通聊天中请助手另开工作，终端会显示原始 `/attach` 链接。新工作须在自己的会话确认任务说明和预算。

要在验收后回到原会话看结果，可用 `/thread-report 独立核对 | 核对这一份材料`，或在聊天里说明「做完后回到当前会话告诉我结果」。回传保留原任务的 `/attach` 入口。空闲的本机普通聊天会在剩余额度内续答。来源有待答、已进入执行任务或已停止时，可以在来源查看回传记录。[回传契约](superpowers/plans/2026-11-26-thread-report-back.md)

需要第二种模型的意见时，可在标题前加 `--model provider/modelId`。例如 `/thread-report --model siliconflow/Qwen/Qwen2.5-7B-Instruct 独立复核 | 核对材料中的数值`。也可在普通聊天中请助手列出可用模型，再明确指定其中一个。回传会显示交付所用模型。 [模型选择与验收](superpowers/plans/2026-11-26-independent-thread-models.md)

普通聊天也可以说「列出这条会话打开的工作」「把当前会话改名为验收记录」或「归档已完成的那项工作」。助手按目录里的原任务和修订处理。仍在运行、排队或等用户确认的工作会留在列表中。 [聊天内会话管理](superpowers/plans/2026-11-26-chat-thread-management.md)

给关联会话留资料时，可以说「给独立复核的会话留一句：源数据用第二版」。再加「请它现在读并回复」即可请求唤醒。打开接收会话可以看到留言正文和发送会话的 `/attach` 链接。待答和确认仍由用户在目标会话处理。 [留言与唤醒](superpowers/plans/2026-11-26-thread-posts.md)

`/title 标题` 修改当前会话的显示名称。结清工作后用 `/archive` 归档，`/tasks archived` 查看列表，`/attach 任务ID` 阅读历史，`/unarchive` 恢复显示和继续输入。来源、原对话、交付和已耗额度随原任务保存。[会话管理契约](superpowers/plans/2026-11-26-local-threads.md)

## 本机语音

本机 daemon 设置 `SILICONFLOW_API_KEY` 后，可转写原会话工作区内的 WAV。终端先显示转写结果，再用独立命令把已保存文本发给原会话。朗读从同一会话已保存的助手答复生成 WAV，可在本机打开原文件。

```powershell
npm run harness -- voice transcribe 会话ID recording.wav note-1
npm run harness -- voice show 会话ID note-1
npm run harness -- voice send 会话ID note-1
npm run harness -- voice render 会话ID reply-1
npm run harness -- voice play 会话ID reply-1
```

录音上限为 5 MiB，合成结果上限为 16 MiB。再次查询或用同一请求重试会读取保存的回执。 [源码与实际转写和合成验收](superpowers/plans/2026-11-26-voice-notes.md)

## 交付图表

已确认的本机任务可以用 `save_chart` 写出线图或柱状图的 `.chart.json`。任务交付后，用 `files 任务ID` 查编号，再用 `files chart 任务ID 编号` 获取本机预览。浏览器可切换序列、看原数据及下载当前图的 PNG。链接保留验收时的图表快照，有效期十分钟。 [固定源码与实测](superpowers/plans/2026-11-26-chart-preview.md)

## 工作区快照

`snapshots browser 任务ID` 生成原工作区的本机浏览器链接。页面可以保存快照、比对要恢复或移除的文件，再确认当前预览。恢复前的一份自动快照可用于撤销。 [验收](superpowers/plans/2026-11-26-workspace-snapshot-page.md)

保存快照后可预览工作区的文件差异，再提交显示的 `version`。恢复会保存一个撤销快照，回执给出 `undoSnapshotId`，用同一预览与恢复入口可撤销这次操作。重叠任务还在执行或工作区在预览后发生编辑时，恢复返回当前冲突。[实现与验收](superpowers/plans/2026-11-26-workspace-snapshots.md)

在后台配置加入 `"workspaceSnapshots": true` 后，新本机任务会在确认后的每个执行回合保存一个快照。默认保留最近十份自动快照，并保留手工快照与恢复历史引用的快照。

```powershell
npm run harness -- snapshots save 任务ID "修改前"
npm run harness -- snapshots list 任务ID
npm run harness -- snapshots preview 任务ID 快照ID
npm run harness -- snapshots restore 任务ID 快照ID 预览版本
```

新本机聊天可直接说“保存待办：整理周报，先不要执行”“把这条待办标为完成”或“归档，保留记录”。助手用 `work_item_create` 保存，`work_items_list` 分页查询，`work_item_read` 回读原 ID 与修订，`work_item_update` 修改文字、open/parked/done 状态或归档。默认列表只显示未归档的 open/parked 项，查询已完成/归档记录时可分别开启 includeDone/includeArchived。列表说明最多 500 字，回读最多 8,000 字，均标注截断。

待办状态是用户的规划记录：完成或归档不会开始、取消或证明原运行完成，已分享给手机的工作项仍可查看原运行。新运行前需恢复已完成/归档项；原运行请求重试保留原身份。聊天转为 Goal 后不再提供待办管理工具。旧聊天、远程、准备、执行与子任务不自动获得这些工具。修改回执在重放时返回当次结果，最新状态应重新查询。

原 CLI `work-items edit 工作项ID 文件.json` 也支持 `{ "revision": 1, "status": "done", "archived": true }`，标题和说明可同时修改；不删除原工作项或运行记录。

待办还可保存 `low/normal/high/urgent` 优先级，以及日期或精确时刻截止。例如说“把这条待办设为高优先级，截止纽约时间 2026 年 12 月 1 日，先不要执行”。助手沿同一条记录保存；时间或时区不清楚时需先补齐。截止只用于规划，不会创建提醒；需要提醒时单独提出。

CLI 创建/编辑的 JSON 可带 `priority`、`dueDate`、`dueAt`、`timeZone`。日期截止保留为 `YYYY-MM-DD`，精确时刻须带 `Z` 或 UTC 偏移；两种截止互斥。下面的修改将日期截止改成纽约时间 17:00：

```json
{ "revision": 1, "priority": "high", "dueDate": null, "dueAt": "2026-12-01T17:00:00-05:00", "timeZone": "America/New_York" }
```

用 `dueDate: null` 或 `dueAt: null` 清空相应截止；切换种类时明确清空原字段。未填写规划字段的旧记录按普通优先级、无截止、UTC 展示，读取不改原文件。已分享的手机卡片和详情可查看优先级、截止及逾期，仍无规划编辑权限。日期按保存的时区跨天才逾期；完成或归档后不显示逾期。修改规划保留原执行目标和运行修订。[源码及验收范围](superpowers/plans/2026-11-26-work-item-planning-research.md)

```text
/memory list
/memory edit 记忆ID 新的内容
/memory forget 记忆ID
/memory used
/tasks pending
/tasks running
/tasks delivered
/attach 任务ID
/inbox
/read 通知ID
/files
/open 1
/remind 2026-12-01T17:00:00-05:00 汇总项目进展
```

记忆纠正和遗忘操作只影响检索与后续背景注入。原始文件、历史引用和既有产物保留。相同请求身份会返回原结果，冲突版本须重新查看后修改。打开产物前会重新检查文件范围及哈希；可执行格式在文件夹中显示。

项目记忆采集默认开启。关闭后仍可召回该项目已保存的记忆，也可用原入口纠正或遗忘。再次开启后可以采集项目来源的新版本。

```powershell
npm run harness -- memory capture --workspace E:/project
npm run harness -- memory capture off --workspace E:/project
npm run harness -- memory capture on --workspace E:/project
```

项目可开启模型写入记忆的候选审阅。开启后，`user_remember` 提交的候选需要由用户接受才会进入召回。接受时会重新核对来源版本和原记忆版本。

```powershell
npm run harness -- memory review on --workspace E:/project
npm run harness -- memory candidates --workspace E:/project
npm run harness -- memory accept 候选ID --workspace E:/project
npm run harness -- memory reject 候选ID --workspace E:/project
npm run harness -- memory review off --workspace E:/project
```

## 命名助手

`npm run harness -- assistants browser --workspace 路径` 打开本机项目助手设置。选择或新建助手，编辑原指令、选定模型与工具，或归档和恢复。保存后可从页面复制带项目路径和助手修订的新会话命令。 [浏览器验收](superpowers/plans/2026-11-26-project-assistants-page.md)

开启本机记忆时，可以将角色的「记忆范围」设为「此助手的私有记忆」。同一角色的新会话可检索自己的私有事实和原对话。记录与复核开关沿用项目设置。已接回的私有会话用 `/memory list` 查看，终端也可在 `memory list`、`memory edit`、`memory forget`、`memory candidates`、`memory accept` 或 `memory reject` 加 `--assistant ID@修订 --workspace 路径` 管理私有记录。 [实现与验收](superpowers/plans/2026-11-26-assistant-private-memory.md)

先在项目中保存一份角色定义，例如 `reader.json`：

```json
{ "name": "研究员", "instructions": "阅读原始资料并引用证据，能力不足时明确说明。", "model": null, "tools": ["read", "history_search", "history_read", "project_tasks"] }
```

```powershell
npm run harness -- assistants add reader.json --workspace E:/project
npm run harness -- assistants list --workspace E:/project
npm run harness -- assistants show 助手ID
npm run harness -- chat --assistant 助手ID@1 --workspace E:/project
npm run harness -- run "阅读资料并给出摘要" --assistant 助手ID@1 --workspace E:/project
```

创建定义只保存配置，不开始工作。`model: null` 使用新任务创建时的原项目模型；也可指定目录中的 `{ "provider": "…", "modelId": "…" }`，认证仍沿 Pi 原设置，不把凭据写进角色定义。CLI 省略 workspace 时，选角色的新工作使用当前目录。角色只能在原任务已有能力内收窄工具，名称按实际注册名填写；Goal 和待答所需的少量控制由宿主保留，命令核验需要 bash。名单不构成系统沙箱。

新本机普通聊天也可以说“为当前项目保存一个研究员助手，先读原始资料并引用来源，只允许 read，使用默认模型；先不要开始工作”。助手通过 `assistant_catalog` 查实际模型/工具名称，用 `assistant_create` 保存定义，不创建 Goal、提醒或新会话。随后可说“给这位研究员的原指令末尾加上结果用中文”“归档这个助手，保留记录”或“恢复刚才归档的助手”。`assistants_list` 分页查询元数据，`assistant_read` 读完整原配置，`assistant_update` 按原 ID/修订修改；不能用列表摘要覆盖完整指令。

回执丢失后由原 Pi 工具身份重试，同一调用返回当时结果，不重复创建，也不覆盖后来的编辑或归档。查询最新配置需再次读取。目录模型和工具元数据只用于选择，不证明账户连通性，不启用新服务。配置管理不会切换当前会话角色，保存后仍在新 chat/run 明确选择版本。历史聊天、远程、准备/执行阶段和子任务不自动获得管理工具；已选角色也继续受其原工具名单限制。[聊天管理参考与验证](specs/2026-11-26-chat-assistants.md)

普通角色聊天仍无 Goal，提出实际交付后沿原说明与预算确认。`run --yes` 和聊天 `/run` 继续要求已有明确授权。终端新建、接回和 `/status` 会显示助手名称与修订。接回已有任务不带 `--assistant`，原任务不能通过追加消息换角色。

用 `assistants edit 助手ID edit.json` 修改，例如 `{ "revision": 1, "instructions": "新的完整指令", "tools": ["read", "write"] }`。只修改提供的字段；新工作须明确选择新修订，旧会话和原子任务保留原模型、指令与范围。模型用于主会话，子任务如有原先指定的 worker 模型则继续该配置，否则由 Pi 复制父配置。指令保留原空白与 Unicode 字符串，不能从缩略列表拼回覆盖。

归档使用 `{ "revision": 2, "archived": true }`，恢复用当前修订和 `false`。归档阻止新选择，既有任务仍从原任务入口暂停/取消。目录不删除历史。当前由本机 owner CLI/API 管理，手机和模型不会自动获得角色编辑权。配置旧服务尚不支持时，角色请求会报错。[源码与验收](specs/2026-11-26-named-assistants.md)

## 持久助手协作

用 `assistants list` 查到当前项目的助手 ID 与修订后，可以为一项新本机任务指定协作者。重复 `--collaborator` 可指定多位助手。根助手选择启用协作的角色时，其工具名单也须允许 `assistant_assign` 等协作工具。协作者可在各自名单中使用 `assistant_ask` 提问和 `assistant_attach` 回交文件。

```powershell
npm run harness -- run "请研究员核对资料，再由主助手提交结果" --workspace E:/project --collaborator 助手ID@1
```

在聊天中 `/attach 任务ID` 查看并确认原任务说明。确认后，主助手可以在同事的原会话里派新工作或返工。每份工作单独保存输入、提问、结果和固定文件副本。所有同事计入原任务预算。

- `/assistant-work` 列出原工作。加工作 ID 可读原结果和文件引用。
- `/reply-assistant 工作ID 问题ID 答复` 回答当前问题。重启后可接回同一任务继续答复。
- `/guide-assistant 工作ID 补充说明` 给指定工作追加说明，由 Pi 在独立回合送达。
- `/stop-assistant 工作ID` 停止刚查看的工作及其下游工作。同事已排队的其他工作可以继续。

目前从本机终端和 owner API 操作。站立会话归属于原任务和来源会话，任务状态可查到原工作 ID、角色修订、用量和留下的文件。[协作契约与验收](specs/2026-11-26-assistant-collaboration.md)

## 助手群组

从项目的命名助手中选 2 到 8 位成员及修订。用成员 ID 点名答复。成员使用固定版本的指令、模型和 Pi 会话，并读取已经发生的近期群组消息。回复期间可从终端或已授权的手机继续发送，每个群组最多保留八条等待消息，按接收顺序处理。保存请求 ID 可查询或重试同一条消息。 [排队验收](superpowers/plans/2026-11-26-assistant-room-queue.md)

```powershell
npm run harness -- rooms add "发布复核" 助手一ID@1 助手二ID@1 --workspace E:/project
npm run harness -- rooms list
npm run harness -- rooms send 群组ID 助手一ID "核对一下上一条发布说明" release-review-1
npm run harness -- rooms show 群组ID
```

使用 `rooms edit 群组ID 修改.json` 改标题或成员。编辑文件带 `revision`，可附 `title` 或完整的 `members` 数组，每项为 `{ "id": "助手ID", "revision": 1 }`。旧修订请先重新读取。助手工具名单可选 `room_handoff`，让成员把本轮依次交给尚未参与的成员。原群组显示交棒过程与最终答复。

发言可重复加 `--room-file 相对路径` 附带工作区里的文本文件。发言后修改原文件时，群组仍保留选定版本。角色可按配置使用 `room_attach_text` 保存本轮产出，以及用 `room_read_file` 按原编号读取。用 `rooms show` 查附件消息与编号，再用 `rooms file 群组ID 消息ID 附件编号` 找到固定副本。 [原附件与回交验收](superpowers/plans/2026-11-26-room-attachments.md)

本机通过 `rooms share 群组ID 账户ID 设备ID` 分享查看，通过 `rooms share-replies 群组ID 账户ID 设备ID` 授予发送权限。手机 Web 的 **Shared rooms** 打开同一群组。用 `rooms unshare-replies` 撤回发送权限，或用 `rooms unshare` 一并撤回查看和发送。 [源码与验收](superpowers/plans/2026-11-26-assistant-rooms.md)

`rooms share-files 群组ID 账户ID 设备ID` 授予该设备下载固定附件的权限，`rooms unshare-files` 单独撤回。撤回群组查看会同时撤回下载。 [附件权限验收](superpowers/plans/2026-11-26-room-attachments.md)

## 应用 API 凭据

新本机主会话可请求提供 API 凭据。卡片列出名称、用途、HTTPS 站点与认证方式；核对后输入 `/credential 问题ID`，再在终端的无回显提示中粘贴值。命令本身只填问题 ID。用 `/decline-credential 问题ID` 拒绝。macOS 已接入独立密码字段，编译与实机交互仍待验证。普通消息、选项答复和管道不能提供凭据；手机共享卡提示回本机处理。

保存只回传通用确认，不创建 Goal 或授权外部工作。已确认执行任务可按名称、修订使用 Bearer、自定义认证头或 Basic；后端将认证头绑定原 HTTPS origin，检查公开 DNS 并固定连接地址，拒绝重定向和覆盖认证头。取消会关闭请求；未知外部结果不自动重试。响应有体积限制，检测到原值或支持的 JSON/percent/base64 转义形式时整段隐藏，不能保证任意服务变换后的秘密都能识别。旧任务、远程和子任务不会自动获得这些工具。

```powershell
npm run harness -- credentials list --workspace E:/project
npm run harness -- credentials remove reports 1 --workspace E:/project
```

列表只返回元数据，删除须使用显示的当前修订。替换由新凭据请求完成，重复提交返回该请求的原回执。凭据文件为 dataDir 的 `application-credentials/items.json`，Git 忽略该路径并检查强制暂存。Windows 写入使用当前用户 DPAPI 保护的数据密钥。旧文件在首次成功修改时迁移，移机恢复需要能解开密钥的 Windows 用户配置。其他系统使用限权的本机文件。网页登录和人工验证可在本机浏览器交接。 [Windows 存储与验收](superpowers/plans/2026-11-26-windows-application-credential-protection.md) · [浏览器登录交接](superpowers/plans/2026-11-27-browser-sign-in-handoff.md)

## 模型与方法

`model browser --workspace 路径` 生成该项目的本机模型设置链接。浏览器显示当前生效模型，支持检查连接、保存项目覆盖和恢复全局值。 [验收](superpowers/plans/2026-11-26-project-model-page.md)

从当前工作区导入自写或已核对的原生 Skill，用 `skills import 目录 --workspace 路径`。更新既有包时在目录后提供展示的当前版本。用 `skills export 名称 版本 目标目录 --workspace 路径` 导出指定版本。导入进入现有本机 managed 目录，项目 Skill 的同名优先级保留。 [实现与验收](superpowers/plans/2026-11-26-skill-authoring.md)

在本机普通聊天中，可以请助手为当前项目建议一个默认模型。用 `/model-proposals` 核对原值、所提型号及理由，再输入 `/apply-model 建议ID` 检查连通性并应用，或用 `/decline-model 建议ID` 拒绝。应用后的项目默认值供新任务选择，已接回的对话沿自己的模型继续。[设置契约与测试](superpowers/plans/2026-11-26-chat-model-proposals.md)

密钥通过供应商环境变量或 Pi 已有认证设置。硅基流动使用 `SILICONFLOW_API_KEY`，凭据不写入任务配置。

```powershell
npm run harness -- model list siliconflow
npm run harness -- model check siliconflow Qwen/Qwen2.5-7B-Instruct
npm run harness -- model select siliconflow Qwen/Qwen2.5-7B-Instruct
npm run harness -- model check siliconflow deepseek-ai/DeepSeek-V3.2
npm run harness -- model select siliconflow deepseek-ai/DeepSeek-V3.2
npm run harness -- model select siliconflow deepseek-ai/DeepSeek-V3.2 --workspace E:/project
npm run harness -- model list siliconflow --workspace E:/project
npm run harness -- model clear --workspace E:/project
npm run harness -- skills list --workspace E:/project
npm run harness -- skills disable 方法名 --workspace E:/project
npm run harness -- skills enable 方法名 --workspace E:/project
npm run harness -- run "目标" --workspace E:/project --skills 方法名
npm run harness -- skills capture 任务ID 已核验的Skill目录
npm run harness -- skills rollback 方法名 版本
```

新任务采用当前模型，原任务保留保存的模型及方法版本。`--skills ""` 显式不选择方法。方法目录按项目、已发现的用户方法、内置方法、本地试用处理同名优先级。停用和固定版本使用同一目录，新任务不再通过原始发现目录绕过选择。读取方法与真实运行脚本分别记录，脚本通过 Pi 原生 bash 执行。

项目默认模型需先通过 `model check`。`model select --workspace` 与记忆使用同一个项目根，新的本地 `run` 或 `chat` 指定该项目工作区时会采用项目默认。`model clear --workspace` 恢复全局默认，已有任务继续使用创建时保存的模型。

硅基流动目录的价格尚未配置，因此金额显示未知；金额上限无法计量，实际停止依赖 token 预算与时限。预算在请求边界按已返回用量检查，单个已受理请求可能跨过累计额度。请在本地配置中明确 `maxTotalTokens`、`maxDurationMs`，费用以供应商账单为准。

## MCP

`npm run harness -- mcp connections` 生成本机连接管理链接。可保存连接定义、发起或退出 OAuth 登录、测试连接、启用工具、要求逐次批准和停用连接。完成 OAuth 登录后，在连接页刷新状态，再测试并启用所需工具。 [验收](superpowers/plans/2026-11-26-mcp-connections-page.md)

`mcp browser --workspace 路径` 生成本机项目工具设置链接。可指定当前已启用的工具，也可以保存空白范围或恢复继承。 [验收](superpowers/plans/2026-11-26-project-mcp-page.md)

在新本机普通聊天中，可请助手建议登记一个 MCP 地址，或者调整项目使用的工具。用 `/mcp-proposals` 核对地址、传输类型或新旧工具范围，再用 `/apply-mcp 建议ID` 应用或 `/decline-mcp 建议ID` 拒绝。登记后的连接沿下面的测试、登录和工具启用入口设置。项目工具建议应用到新任务。[契约与实测](superpowers/plans/2026-11-26-chat-mcp-proposals.md)

远程连接的 `transport` 使用 `http` 选择 Streamable HTTP，或用 `sse` 选择旧版 SSE。地址、环境变量认证和 OAuth 沿相同配置入口。[SSE 验证](superpowers/plans/2026-11-26-legacy-sse-mcp.md)

使用既有服务的配置文件，例如：

```json
{"id":"local-tools","transport":"stdio","command":"node","args":["E:/tools/server.mjs"]}
```

```powershell
npm run harness -- mcp add mcp.json
npm run harness -- mcp test local-tools
npm run harness -- mcp enable local-tools 测试返回的revision 工具名
npm run harness -- mcp disable local-tools
npm run harness -- mcp project --workspace E:/project
npm run harness -- mcp project-set tools.json --workspace E:/project
npm run harness -- mcp project-clear --workspace E:/project
```

发现工具不授予执行权限。用户启用后，新任务固定该版本和所选工具；连接或工具定义变化使旧测试失效。禁用会停止当前连接调用。凭据映射填写环境变量名称，服务状态不返回认证值。

新建本机任务固定的 MCP 工具总数超过 20 个时，执行阶段先使用 Pi 的 `tool_search` 按工具名、英文描述或参数搜索，再加载需要的工具。已加载工具随原 Pi 会话保存，压缩和重启后仍可用。搜索只覆盖该任务固定的工具清单，实际调用仍核对当前连接与审批；加载工具不代表获得新权限。普通聊天和任务准备阶段不开放 MCP 执行工具，旧任务保持原来的直接工具列表。

项目可以从全局已启用的工具中选择一个子集。`tools.json` 格式为 `[{"id":"local-tools","tool":"工具名"}]`，空数组关闭该项目新任务的所有 MCP 工具。`project-clear` 恢复继承全局设置。

已启用的工具可要求逐次审批。任务停在待答状态后，用 `/approvals` 查看参数、摘要和有效期，再用 `/allow 动作ID` 或 `/deny 动作ID` 答复。批准绑定已展示的动作，断线后重发同一个决定会查询原回执。执行已派发但回执丢失时，任务会报告结果未知。

```powershell
npm run harness -- mcp approval local-tools 当前revision 工具名
```

可以把单项 MCP 审批交给已配对的手机处理。先在终端接回任务，用 `/approvals` 查看动作 ID 和摘要，再分享给指定设备。

```powershell
npm run harness -- remote share-approval 任务ID 动作ID 账户ID 设备ID 摘要
npm run harness -- remote unshare-approval 任务ID 动作ID 账户ID 设备ID 摘要
```

配对手机连接或刷新后，在 **Action approvals** 查看脱敏参数和有效期，选择允许一次或拒绝。撤销分享会关闭该设备对这一项的审批权限。撤销设备配对后，重新配对须重新分享。

## 项目工作项

项目看板的 **截止日历** 按月份展示已设日期的工作项。带时刻的卡片按其保存时区归到当天。点击同一张卡可编辑截止日期、时刻和时区，保存后日历随原工作项更新。 [截止日历验收](superpowers/plans/2026-11-26-project-workboard.md#截止日历增量)

项目也可接入 Google Calendar MCP。用 `mcp add`、`mcp test` 和 `mcp enable` 配好可直接读取的 `list-events` 工具，再给项目指定一个账号别名、一个日历和显示时区。配置文件里的 `revision` 采用 `mcp test` 返回的当前值。

```json
{
  "id": "calendar",
  "revision": "当前连接修订",
  "account": "work",
  "calendarId": "primary",
  "timeZone": "America/New_York"
}
```

```powershell
npm run harness -- work-items calendar-source source.json --workspace E:/project
npm run harness -- work-items calendar 2026-11 --workspace E:/project
npm run harness -- work-items calendar-clear --workspace E:/project
```

在日历来源里设置 `"allowAssistant": true` 后，新建本机聊天可询问当天或指定日期范围的日程。查询默认使用绑定日历的时区，助手可获得返回的标题和起止时间。

要让助手创建、修改或取消日程，在这条连接上启用所需的 `create-event`、`update-event` 或 `delete-event`，并用 `mcp approval` 为相应工具开启逐次审批。在项目执行任务中，用 `/approvals` 查看原日历、事件 ID、变更字段和邀请设置，再用 `/allow` 或 `/deny` 处理。派发前会复核项目当前的日历绑定和工具许可。 [日历工具及验收](superpowers/plans/2026-11-27-project-calendar.md)

打开看板的截止日历即可浏览本月外部日程。工作项日期沿其保存时区显示，外部日程沿日历来源所选时区显示。 [工具契约与验收](superpowers/plans/2026-11-27-project-calendar.md)

### Gmail

在 Google Workspace MCP 的 Gmail 连接上启用只读的 `search_gmail_messages` 和 `get_gmail_message_content`，并允许项目使用它们。将 MCP 连接 ID、当前测试修订和邮箱地址保存为配置文件。

```json
{
  "id": "mail",
  "revision": "当前连接修订",
  "email": "team@example.com"
}
```

```powershell
npm run harness -- gmail source mailbox.json --workspace E:/project
npm run harness -- gmail search "in:inbox" --workspace E:/project
npm run harness -- gmail read MESSAGE_ID --workspace E:/project
npm run harness -- gmail read MESSAGE_ID NEXT_OFFSET BODY_SHA256 --workspace E:/project
npm run harness -- gmail attachments MESSAGE_ID --workspace E:/project
npm run harness -- gmail download MESSAGE_ID ATTACHMENT_ID mail/receipt.pdf 0 --workspace E:/project
npm run harness -- gmail clear --workspace E:/project
```

搜索结果提供邮件 ID 和后续页的令牌。把令牌作为 `gmail search` 的第二个参数继续查询。读取正文时，用返回的 `next_offset` 和 `body_sha256` 接回原邮件版本。 [源码与验收](superpowers/plans/2026-11-27-project-gmail.md)

启用只读的 `get_gmail_attachment_content` 后，可把附件保存到指定的项目文件。请用最新清单里的附件 ID 和索引。保存回执包含路径、字节数和 SHA-256。同位置重复下载会核对已有字节，内容冲突时保留原文件。项目执行任务也可保存原附件并交付该文件。 [附件验收](superpowers/plans/2026-11-27-project-gmail.md#附件读取和交付)

想在本机普通聊天里搜索和阅读这个邮箱时，在同一配置里加上 `"allowAssistant": true`，重新运行 `gmail source`，再打开新聊天。助手读取的搜索结果和邮件正文会发给该聊天使用的模型。用 `false` 或 `gmail clear` 可撤回后续调用。账号、连接修订或项目许可变化也会停止已有聊天的读取。

项目执行任务可保存草稿、发送纯文本邮件，或按原邮件 ID 增删标签。在已开启助手访问的邮箱连接上启用所需的 `draft_gmail_message`、`send_gmail_message` 或 `modify_gmail_message_labels`，再用 `mcp approval` 开启逐次审批。用 `/approvals` 核对邮箱、收件人、抄送、密送、正文或标签，再用 `/allow` 或 `/deny` 处理。 [邮箱写入及验收](superpowers/plans/2026-11-27-project-gmail.md#邮件写入)

### 按 Gmail 搜索触发例行规则

用 `routines add` 保存以下规则。第一次成功检查只登记已有邮件。后续发现新的匹配 ID 时，收件箱会收到一条带匹配数量的通知。每个规则修订对同一邮件只触发一次。

```json
{
  "id": "invoices",
  "action": "notify",
  "objective": "检查新收到的发票",
  "workspace": "E:/project",
  "schedule": { "kind": "interval", "everyMinutes": 5, "anchorAt": "2026-11-27T00:00:00Z" },
  "precheck": { "gmail": { "query": "in:inbox from:receipts@example.com newer_than:7d" } }
}
```

将 `action` 改为 `task` 可运行助手。该任务用 `project_gmail_read` 获取本次匹配的邮件正文，并将读取结果交给所选模型。规则保存时固定当前邮箱和连接修订。换绑后编辑规则可建立新基线。每次采样最多读五页，每次触发最多包含 100 个新 ID。用 `routines history invoices` 查看基线、匹配与失败记录。 [源码与验收](superpowers/plans/2026-11-27-project-gmail.md)

在看板的 **分配助手** 选择同项目助手与修订。终端工作项 JSON 可带 `"assignee": { "id": "助手ID", "revision": 1 }`，用 `null` 清空。由用户发起工作项运行后，Pi 使用所选角色准备并等待原确认。角色更新后，新运行需要重新选择当前版本，已有运行按原版本处理。

配对手机获得查看后，本机可用 `work-items share-edits 工作项ID 账户ID 设备ID` 开启该卡的 **Edit work item**。手机保存名称、说明、状态、优先级、截止日期或时刻及其时区。旧修订出现冲突时可保留草稿，选择 **Load current fields** 读取最新字段。用 `work-items unshare-edits` 撤回编辑。 [分配与手机编辑验收](superpowers/plans/2026-11-26-work-item-assignees.md)

工作项保存项目范围、标题、目标和修订号。用一个工作项可以多次执行同一个项目任务，每次运行记录启动时采用的修订，原任务可以继续接回。`item.json` 包含 `workspace`、`title` 和 `objective`。编辑时用 `edit.json` 传入当前 `revision` 和要修改的字段。

```powershell
npm run harness -- work-items add item.json
npm run harness -- work-items list --workspace E:/project
npm run harness -- work-items board-link --workspace E:/project
npm run harness -- work-items edit 工作项ID edit.json
npm run harness -- work-items run 工作项ID 1 本次请求ID
npm run harness -- work-items runs 工作项ID
```

新运行先准备任务说明和预算。已有明确授权时可附加 `--yes`。断线后用同一请求 ID 和原修订重试，返回原任务。

在本机浏览器打开 `board-link` 返回的 URL，即可新建和编辑工作项、增减自定义列、调整列顺序。拖动卡片或在工作项内选择「移动到列」。移到已完成列会记录完成时间。链接在两分钟内可使用一次，页面刷新会沿用已打开的会话，重启服务后重新获取链接。

把工作项分享给指定配对设备后，手机可以在 **Shared work items** 查看当前目标、修订和原运行的状态。点击某次运行可展开它的原始目标、步骤和子任务问题。需要处理的运行排在前面。分享按工作项 ID 生效，包含后续修订和运行。撤销分享后，设备刷新时会移除该工作项。

```powershell
npm run harness -- work-items share 工作项ID 账户ID 设备ID
npm run harness -- work-items unshare 工作项ID 账户ID 设备ID
```

## 提醒与例行任务

新建的本机普通聊天可直接说“请在 2026 年 12 月 1 日纽约时间下午 5 点提醒我检查报告”，或“每周二纽约时间下午 5 点提醒我检查周报”。可以要求“改成每天 18 点，内容改为检查更新报告”，也可查看本项目提醒或取消。助手先读取机器时间和时区，时间不明确时会澄清；保存成功才表示提醒已建立。提醒只产生本机通知，不执行报告整理等工作，也不需要创建 Goal。

修改和取消核对原提醒 ID 与修订，保留历史和原补跑政策。聊天修改暂停提醒时保留暂停；暂停的周期提醒改为单次前，先从原管理入口明确恢复。修改请求中断后沿原请求重放，返回当次已应用的结果，不能覆盖后来的编辑；当前状态仍以再次查询提醒为准。同项目的子目录共用提醒范围。先前只有单次提醒工具的聊天保持原接口；远程私有会话和任务准备阶段不获得提醒管理工具。

原 `/remind` 和 JSON 管理入口继续可用。每日、每周保存明确时区与补跑政策：

```json
{
  "action": "task",
  "objective": "汇总这个项目的本周变更，输出 summary.md",
  "workspace": "E:/project",
  "schedule": {"kind":"weekly","weekday":5,"time":"17:00","timeZone":"America/New_York"},
  "missedPolicy": "run_once",
  "budgetPolicy": "pause",
  "notifyOnChange": true,
  "budget": {"maxEstimatedCostUsd":1,"maxDurationMs":180000,"maxTotalTokens":30000}
}
```

```powershell
npm run harness -- routines add routine.json
npm run harness -- routines list
npm run harness -- routines history 规则ID
npm run harness -- routines history 规则ID --task-status
npm run harness -- routines update 规则ID routine.json
npm run harness -- routines run 规则ID 本次请求ID
npm run harness -- routines pause 规则ID
npm run harness -- routines resume 规则ID
npm run harness -- routines cancel 规则ID
```

`weekday` 以周日为 0。周期规则默认跳过离线错过项，单次默认补跑一次。`run_once` 只补最新一项。每日与每周的夏令时缺失时刻顺延，重复时刻选第一次。`notifyOnChange` 比较已验收产物的哈希；相同产物不重复通知，失败和待答仍展示。规则中的 task 操作就是对该目标及预算的明确授权。

间隔规则可按固定起点每隔 5 到 1440 分钟运行。以下日间窗口左闭右开。间隔按实际经过时间计算，星期和窗口按已选时区过滤，`endsAt` 可省略。

```json
{"kind":"interval","anchorAt":"2026-12-01T09:00:00-05:00","everyMinutes":30,"timeZone":"America/New_York","weekdays":[1,2,3,4,5],"window":{"start":"09:00","end":"17:00"},"endsAt":"2026-12-31T17:00:00-05:00"}
```

Cron 规则使用五字段和显式 IANA 时区。下面的示例在每个工作日当地 09:15 执行。春季跳时中的匹配点顺延至有效时刻。回拨小时的发生点由表达式决定，例如每分钟规则可在两个重复小时中运行。

```json
{"kind":"cron","expression":"15 9 * * MON-FRI","timeZone":"America/New_York"}
```

暂停周期规则后，已经受理的任务仍可从原任务入口管理。恢复使用原规则和预算，从未来第一个有效时间点开始。暂停期间的时间点不会补跑。

手动运行沿用规则的预检和预算，发生项在历史中标为 `manual`，原定时点继续生效。若命令断线，使用相同的请求 ID 可查询原受理回执；省略 ID 会为本次命令生成新的 ID。

现有本地连接器可向 `POST /v1/routines/:id/events` 投递事件，使用 daemon 管理令牌鉴权。规则中的 `event` 设置来源、类型和字段匹配条件，例如 `{"source":"inventory","type":"item.changed","equals":{"warehouse":"east"}}`。投递数据为 `{"source":"inventory","type":"item.changed","eventId":"delivery-1","data":{"warehouse":"east"}}`。事件只触发规则保存的工作，不修改目标或预算。重投同一事件 ID 返回原回执，改动内容会报告冲突。

```powershell
npm run harness -- routines event 规则ID event.json
```

只由事件触发的规则使用 `"schedule":{"kind":"event"}`，并填写 `event` 过滤条件。这种规则没有下次定时时间，仍可手动运行、暂停和恢复。

可用 `routines github-sync` 同步公开 GitHub 仓库的新 Issue。先将这份规则保存为 `github-triage.json`，把 `owner/repo` 改成全小写仓库名，再添加规则。

```json
{
  "id": "github-triage",
  "action": "notify",
  "objective": "检查 GitHub 仓库的新 Issue",
  "schedule": {"kind": "event"},
  "event": {"source": "github", "type": "issues.opened", "equals": {"repository": "owner/repo"}}
}
```

```powershell
npm run harness -- routines add github-triage.json
npm run harness -- routines github-sync github-triage
```

在本机配置中加入 `"githubIssuePolling": ["github-triage"]` 并重启 daemon，即可在后台同步列出的启用规则。轮询间隔至少一分钟，遇限流会按 GitHub 返回的时间退避。暂停规则后停止轮询，恢复后从保存的游标继续。

可选的 `githubIssueTokenEnv` 填入环境变量名称。CLI 同步与后台轮询都用它读取当前 GitHub 凭据，并只发往固定的 GitHub API。留空时使用匿名事件流。

手动同步和后台轮询共用游标。首次同步记录最新事件，后续从旧到新处理。同步只提交事件 ID、仓库和 Issue 编号。回执丢失后，重试会按原事件 ID 查回同一次受理。GitHub 的公开事件流可能有延迟。若游标超出 GitHub 的事件保留窗口，报错并保留原游标。 [GitHub 事件接口](https://docs.github.com/en/rest/activity/events#list-repository-events)

有明确 `workspace` 的任务规则可添加 `"precheck": {"command":["node","checks/project-fingerprint.mjs"]}`。脚本在该目录中以本地用户权限运行，使用参数数组直接启动，时限为 30 秒。使用只读脚本，并向标准输出写出稳定的 UTF-8 检查结果。首次成功或输出的 SHA-256 变化会创建任务，输出相同的发生项记为 `skipped`。更新规则版本会重新建立基线。预检失败或中断会记录原因，当前发生项到此结束。`routines history` 可查看预检状态和成功样本的哈希。

周期任务可设置 `"overlapPolicy": "skip"`。如果同一规则版本的上一次任务仍在运行或等待处理，本次直接跳过。回执的 `blockedBy` 保存上一次发生项、任务 ID 和当时的状态。`--task-status` 按原任务 ID 查询当前状态，并在有值时显示待答问题、原因或交付摘要。若回执有关联 ID 但任务尚未建立，当前状态显示 `missing`。

列表的 `nextTiming` 显示计划本地时间、实际本地时间及夏令时调整说明；发生项回执保留已采用的调整。`history` 读取 Pi 的持久条目，保留旧规则版本的认领、失败、跳过和预算停止记录。`claimed` 表示已认领但尚无确认结果，不能当作任务已经启动或成功；取消/中断后应按 `taskId` 查询实际状态。任务产物和用量仍从原任务读取。更早版本只有最近回执，没有的历史不会被补造。

## 手机 Web 入口

```powershell
npm run harness -- remote pair owner phone
npm run harness -- remote list
npm run harness -- remote revoke owner phone
```

配对返回一次性展示的设备令牌，在 `/remote` 页面输入。设备只访问自己的会话；daemon 管理令牌不会提供给手机。每个会话使用独立工作区和项目边界。附件每条消息最多 4 个、每个 5 MiB，输入和下载核对 SHA-256。已受理消息通过原请求身份查询，中断状态保留原请求。

在本机把已有会话共享给某台配对设备后，手机的 **Shared threads** 可打开原会话、翻阅历史、看留言和下载已验收的交付。另行授予回复权限后，可以处理原会话中的结构化待答。授予控制权限后，可以审阅和确认待执行方案，也可以暂停、继续或取消原任务。手机继续使用原任务的剩余预算和截止时间。 [共享会话](superpowers/plans/2026-11-26-shared-thread-directory.md) · [控制验收](superpowers/plans/2026-11-26-shared-thread-controls.md)

```powershell
npm run harness -- remote share-thread 会话ID 账户ID 设备ID
npm run harness -- remote share-thread-replies 会话ID 账户ID 设备ID
npm run harness -- remote share-thread-controls 会话ID 账户ID 设备ID
npm run harness -- remote unshare-thread-controls 会话ID 账户ID 设备ID
npm run harness -- remote unshare-thread 会话ID 账户ID 设备ID
```

从 **Pending work** 直接打开本设备待处理的原会话。会话下拉列表也将待处理会话排在前面，并显示待答问题、等待原因和交付状态。连接、回到页面或点击 **Refresh** 都会更新列表。展开 **Task history** 可查看原会话中的请求补充、确认和交付阶段。

手机发起的任务经确认后可以在同一会话工作区内分派后台子任务。子任务提问时，可在原会话的问题卡中填写 **Answer** 并提交。页面轮询会保留当前输入。若回复回执丢失，可用 **Retry answer** 按原请求 ID 重试。答复进入提出问题的 Pi 子会话。

在原会话的任务卡点击 **Stop** 加子任务名称，再确认，可单独停止该子任务。停止决定在 daemon 重启后仍有效，同批其他子任务可继续交付。

后台子任务正在调用工具时，任务卡显示 **Interrupt** 加工具和子任务名称。点击后只中断选中的调用，子任务收到中断结果后可继续。若该调用已经结束，刷新后的任务卡会显示当前可用的操作。

打开会话时加载完整历史，之后使用 Pi 条目游标接收新增消息和进度，同时刷新任务状态和回执。临时断线后从最后收到的位置继续读取，切换会话或游标失效后重新同步。

任务卡提供 **Pause**、**Continue** 和 **Cancel task**。手机可在原时限和额度内继续由该手机暂停的任务。发送记录、任务身份和草稿在暂停和接回时保留。

支持 Web Locks 的浏览器会按配对和会话保存草稿。关闭页面后，用原配对令牌连接可恢复原文。待发记录保存原消息 ID 和已上传的附件引用，刷新后先查原回执。查不到回执时，可点击 **Retry send** 用原 ID 重发。未上传的本地文件需重新选择。附件过期时，原正文会回到输入框。

已发送的附件随原消息显示。支持的图片和文本可预览，原始文件可下载。预览和下载会校验原始文件的 SHA-256。每个会话最多保存 50 MiB 的附件原件。达到上限后可在新会话继续发送附件。

支持视觉输入的模型会收到附件中的图片。Pi 按模型的尺寸、Base64 字节数和张数限制处理图片，原件独立保留。模型不支持视觉或图片无法解码时，会在输入中说明，并提供已有的工作区文件路径。

手机首版提供工作区内的读取、写入、编辑、二进制复制和受相同限制的子会话。确认前只有只读工具。Shell、命令核验、现有 MCP、电脑工具、宿主 Skills 和本机全局记忆不会自动交给远程设备。这是工具权限边界；要开放完整宿主执行能力，需要另行选择现成隔离执行环境。未保存该权限策略的历史实验会话会被拒绝，需新建会话。

服务监听本机 `127.0.0.1`。真实手机访问时，将用户已有 HTTPS 代理的 canonical origin 写入 `remoteOrigin`，并让代理只转发 `/remote` 与 `/remote/*`。保持原始 Host；不要向手机暴露 `/v1` 管理 API。页面令牌存于 sessionStorage，恢复同一设备会话后继续原任务。

要在网页关闭后接收任务待答、子任务待答、确认或完成提醒，在同一份配置设置 `"remotePush": true` 并重启 daemon。手机配对后点击 **Enable task notifications**，再允许浏览器通知。iOS 需先把手机入口添加到主屏幕。通知仅展示通用提醒，点击后进入原设备会话。若浏览器未保留配对令牌，页面会先要求配对。可以在页面点击 **Disable task notifications**，本机也可撤销设备配对。

## 电脑接管与分工

```powershell
npm run harness -- computer status
npm run harness -- computer takeover
npm run harness -- computer return
```

未配置驱动时 status 显示 disabled。接管会立即阻止新动作并等待当前调用结束；`takingOver`、`busy` 和 `uncertain` 分别显示等待、当前操作及结果不明。回交或重连后重新获得租约并观察。

同一次租约取得更新的同类观察后，模型请求会省略已被替代的大段快照或截图图片。完整观察保留在 Pi 会话历史中。交互快照、完整快照和截图分别处理。

任务请你登录或验证时，在接回原任务的终端输入 `/sign-in 问题ID`。在能看到的原浏览器会话完成操作，然后用 `/signed-in 问题ID` 回交，或用 `/decline-sign-in 问题ID` 拒绝。后台重启后保留用户控制。回交后，原任务重新观察页面再继续。任务已放弃时，可用 `computer return` 交还控制权。密码与验证码请在浏览器中输入。 [实现与验收](superpowers/plans/2026-11-27-browser-sign-in-handoff.md)

首个真实驱动选择为已安装的 agent-browser 0.38.1，仅用于本地测试网页。它的原生 MCP 端点在本机调用超时，因此提供 `scripts/agent-browser-stdio.ts` 薄适配，仍由现成 CLI 执行浏览器操作。会话、页面和截图路径固定，不提供任意 JavaScript 或 Shell。当前 CLI 不支持安全传递以 `-` 开头的填写值，适配会明确拒绝。

```powershell
npm run test:computer:browser -- --command C:/path/to/agent-browser-win32-x64.exe
npm run test:computer:browser -- --live --command C:/path/to/agent-browser-win32-x64.exe
```

测试自建合成本地验证页和临时配置。第一条用脚本化模型驱动真实浏览器。第二条使用硅基流动，默认 DeepSeek-V3.2，凭据沿用前文的环境变量或终端无回显输入。独立操作端自动模拟用户接管和输入合成验证码。脚本强制中断并重连驱动，再让同一 Pi 任务经回交重新观察并交付 JSON。

每次运行在独立的 `.harness/computer-browser-…/result.json` 保存结果，终端输出该文件的路径。

任务状态与 `/v1/tasks/:id/view` 的 `delegations` 显示 Pi 子会话职责、状态、结果目录与用量。接回任务后，主 Agent 可通过 `task_status` 查询已有子任务和原结果。常规响应显示完整用户要求、待办和简要失败信息，完整确认说明与证据可按需读取。任务总用量已包含子会话。

已授权的本地任务可通过 `delegate_background` 启动一批子任务，收到回执后继续独立工作。子任务使用 Pi 原生本地文件和终端工具。结果就绪后，主会话会收到一次提示，读取结果后再交付。

主助手可调用 `delegate_send`，用 `childId` 和 `instructions` 给当前批次的原子会话补充指令。Pi 会在回合边界接收。若该子会话已在等用户答复，先处理答复，再接收补充指令。批次会等补充指令对应的结果，其他子任务可以继续工作。

后台子任务需要用户补充信息时，原任务会进入终端的 `/tasks pending` 列表。用 `/attach 任务ID` 查看问题，再用 `/reply-child 子会话ID 问题ID 答复` 将回复送回原子会话。其他子任务可以继续执行，主任务等待这一批结果再交付。

macOS 任务卡显示每个正在等答复的子任务。每条答复从对应问题下发送，提交失败时可在同一张卡重试。任务卡沿用原任务、子会话和问题 ID。

在运行中或子任务待答的任务卡上，打开 **子任务操作** 可停止单个子任务，或中断指定的工具调用。停止前会显示确认。工具调用结束后，任务卡会刷新可用操作。

在已接入的本地任务中用 `/children` 查看子会话 ID 与状态，或用 `/stop-child 子会话ID` 停止其中一个后台子任务。此前写入的文件仍可检查，同批其他子任务继续运行。重启会完成已经保存的停止操作。

`/interrupt-child 子会话ID` 中断该子会话当前正在运行的工具。子任务收到工具中止结果后继续工作。若工具仍在退出，终端会提示中断尚未确认。

## 验证

```powershell
npm run test:assistant
npm run typecheck
npm run build
npm run check:commit
npm run test:live:assistant:tools
npm run test:live:assistant:memory
node --import tsx scripts/live-assistant-capture.ts --live
```

在线脚本使用合成数据，可在终端无回显输入硅基流动凭据。`SILICONFLOW_MODEL` 可以指定账户目录实际提供的模型；在线验证的临时目录和失败尝试均与用户项目分开。独立断言核对工具次数、产物字节、记忆引用和实际执行记录。小模型的复杂工具执行失败保留在实验记录中，测试通过不代表长期任务完成率或成本已经改善。

全量测试逐文件执行，保留进程隔离，减少 SQLite、子进程恢复与短计时场景之间的资源争用。Windows 若 `python3` 是商店占位命令，先将 `CASE_PYTHON` 指向已安装的实际 Python 3.12；无需修改系统权限。Office 案例依赖 `scripts/cases/requirements.txt`。
