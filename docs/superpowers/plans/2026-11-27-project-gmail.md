# 项目 Gmail 搜索和原邮件读取

用户为项目绑定已测试的 Google Workspace MCP 连接和一个邮箱。终端支持查询、下一页和原邮件阅读。请求始终使用绑定的邮箱。每次调用都核对当前连接修订、项目许可及只读声明。原邮件正文以分页读取，后续页使用原正文的 SHA-256 防止混入编辑后的版本。

Rakazo 从连接账号发现并路由应用工具。Kada 复用 Pi 宿主已有的 MCP 授权和派发，使用 Google Workspace MCP 声明为只读的两个 Gmail 工具。 [连接工具路由](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/providers/integration/pipedream/pipedream-connector.ts#L224) · [Gmail 查询](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1748) · [原邮件页](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1987)

14 项相关回归与构建通过。验收覆盖原邮箱绑定、项目隔离、重启恢复、查询翻页、原正文签名校验、许可变更和终端入口。合成 MCP 夹具采用上游的文本查询和 JSON 正文页协议。真实 Google 账号仍需配置授权。 [回归](../../../test/project-gmail.test.ts) · [原正文分页契约](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_helpers.py#L397)

## 本机普通聊天

Rakazo 派发工具前按当前账号批准范围查找连接。Kada 在邮箱配置中提供 `allowAssistant`，由本机用户明确开启。新本机普通聊天固定项目、邮箱和连接修订，使用与终端相同的只读调用。搜索结果和正文可以进入当前聊天使用的模型。每次调用重新核对邮箱和权限，过期的邮箱绑定会报错。 [Rakazo 已批准账号选择](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/providers/integration/pipedream/pipedream-connector.ts#L264) · [Kada 邮箱工具](../../../src/project-gmail.ts)

脚本化 Pi 与合成 MCP 回归验证普通聊天查询和阅读、重启后的同一聊天读取、更换邮箱后的拒绝、旧聊天和远程聊天的工具范围。真实邮箱及远端模型的综合验收待完成。 [回归](../../../test/project-gmail.test.ts)

## Gmail 匹配触发

用已有的循环规则轮询当前项目授权的 Gmail 查询。首次成功采样登记已有 ID，后续只受理该修订下未登记的 ID。消息移出查询又重新匹配，仍保留已登记身份。检查沿用 Pi 定时、已受理运行和预算策略。 [Rakazo 条目观察与基线](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L275) · [DuskBot Gmail 查询](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L178)

Pi 事务同时登记选中的邮件 ID 及原发生项。恢复时沿同一发生项投递，收件箱按发生项去重，任务沿用原任务 ID。用户暂停、取消或编辑时，可在历史中看到已受理且被中断的邮件批次。任务只获得来源连接的本次匹配邮件读取工具，正文按现有 SHA-256 分页读取。 [DuskBot 投递与游标](https://github.com/DuskBotAI/duskbot/blob/18df35a445e3/server/app-triggers.ts#L451) · [Gmail 查询输出](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1639)

合成 MCP 与 Pi 宿主回归覆盖两页基线、新匹配、移除后重新匹配、规则重启、通知保存后的同一发生项恢复、格式异常、连接撤权，以及任务读取本次邮件并拒绝其他 ID。真实邮箱的触发时延和大查询仍需实测。 [回归](../../../test/routine-gmail.test.ts)

## 邮件写入

项目授权后的执行任务可分别请求保存草稿、发送纯文本邮件、修改原邮件标签。连接需对每种动作启用逐次审批。保存的审批绑定账号、动作和完整参数，执行器在每次派发前检查原邮箱绑定及当前项目许可。收件人、抄送和密送来自原请求，发件账号来自项目绑定。同一审批在重启和重复决定后依照原回执结算。 [Suparagent 写入审批](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/composio_actions.py#L136) · [Rakazo 固定批准的调用](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/approvals/approval-effect.ts#L119)

草稿和发送可附带工作区文件。创建审批时只保存原路径、字节数及 SHA-256，实际执行前重新读取并校验，发送给 Google Workspace MCP 的参数使用标准 Base64。审批预览提供附件版本，文件同长却改动时会停止派发。 [附件参数](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L2697) · [原 MIME 封装](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L1294)

合成账号回归核对草稿、发送以及标签参数，并验证拒绝发送、重复批准、附件变化和邮箱换绑。真实发件和转发仍待补充或验收。 [草稿](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L3290) · [发送](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L2622) · [标签](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L4584) · [本机回归](../../../test/project-gmail.test.ts)

## 附件读取和交付

终端按原邮件 ID 列出附件，并使用附件 ID 与索引下载。执行任务在项目授予只读附件权限后可保存并提交同一文件。触发邮件任务的范围仍以该次匹配的原邮件为准。Google Workspace MCP 提供附件名、索引和完整标准 Base64。Kada 核对响应中的邮件 ID、长度和字节，将文件原子保存到项目路径，并给出 SHA-256。单文件上限为 25 MiB。 [原附件清单](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L2058) · [原附件下载](https://github.com/taylorwilsdon/google_workspace_mcp/blob/6df4ad5a9fd1209f1e946c12cdffa64226b5f694/gmail/gmail_tools.py#L2324)

合成二进制附件回归覆盖终端保存、原字节和哈希、重复调用、工作区路径、已有文件冲突、撤权以及助手原任务的交付。真实邮箱的附件 ID 刷新及大文件等待真实账号验收。 [回归](../../../test/project-gmail.test.ts)
