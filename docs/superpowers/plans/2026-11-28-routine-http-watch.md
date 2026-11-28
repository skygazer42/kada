# HTTPS 变化预检查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 公开 HTTPS 未变化时不启动模型，变化后沿原发生项执行或通知。

**Architecture:** 一次受限 GET 与指纹模块接入原 Pi precheck；baseline、变化受理和通知保存沿原规则事务与回执。没有新的执行循环或状态存储。

**Tech Stack:** TypeScript、Node 24 HTTPS、已安装 Pi 1.4.0。

**Spec:** [行为、网络边界与固定参考](../specs/2026-11-28-routine-http-watch-design.md)

## Global Constraints

- 仅公开 443 HTTPS GET，无认证、Cookie、正文、重定向或模型检查。
- 15 秒总限时、1,000,000 字节、JSON 深度 64；错误保留原基线。
- 只扩展原 precheck，原有其他检查语义保持；HTTP task 默认 skip overlap。
- 保存及历史不包含响应正文；实际公网只验证公开无需凭据资源。

## Review Focus

- DNS、状态码和内容错误不能成为成功指纹，也不能暴露 URL 令牌。
- 取消与目录/规则修订后的迟到响应不能写入原基线。
- 原任务受理失败后，同一变化必须保持可触发。
- 通知写入与任务受理都只在成功后推进变化基线。
- 强杀后原 claim、基线及 taskId 不重复；其他 precheck 不变。

## Task 1: 受限读取与稳定指纹

**Files:** 新 src/routine-http.ts、test/routine-http.test.ts；src/mcp-tools.ts 导出已有 stableJson。

**Interfaces:** RoutineHttpCheck={url:string;track?:string[]}；normalizeRoutineHttp(input:unknown)；sampleRoutineHttp(check, signal?, network?) 返回 {sha256}。网络复用已有 lookup/request 类型，所有安全判断继续执行。

- [ ] 先写并运行失败测试：规范化、JSON/track 指纹、请求固定及网络拒绝。
- [ ] 实现原始响应限额、固定 DNS、取消和安全错误；复用公网地址及稳定 JSON。
- [ ] 验证重复身份、噪音字段、内容信封、超深/超大输入和 DNS 迟到失败。

## Task 2: Pi 发生项、入口与恢复

**Files:** src/routines.ts、src/runtime.ts、新 test/routine-http-watch.test.ts 及恢复 fixture；说明、矩阵和既有决策记录。

**Interfaces:** precheck.http；LocalRoutineOptions.http 和 RuntimeOptions.routineHttp 注入一次读取依赖。原发生项预检状态使用已有 baseline/unchanged/changed/failed。

- [ ] 先写 baseline→重启→unchanged→changed 失败测试，再把检查接入原 samplePrecheck。
- [ ] 首次在原采样事务保存基线；任务/通知成功再更新变化基线，保留原未知效果与修订检查。
- [ ] 覆盖运行失败、通知、暂停/更新/取消、Run now、原回执及实际强杀恢复。
- [ ] 从 CLI/API 保存、读取并运行；真实公共 HTTPS 验证仅做安全读取，记录脚本化对照及局限。
- [ ] 更新 Spec/使用说明/矩阵；聚焦测试、独立审查后冻结代码跑全量 check，提交并仅推送 Fork。
