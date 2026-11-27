# 手机 Web 录音转写

配对设备在现有聊天输入框录一段话，停止后由硅基流动转写，再由用户编辑和发送。OpenMausBot 在录音开始时绑定草稿 ID，转写返回时核查草稿版本，再把文本接到原草稿。其转写入口校验 WAV 和大小。 [草稿归属](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/src/lib/use-composer-dictation.ts#L30) · [音频入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/routes/tts.ts#L88)

- 先给配对门户加定向回归。验证匿名与跨站请求拒绝、类型和大小边界、合成录音进入现有供应商，以及转写完成时原消息列表仍为空。
- 在 `src/remote.ts` 复用配对会话和请求体上限，在 `src/runtime.ts` 与 `src/voice-notes.ts` 复用当前转写供应商和 WAV 校验。每台配对设备同一时间可转写一段。
- 在 `src/remote-page.ts` 使用浏览器录音。单段上限 30 秒，停止后编码为 16 kHz 单声道 WAV。切换会话、离开页面、发送文本或取消时放开麦克风。原草稿变化后，迟到结果不写入当前输入。成功时复用原输入保存和发送入口。
- 回归覆盖原草稿持久化、编辑后发送、取消和迟到响应。用本机 Chromium 模拟麦克风验证真实录音控件、WAV 上传和原会话发送。

## 验收

Chromium 的 390 × 844 视口使用浏览器模拟麦克风。取消第一段后，第二段上传一份 71,084 字节、16 kHz 的 WAV。转写使用合成供应商。刷新原会话保留转写文字，修改后由用户发送，模型收到一次最终文本。门户回归覆盖无效配对、跨站请求、超限音频和同一设备的并发请求。实体手机的录音权限、编码和供应商调用待验收。 [门户测试](../../../test/remote.test.ts) · [草稿测试](../../../test/remote-pending-page.test.ts) · [本机供应商实测](2026-11-26-voice-notes.md#验收)

## 手机播放原答复

OpenMausBot 从已结束回合选取原答复，并把生成的音频放进该消息的语音控件。Kada 的配对门户允许用户按一条原答复发起合成，复用 Pi 会话内的请求回执和 WAV 哈希校验。 [固定原答复](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/host/reply-voice-notes.ts#L91) · [播放控件](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/src/components/VoiceNoteBubble.tsx#L90)

- 门户按当前配对和原会话核对答复条目。只有有文本的助手答复可朗读，合成请求重复到达时返回原文件。
- 手机页面取得音频后在原消息显示浏览器播放控件，切换会话或离开页面释放音频和等待中的请求。
- 验收覆盖答复之后产生新消息、后台重启、不使用新答复覆盖旧请求，以及其他配对无法朗读该会话。

Chromium 在手机尺寸下生成并播放了第一条答复的 1 秒合成 WAV，当时会话中已经有第二条答复。刷新后选择第一条，合成供应商仍只有一次请求。新建会话后页面音频控件清除。服务端回归核对同账号的另一台设备、用户消息、答复绑定和进程重启。实际硅基流动合成已在本机 CLI 验收，手机端使用合成测试服务。 [门户回归](../../../test/remote.test.ts) · [本机合成](2026-11-26-voice-notes.md#朗读原答复)
