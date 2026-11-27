# Agent Note: 在原工作区预览和恢复快照

Status: implemented

## Problem

终端已有快照与恢复，浏览器需要展示具体文件变化，并把确认传给原来的版本校验。

## Decision

浏览器会话绑定选定的本机任务。快照、预览和恢复都由 LocalRuntime 处理。恢复提交当前预览，碰到工作区变化或未结清运行时复用原保护和撤销记录。 [参考源码与验收](../../../../docs/superpowers/plans/2026-11-26-workspace-snapshot-page.md)

## Alternatives considered

由浏览器计算差异可减少一个接口请求，但页面无法验证当前磁盘字节和原任务状态。后端继续持有变更证据。

## Consequences

自动化覆盖作用域和过时预览。Chromium 验证原字节恢复及用上一份快照撤销。 [浏览器验收](../../../../docs/experiments/2026-11-26-workspace-snapshot-browser.json)
