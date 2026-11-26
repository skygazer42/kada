# 应用 API 凭据输入与请求实现计划

> 当前 Fork 功能分支内按 superpowers:executing-plans/TDD 实现。先完成 API 凭据链路；网页登录、验证码和命令变量继续保留为能力差距，不把这一轮标为整个密钥库对齐。

**目标：** 用户在独立遮罩字段提供应用 API 凭据，模型只看到名称、用途和站点；已确认任务可在绑定站点使用，响应不能回显秘密。

**源码参考：** [Rakazo 凭据输入契约](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/builtin-conversation.tool-definition.ts#L27)、[站点/认证头校验](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/secrets/bot-secret-destination.ts#L33)、[实际注入与请求边界](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/secrets/bot-secret-request.ts#L201)、[有界读取与安全地址解析](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/web/web-ssrf.ts#L166)、[OpenMausBot 独立凭据卡](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L451)。独立实现，不复制云端 Vault/数据库。

**Pi 核对：** 1.4.0 的 CredentialStore 接口是按模型 provider 管理，内置内存实现；coding-agent 的磁盘 AuthStorage 没有公开导出，不能依赖内部路径。应用凭据用现有 proper-lockfile 与 atomicJson；request_credential 只保存元数据到原 Pi Questions，secret 不进入 Pi 输入/文档。HTTP 请求沿 Pi 工具的非安全重放策略，未知结果不自动重试。

## 契约与范围

- 新本机主会话固定原项目凭据能力；远程、旧任务、子任务不自动获得账户使用能力。远程可填原本机明确分享的请求卡是后续独立权限项，本轮先提供 owner 本机遮罩入口。
- `request_credential` 只接受 name、origin、label、reason 和 auth（bearer/header/basic），不接受 secret/value。复用 Questions 身份和当前回合等待，模型只得到已保存/拒绝的通用结果。普通聊天不创建 Goal；准备/执行任务保持原等待阶段。
- 用户从终端 `/credential 问题ID` 无回显输入，或 macOS 密码字段填入。值不作为普通 messages/answer 路由或工具参数提交。owner `POST /v1/tasks/:id/credentials/:questionId` 只在当前原问题/项目、控制与预算允许时接收；其他问题、已取消或错修订拒绝。
- 凭据记录以项目+名称定位，绑定规范 HTTPS origin 与认证类型，原子保存修订及提供请求回执。重复提供原请求/原值返回原 receipt，不覆盖后来的轮换；异内容冲突。明文值只在私有应用凭据文件及实际请求注入存在，公开列表只见名称、站点、认证类型和修订。现有用户历史凭据不读取或改写。
- 私有路径 `application-credentials/`，默认 Git 忽略，提交检查拒绝强制暂存；现有原子写入 mode 0600/目录0700 在适用系统生效，Windows 沿用户目录权限。该存储是受限本地文件，不冒称系统密钥库或对本机任意代码的秘密隔离。
- `credentials_list` 只读当前项目元数据；owner CLI 可删除指定修订。`credential_request` 只在已确认执行 Goal 内提供，使用名称及固定修订，支持 GET/HEAD/POST/PUT/PATCH/DELETE。原 scope/预算仍约束任务；工具无自动重放/重试，外部结果未知须先核对。
- 请求只向原 origin 注入认证头，拒绝 userinfo、片段、非 HTTPS、重定向以及尝试覆盖认证/Host/连接等头。先验证 DNS 的全部地址为 public，并将本次连接 lookup 固定到通过的地址，防止再次解析切换；保留 TLS 主机名验证。测试通过注入 transport/lookup 使用本机合成服务，不增加生产内网开关。
- 请求/响应各有界，30 秒总限时，响应最多1MB并截断给模型至20k字符。脱敏先于截断，至少覆盖原值、认证头值、percent/base64形式；不返回任意响应头，仅允许分页/限速字段，回显失败错误使用通用文字。值不写日志、命令行或测试证据。
- 凭据提供先写原子存储回执，再以固定提供请求身份给原问题回传通用消息。跨两处持久化中断可用原请求回执补齐，不向模型重传值；实际 SIGKILL 验证。拒绝仍走不带值的专用入口。

## 修改与验证

src/application-credentials.ts：验证、锁与原子存储、元数据和请求边界；src/credential-tools.ts：主会话薄工具与问题元数据；src/questions.ts：保护凭据问题不被普通 answer 输入当作值；src/runtime.ts：原项目范围、提供事务与回传；src/server.ts、src/chat.ts、src/cli.ts 和 desktop：独立无回显入口；提交检查、Spec 和笔记同步。

- [x] 原服务失败测试：项目/修订、重放、轮换/删除、无公开值、无效 origin/header、文件权限/坏文件。
- [x] 网络失败测试：原 origin/重定向、DNS public与固定连接、HTTP方法、取消/体积、错误与回显脱敏、撤销修订。
- [x] 原 Pi 工具与遮罩输入：无 Goal保存、普通 answer不能提供值、已确认请求、旧/远程/子任务范围；SIGKILL不重复覆盖。
- [x] 终端与 Swift入口，真实模型用合成凭据引用请求；真实网络用本机合成服务，外部真实应用另验收。
- [x] 相关/全量测试、类型/构建、笔记与提交检查。集成策略为推送 Fork，不创建上游 PR。

## 实际验收与边界

初轮相关回归 97 项通过。全量 494 项中 490 通过、4 项可选 Office 跳过，无失败；收尾修复后再次运行凭据服务、Pi/owner/终端与聊天入口共 24 项全部通过。4 项 SIGKILL 包含存储提交、聊天/执行答复窗口和已发出请求的非重放。类型、构建、三项笔记校验和提交候选检查通过。

补充失败用例暴露 JSON 引号/反斜杠回显漏检、取消时晚到的 DNS 拒绝未挂处理，以及 Ctrl+C 后 readline 残留字符进入后续消息的风险。分别增加转义形式匹配、先挂工作/取消处理、凭据完成或取消后重建原编辑器；新编辑器同时丢弃 history、undo 和 kill/yank。Windows 真正 PTY 验证无回显、取消后再提供、编辑值、保存后 Ctrl+Y 不恢复原私密文本，再正常执行帮助与退出。TERM=dumb 不提供 Ctrl+U 编辑；编辑缓存验收使用 TERM=xterm，默认终端完整输入与取消仍可用。

DeepSeek V3.2 经硅基流动执行 5 次请求、33,461 总 token：中文发起保护输入、提供合成值、重启无新增请求、独立授权执行调用合成 API 一次，值未进入实际模型/Pi 输入。金额未知，仅验证该样本。[真实模型记录](../../experiments/2026-11-26-application-credential-deepseek.json)

另用临时生成且显式信任的本地 CA 完成真实 TLS 握手，正确主机名请求一次，错误主机名在 HTTP 前被拒绝；未关闭 rejectUnauthorized。路由与 CA 是测试注入，不能证明真实第三方 DNS/API 兼容。[本地 TLS 记录](../../experiments/2026-11-26-application-credential-local-tls.json)

Swift 四文件语法解析通过，macOS 编译与实机仍未验收。自动独立审查因缺少 TruffleHog 在调用审查模型前退出；既往委派的审查也未获得有效代码审查结果，因此本次没有独立审查通过结论。保留本地明文、任意服务变换回显不保证识别、网页登录/OTP、系统密钥库、远程输入等限制。

## 取舍

直接把 secret 作为工具参数最少，却写进原 Pi 工具意图和模型上下文，因此不能用。依赖 Pi 的内部 AuthStorage 路径可少写锁，但不是公开 API，且其文件写入不是本项目的原子保存；采用仓库现成锁与原子保存。另建加密算法/系统密钥库适配会扩大跨平台依赖，第一条 API 链路先明确受限本地文件边界，后续可接现成秘密服务，不伪装为已加密。
