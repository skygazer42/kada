# 浏览器登录交接

## 任务选择浏览器配置

OpenMausBot 保存用户为会话选定的执行位置，之后沿原位置操作。Kada 的本机用户可在建任务时指定一个已配置的浏览器。任务保留配置名称和连接指纹。每个固定会话拥有独立租约与接管记录，重启后分别恢复。 [用户选定的位置](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/computer-selection.ts#L12) · [选择原位置](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/computer-selection.ts#L23)

两个合成的本地浏览器提供独立回归，校验不可用配置、原任务观察、并行接管、重启、单独回交和错配驱动。原有单浏览器任务继续使用现有的默认配置与保存记录。

Windows 上用安装的 agent-browser 和两个独立 Chromium 会话运行合成本地页。两个原任务先观察各自的页面，再申请接管。后台重启后两套控制均保留。先回交其中一个，另一个继续由用户控制。两项任务各自重新观察改变后的原页面并完成。

配置示例使用仓库内的固定会话适配。为第二个配置选另一个名称、会话名和截图路径。接管状态按固定会话保存，改名后仍保留用户控制。任务回交核对创建时选定的配置、会话和工具范围。终端在操作前检查后台是否支持命名配置。 [适配器](../../../scripts/agent-browser-stdio.ts) · [回归](../../../test/browser-sign-in.test.ts)

```json
{
  "browserProfiles": {
    "review": {
      "command": "node",
      "args": ["--import", "tsx", "scripts/agent-browser-stdio.ts", "C:/path/to/agent-browser-win32-x64.exe", "http://127.0.0.1:9911/", "kada-review", "E:/qa/review.png"],
      "tools": ["agent_browser_open", "agent_browser_snapshot", "agent_browser_click"],
      "observationTools": ["agent_browser_snapshot"]
    }
  }
}
```

本机任务在观察浏览器后，可以请用户接手登录或验证。请求沿 Pi 原任务保存并暂停执行。用户在终端用当前问题 ID 接管，在原浏览器操作，再选择回交或拒绝。原答复只包含固定的结果提示。回交后的第一步是重新取得租约并观察页面。

接管期间的持有状态绑定原任务和问题。后台重启先恢复浏览器的用户控制。续预算保留原问题。回交会核对原驱动配置，确认和拒绝沿 Pi 原任务保存，答复回执支持重试。任务已经放弃时，可用 `computer return` 交还控制权。

OpenMausBot 在原会话发出登录卡片并以完成或拒绝接回原工作。Kada 通过 Pi 的 `ToolExecutionApi.commit` 保存原问题，使用已有的计算机模式和任务事务恢复。验收使用合成的本地网页，覆盖等待、接管、重启、回交、重新观察和重复答复。 [请求](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L625) · [任务归属](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/handoff-requests.ts#L74)

回归复现了续预算丢掉原问题，并覆盖重启续期、原驱动校验、答复保存后中断和恢复。56 项相关测试、类型检查和构建通过。真实 Chromium 驱动在本地验证页通过接管、输入合成验证码、驱动重连及回交。测试脚本模拟用户操作，原任务重新观察后提交了通过核对的 JSON。硅基流动对 DeepSeek-V3.2 和 Qwen 的首次模型请求均返回 402。本机运行 macOS 客户端验收需要 macOS。 [测试源码](../../../test/browser-sign-in.test.ts) · [浏览器和模型记录](../../experiments/2026-11-27-browser-sign-in-handoff.json)

启用本机浏览器驱动时，新任务保存启动时的驱动指纹。重启后只安装对应驱动的工具。已打开任务的 MCP 工具也在派发时校验指纹。合成回归在同一任务里验证替换驱动遭到拒绝、重启暂缺原驱动、接回原驱动后继续。 [OpenMausBot 的指定电脑入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-catalog.ts#L154) · [本地回归](../../../test/browser-sign-in.test.ts)
