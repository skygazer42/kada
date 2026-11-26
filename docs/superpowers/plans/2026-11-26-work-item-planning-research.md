# 工作项优先级与截止日期：源码研究及下一步

状态：优先级、截止日期、原聊天与共享只读展示已实现，本地回归及原会话真实模型续验通过。承接[能力核对表](../../specs/2026-11-25-reference-capability-matrix.md)的 P1 工作项规划；API 凭据本机链路已由前一项交付，广义秘密服务仍有缺口。[实施计划](2026-11-26-work-item-planning.md)

## 已核对的真实实现

| 能力 | 固定源码及执行路径 | Kada 应吸收的内容 |
| --- | --- | --- |
| 优先级 | [Suparagent schema，low/normal/high/urgent](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/schemas/work_item.py#L7)；[Rakazo createTicket 实际保存](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/ticket-tools.ts#L160)、[updateTicket 事务修改](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tasks/ticket-tools.ts#L205) | 扩展现有 WorkItem 和原聊天工具；默认 normal，不把优先级解释为执行授权。 |
| 日期与时刻分开 | [Suparagent due_date、due_at 与时区校验](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/schemas/work_item.py#L10)、[实际互斥校验](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L58) | 日期保留 YYYY-MM-DD 与 IANA 时区，不转换为 UTC 午夜；精确时刻要求显式偏移。不接受同时存在的两种截止。 |
| 修订冲突 | [Suparagent update_item 的原修订检查与条件更新](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L96) | 复用 WorkItems 原队列、revision 和原子回执。新字段不能改变旧操作的回放身份。 |
| 逾期与完成分开 | [Suparagent isOverdue](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/frontend/lib/planner.ts#L23) | 完成或归档项不显示逾期；按存储的时区判断日期，不采用当前浏览器任意时区。 |
| 列内位置与移动 | [创建/换列时分配 position](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L75)、[列表按 position、ID 排序](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/work_planner.py#L65)、[公开 WorkUpdate 字段](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/schemas/work_item.py#L45) | 不能从数据库存在 position 就推断任意拖拽排序。自定义列、排序编辑与完整看板单列后续，不塞进第一轮日期功能。 |

这里核对了 schema、实际持久更新及读取展示，未把工具声明或产品说明当作完整实现证明。机制独立适配，不复制对方 ORM、数据库或运行调度。

## 已实现范围

在现有 WorkItems 上增加 `priority`、`dueDate`、`dueAt`、`timeZone`。旧文件读取投影为 normal、null、null、UTC，读取不改原文件；新建/修改沿原 owner API、CLI JSON 与聊天工具，不另建 Planner 服务。

- `priority`：low、normal、high、urgent。只能保存有效枚举；清空通过 normal，不能写 null。
- `dueDate`：有效日历日期 YYYY-MM-DD 或 null。`dueAt`：带显式 UTC 偏移的 ISO 时刻或 null，保存为规范时间。两者合并到当前记录后至多一个非空。切换种类时明确清除旧字段，不能默默丢掉用户原截止。
- `timeZone`：规范 IANA 时区，日期截止按此日历理解；精确时刻的真实时间以 dueAt 为准。用户时间或时区不明确时用原提问入口补齐，不能猜成当地午夜；当前时钟可复用已有只读入口。
- 修改字段不启动提醒或执行，不补预算，不改完成/归档状态、原运行要求与原修订快照。需要提醒时仍由现有提醒入口另行保存。
- `work_items_list`、`work_item_read`、创建/修改回执与共享只读投影均返回规划字段；列表/卡片用明确日期或时刻显示。已分享手机保留原查看范围，不因此获得编辑权限。原默认列表顺序保持，完整看板另做。

以上字段与边界已按本轮实现接入；当前验收证据及未完成项以末尾记录为准，不等于完整看板已实现。

## Pi 与现有代码落点

已安装 Pi 1.4.0 的 defineTool、原 taskId、memo/commit 和安全重放继续承担聊天调用及恢复，执行仍由原 Pi 会话/Goal 负责。规划元数据属于现有 WorkItems；没有增加新运行时、调度器、数据库或消息总线的理由。

预计修改 `src/work-items.ts` 的输入验证、投影、保存与旧回执规范化；`src/chat-work-items.ts` 的可选字段/schema 与有界输出；既有 owner/remote 投影与列表卡片只做必要展示；CLI 继续用原 JSON 编辑，不新增一组平行命令。实际实现前搜索所有 WorkItem 构造、调用、夹具和展示端。

已发现的兼容陷阱：create/update 目前用固定数组生成请求 fingerprint。不能因为给数组追加默认规划字段，令升级前已提交的原请求重放变成冲突。旧 receipt.result 也可能不含新字段，应从原结果投影默认值，而非改写原 receipt 或把历史结果替换成当前状态。

`src/routine-schedule.ts` 已有带偏移时刻和有效日期校验。实施时优先复用公开的 once 规范化入口，或仅在确有跨模块复用时提取现有私有校验；不创建第三套日期解析器，不为截止日期调用定时器。

## 先失败、后实现的验收清单

- [x] 无新字段的旧文件逐字节不变；旧 create/update/no-op 回执升级后可重放，原请求不覆盖后来的字段修改或完成/归档。
- [x] 创建/修改/清空优先级及两种截止，daemon 重启保持；查询与回执不暴露 operations/fingerprint，其他项目不能读改。
- [x] 拒绝错误枚举、非闰年 2 月 29 日、2 月 30 日、无偏移时刻、无效时区、同时存在的两种截止；错误不保存半条更新。
- [x] 日期截止在所选时区跨天才逾期；精确时刻按同一瞬间判断，覆盖纽约 DST 两侧和浏览器时区不同；done/archived 不显示逾期。
- [x] 两个并发编辑只有一个赢，陈旧 revision 明确冲突；原运行的目标、验收和 workItem 修订不因后来规划修改而变化。
- [x] 原 Pi 聊天工具创建→重启→修改/清空→回读；没有 Goal、运行、提醒或附加预算。实际 SIGKILL 后回放原回执不覆盖后来的更新。
- [x] 终端 owner/CLI JSON 与共享手机只读显示一致；手机没有新增编辑或执行权限，页面日期不因时区静默移动一天。
- [x] 硅基流动真实模型用合成明确日期完成创建、重启和修改，独立断言工具次数、原 ID 与无 Goal/提醒。记录失败尝试、token 与未知金额，不据样本声称净收益。
- [x] 聚焦 WorkItems、聊天、原运行和 remote 回归，全量、类型/构建、文档与提交检查。集成策略为 Fork 提交，无上游 PR。macOS/实体手机未验收时继续明确标注。

## 仍保留的差距

自定义列、可编辑看板排序、日历拖拽、角色/团队分配以及截止提醒自动化不由这一项完成。Suparagent 的浏览器日期 helper 使用浏览器本地时区，不直接复制为跨设备日历语义；以保存的 timeZone 为准。更广角色协作和真实服务接入继续按能力表逐项核对。

## 当前验收证据

存储/原运行相关 13 项、普通聊天 6 项通过；随后合并服务、Pi/共享页面及实际 SIGKILL 共 62 项通过。恢复包含规划创建已提交和规划更新已提交两种新窗口，原回执仍返回当次日期，后来 owner 的优先级、日期和时区保持。输入与 DOM 新展示的失败用例均先复现后通过。共享页面测试从固定子节点下标改为定位原运行列表，保留原答复/控制的验证。

最终全量 503 项：499 通过、4 项可选 Office 跳过、无失败。类型/构建、笔记与提交候选检查通过；完整产品能力仍按核对表推进。

Windows Chromium 390 × 844，页面时区通过既有 CDP 接口设为 Asia/Tokyo，独立查询确认。列表与详情保留纽约 2026-11-01 日期，精确时刻显示 1:30 AM EST；完成后移除原项逾期，未发送草稿保持，无横向溢出。这是本地合成任务与真实浏览器验收，不代表实体手机或 macOS 实机。

硅基流动首轮的 90 秒观察在模型仍生成最终回复时到限，验证进程随之关闭。原 Pi 记录证实日期创建、回读和 urgent/精确截止更新已经成功；该失败记录保留，不能算通过。观察时限已改为原配置的每轮窗口加 5 秒，并从原合成会话继续检查，而非重建待办或重放已提交修改。[首轮记录](../../experiments/2026-11-26-work-item-planning-deepseek-attempt-1.json)

原会话续验通过：恢复后先显式续接已经过期的合成聊天时限，完成原文字回复，再清空截止并恢复 normal。原 Pi 记录中一次创建、两次修改，原 ID、时区保留，无 Goal、运行或提醒。初轮 5 次请求、续验 3 次，合计 8 次与 56,332 已知 token；金额及中断请求费用未知。修正观察时限后的完整新样本没有重跑，不能把续验称作该样本的不中断通过。[原会话续验](../../experiments/2026-11-26-work-item-planning-deepseek-continuation.json) · [浏览器证据](../../experiments/2026-11-26-work-item-planning-browser.json)

独立审查第一次因模型通道不可用而未启动，第二次的任务正文未送达，均未审阅代码。自动审查仍缺少 TruffleHog，本轮不声称独立审查通过；保留作者代码检查、确定性回归、真实浏览器及模型证据。
