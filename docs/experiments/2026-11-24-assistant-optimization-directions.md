# Kada 下一轮优化方向

本次对照以 Kada `18485b1` 为基线，查阅了上一轮的固定源码快照、两次硅基流动交接会话及本地回归。优先级按对完整交付、重复操作和日常使用的影响排序。先解决已经复现的交付问题，再分别衡量上下文和操作体验的收益。 [上一轮开发计划](../superpowers/plans/2026-11-23-personal-assistant.md) · [当前产品约束](../../AGENTS.md)

## 证据

| 交接场景 | 原生 Pi | Kada |
| --- | ---: | ---: |
| 首次模型请求总用量 | 1,212 token | 4,147 token |
| 首次请求可见工具 | 4 个 | 13 个 |
| 首次工具定义序列化大小 | 2,720 字节 | 9,654 字节 |
| 模型请求数 | 8 | 12 |
| 累计 token | 13,178 | 60,101 |
| 其中缓存读取 | 0 | 52,736 |
| 独立交付检查 | 已交付 | 正确 JSON，提交前耗尽预算 |

两列来自同一次合成日报复测。工具大小来自保存的 Pi 记录，按 JSON 的 UTF-8 编码计量。首次请求均无缓存，两侧均未压缩。复测按 Pi、Kada 的固定顺序进行。实际费用未知，表中累计 token 用来说明预算压力。 [配对复测](2026-11-23-memory-handoff-comparison-retest.json)

