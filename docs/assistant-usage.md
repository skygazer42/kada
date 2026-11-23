# 个人助手使用入口

实现范围和逐功能参考代码见[功能 Spec](specs/2026-11-23-personal-assistant.md)。当前通过 Fork 功能分支迭代。真实电脑驱动保持关闭，跨设备访问需要现成 HTTPS 代理。

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

## 模型与方法

密钥通过供应商环境变量或 Pi 已有认证设置。硅基流动使用 `SILICONFLOW_API_KEY`，凭据不写入任务配置。

```powershell
npm run harness -- model list siliconflow
npm run harness -- model check siliconflow Qwen/Qwen2.5-7B-Instruct
npm run harness -- model select siliconflow Qwen/Qwen2.5-7B-Instruct
npm run harness -- model check siliconflow deepseek-ai/DeepSeek-V3.2
npm run harness -- model select siliconflow deepseek-ai/DeepSeek-V3.2
npm run harness -- skills list --workspace E:/project
npm run harness -- skills disable 方法名 --workspace E:/project
npm run harness -- skills enable 方法名 --workspace E:/project
npm run harness -- run "目标" --workspace E:/project --skills 方法名
npm run harness -- skills capture 任务ID 已核验的Skill目录
npm run harness -- skills rollback 方法名 版本
```

新任务采用当前模型，原任务保留保存的模型及方法版本。`--skills ""` 显式不选择方法。方法目录按项目、已发现的用户方法、内置方法、本地试用处理同名优先级。停用和固定版本使用同一目录，新任务不再通过原始发现目录绕过选择。读取方法与真实运行脚本分别记录，脚本通过 Pi 原生 bash 执行。

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
```

发现工具不授予执行权限。用户启用后，新任务固定该版本和所选工具；连接或工具定义变化使旧测试失效。禁用会停止当前连接调用。凭据映射填写环境变量名称，服务状态不返回认证值。

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
npm run harness -- routines update 规则ID routine.json
npm run harness -- routines cancel 规则ID
```

`weekday` 以周日为 0。每日/每周默认跳过离线错过项，单次默认补跑一次。`run_once` 只补最新一项。夏令时缺失时刻顺延，重复时刻选第一次。`notifyOnChange` 比较已验收产物的哈希；相同产物不重复通知，失败和待答仍展示。规则中的 task 操作就是对该目标及预算的明确授权。

列表的 `nextTiming` 显示计划本地时间、实际本地时间及夏令时调整说明；发生项回执保留已采用的调整。`history` 读取 Pi 的持久条目，保留旧规则版本的认领、失败、跳过和预算停止记录。`claimed` 表示已认领但尚无确认结果，不能当作任务已经启动或成功；取消/中断后应按 `taskId` 查询实际状态。任务产物和用量仍从原任务读取。更早版本只有最近回执，没有的历史不会被补造。

## 手机 Web 入口

```powershell
npm run harness -- remote pair owner phone
npm run harness -- remote list
npm run harness -- remote revoke owner phone
```

配对返回一次性展示的设备令牌，在 `/remote` 页面输入。设备只访问自己的会话；daemon 管理令牌不会提供给手机。每个会话使用独立工作区和项目边界。附件每条消息最多 4 个、每个 5 MiB，输入和下载核对 SHA-256。已受理消息通过原请求身份查询，中断状态保留原请求。

手机首版提供工作区内的读取、写入、编辑、二进制复制和受相同限制的子会话。确认前只有只读工具。Shell、命令核验、现有 MCP、电脑工具、宿主 Skills 和本机全局记忆不会自动交给远程设备。这是工具权限边界；要开放完整宿主执行能力，需要另行选择现成隔离执行环境。未保存该权限策略的历史实验会话会被拒绝，需新建会话。

服务监听本机 `127.0.0.1`。真实手机访问时，将用户已有 HTTPS 代理的 canonical origin 写入 `remoteOrigin`，并让代理只转发 `/remote` 与 `/remote/*`。保持原始 Host；不要向手机暴露 `/v1` 管理 API。页面令牌存于 sessionStorage，恢复同一设备会话后继续原任务。

## 电脑接管与分工

```powershell
npm run harness -- computer status
npm run harness -- computer takeover
npm run harness -- computer return
```

未选驱动时 status 显示 disabled。接管会立即阻止新动作并等待当前调用结束；`takingOver`、`busy` 和 `uncertain` 分别显示等待、当前操作及结果不明。回交或重连后重新获得租约并观察。真实驱动选型与 U02 保持待办。

任务状态与 `/v1/tasks/:id/view` 的 `delegations` 显示按需创建的 Pi 子会话职责、状态、结果目录与用量。父任务取消会终止所属工作，子任务无法提交父目标。任务总用量已经包含子会话，无需再次累加。

## 验证

```powershell
npm run test:assistant
npm run typecheck
npm run build
npm run check:commit
npm run test:live:assistant:tools
npm run test:live:assistant:memory
```

在线脚本使用合成数据，可在终端无回显输入硅基流动凭据。`SILICONFLOW_MODEL` 可以指定账户目录实际提供的模型；在线验证的临时目录和失败尝试均与用户项目分开。独立断言核对工具次数、产物字节、记忆引用和实际执行记录。小模型的复杂工具执行失败保留在实验记录中，测试通过不代表长期任务完成率或成本已经改善。
