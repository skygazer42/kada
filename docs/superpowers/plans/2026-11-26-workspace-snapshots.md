# 工作区快照与撤销

Suparagent 将工作区清单及哈希内容存到独立位置，恢复前保存撤销点，运行中拒绝恢复。Kada 沿已有本机任务和工作区边界提供保存快照、查看差异、按预览恢复和撤销恢复的入口。文件读写复用 Workspace 的路径检查与原字节哈希。[快照存储](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/workspace_snapshots.py#L112) · [恢复](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/workspace_snapshots.py#L167) · [本机入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/workspace_snapshots.py#L50) · [Kada Workspace](../../../src/workspace.ts)

- 快照以工作区规范路径分组，保存普通文件的相对路径、长度和 SHA-256。内容按哈希复用，单次最多 5,000 个文件、200 MiB。版本库、依赖缓存、已知凭据路径、链接和 Kada 后台目录留在原处。超过上限或捕获时文件发生变化时明确返回失败。
- 预览返回新增、替换与删除的路径及当前工作区版本。恢复按原快照和预览版本受理，检查目标路径和所有将使用的内容，再保存当前工作区的撤销点。拒绝过期的预览及仍在执行的重叠任务。恢复按原文件逐项核对，有中断时通过原版本重试或从撤销点恢复。
- 本机 API 和终端使用原任务确定工作区。验收包含二进制、空文件、超过预览后的编辑、恢复与撤销、重复请求、目标链接、损坏快照和原工作区之外的凭据材料。
- 配置 `workspaceSnapshots: true` 后，新本机任务在确认后的原 Pi 执行回合生成自动快照，同一输入的工具后续请求和恢复沿同一个快照身份。自动保留最近十份并清理无引用内容，手动快照及恢复记录引用的快照继续保留。快照存储优先使用 Kada 数据目录，当数据目录位于工作区内时使用工作区旁的私有目录。[Suparagent 回合入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/thread_runtime.py#L1242) · [保留与内容回收](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/workspace_snapshots.py#L152)

## 验证

回归使用合成工作区核对了预览版本、重复恢复、撤销、受保护文件、损坏内容、重叠的运行任务及恢复中间点强杀。自动回归核对确认前后、原回合重用和保留规则。[测试](../../../test/workspace-snapshots.test.ts)

硅基流动 DeepSeek V3.2 最终通过 3 次请求写了测试文件。自动快照保存写入前的字节，后台重启后通过原预览恢复并撤销恢复。恢复和撤销各自使用本机文件读写，模型请求计数均为零。首次超时已用同一份真实编辑结果继续验收手动恢复。[实测](../../experiments/2026-11-26-workspace-snapshots-deepseek.json)

全量 630 项通过。快照和相关入口的 71 项定向回归、类型与构建、最终自动快照与角色隔离复查均通过。真实文件恢复与撤销也经过编译后的 CLI。
