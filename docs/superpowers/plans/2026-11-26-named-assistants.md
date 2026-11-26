# 命名助手实现计划

> 按 superpowers:executing-plans 与 TDD 在现有 Fork 功能分支实施，原 Pi 运行、预算和持久任务保持。

**Goal:** owner 保存具名角色和明确版本，通过原 chat/run 选择，实际工具范围在主/子会话及恢复后保持。

**Architecture:** 原子 JSON 只保存角色业务配置；TaskMeta 固定必要快照，Pi section、工具选择与 ToolTask 钩子执行该快照。原后台工具配置与命令核验入口必须取同一范围。

**Tech Stack:** 现有 Node.js、TypeScript、Pi 1.4.0、原子 JSON 和 owner API/CLI，无新增依赖。

**Spec:** [字段、接口、固定源码与原生实验](../../specs/2026-11-26-named-assistants.md)。

## Global Constraints

- 配置保存不开始任务；原默认、远程、工作项和例行任务不自动选角色。
- 新选择要求同项目、ID、修订和未归档；原任务固定模型/指令/工具，目录编辑不追随。
- modelTools 只管可见，tools 可被 addTools 扩大；固定执行钩子检查每次调用。
- 后台子任务显式 tools、嵌套调用、按需加载和命令核验均不能扩大角色范围；本机工具限制不宣称 OS 沙箱。
- 只有 Fork 提交，无上游 PR。角色模型管理、团队、私有电脑/记忆等仍为后续差距。

## Review Focus

原任务重放不得重新读取角色最新版；角色同名/跨项目/归档选择；后台工具覆盖与 nested/load 绕过；模型借检查命令执行；旧任务及原用户确认/预算行为。每项在对应任务留下有副作用或原状态断言。

### Task 1：角色目录与修订

创建 src/assistants.ts、test/assistants.test.ts。记录采用 Spec 字段，项目复用 memoryProject、模型校验复用 validateModel，写入沿 atomicJson/SerialQueue。

- [x] 先写失败测试并运行：创建/读改/归档/恢复、重复名与并发修订、坏文件不清空、模型/字段验证、同项目子目录选择与外项目拒绝。
- [x] 最小实现 Assistants 的 list/get/create/update/select；不产生 Pi 任务或新数据库。

### Task 2：Pi 角色快照与执行范围

创建 src/assistant-policy.ts，修改 src/runtime.ts、src/delegation.ts；新增 test/assistant-role.test.ts 和必要的恢复夹具。Runtime.create 接受 AssistantRef，TaskMeta 保存 AssistantPin。

- [x] 先写失败测试：角色指令/模型选择、普通无 Goal、编辑后原任务不变；直接/嵌套写、加载写、后台工具覆盖及命令核验不能绕过名单。
- [x] 复用原 configureStage 与 Pi 钩子，所有阶段与子任务安装同一个固定范围；普通任务不安装该策略。初次创建散列只在实际提供助手时加入引用，旧重放散列不变。
- [x] 核对真实命令入口并拒绝越界执行：当前 acceptance/CheckSchema 无 command 类型，不增加无效分支；criterion.verification 与 task_verify 要求 bash，嵌套调用再受 gate 约束。
- [x] 覆盖允许的执行交付、确认、同步/后台范围、原生压缩与实际 SIGKILL；重启不读新目录替换旧快照。

### Task 3：owner 与终端入口、完整验收

修改 src/server.ts、src/cli.ts、src/chat.ts；添加 API/终端测试。复用原 JSON 配置操作，chat/run 新建参数 --assistant ID@REVISION；接回原任务不能换角色。

- [x] 先写 owner/API 与客户端请求失败测试；实现列表、全量读回、创建与带修订编辑、状态身份展示。
- [x] 对照原调用补齐新参数，保留默认路径；新会话采用明确角色，配置过期报冲突，已有任务继续原版本。
- [x] 用硅基流动及合成角色/文件验证配置、聊天、执行和恢复；计入失败尝试、请求数与未知费用，原生 Pi 范围实验不冒称产品验收。
- [x] 聚焦 25 项与全量 524 项通过、4 项可选 Office 跳过，类型/构建通过；笔记转 implemented，同步 Spec/矩阵/使用入口。集成策略为 Fork 提交推送，独立审查收尾单列。

## 当前裁定与证据

目录、实际策略、Pi 主/子任务、MCP、压缩、SIGKILL 和 owner/CLI 共 25 项聚焦测试通过，类型/构建通过。后台原筛选只保留 coding-tools，会丢掉角色扩展；失败用例后已保留策略并收窄显式 tools/modelTools。

真实检查表没有 command 分支，研究阶段的宽泛描述已按实际代码收敛；原 task_plan 的说明同步为机械文件检查。角色输入指令保持原 Unicode/空白，更新的 undefined 可选字段不清除既有模型。capability 握手和已有任务消息拒绝换角色均有失败回归。

真实 DeepSeek 首轮确认模型提出的 30 秒预算后正确到限，无产物；第二轮明确采用配置的 180 秒及 100,000 token 并跳过可选计划，通过旧会话 v1/新会话 v2、原确认、写入一次及独立精确字节检查。两轮 12 次请求、41,924 已知 token，费用未知。后台待答后重启和加载脚本的额外范围断言再次通过，未新增产品权限。

TruffleHog 官方 3.100.1 扫描器已临时准备且归档校验和匹配；本地模式的 Windows atime 比较误判，采用支持的 commit 模式审查不可变 Git 内容。没有修改或跳过安全检查；审查结论待记录。
