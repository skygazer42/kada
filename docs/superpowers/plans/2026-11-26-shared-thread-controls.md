# 手机控制共享任务

Codync 从原任务详情读取执行状态，手机停止按钮把请求发给对应任务。Kada 已有设备自己的任务和共享工作项的执行控制，本次把同样的原任务状态检查接到共享会话。 [Codync 手机原任务操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/WorkThreadView.kt#L143)

## 契约

- 本机按配对设备和原任务 ID 授予控制权限。共享查看和结构化回复维持各自授权。撤回控制可保留查看，撤回会话共享同时移除控制权限。
- 手机查看待确认的方案、输入、范围、验收条件和总预算，确认携带显示的原修订与摘要。重试同一确认沿既有 Pi 提交回执。
- 暂停、继续和取消携带原任务的当前状态版本。手机继续沿原预算与截止时间，仅适用于设备已暂停且仍有预算的原任务。本机暂停和过期状态沿现有本机处理入口。

## 实施与验收

- [x] 扩展配对授权、owner CLI、共享会话的确认和控制入口。验证状态冲突、权限撤回和原提交重用。 [接口回归](../../../test/shared-thread-controls.test.ts)
- [x] 手机详情呈现可授权的原方案和当前可用控制，覆盖轮询、迟到响应和聊天草稿。 [页面回归](../../../test/remote-pending-page.test.ts)
- [x] Chromium 窄屏验证原任务控制，硅基流动验证手机确认推动原 Pi 任务执行。

## 共享任务账户授权

本机 owner 按配对账户为原任务授予查看或结构化回复。已验收文件下载和原任务控制各有单独的权限。请求绑定原配对，再按同一账户的当前角色检查，重启后新配对设备沿原账户读取角色。设备直接获授的权限也参与访问判断。 [OpenMausBot 账户角色更新和会话撤回](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/cloud-team-roster.ts#L87) · [Codync 原任务操作](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/android/app/src/main/kotlin/com/codync/android/WorkThreadView.kt#L143)

回归通过终端授予查看，原任务的准备说明在重启后由新设备确认。该设备答复原问题，任务沿同一已确认预算交付。另验收独立授予和撤回产物下载、旧设备授权以及非本账户的访问拒绝。 [账户回归](../../../test/shared-thread-controls.test.ts)

## 验收结果

- 相关回归 76 项通过。追加的普通聊天暂停和本机恢复用例确认旧控制版本会失效。共享方案的确认和继续分别复用原 Pi 提交与原预算。
- 整仓检查 658 项通过，4 项可选 Office 案例跳过。类型检查、构建、笔记校验和提交候选检查通过。
- Chromium 在 390 × 844 视口核对授权前后显示、原方案输入与命令、确认、暂停、重载后继续、取消及撤回。测试夹具接受取消提示，普通聊天草稿仍存在。 [浏览器记录](../../experiments/2026-11-26-shared-thread-control-browser.json)
- DeepSeek V3.2 用两次硅基流动请求完成准备和交付，验收脚本指定两次调用的工具。配对设备确认的是原方案，重启后重放采用原提交和交付。 [实测](../../experiments/2026-11-26-shared-thread-controls-siliconflow.json)
