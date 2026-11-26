# 配对设备的共享会话目录

Codync 从工作行打开它的原线程并在重连后重新读取，nanoMuse 按同一个会话 ID 分页读取历史。Kada 在手机 Web 沿现有设备配对共享原本机会话。 [Codync 原线程入口](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/host/src/tui/manage/threads.rs#L130) · [nanoMuse 分页记录](https://github.com/nano-muse/nanoMuse/blob/09850259cab0/android/src/android/app/src/main/java/com/openminis/app/sandbox/offload/SessionsOffloadHandler.kt)

## 契约

- 本机 owner 给一个配对设备共享一个原会话 ID。手机目录、分页消息、留言和验证过的交付都从该会话取得。设备只看到获授权的发送会话链接。撤回共享或撤销配对同时撤回读取、下载和回复。
- 用户可在共享查看后，另外授予主会话结构化待答的回复权限。端上按显示的原问题 ID 回复，使用现有 Pi 答案确认和幂等回执。凭据请求在本机处理。方案确认和执行操作沿独立控制授权。 [执行控制](2026-11-26-shared-thread-controls.md)
- 使用现有门户的同源校验、设备凭据、回放与文件校验。原远程聊天和共享工作项沿各自现有权限继续使用。

## 实施与验收

- [x] `remote-devices` 与 owner CLI 管理共享和回复。门户 API 读取原会话、分页历史、留言、原文件和待答。覆盖无权限设备、复用请求、撤回与重新配对。 [接口回归](../../../test/shared-threads.test.ts)
- [x] 手机 Web 目录打开原会话。验证复览、翻页、回复、下载、撤回及当前聊天草稿。 [页面回归](../../../test/remote-pending-page.test.ts)
- [x] 使用 Chromium 窄视口验证门户交互，用硅基流动验证回复确实进入原会话。

## 验收记录

- Chromium 在 390 × 844 视口完成本机 CLI 授权、打开原会话、翻阅历史、回复、下载已验收文件、重载和撤回。设定浏览器下载目录后，正常点击保存的字节与原文件一致。撤回后页面清除原详情，原聊天草稿保留。 [窄视口记录](../../experiments/2026-11-26-shared-thread-browser.json)
- DeepSeek V3.2 通过硅基流动用两次请求完成原结构化提问与配对设备的回复。重启复用原任务和提交，重放成功且模型请求计数保持一致。 [实测](../../experiments/2026-11-26-shared-threads-siliconflow.json)
- 整仓检查 655 项通过，4 项可选 Office 案例跳过。最终 74 项相关回归包含撤回后仍在途的旧详情响应，类型检查、构建、笔记校验及提交候选检查通过。
