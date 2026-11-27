# 群组交棒使用原附件

OpenMausBot 在接受交棒时保存实际文件并检查配额，交接绑定文件和原工作。Kada 让本机 owner 在群组发言时显式附带文件，复用原工作区的固定文件复制和 Pi 原输入。 [OpenMausBot 文件暂存](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/handoff-files.ts#L159) · [Rakazo 原交棒文件与链路](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L139)

- 每条群组输入可固定工作区内最多五个 UTF-8 文本附件，每份至多 1 MiB。收到文件的角色用明确选定的 `room_read_file` 工具按编号读取。
- 交棒沿同一轮已经固定的附件。用户或进程后续修改原文件时，接手角色沿原哈希读取副本。
- 获得 `room_attach_text` 的角色可以用文件名和文本内容创建本轮附件。用户附件和助手产出共用五个编号，产出绑定原成员、原工具调用和回交消息。接棒成员用同一个附件编号读取。 [OpenMausBot 原工作回交附件](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/handoff-files.ts#L234)
- 用 `rooms file 群组ID 消息ID 附件编号` 从本机找到原副本。读取前核对目录、原输入和文件哈希。
- 配对设备从获授权的原群组看到附件名称和大小。独立授予 `share-files` 后，可按同一条原消息下载哈希匹配的副本。撤回下载仍保留已经授予的查看和发言。 [OpenMausBot 文件回读](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/threads.ts#L249)

硅基流动 DeepSeek 经两次群内交棒，文件已在发言后改动，接手助手读到原附件中的 `EMBER-381`。重放原请求没有增加用量。自动化覆盖越界输入、错误编号、原副本更改及手机投影。 [供应商实测](../../experiments/2026-11-26-room-attachments-siliconflow.json) · [附件测试](../../../test/assistant-room-files.test.ts)

另一轮 DeepSeek 由 Lead 生成 `findings.txt`，交给 Reader 读取。本机按原附件消息查到同一份 `QUARTZ-196` 字节，重放复用原答复。 [文件回交实测](../../experiments/2026-11-26-room-attachment-publication-siliconflow.json)

Chromium 窄视口验收原入口展示、单独授权、内容相同的轮询之后下载固定字节，以及单独撤回下载。接口回归覆盖第二台设备、伪造权限、已有固定副本被改动和撤回查看后的拒绝。 [浏览器验收](../../experiments/2026-11-26-room-file-download-browser.json) · [接口回归](../../../test/shared-assistant-rooms.test.ts)
