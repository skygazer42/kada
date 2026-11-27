# 本机项目模型设置页

按 OpenMausBot 的原模型校验和默认设置更新机制，在本机浏览器接入 Kada 已有的模型连接检查、项目默认值和恢复全局值。入口绑定用户选择的项目，沿用本机看板的一次性链接和同源会话。 [OpenMausBot 模型更新及冲突校验](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/model-requests.ts#L306)

- 用户从终端为当前项目生成本机设置链接。浏览器会话可列出可用模型元数据、连接检查及当前生效值。
- 选择项目模型复用已有的成功连接检查。恢复全局值清除该项目的覆盖。浏览器在同一作用域内更新。
- 回归覆盖链接兑换、异项目请求拒绝、检查、保存、恢复和原会话的模型 pin。 [自动化测试](../../../test/project-model-page.test.ts)

Chromium 在 390 × 844 视口打开 CLI 生成的链接，实际调用硅基流动检查 Qwen。保存、重新加载与恢复 DeepSeek 全局模型均沿本机项目 API 完成。 [浏览器验收](../../experiments/2026-11-26-project-model-browser.json)