前一轮的 Kada 会话有另一条失败路径。原任务已经保存了成功的 `task_submit` 和 `submitted` 候选，随后记录预算耗尽，机械验收尚未执行。在当前代码上用脚本化模型做了本地复现。一个已存在并符合断言的 JSON 经一次请求提交，Pi 保存候选，Kada 返回 `budget_limited`，机械验收字段为空。 [首轮配对记录](2026-11-23-memory-handoff-comparison.json) · [当前监督逻辑](../../src/runtime.ts#L589)

## P0 · 确定性验收已提交的结果

让监督循环和重启入口共用一条结算路径。对当前修订已经提交、Pi 已结清本轮且仍在执行时限内的候选，金额或 token 预算到限时允许完成已有的本地校验。通过按原规则交付。检查失败则保留候选和检查报告，状态为预算到限，等待用户补充额度后再返工。需要独立模型评审的任务继续等待评审预算。Suparagent 在重试前查询已经成功落库的回合并阻止重复启动，提供了先查持久结果的参考。 [Suparagent 重试前核对](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/notices.py#L437) · [Kada 重启](../../src/runtime.ts#L430) · [Kada 机械验收](../../src/runtime.ts#L633)

验收覆盖最后一次模型请求到限、有效候选与失效证明、无候选、需模型评审、暂停与取消，以及 Pi 落库本轮终态后、Kada 结算前强杀再接回。有效结果只交付和通知一次，新增模型请求为零。

本轮已实现预算到限时的机械验收。强杀测试在 Pi 记录本轮终态后停止进程，恢复沿用任务、提交和候选的原 ID，只记一次完成事件，模型调用为零。失败候选的检查报告可查，到限时不启动返工。 [监督循环](../../src/runtime.ts#L596) · [强杀回归](../../test/supervision-recovery.test.ts#L33)

## P1 · 缩小首轮工具集合和提示

按当前阶段与已授权能力构造 Pi 的模型可见工具集。第一小步是有固定 Skill 的任务才展示 `run_skill_script`。然后精简重复的交付提示，保留原确认标准、用户补充及证据要求。Rakazo 为当前运行按触发来源、记忆和桌面能力选择工具，Pi 已提供 `modelTools`。工具权限由现有入口检查。 [Rakazo 工具选择](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-assembly-capabilities.ts#L734) · [Kada 扩展装配](../../src/runtime.ts#L390) · [Pi 可见工具](https://github.com/earendil-works/pi/blob/v1.4.0/packages/durable/README.md#who-may-call-a-tool)

回归覆盖确认前后的工具可见性、重启恢复和固定 Skill 的执行。此前脚本向模型展示 Bash 和编辑工具，再在调用时拒绝。此次对照让原生 Pi、冻结版 Kada 和新版 Kada 使用相同的原生读写范围，并轮换运行顺序。先判定完整交付，再比较请求数、输入和缓存读写用量。 [对照工具范围](../../scripts/compare-assistant-handoff.ts#L147)

本轮已接入 Pi 的工具过滤和较短的执行提示。对照脚本在三组请求中都核对原生工具仅包含 `read`、`write`，并保留文件范围检查。脚本用 `--arm=pi` 或 `--arm=kada` 单独运行指定组。冻结组使用 `18485b1` 源码和同一份对照脚本。 [对照脚本](../../scripts/compare-assistant-handoff.ts)

两轮使用硅基流动 DeepSeek-V3.2 和同一份合成日报，累计 token 上限均为 60,000，每组最多 18 次请求、180 秒。表格按实际运行顺序列出结果。工具定义大小来自发给供应商的首个请求。六次都写出了正确的 JSON，终态到限的两次都没走完交付。第一轮的新版提示随后补回了等待用户与正式提交的指令，第二轮使用最终提示。

| 轮次与方案 | 完整交付 | 请求数 | 首轮工具 / 字节 | 非缓存输入 | 输出 | 缓存读取 | 累计 token |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 · Pi | 通过 | 6 | 2 / 1,112 | 6,129 | 665 | 0 | 6,794 |
| 1 · 冻结 Kada | 通过 | 9 | 11 / 8,325 | 5,151 | 957 | 32,384 | 38,492 |
| 1 · 优化初稿 | 到限 | 14 | 10 / 7,867 | 6,039 | 1,195 | 56,192 | 63,426 |
| 2 · 最终版 | 通过 | 10 | 10 / 7,867 | 5,456 | 1,313 | 37,248 | 44,017 |
| 2 · 冻结 Kada | 到限 | 13 | 11 / 8,325 | 6,211 | 1,164 | 52,736 | 60,111 |
| 2 · Pi | 通过 | 8 | 2 / 1,112 | 8,902 | 748 | 0 | 9,650 |

六次的缓存写入均为零，实际账单未知。新版请求少发送一个工具定义和 458 字节。两轮只有一个最终版样本，完成率和累计费用的改善仍待验证。

## P1 · 精简恢复时的任务状态

把 `task_status` 的常规响应收敛到当前目标、完整用户要求、当前修订、待办步骤和失败摘要。冻结任务说明、确认标准编号和详细证据可按需查阅，恢复提示明确告诉模型怎么取回。OpenMausBot 的增量上下文完整保留尚未传递的用户指令和标记为关键的队友结果，Rakazo 的工作清单按预算呈现摘要。状态来自当前 Pi 文档和已经持久化的子任务记录。 [OpenMausBot 增量上下文](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/delta-context.ts#L89) · [Rakazo 工作清单](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runtime/context/scratchpad-context.ts#L47) · [Kada 状态响应](../../src/goal.ts#L115)

本地重启复现中，宿主能读到原子任务结果，模型调用 `task_status` 时缺少这一入口。可让接回后的主任务按需读取已完成或失败的子任务结果。Pots 的子任务清单和 Suparagent 的部分结果回传给出了实现参考。测试在原委派结果退出活动上下文后接回任务，使用已有子会话身份重新核对产物，并确认没有重复启动子任务。 [Pots 子任务结果](https://github.com/Crokily/pi-durable-bot/blob/38486add7c1f/src/agent/children.ts#L560) · [Suparagent 结果回传](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/team/jobs.py#L706) · [Kada 子任务查询](../../src/delegation.ts#L44)

## P1 · 保留桌面动作的未知结果

让电脑桥在已发出的动作回复因接管、取消或租约变更被丢弃时报告 `uncertain`。Amuse 会结合动作是否可能已生效判断恢复。本地合成 MCP 驱动已复现一次差异。动作实际追加了一条记录，模型拿不到过期回复，随后观察能读出该记录，接管期间桥的状态却仍显示 `uncertain=false`。 [Amuse 恢复决定](https://github.com/replit/amuse/blob/a71da98873f0/apps/server/src/agent/robustness.ts#L100) · [Kada 电脑桥](../../src/computer.ts#L152)

回归让合成动作在确认回复前先写入标记，再发生接管。确认桥保留未知结果，重新观察读到实际标记后恢复可操作状态，写入总数为一次。任务自己的核对负责判断动作是否已达到目标。

## P2 · 恢复手机断线前的待发送内容

Codync 在移动端保存待发送正文、附件引用和稳定 nonce，明确重试沿用同一个 nonce。Kada 的服务端已能核对同一请求，移动页目前只保存 `messageId`。用本地脚本拦截请求并重建页面后，页面能查原请求，待发正文已丢失。可在原页面会话里保留正文和已上传的附件 ID，在回执为 `unknown` 时提供明确重试，并沿用原 ID。 [Codync 保存待发送项](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/AppStoreDrafts.kt#L63) · [Codync 复用 nonce](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/AppStoreChat.kt#L225) · [Kada 手机页面](../../src/remote-page.ts#L235) · [Kada 请求受理](../../src/remote.ts#L425)

浏览器回归分别拦掉请求和拦掉响应。前者在刷新后能用原正文、附件引用和 ID 重试一次。后者能接回原请求。附件过期时保留可操作的错误，其他设备无法读取这份待发送内容。

## P2 · 手机侧优先显示待处理会话

OpenMausBot 的通知接口用读取方区分通知状态。Kada 的手机会话选择器目前以标题和更新时间为主，进度读取集中在已选会话。可在设备已可访问的会话列表中加入等待原因和交付状态，优先让用户找到需要答复的会话。复用当前任务视图、设备归属和原会话 ID。 [OpenMausBot 通知读取](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/notifications.ts#L45) · [Kada 手机列表](../../src/remote.ts#L328) · [Kada 任务视图](../../src/task-view.ts#L34)

从连接、回到页面或手动刷新开始更新列表，控制加载完整任务状态的次数。浏览器验收覆盖两个同设备会话，一项正在执行，另一项进入待答或交付。更新后可直接接回原会话，并核对其他设备的任务状态与理由不可见。 [现有完整任务状态开销](../../src/runtime.ts#L786)

这轮复现覆盖本地脚本化模型和合成 MCP。两个硅基流动样本来自此前的合成交接实验。下一轮的降本结论依赖新的匹配对照，真实用户任务、小时级交付和实机条件各自保留原有验收要求。 [既有验收记录](2026-11-23-assistant-validation.md)
