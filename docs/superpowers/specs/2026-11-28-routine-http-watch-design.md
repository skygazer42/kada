# 公开 HTTPS 变化预检查

Status: implemented. 基线 `40544f0` 的规则不支持 precheck.http；合成试验在保存前拒绝，未发网络或模型请求。功能提交为 `5bff18f`。

## 场景与固定源码

用户希望每隔一段时间检查公开服务状态或 JSON 列表，内容未变化时不启动模型，发生变化时只执行原目标或发一条通知。

[Rakazo HTTP 读取](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L184) 用受限 GET 读取公开 HTTPS，仅保存指纹；[比较基线](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L275) 的首次样本不启动模型；[字段跟踪](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-watch.ts#L369) 保留重复身份的全部值并忽略条目顺序；[原测试](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/routines/routine-http-watch.test.ts#L38) 覆盖零电脑初始化、DNS 边界、错误状态和正文不进入提示。入口来自原定时运行流程，不只参考工具 schema。

Kada 使用已安装 Pi 1.4.0 的持久 task、sleepUntil、claim 与发生项历史。扩展现有 LocalRoutines.precheck，HTTP 只负责一次受限读取和指纹，不添加浏览器、抓取服务、模型调用、认证库或调度器。原 command/MCP/Gmail/calendar 预检查行为保留。

## 配置与结果

新增 `precheck: { http: { url, track? } }`，只能用于有显式 workspace 的周期 task 或 notify 规则。沿用既有日程、预算、活动门槛、账户降频及 Run now；不与一次性或事件规则混合。HTTP task 默认使用既有 skip overlap 策略，避免同一规则并行工作。手动运行也做原预检查，不强制绕过变化判断。

规范化后的 URL 最多 2048 字，必须为 443 端口的 HTTPS，无用户名、密码和 fragment。配置不接受请求头、请求体或方法，不发送 Cookie、认证或系统环境。传输固定声明 identity 编码与 Kada 版本的 User-Agent；保存只规范化 URL，不发请求。

`track` 为 1–16 个不同的原始 JSON 属性名，每个最多 80 字，第一项是身份，后续项为变化字段。递归查找 JSON 对象中的字符串或有限数字身份；同一身份的多个对象全部参与比较，身份和值的类型保留，条目顺序不影响结果。缺少变化字段按 null 处理。身份集合为空仍是一个有效指纹；不推断点号路径或把正文 content 数组当 MCP 消息。没有 track 时，对合法 JSON 排序对象键，数组顺序保留；普通 UTF-8 文本比较其完整文本。JSON 对象/数组嵌套超过 64 层、非有限数或非法 UTF-8 明确失败。

首次成功读取在原 Pi 事务中保存基线及本次检查回执，状态 baseline、发生项 skipped，无模型/通知。之后相同指纹为 unchanged；新指纹为 changed。只有原任务已受理或通知已保存，才推进变化基线；失败或预算拒绝不吞掉该变化。通知内容是用户原目标，不包含网页正文。

读取失败保留原基线，在原发生项写有界安全原因，下一次按原日程再检查，不增加即时重试或模型解释。规则改动重置基线，暂停/恢复保持原基线。配置撤销或修改后，旧排队请求不能写回基线或启动工作。

暂停若发生在宿主效果完成、定时回执保存之前，原 Pi 规则暂存当时的发生项 ID、任务 ID、动作、时间和哈希。恢复后的检查先从宿主原队列核对任务元数据或通知回执，只有有效受理得到确认才推进基线；读取失败保留待核对状态并报安全错误。没有新的执行或回执存储，正文不参与暂存。编辑规则仍明确重建基线。

## 网络边界

每次读取都验证目的地，并复用现有 publicCredentialAddress 的公网地址判断。DNS 的全部结果必须为公网、与 address family 一致；实际请求通过自定义 lookup 使用这些固定结果，保持原主机名和 TLS 校验。拒绝 IP 别名、localhost、单标签内部主机及私有、保留、链路本地、metadata 地址，不实际访问这些服务。

一次检查总限时 15 秒，含 DNS 与读取；父任务取消立即终止等待，DNS 的迟到失败不会成为未处理拒绝。响应最多 1,000,000 字节，只接受成功 2xx 和 identity 编码，不跟随重定向。错误状态、体积、TLS 和网络错误不能被当成新业务正文。错误信息不得包含上游错误、URL 路径或查询令牌。

## 实现与验证范围

新 routine-http.ts 复用 Node HTTPS、现有公网地址判断及 MCP 的稳定 JSON 序列化；暴露规范化和一次检查函数，网络依赖只用于注入真实/合成 DNS 和 HTTPS 请求。LocalRoutines 与 RuntimeOptions 将依赖传入原任务；HTTP 基线与通知成功后更新沿原文档字段完成。

测试覆盖：规范化和无隐式参数；公网 DNS 固定、混合/私有地址拒绝；状态码、压缩、体积、非法 UTF-8、深度与取消；JSON 键序、跟踪字段、重复身份、空列表；baseline、重启、unchanged、changed、失败后重试、通知去重、暂停/更新/取消及旧回执。实际 SIGKILL 覆盖基线保存后和任务受理后的恢复。

公开网络验收使用无需凭据的稳定公共页面，只验证真实 TLS/读取与相同内容指纹。变化和安全边界用合成传输验证。对照记录检查次数和原模型启动次数，脚本化模型的零启动不能证明真实模型质量或净费用收益。原生设备、成员浏览器、云执行等其他差距继续单列。

## 当前证据

核对的源码、失败测试及恢复场景覆盖了上述实现。最初的公开读取 `example.com` 因本机 DNS ENOTFOUND 未通过；GitHub 公开根接口要求 User-Agent，固定客户端标识加入后，两次原生 Node HTTPS 读取获得相同指纹，不保存正文且没有模型请求。

原生 Pi 1.4.0 对照使用相同脚本化模型、原指令和一个只读状态工具。三个样本 `[1,1,2]`，直接运行有 3 次模型工作、6 次请求及 3 次 HTTP 读取；接入变化预检查有 1 次模型工作、2 次请求及 4 次 HTTP 读取。多出的一次读取来自变化后的模型工作再次核对来源。只证明此合成路径抑制模型启动，不据此推断费用或质量改善。

八个相关测试文件的 46 项回归通过，另在使用 URL 类构造合成认证 URL 后复测六项网络边界用例。类型检查、构建、提交内容检查和笔记校验通过。 [实验与局限](../../experiments/2026-11-28-routine-http-watch.json)。

`5bff18f` 的最终 `npm run check` 已通过：782 项测试全部通过，无跳过，类型、构建和提交内容检查通过。独立静态审查核对网络边界、指纹、基线、受理确认、暂停恢复、取消及 Owner 入口后未发现实质性问题。原 Autoreview 凭据预检通过；额外模型审查的认证已知不可用，本项未重复调用，也没有将其记为有效报告。完整参考能力对齐仍未完成。
