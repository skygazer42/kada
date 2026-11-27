# 本机工作区快照浏览器

参考 Suparagent 在原线程范围内预览和恢复工作区快照，Kada 为选定的本机任务生成一次性链接。页面继续使用已有的原文件哈希、预览版本和撤销快照逻辑。 [Suparagent 恢复入口](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/workspace_snapshots.py#L50)

- 浏览器在同一原任务范围内列出快照、保存新快照并预览要增加、替换和移除的文件。
- 恢复按钮提交当前预览版本。工作区变化、任务仍在执行或原证据不符时沿现有检查处理，成功后能看到恢复前的撤销快照。
- 测试覆盖一次性链接、过时预览、任务范围与原文件的保留和恢复。 [自动化回归](../../../test/workspace-snapshots.test.ts)

Chromium 通过终端链接创建快照并预览文件变化。工作区再次修改后，旧预览被拒绝。重新预览恢复了原始字节，选择自动保存的恢复前快照后又得到操作前的字节。 [浏览器验收](../../experiments/2026-11-26-workspace-snapshot-browser.json)
