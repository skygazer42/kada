# 本机录音转写

OpenMausBot 逐次受理 WAV 音频、校验长度后交给选定的语音供应商，单独返回转写文本。Kada 从原会话的工作区读取用户指定的 WAV，使用硅基流动 SenseVoiceSmall 转写并保存原会话回执。 [OpenMausBot WAV 验证与转写](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/tts.ts#L88) · [硅基流动转写接口](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post)

- 本机 owner 用 `voice transcribe TASK WAV REQUEST` 明确提交录音。只读取原工作区内至多 5 MiB 的 WAV。回执保存原文件身份、哈希和转写文本。
- 用 `voice show TASK REQUEST` 读取保存的文本。用 `voice send TASK REQUEST` 将这一条作为原会话的新输入。重新打开会话和重放发送都沿同一标识。
- 相同请求和文件返回原转写。录音改动与同一请求冲突，供应商请求中断且没有回执时须显式使用新请求。

## 朗读原答复

`voice render TASK REQUEST` 选取原会话已保存的最后一条助手答复，读取它的 Pi 条目编号，再用 CosyVoice2 生成 WAV。文本和音频有明确上限。文件保存在原任务数据目录，重试沿原答复和已保存文件。用 `voice play TASK REQUEST` 打开原 WAV，先校验文件哈希。 [OpenMausBot 语音路由](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/tts.ts) · [硅基流动语音合成](https://docs.siliconflow.com/en/api-reference/audio/create-speech.md)

## 验收

原 CLI 路径使用 Windows 合成录音调用 SenseVoiceSmall。转写正确识别了数字 42，误识别项目名 Kada。查看转写、重复发送一次和 CosyVoice2 合成真实 WAV 均通过。合成音频引用同一条 Pi 答复，重试保留原文件。麦克风录音、手机语音入口与实体扬声器另需实机。 [测试与恢复](../../../test/voice-notes.test.ts) · [供应商实测](../../experiments/2026-11-26-voice-notes-siliconflow.json)
