# 浏览器登录交接

本机任务在观察浏览器后，可以请用户接手登录或验证。请求沿 Pi 原任务保存并暂停执行。用户在终端用当前问题 ID 接管，在原浏览器操作，再选择回交或拒绝。原答复只包含固定的结果提示。回交后的第一步是重新取得租约并观察页面。

接管期间的持有状态绑定原任务和问题。后台重启先恢复浏览器的用户控制。续预算保留原问题。回交会核对原驱动配置，确认和拒绝沿 Pi 原任务保存，答复回执支持重试。任务已经放弃时，可用 `computer return` 交还控制权。

OpenMausBot 在原会话发出登录卡片并以完成或拒绝接回原工作。Kada 通过 Pi 的 `ToolExecutionApi.commit` 保存原问题，使用已有的计算机模式和任务事务恢复。验收使用合成的本地网页，覆盖等待、接管、重启、回交、重新观察和重复答复。 [请求](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L625) · [任务归属](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/handoff-requests.ts#L74)

回归复现了续预算丢掉原问题，并覆盖重启续期、原驱动校验、答复保存后中断和恢复。56 项相关测试、类型检查和构建通过。真实 Chromium 驱动在本地验证页通过接管、输入合成验证码、驱动重连及回交。测试脚本模拟用户操作，原任务重新观察后提交了通过核对的 JSON。硅基流动对 DeepSeek-V3.2 和 Qwen 的首次模型请求均返回 402。本机运行 macOS 客户端验收需要 macOS。 [测试源码](../../../test/browser-sign-in.test.ts) · [浏览器和模型记录](../../experiments/2026-11-27-browser-sign-in-handoff.json)

启用本机浏览器驱动时，新任务保存启动时的驱动指纹。重启后只安装对应驱动的工具。已打开任务的 MCP 工具也在派发时校验指纹。合成回归在同一任务里验证替换驱动遭到拒绝、重启暂缺原驱动、接回原驱动后继续。 [OpenMausBot 的指定电脑入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L154) · [本地回归](../../../test/browser-sign-in.test.ts)
