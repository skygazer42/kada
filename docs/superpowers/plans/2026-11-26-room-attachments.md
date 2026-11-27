# 群组交棒使用原附件

OpenMausBot 在接受交棒时保存实际文件并检查配额，交接绑定文件和原工作。Kada 让本机 owner 在群组发言时显式附带文件，复用原工作区的固定文件复制和 Pi 原输入。 [OpenMausBot 文件暂存](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/handoff-files.ts#L159) · [Rakazo 原交棒文件与链路](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/bots/group-handoff.ts#L139)

- 每条群组输入可固定工作区内最多五个 UTF-8 文本附件，每份至多 1 MiB。收到文件的角色用明确选定的 `room_read_file` 工具按编号读取。
- 交棒沿同一轮的用户原附件。模型提供的路径不会增加已固定附件。用户或进程后续修改原文件时，接手角色沿原哈希读取副本。
- 用 `rooms file 群组ID 消息ID 附件编号` 从本机找到原副本。读取前核对目录、原输入和文件哈希。
- 配对设备从获授权的原群组看到附件名称和大小。本机上传与只读交棒是当前实施范围，群内模型生成文件及远程附件编辑继续单独实现。

硅基流动 DeepSeek 经两次群内交棒，文件已在发言后改动，接手助手读到原附件中的 `EMBER-381`。重放原请求没有增加用量。自动化覆盖越界输入、错误编号、原副本更改及手机投影。 [供应商实测](../../experiments/2026-11-26-room-attachments-siliconflow.json) · [附件测试](../../../test/assistant-room-files.test.ts)
