# Agent Note: 本机浏览器项目模型设置

Status: implemented

## Problem

已有终端模型设置和聊天提案，浏览器用户也需要在明确的项目中检查模型、保存默认项和恢复全局值。

## Decision

模型页面复用项目浏览器会话机制，链接只兑换一次，每个页面持有独立会话存储。服务从会话取项目，检查与写入转给当前 ProviderSettings。已有运行沿原任务固定的模型。 [源码参考及验收](../../../../docs/superpowers/plans/2026-11-26-project-model-page.md)

## Alternatives considered

沿用工作看板已有会话能减少一个入口，但工作项授权会扩大到模型设置。共享底层会话实现并分别发放链接，保留原操作边界。

## Consequences

自动化验证项目范围、链接重用和旧任务模型 pin。Chromium 使用硅基流动检查后保存 Qwen，并恢复已有 DeepSeek 全局模型。 [真实浏览器验收](../../../../docs/experiments/2026-11-26-project-model-browser.json)
