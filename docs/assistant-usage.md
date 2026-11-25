# 个人助手使用入口

实现范围和逐功能参考代码见[功能 Spec](specs/2026-11-23-personal-assistant.md)。当前通过 Fork 功能分支迭代。用户已选择 agent-browser 验证本地网页；日常配置仍按需启用，跨设备访问需要现成 HTTPS 代理。

## 终端与交接

运行 `npm run chat`。普通问答直接回复；交付请求先展示任务说明、核验方式和预算，确认后执行。

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

## 模型与方法

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

工作项保存项目范围、标题、目标和修订号。用一个工作项可以多次执行同一个项目任务，每次运行记录启动时采用的修订，原任务可以继续接回。`item.json` 包含 `workspace`、`title` 和 `objective`。编辑时用 `edit.json` 传入当前 `revision` 和要修改的字段。

```powershell
npm run harness -- work-items add item.json
npm run harness -- work-items list --workspace E:/project
npm run harness -- work-items edit 工作项ID edit.json
npm run harness -- work-items run 工作项ID 1 本次请求ID
npm run harness -- work-items runs 工作项ID
```

新运行先准备任务说明和预算。已有明确授权时可附加 `--yes`。断线后用同一请求 ID 和原修订重试，返回原任务。

## 提醒与例行任务

单次提醒可直接用聊天 `/remind`，规则可通过 JSON 管理。每日、每周保存明确时区与补跑政策：

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

首个真实驱动选择为已安装的 agent-browser 0.38.1，仅用于本地测试网页。它的原生 MCP 端点在本机调用超时，因此提供 `scripts/agent-browser-stdio.ts` 薄适配，仍由现成 CLI 执行浏览器操作。会话、页面和截图路径固定，不提供任意 JavaScript 或 Shell。当前 CLI 不支持安全传递以 `-` 开头的填写值，适配会明确拒绝。

```powershell
npm run test:computer:browser -- --command C:/path/to/agent-browser-win32-x64.exe
npm run test:computer:browser -- --live --command C:/path/to/agent-browser-win32-x64.exe
```

测试自建合成本地页面和临时配置，不改日常 daemon。第一条用脚本化模型驱动真实浏览器；第二条使用硅基流动，默认 DeepSeek-V3.2，凭据沿用前文的环境变量或终端无回显输入。验证会调用原接管 API、通过独立操作端修改页面、强制中断并重连驱动，然后让同一 Pi 任务重新观察并交付 JSON。这里的操作端由测试自动模拟，并非人工操作记录。

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
