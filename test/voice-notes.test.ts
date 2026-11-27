import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { scriptedFixture, until } from './helpers.js';

function wave() {
  const buffer = Buffer.alloc(48);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(40, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(4, 40);
  return buffer;
}

test('a local voice note preserves the source bytes, stable transcription and one original chat input', async t => {
  const clip = wave(), modelInputs: string[] = [];
  let transcriptions = 0;
  const voiceTranscriber = async (audio: Uint8Array) => {
    transcriptions++;
    assert.deepEqual(Buffer.from(audio), clip);
    return 'The original voice note.';
  };
  const f = await scriptedFixture(context => {
    modelInputs.push(String(context.messages.findLast(message => message.role === 'user')?.content));
    return fauxAssistantMessage('Acknowledged.');
  }, {}, () => [], { voiceTranscriber });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const notePath = join(f.workspace, 'voice.wav');
  await writeFile(notePath, clip);
  await writeFile(join(f.workspace, 'wrong.wav'), 'This is not audio.');
  const chat = await runtime.create('Original text', f.workspace, [], { chat: true });
  await until(() => runtime.status(chat.id), row => row.status === 'answered');
  await assert.rejects(runtime.transcribeVoice(chat.id, { file: 'wrong.wav', requestId: 'invalid' }), /wav/i);
  await assert.rejects(runtime.transcribeVoice(chat.id, { file: '../voice.wav', requestId: 'outside' }), /outside/i);
  const input = { file: 'voice.wav', requestId: 'recording-1' };
  const receipt = await runtime.transcribeVoice(chat.id, input);
  assert.equal(receipt.text, 'The original voice note.');
  assert.equal(receipt.file.bytes, clip.length);
  assert.deepEqual(await readFile(notePath), clip);
  assert.deepEqual(await runtime.transcribeVoice(chat.id, input), receipt);
  assert.deepEqual(modelInputs, ['Original text']);
  assert.equal(transcriptions, 1);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, voiceTranscriber });
  await runtime.recover();
  assert.deepEqual(await runtime.voiceNote(chat.id, input.requestId), receipt);
  await writeFile(notePath, Buffer.concat([clip, Buffer.from([1])]));
  await assert.rejects(runtime.transcribeVoice(chat.id, input), /different source/i);
  await runtime.sendVoiceNote(chat.id, input.requestId);
  await until(() => runtime.status(chat.id), row => row.status === 'answered' && modelInputs.length === 2);
  await runtime.sendVoiceNote(chat.id, input.requestId);
  assert.deepEqual(modelInputs, ['Original text', receipt.text]);
  assert.equal(transcriptions, 1);
});

test('a voice provider attempt with no receipt keeps its original identity through restart', async t => {
  let attempts = 0;
  const voiceTranscriber = async () => { attempts++; throw new Error('Synthetic lost provider response.'); };
  const f = await scriptedFixture(() => fauxAssistantMessage('Ready.'), {}, () => [], { voiceTranscriber });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('Original conversation', f.workspace, [], { chat: true });
  await until(() => runtime.status(chat.id), row => row.status === 'answered');
  await writeFile(join(f.workspace, 'voice.wav'), wave());
  const input = { file: 'voice.wav', requestId: 'uncertain-voice' };
  await assert.rejects(runtime.transcribeVoice(chat.id, input), /lost provider response/i);
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, voiceTranscriber });
  await runtime.recover();
  await assert.rejects(runtime.transcribeVoice(chat.id, input), /new request ID/i);
  await assert.rejects(runtime.sendVoiceNote(chat.id, input.requestId), /no saved transcript/i);
  assert.equal(attempts, 1);
});

test('rendering a completed assistant reply records the original entry and reuses its audio after another turn', async t => {
  const clip = wave(), spoken: string[] = [];
  const voiceSynthesizer = async (text: string) => { spoken.push(text); return clip; };
  const f = await scriptedFixture(context => {
    const input = context.messages.findLast(message => message.role === 'user')?.content;
    return fauxAssistantMessage(input === 'Initial' ? 'Original assistant answer.' : 'Another assistant answer.');
  }, {}, () => [], { voiceSynthesizer });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const chat = await runtime.create('Initial', f.workspace, [], { chat: true });
  await until(() => runtime.status(chat.id), row => row.status === 'answered');
  const first = await runtime.renderVoiceReply(chat.id, 'read-reply');
  assert.deepEqual(spoken, ['Original assistant answer.']);
  assert.deepEqual(await readFile(first.file.path), clip);
  await runtime.followUp(chat.id, 'A different turn');
  await until(() => runtime.status(chat.id), row => row.status === 'answered' && row.messages.some(message =>
    message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === 'Another assistant answer.')));
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models, voiceSynthesizer });
  await runtime.recover();
  assert.deepEqual(await runtime.renderVoiceReply(chat.id, 'read-reply'), first);
  const next = await runtime.renderVoiceReply(chat.id, 'read-another');
  assert.notEqual(next.answerEntryId, first.answerEntryId);
  assert.deepEqual(spoken, ['Original assistant answer.', 'Another assistant answer.']);
  await writeFile(first.file.path, 'not a WAVE');
  await assert.rejects(runtime.voiceReplyFile(chat.id, 'read-reply'), /audio changed/i);
});
