# 命名助手、角色版本与 Pi 工具范围

状态：角色目录、原 chat/run 入口及固定范围已实现，聚焦、全量和真实模型验收通过。独立审查另行记录，不把一次性 workers 当成固定助手，也不把本机目录称为完整 Bot 产品。[实施计划](../superpowers/plans/2026-11-26-named-assistants.md)

## 逐项源码参考

| 能力 | 已核对的固定实现 | 本项目落点 |
| --- | --- | --- |
| 创建角色及独立身份 | [OpenMausBot create_bot 的实际请求与结果处理](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L511)、[创建路由写入 soul/modelSelection/toolScope](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/bots-create.ts#L212) | 先保存具名项目配置，用户选定后由现有 Pi 建立会话；配置保存本身不启动工作。 |
| 创建重放及来源 | [Rakazo spawnBot 的 spawnKey 回执与可选初始工作](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/child-bots.ts#L64)、[createBot 事务建立 Bot/Thread/Memory](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/bots/bot-repository.ts#L429) | 配置 ID、修订与使用它的原任务分开；不复制对方数据库、机器或队列。模型管理角色的幂等创建后续接原 Pi taskId，不能随机生成重复角色。 |
| 版本检查与后续模型 | [Rakazo setChildInstructions 的版本再次检查](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/fleet-tools.ts#L837)、[模型选择实际校验](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/own-bot-settings.ts#L271)；[OpenMausBot 设置快照及既有线程](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/team-setup-requests.ts#L147) | 新工作引用明确修订，原任务保存完整必要快照；编辑目录不替换旧会话的角色、模型或工具范围。 |
| 默认工具继承 | [Rakazo 创建时继承模型与 disabledBuiltinTools](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/bots/bot-repository.ts#L468) | 角色只能在原任务可用范围内收窄能力；不能通过角色配置启用未授权 MCP、电脑或远程工具。 |

以上检查了实际调用、持久创建和更新代码。OpenMausBot 本地另一个 clone 为 ad27f071，与固定 3aec210054cd 不同，因此本轮使用固定版本原文，没有把两个版本混为一个证据。

## Pi 1.4.0 边界与实验

Pi 已公开每会话 `configure()`、`tools`、`modelTools`、固定指令、模型与 task ownership。任务拥有的子会话复制父会话配置；本项目后台分工另显式指定 tools，因此不能只收窄主会话。[Pi 已安装版本](../../package.json) · [现有后台配置](../../src/delegation.ts)

真实原生 Pi 与脚本化模型的五个用例确认：仅设置 modelTools 仍可通过嵌套工具产生副作用；tools 选择可阻止已禁用嵌套工具；原工具的 `control.addTools` 又能扩大实际 tools；固定 `ToolTask.beforeTool` 允许表分别阻止嵌套及加载后的越界动作。源码 README/types 与实际实验一致。故产品接入须同时控制可见工具、可用工具和每次实际执行，不能把 modelTools 当授权边界。[可复现测试](../../test/pi-tool-scope.test.ts) · [实验结果](../experiments/2026-11-26-pi-tool-scope.json)

该原生实验只证明 Pi 的边界；产品接入另由助手服务、策略、原运行、入口及强杀恢复测试验证，不能用原生实验替代。

## 首个完整产品路径

用户在现有项目中创建“研究员”等具名配置，明确指令、模型与工具名称；通过 `chat --assistant ID@REVISION` 或 `run --assistant ID@REVISION` 开始工作。复用原聊天转 Goal、预算、确认、执行、恢复与交付。CLI 和 owner API 先承担配置管理，模型自行创建/修改角色和跨助手交接继续单独补齐。

- 记录：id、project、name、description、instructions、model（明确 ModelRef 或 null 表示使用当前项目模型）、tools（明确名称数组）、revision、archived、createdAt、updatedAt。项目由现有 memoryProject 规范化；同项目名称规范化后不可重复。工具数组不接受通配符；空数组表示无额外动作工具。
- name 为 1–80 字符的单行标签，拒绝终端控制字符；description 最多 1,000，instructions 为 1–16,000 非空字符，拒绝 NUL，指令字符串保留原空白和 Unicode 码点。工具名最多 128 个、每个 256 字符且不重复。输入拒绝未知字段。模型引用沿原已安装目录校验，不存凭据或自动换供应商。
- 更新要求当前 revision，仅修改提供的字段。归档阻止新选择，不删除历史或偷偷取消既有任务；现有任务管理入口负责暂停/取消。目录先用现有原子 JSON 与单 daemon 队列，不加数据库/调度器。
- 新任务核对原项目、ID、修订、未归档状态及模型可用性，再保存完整必要角色快照与解析后的模型；实际工具取原阶段与角色名单的交集，不存在或未授权者不会因列入角色而启用。版本变化明确冲突，不能自动追随最新版本。已接回任务不接受换角色参数，普通消息不修改角色配置。
- 普通默认任务、远程、工作项与例行任务不自动附加角色。共享查看不获得角色编辑权。首项不提供角色专属秘密库、系统沙箱、独立电脑或完整团队状态。

## 工具与验证范围

动作工具只能取原任务当前阶段/权限允许工具与固定角色名单的交集。Goal 和待答所需的少量控制工具由宿主明确维护；这些工具不能借模型参数扩大执行范围。角色指令作为原 Pi 的固定 section/指令配置，基础用户要求及授权规则保留。

主任务、同步/后台子任务以及嵌套调用必须使用同一个固定允许表，重启、压缩、角色编辑、MCP 按需加载和阶段切换均不能放宽。实际 gate 随原角色快照注册，不在调用时读取可变的最新目录。afterTool 在 Pi 提交 control.addTools 前过滤越界名称，beforeTool 仍逐次检查执行。后台 createChild 的显式 tools 取交集并保留角色策略，不能覆盖父范围。

已核对当前 acceptance 和 task_plan 的 CheckSchema：它们只接受机械文件检查，本来就没有 command 类型，因此不增加虚构的命令分支。真实命令入口是 task_prepare 的 criterion.verification 和 task_verify，后者再调用原 Pi bash。角色未允许 bash 时拒绝命令核验说明及 task_verify，嵌套 bash 也受同一允许表约束。Goal 的其他少量控制保留，已有普通任务语义不变。

MCP 名称按实际注册名取交集，只使用原任务的 mcpPins；角色明确选择的 schema 可通过原生 modelTools 直接提供，即使原目录超过 20 个工具。目录中的其他工具仍不启用，角色名单不会配置新连接、变更授权或选择其他渠道。

工具名称限制保留现有本机执行权限，不构成操作系统沙箱。获准的 bash、脚本或电脑工具仍具有各自原有能力；不能把只设 cwd 说成文件隔离。独立模型、工作目录及完整 Bot 私有记忆属于后续明确扩展，不能从角色字段推断已具备。

## 接口与实施验收

owner：GET/POST `/v1/assistants`（GET 用 workspace 查询，POST 带 workspace 和完整定义）；GET/PATCH `/v1/assistants/:id`。PATCH 不能移动项目，保留原数据。CLI：`assistants list --workspace`、`assistants add 文件.json`、`assistants show ID`、`assistants edit ID 文件.json`。复用已有 JSON 请求、错误与 daemon 认证，不新增并行配置入口。

任务创建/普通聊天传 `{ assistant: { id, revision } }`，由原 Runtime.create 解析和固定；TaskMeta/状态展示名称与修订，终端接回时可识别所用角色。新 CLI 参数只用于新会话，不能改变接回的原任务。现有无参数调用保持。

角色请求先要求 daemon 的 named-assistants capability；同版本旧进程若只支持普通聊天，客户端在发任务前报错，避免忽略未知 assistant 字段后执行成普通任务。原消息入口拒绝 assistant 字段，不能借追加消息换角色。

- [x] 目录创建/查询/修订/归档/重启，旧文件缺失正常为空，损坏数据报错不清空；跨项目、重复名称、未知模型和无效定义不改文件。
- [x] 新聊天收到正确指令/模型，普通回复无 Goal；后续明确任务沿原确认执行。配置编辑后旧任务与已拥有子会话保持原模型/指令/工具，新任务明确使用新修订。
- [x] 读角色不能直接 write/bash，嵌套工具、按需加载和后台子任务不扩大范围；未允许的 Skills 等动作同样逐次检查，命令核验经真实 bash 入口拒绝。有副作用标记的失败用例覆盖边界，不能只看 schema。
- [x] 允许的工具仍可完成真实执行与交付；宿主必要 Goal/待答控制、预算与恢复继续有效，拒绝的工具不变成默认成功。
- [x] 角色保存不启动任务；原角色选定后的普通多轮、执行确认、CLI/owner、SIGKILL、压缩及旧任务兼容通过。实际模型用合成角色/文件验证，不据少量样本声称净收益。
- [x] 更新能力矩阵、使用说明和架构笔记；聚焦/全量、类型/构建通过，提交检查和审查收尾。集成策略为 Fork 提交，无上游 PR；无法完成的独立审查或目标设备验收继续明确记录。

完整会话归档/重开、模型聊天内修改、助手间持久交接、角色任务看板、私有记忆/电脑、团队和语音仍按原能力矩阵推进；首项交付不等于整个 Bot 产品对齐。

## 验收记录

聚焦 25 项通过，全量 528 项中 524 通过、4 项可选 Office 跳过；类型/构建通过。后台待答后修改目录并重启，原子会话继续原范围；两个实际 SIGKILL 场景和原生压缩均保留原快照。MCP 用合成真实 stdio 连接验证 21 项只提供并调用角色允许项。角色模型用于主会话；子任务沿原 TaskMeta 固定的 worker 模型（若有），否则由 Pi 复制父配置。

DeepSeek V3.2 的首轮模型提议 30 秒执行预算，确认后因可选计划/进度调用到限，未写文件；安全边界没有被扩大。第二轮明确使用 180 秒、100,000 token、配置费用上限 1 并跳过可选计划，通过旧 v1/新 v2、原确认、写入一次、精确字节及实际模型上下文检查。首轮 6 次、第二轮 6 次，合计 12 次请求与 41,924 已知 token，金额及被中断请求费用未知。[失败记录](../experiments/2026-11-26-named-assistant-deepseek-attempt-1.json) · [通过记录](../experiments/2026-11-26-named-assistant-deepseek.json)

独立审查针对不可变提交 `879af23`。临时扫描器来自 TruffleHog 官方 3.100.1，归档 SHA-256 与官方清单一致；Windows 本地读取的 atime 误判通过支持的 commit 模式避免，扫描器的 Windows drive URI 由薄适配只转换拼写，保留全部扫描参数和退出码。凭据扫描通过（27.1 秒）。审查模型随后因未携带认证访问 Responses API 返回 401，进程已结束，未产生代码审查结论；不修改安全检查或既有认证配置，不声称独立审查通过。[收尾记录](../experiments/2026-11-26-named-assistant-review.json)
