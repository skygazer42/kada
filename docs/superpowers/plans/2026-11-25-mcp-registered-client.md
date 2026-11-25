# MCP 预注册客户端实现计划

**目标：** 给不支持动态客户端注册的 HTTP MCP 服务提供 owner 配置，复用现有登录、回调和 SDK 令牌刷新。

**配置：** `oauth: true` 保持动态注册；预注册使用 `oauth: { clientId, issuer, clientSecretEnv?, scope? }`。`issuer` 必填，`clientSecretEnv` 只保存环境变量名称，不保存其值。SDK 选择 public、Basic 或 POST 认证；`scope` 作为 SDK 的客户端 scope 后备值。

**参考：** [Rakazo boundClient](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L369)、[SDK provider](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/mcp/mcp-oauth.ts#L674)，以及已安装 SDK 1.32.2 `client/auth.js` 的 issuer 检查与 `selectClientAuthMethod`。

**修改范围：** `src/mcp-oauth.ts` 负责配置规范化、环境变量解析和 provider；`src/mcp-tools.ts` 传递配置；`test/mcp-oauth.test.ts` 用合成服务验证实际网络。CLI 沿用现有 `mcp add/login/test/enable/logout`。同步 Spec 与原架构笔记，无新依赖。

- [x] 先写失败回归：不提供注册端点的服务，public、Basic、POST 依次完成登录、跨重启回调、刷新及退出；注册请求数为零。
- [x] 实现严格配置校验，provider 返回带指定 issuer 的注册信息，禁止 SDK 为预注册模式动态注册。
- [x] 验证缺失环境变量、issuer 不匹配、配置变更、凭据回显与公开状态不泄露 secret。
- [x] 运行相关测试、全量测试、类型/构建/提交/笔记检查。
- [x] 提交到 Fork 现有分支，不创建上游 PR。

**边界：** 本机环境变量由用户原有配置管理；退出清除授权材料并停用工具，但不删除环境变量或撤销应用端的客户端注册。真实第三方账号、设备码和任意自定义授权参数另行验证。

## 验证记录

38 项相关回归通过。完整 `npm test` 使用现有 `CASE_PYTHON` 指向本机 Python，378 项中 374 项通过、0 失败，4 项 Office 样例因缺少可选依赖跳过。类型检查、构建、提交凭据扫描和笔记校验通过。

合成 POST 客户端从 owner CLI 加入配置、登录，经 Chromium 完成 PKCE 回调，再发现、启用和退出；注册请求数为零，临时服务与数据由夹具关闭流程清理。public、Basic、POST 的自动刷新与跨重启回调由实际 HTTP 协议回归覆盖。

本轮还修复两个验证中发现的问题：移除重复的严格 issuer 字符串比较，沿用 SDK 对末尾 `/` 的等价规则；预检撤权测试用独立释放标记，避免 Windows 反复读取样本与原子替换发生占用冲突。独立审查因委派任务正文传递失败未产出结论，不计为通过；主会话完成了源码与 SDK 路径复核。
