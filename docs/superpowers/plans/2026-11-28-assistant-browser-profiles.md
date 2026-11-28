# 助手默认浏览器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 助手配置可选择已有浏览器，新直接任务和例行运行按原版本选择并固定会话。

**Architecture:** 增加可选 profile 引用并复用现有 Assistants 回执、ComputerBridge、create 和恢复路径。宿主仅传入已有目录回调，保存配置不启动或更换活动浏览器。

**Tech Stack:** TypeScript、Node 24、Pi 1.4.0、现有 agent-browser。

**Spec:** [用户行为与参考代码](../specs/2026-11-28-assistant-browser-profiles-design.md)

## Global Constraints

- 默认关闭不变，不新增依赖或执行系统。
- 字段不授权新工具，配对、协作者和群组不继承电脑执行权限。
- 保存时校验已有名称，启动时校验驱动；旧回执和任务先沿原身份读取。
- 新角色修订不改变旧任务的有效 profile、session、driver 或控制权。

## Review Focus

- 原 profile 被删后，读取与归档可用；重复请求返回历史结果而不覆盖后续选择。
- 直接任务显式覆盖必须在新关联工作中保留，不能被源角色默认覆盖。
- 未连接或替换的驱动不能静默执行到另一浏览器。
- 配置页面失败及未知候选不能丢失原选项或草稿。
- 例行任务和成员配置不能绕开原工具权限。

## Task 1: 保存和应用助手 profile

**Files:** src/assistants.ts、src/runtime.ts、test/assistants.test.ts、test/assistant-browser-profiles.test.ts。

**Interfaces:** Definition 增加 browserProfile；Assistants 可接收读取已有名称的回调；null 清除。任务有效选择仍保存在原 TaskMeta 字段，不增加第二份运行状态。

- [ ] 先写并运行失败测试：配置修订/清除/回执和不可用名称拒绝；两角色默认、显式覆盖、目录更新及重启后原会话。
- [ ] 在原字段校验、公开读取、select 与保存处加入 profile；缺省保持旧行为，其他字段修改不要求过时选择仍可用。
- [ ] create 使用显式、继承实际选择、角色默认、宿主默认的顺序，摘要只包含显式参数。沿原驱动核对及元数据保存应用结果，继承场景核对源指纹。
- [ ] 补普通聊天确认、例行任务和关联工作测试，检查非执行阶段及 peers/room 的权限。

## Task 2: 配置入口与验收

**Files:** src/chat-assistants.ts、src/project-assistants-access.ts、src/project-assistants-page.ts、src/server.ts，原聊天/API 测试与文档。

**Interfaces:** assistant_catalog kind=browsers；项目页面 state.browserProfiles 仅名称和连接状态；所有写入沿 Assistants。

- [ ] 先验证目录读取、创建、修改、清除和历史回执的失败/成功路径，再接入工具 schema 与页面选择。
- [ ] 用 Chromium 检查选择/保存/重载、清除、失效值和失败输入保留；使用两个合成本地浏览器验证原接管与回交。
- [ ] 更新能力矩阵、使用说明和既有决策记录，分别记录直接任务默认与团队浏览器缺口。
- [ ] 跑相关回归、typecheck、build、提交内容检查和全量 check；独立审查后提交并推送 Fork，保持无上游 PR。
