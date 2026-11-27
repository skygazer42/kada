# 项目工作看板

Suparagent 按 owner 与 board 查列，按列内位置列出卡片，移动时检查卡片修订及目标列并更新时间。Kada 复用项目工作项、原修订、原运行和现有本机权限，提供自定义列与显式排序。[列和工作项](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L21) · [列表排序](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/work_planner.py#L65) · [移动和完成时间](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L96)

- 项目默认列按待办、搁置和已完成显示。可增加和调整自定义列，每列映射到一种已存在的工作项状态。列及卡片顺序保存在原项目数据中，旧工作项首次读取按已有状态归类。
- 移动接收显示后的看板版本、原卡片修订及目标列。移动到其他状态的列按原工作项规则保存状态与完成时间。改名、调整列顺序和移除空的自定义列沿同一个版本及回执机制。
- 本机终端与 owner API 可操作当前项目的看板。`work-items board-link --workspace 路径` 生成两分钟内可兑换一次的浏览器链接。浏览器会话仅可读写该项目的看板，重启服务后重新领取链接。看板排序和移动沿工作项事务保存。
- 浏览器支持新建和编辑卡片、拖拽和表单移动、自定义列的增删改名与排序。每次打开的卡片表单固定一个请求 ID，重试同一内容沿原回执返回。角色分配和手机编辑仍待补充。

## 验收

- 回归覆盖旧数据、跨项目拒绝、修订冲突、同请求重放，以及重开后项目列和卡片顺序。HTTP 测试覆盖单次兑换、浏览器权限和工作项新建的原回执。[回归](../../../test/workboard.test.ts)
- 用 agent-browser 0.38.1 驱动本机 Chromium，从终端链接打开合成项目。验证新建与改名、优先级和日期、拖入自定义列、用表单移到已完成、列排序及移除空列。刷新页面和重启服务后，卡片和原位置均可重读。同一个标签页打开另一个项目的新链接后显示该项目的看板。
- 在浏览器中丢弃一次已保存的创建响应，再提交同一表单。修复前产生两张卡，固定表单请求 ID 后只保留一张。看板操作通过本机 API 完成。
- 工作项聚焦回归 15 项通过，最终链接版本另行复跑看板回归通过。整仓首跑 643 项，其中 635 项通过、4 项代码案例因 Windows 缺少可执行的 `python3` 入口失败、4 项可选 Office 案例跳过。用 `CASE_PYTHON` 指定本机 Python 3.14 后，4 项代码案例复跑全部通过。类型检查与构建通过。
- 独立复核通道两次未收到任务正文。本轮审阅覆盖主会话里的差异与调用路径。
## 截止日历增量

在原看板切换到截止日历，按月份浏览已设截止时间的工作项。全天日期沿原字符串保存和显示，指定时刻按卡片的 IANA 时区归到本地日。点击同一张卡进入已有编辑器，保存后日历根据原修订刷新。归档或没有日期的工作项留在各自原入口。 [Suparagent 日期与时刻契约](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L59) · [Rakazo 时刻格式与日程列表](https://github.com/elie222/rakazo/blob/e64d73292179/apps/web/src/pages/shell/meetings/meeting-calendar.tsx#L93)

服务回归用同一个 UTC 时刻验证纽约落在上月、东京落在次月，以及全天日期、时区变更和归档状态。Chromium 在 390 × 844 视口打开原卡，把纽约切换到 UTC，验证卡片随原修订移到次月并仍能切回看板。 [回归](../../../test/workboard-deadlines.test.ts) · [浏览器记录](../../experiments/2026-11-26-workboard-deadlines-browser.json)
