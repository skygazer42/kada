# 项目任务目录实现计划

> 执行方式：在当前 Fork 功能分支内使用 superpowers:executing-plans；沿用用户要求持续研究并实现的授权，不另开会话。

**目标：** 用户在普通聊天询问项目任务时，助手从原任务查询当前状态、待答和交付摘要。

**架构：** Pi 1.4.0 `defineExtension/defineTool` 注册 replay-safe 的只读工具，复用原 `metadataList`、`status` 与 `taskHandoff`，不新增索引、数据库、执行或持久状态。新本机主会话固定工具能力，历史任务、远程私有会话与子任务不扩权。

**技术：** 现有 TypeScript、Node.js、Pi 1.4.0。当前为 `codex/assistant-plan`，不创建上游 PR。

**Spec：** [能力核对表 P0 任务目录](../../specs/2026-11-25-reference-capability-matrix.md)。参考 [OpenMausBot list_threads](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L236)、[Rakazo 原目录聚合](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/task-catalog.ts#L22)，独立实现项目内运行查询；工作项/规则/Skills 的综合目录仍是后续工作。

## 契约与范围

- 新本机任务保存 `projectTaskCatalog: true`；未保存该标记、远程或子会话不可调用。仅主会话注册，聊天转入 Goal 后保留。
- `project_tasks` 参数为可选 `filter`（all/running/pending/delivered）、`limit`（1–50，默认 20）、`offset`（非负安全整数，默认 0）。未知字段、无效筛选和分页参数明确拒绝。
- `LocalRuntime.projectTasks(callerId, filter, limit, offset)` 从调用任务已有工作区取得 `memoryProject`；同项目子目录归一。排除调用者、远程私有会话及其他项目，再读原状态，不先查询全部项目。
- 返回 `tasks`、`total`、`nextOffset`；待处理优先，然后原创建时间降序、ID 决胜。每项仅返回 ID、创建时间、状态/分组、目标（至多 500 字）、摘要（500）、问题（1,000）、步骤（200）和截断标志。不读取认证配置、工具参数或产物正文；用户写入目标/问题的文本仍属于用户数据。需要原讨论时另用 history 工具。
- 查询不提交输入、不启动/恢复/取消旧工作、不改预算或创建 Goal。状态读取沿用 owner 列表路径；历史存储损坏时报错，不能静默当空目录。分页为每次查询的当前视图，不是跨页事务快照。
- 原 `status()` 自己进入状态队列，目录不能在同一个队列内部再等它，避免嵌套等待。

## 文件与验证

修改 `src/runtime.ts` 的元数据、受理快照及主会话扩展；新增 `src/project-tasks.ts` 的薄工具。测试 `test/project-tasks.test.ts`；真实模型沿用 `scripts/live-assistant-memory.ts`。更新增量 Spec、使用文档和原个人助手架构笔记。

- [x] 写并观察失败：同项目过滤/子目录、待处理优先/分页、范围边界和无效输入。
- [x] 注册工具并接原状态投影；验证普通聊天调用无 Goal、查询没有新模型调用或重启旧工作。
- [x] 验证历史/远程/同步与后台子任务工具范围、重启后原权限和状态；覆盖大量摘要截断与损坏状态报错。
- [x] 硅基流动真实模型询问当前项目待处理任务，核对原 ID/问题和请求数；保存证据。
- [x] 相关回归、类型/构建、提交候选、笔记检查，记录审查限制；提交推送 Fork。

## 取舍

复用 owner `list()` 最短，但它先读取所有项目完整状态，范围过滤发生太迟；目录先筛元数据再按原 `status()` 读状态。直接按任务元数据推测运行状态省读取，但会遗漏 Pi 子任务待答、预算及原交付，因此不采用。大历史性能尚未量化；只有测到瓶颈再引入派生索引。

## 验证记录

前四个测试在工具不存在时失败，首次 green 另暴露夹具将成功标志 false 误写为 undefined，以及后台夹具未等待原结果通知的问题；按 Pi 现有契约修正夹具，生产实现未为此增加行为。最终 6 项聚焦测试通过，包括拒绝额外 workspace 参数，以及同一聊天确认 Goal 后继续使用工具。52 项相关回归通过；该次运行包含前 5 项，新增第 6 项随后单独通过。此前提醒提交的全量为 436 通过、4 个可选 Office 跳过，不能把该全量数字当成本轮最终版本结果。

DeepSeek V3.2 经硅基流动用 4 次请求、20,844 总 token 查询原任务 ID 和 CSV/XLSX 待答；daemon 重启未发新模型请求、原任务仍 waiting_user、查询无 Goal、其他项目排除。[实测证据](../../experiments/2026-11-25-project-tasks-deepseek.json)。金额未知，未声称完成率或成本改善。

## 综合目录

Rakazo 的 `taskCatalogFromTool` 分别从清单、日程和 Skill 的原存储读取投影。Kada 的新本机普通聊天增加 `project_catalog`，返回当前项目的原运行、未完成待办、活动规则和可用 Skills。默认返回各类首页，也可指定一类继续分页。条目保留原 ID 或 Skill 版本、简要状态和下一页位置。[Rakazo 聚合调用](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/task-catalog.ts#L22)

查询使用聊天创建时保存的项目范围。运行复用 `project_tasks` 的待处理排序和隔离，待办复用 `WorkItems.list`，规则只给出运行状态、类型和下次触发时间，Skills 复用当前项目可见目录并显示版本。用户从原入口管理这些条目，每次读取按当前保存状态取页。[运行查询](../../../src/project-tasks.ts) · [待办](../../../src/work-items.ts) · [规则](../../../src/routines.ts) · [Skills](../../../src/skills.ts)

验收使用普通聊天发出实际 Pi 工具调用。数据包含同项目和其他项目、远程任务、归档待办、无项目规则及带预检参数的规则。核对原 ID、下一页、原任务状态、无新增 Goal 或模型请求，以及旧聊天、远程和确认后的工具范围。[目录回归](../../../test/project-catalog.test.ts)

DeepSeek V3.2 的最终验收以 3 次请求读到四类原记录，排除另一项目，完成中文答复，查询前后的待办修订一致。首轮模型选择了运行一类，后续生成在测试时限内仍未返回。工具说明和复测提示补充了空参数组合查询方式，两次结果均保留。[硅基流动验收](../../experiments/2026-11-26-project-catalog-deepseek.json)

类型、构建、提交候选、diff 空白及三项笔记校验通过。独立审查命令为 `python <autoreview>/scripts/autoreview --mode local --no-tools --no-web-search --output <临时目录文件>`；因缺少 TruffleHog 在调用 reviewer 前退出，没有独立审查结论。此次没有新增运行时依赖或自动安装审查工具。

## 200 条历史任务验证

OpenMausBot 的内部列表用任务记录与当前等待状态生成简要行，再按页返回。Kada 的列表沿用 Pi 原状态和现有交接摘要。已关闭的会话只打开 Pi Session 读取必要的状态，读取后关闭。完整任务详情仍按原入口读取。 [OpenMausBot 内部任务列表](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/internal-threads.ts#L45) · [Kada 状态读取](../../../src/runtime.ts) · [回归](../../../test/project-tasks.test.ts)

Windows 上对比 `dae579f` 和新读取路径。每侧创建相同的 200 条已答复合成任务，启动新的本机 runtime，连续读取每页 5 条、偏移量为 0、5、100 的结果。两侧的任务总数与分页位置正确。记录各一次。

| 读取方式 | 首页耗时 | 后续两页耗时 | 三页后仍打开的会话 | 三页后进程 RSS |
| --- | ---: | ---: | ---: | ---: |
| `dae579f` 完整详情 | 7.37 秒 | 1.52 秒、1.56 秒 | 200 | 337 MiB |
| Pi Session 读取状态 | 4.31 秒 | 3.18 秒、2.03 秒 | 0 | 294 MiB |

每页仍需读取同项目状态才能按当前待答排序并返回总数。连续翻页会重复这项读取。数据库回归核对读取前后的已保存会话字节、原待答和模型请求次数。

已答复或完成且已关闭的任务可复用内存摘要。宿主核对原任务元数据、SQLite 和 WAL 的文件版本。打开原任务或存储变化时重新读取。回归验证翻页复用已关闭任务，以及替换为损坏数据库时仍报告错误。 [任务目录实现](../../../src/runtime.ts) · [回归](../../../test/project-tasks.test.ts)

在整仓与定向测试退出后，用相同的 Windows 200 条已答复任务各测一次。对照版本的首页、第二页和偏移量 100 分别用 3.25、3.80、3.81 秒。缓存版本分别用 3.83、0.38、0.34 秒。两次均未保留历史会话。读取三页后进程 RSS 分别为 174 MiB 和 283 MiB。首页仍需读取全部匹配状态，缓存版本在此次测量中换得了更快的后续翻页。
