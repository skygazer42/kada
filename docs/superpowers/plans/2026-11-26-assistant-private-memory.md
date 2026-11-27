# 命名助手的私有记忆

项目助手可选择共享或私有记忆。本机直接启动的命名助手按原任务所选的范围保存与检索。私有记录按助手 ID 保存，由用户原话支持。改动在新会话生效，角色归档或切换范围后，已有私有记录仍可由本机 owner 管理。

Rakazo 在装配检索和保存对话时解析同一个助手记忆范围，并以 Bot 身份保存。Kada 让扫描、原记忆工具、复核和历史检索都读取原角色配置。私有角色沿用项目的记录和复核开关。共享工作区文件与用户显式转交的内容按原工具权限处理。 [范围解析](https://github.com/elie222/rakazo/blob/e64d73292179/packages/db/src/bots/memory-config.ts#L10) · [运行装配](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/runs/assembly/run-assembly-records.ts#L414) · [原对话保存](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/memory/conversation-memory.ts#L346)

自动化验证同项目的两位私有助手只检索各自保存的事实和原会话，项目任务目录按同一范围显示。候选审批继承项目复核设置。角色改回共享并重启后，旧会话和终端 `/memory list` 仍读取原范围。owner API 拒绝未认证和跨项目查询。 [回归](../../../test/assistant-memory.test.ts)

390 像素宽的 Chromium 从终端设置链接保存私有范围并重载，再将角色改回共享并验证新修订。 [助手设置入口](2026-11-26-project-assistants-page.md)

硅基流动的 DeepSeek-V3.2 运行 `A04-private-memory`。助手保存一条带原文的私有偏好，owner 复核后重启。在新的同角色会话中，模型用原记忆工具找回偏好。另一个角色及共享视图均查不到该条事实。共 4 次模型请求、15,516 token。 [真实模型记录](../../experiments/2026-11-26-assistant-private-memory-siliconflow.json)
