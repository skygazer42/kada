# 本机项目助手设置

终端发放只绑定一个项目的一次性链接。浏览器列出该项目的助手，可创建并修改名称、说明、原指令、模型和允许的工具，也可归档或恢复。保存返回可用于新任务的助手 ID 和修订。已经开始的任务继续读取自己的 Pi 角色快照。

OpenMausBot 的实际创建路由保存角色指令、模型和工具范围。Rakazo 的设置读取提供已安装模型，同时从原记录读取配置。Kada 复用现有 `Assistants` 服务、固定修订与命令入口。 [OpenMausBot 创建路由](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/bots-create.ts#L212) · [Rakazo 角色设置读取](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/own-bot-settings.ts#L59)

自动化覆盖一次性链接、跨源拒绝、项目隔离、完整指令读取、重复创建、旧修订拒绝、归档和恢复。Chromium 完成创建、修改和重载。PowerShell 将带空格和单引号的工作区路径解析为同一个参数。 [自动化](../../../test/named-assistant-entry.test.ts) · [浏览器验收](../../experiments/2026-11-26-project-assistants-browser.json)
