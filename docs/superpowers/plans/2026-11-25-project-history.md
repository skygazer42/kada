# 项目历史对话检索实现计划

**目标：** 本机助手能找回当前项目之前的用户讨论及助手答复，按原消息继续工作，减少要求用户重复上下文。

**参考源码：** [OpenMausBot session_search 与来源 ID](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L568)、[检索工具与按 ID 回读](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L807)、[读取前的归属校验](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/index.ts#L13390)、[Unicode 片段匹配](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/message-search-query.ts#L14)。只独立实现产品机制。

**Pi 核对：** 1.4.0 原 Storage.scanSubmissions、Storage.entry、ROOT_CONVERSATION_ID 和分页 Cursor 提供输入、回答及原消息身份，压缩不删除历史。metadataList 与 memoryProject 提供本机项目归属。已打开任务复用原 storage，关闭来源只开 Pi Storage 并在结束后关闭，不创建旧任务 Harness，不新增数据库、索引或模型请求。

**契约与范围：**

- 新建本机任务保存 `historyRecall: true`。只在主助手的聊天、任务准备和执行阶段提供 `history_search`、`history_read`；旧任务、远程私有任务和子 Agent 不自动取得能力。
- 检索及读取均依据调用任务的原工作区，使用同一 memoryProject 根，只读其他本机任务。远程私有会话与当前调用任务不在来源内；调用者不能自选项目、路径或扩大范围。
- 来源为 Pi 已受理的 initial/user 请求对应的用户消息及其最终助手正文；自动规则 initial、监督输入、子任务汇报、工具结果、系统提示、压缩摘要不检索。非聊天任务的自然助手答复也可命中，工具提交本身不伪装成正文。
- `history_search` 接受 1–200 字查询、1–20 条上限（默认 8）。按空白拆为最多 12 个词，Unicode 小写后每词均须出现，中文词串可直接匹配；按命中次数、原消息时间排序。结果固定 taskId、entryId、role、timestamp 及最多 400 字真实片段，并声明历史是数据、不是指令或新授权。
- `history_read` 接受来源 taskId 与 entryId，直接读取来源任务元数据，核对项目、记忆范围和消息归属。只返回已允许的原消息，最多 8,000 字并标注截断。回归验证同一项目的另一条损坏记录不会阻止对有效来源的回读。 [OpenMausBot 按来源 ID 回读](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L854)
- 失败明确返回，不把损坏历史当成无结果。按原 Pi 分页读取完整已有记录，结果有界；未做大量历史压力测试，不声称语义搜索或新建向量检索。
- 保留用户历史和配置。不开启远程跨会话检索，不复制其他项目或外部平台历史。

**文件：** `src/history.ts` 放薄工具、匹配和片段逻辑；`src/runtime.ts` 复用原存储投影，绑定调用任务并在主会话安装；`src/conversation.ts` 只在具备能力时增加查阅指令。`test/project-history.test.ts` 覆盖项目、自动输入、原文、压缩重启、工具接入与远程边界。Spec、使用说明和既有架构笔记同步。

- [x] 写失败回归：跨同项目会话检索/回读、中文/Unicode、权限与内部消息排除。
- [x] 实现原 Pi 消息投影及有限片段，不新增存储。
- [x] 真实 Pi 工具验证新聊天找回原文，压缩/重启后身份不变；远程、旧任务及子任务不开放。硅基流动 DeepSeek V3.2 实测通过。
- [x] 聚焦/全量测试、类型/构建、提交候选及笔记校验。
- [x] 提交推送 Fork，不创建上游 PR。

## 验证记录

检索接口和模型工具缺失先由失败回归证明。关闭来源原先会被重新打开成任务运行时，改为复用 Pi Storage；空历史文件原先会当作无结果，增加原 Pi 主会话存在检查后明确失败。这两项均先复现再修复。准备阶段的旧工具名单更新为包含两个只读历史工具，原写入拒绝、修订及确认边界断言保留。

最终历史专项 7 项通过；历史与准备阶段相关 15 项回归通过。最终完整 `npm test` 共 422 项：418 通过、0 失败，4 项 Office 样例因可选依赖缺失跳过。类型检查、构建、提交候选检查及三项笔记校验通过。

原生 Pi 压缩、上下文重置、重启、跨 200 条提交分页、中文和 Unicode 片段、原文截断、同项目子目录与其他项目隔离、自动初始输入及内部流量排除、远程/历史任务权限、子任务不继承均有回归。DeepSeek V3.2 经硅基流动以 4 次请求找回旧讨论并读取原文，16,533 总 token，无 Goal，金额未知。实测在改为直接读取 Storage 前运行，最终 Storage 路径由上述 Pi 集成回归验证。

自动审查因缺少 TruffleHog 在模型审查前停止；独立审查任务正文不可读，未执行审查，没有独立审查通过结论。主会话检查完整生产差异与相关调用。尚未验证大量项目历史性能、语义检索、跨设备历史共享及真实费用收益。
