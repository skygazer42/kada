# 工作项分配具名助手

Suparagent 工作项保存独立的角色引用，新增或更换时核验原 owner。实际开工用工作项修订和一次请求生成原运行。Kada 将单一角色限定在同项目的命名助手，并在开工时沿原 Pi 任务入口固定指令、模型和工具权限。 [分配字段](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L42) · [原 owner 校验](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L59) · [原工作项启动](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/routers/work_planner.py#L37)

- 工作项保存助手 ID、修订和当时的名称。选择、改派和清空沿同一个保存入口和原修订。用户可用本机看板、工作项 API 或普通聊天更新。保存分配后由用户从原工作项发起运行。
- 新运行验证当前角色可用，并固定当时选定的原版本。配置变更后可重新分配。已有运行及其明确重试沿原任务保存的版本和确认。
- 验证跨项目拒绝、改派/清空、重启后原收据、角色修订冲突与看板实际选择。 [计划回归](../../../test/work-item-assignee.test.ts)

## 配对手机编辑

本机对每个配对设备单独授予原工作项的编辑权。手机可以保存名称、说明、状态、优先级、日期或时刻及其时区。原工作项 ID、当前修订和这台设备的请求 ID 一起校验，保存走原工作项的原子回执。编辑权限沿查看撤回，助手选择与运行确认沿各自入口。 [Suparagent 原编辑表单](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/frontend/components/chat/WorkItemEditor.tsx#L46) · [并发修订检查](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/services/work_planner.py#L96)

## 工作项账户授权

本机 owner 可用 `work-items grant-account ITEM ACCOUNT viewer|participant [edits] [controls]` 授权。查看者可读原工作项和运行，参与者也可答复原任务和子任务的待答。编辑工作项、暂停、继续或取消原运行分别按授予的权限检查。当前及以后配对的设备沿账户获得权限，多项授权可以叠加。用 `work-items accounts ITEM` 查阅，用 `work-items revoke-account ITEM ACCOUNT` 撤回。 [OpenMausBot 角色更新与撤回](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/cloud-team-roster.ts#L87) · [Suparagent 工作项与原运行](https://github.com/Anil-matcha/suparagent/blob/f2ae9d0f5cc4/backend/app/db/models/work_item.py#L31)

终端授权测试在重启后配对新设备，验证回答原子任务、原预算和回执、降级后分别判断答复与执行控制，以及撤回账户后仍按已有的设备授权访问。另验证独立编辑权、其他账户隔离和 owner 身份校验。Chromium 的 390 × 844 视口用合成工作项验证编辑原卡片、降级后只读、撤回后移出列表。 [工作项回归](../../../test/work-items.test.ts)

### 看板账户管理

本机 owner 用 `work-items board-link --manage-sharing --workspace 路径` 打开授权管理看板。卡片的账户区域展示当前角色和独立权限，保存及撤回复用账户授权的存储。授权管理会话绑定原项目，普通看板会话仍只具备项目看板权限。 [OpenMausBot 本机授权保存与撤回](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/src/components/ComputerSharingSettings.tsx#L84)

接口回归验证普通看板拒绝授权写入，授权管理链接拒绝其他项目和 owner API，配对设备沿原账户获得权限并随着撤回失去权限。Chromium 的 390 × 844 视口通过终端生成链接，验证原卡片授权、重载、降级和撤回，也验证未保存的卡片名称在操作权限时保留。 [看板回归](../../../test/workboard.test.ts)

## 验收

- 本机验证同项目助手目录、固定修订、重启接回原工作及档案变更后的重放。Chromium 验证看板分配、重载和清空原卡片。[工作项回归](../../../test/work-item-assignee.test.ts)
- 硅基流动 DeepSeek V3.2 先保存并分配一张待办，用户启动原卡后，所选助手生成待确认方案。首次准备因夹具缺文件与格式要求进入澄清，补齐合成 `sample.json` 后通路通过。 [实测记录](../../experiments/2026-11-26-work-item-assignee-siliconflow.json)
- 手机接口验证不同授权、同一请求重试、旧修订和撤回。Chromium 验证本机并发修改后保留手机草稿，再显式加载原卡片的最新字段。 [手机接口回归](../../../test/work-items.test.ts) · [浏览器验收](../../experiments/2026-11-26-work-item-mobile-edit-browser.json)
