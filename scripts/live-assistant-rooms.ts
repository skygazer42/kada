import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Config } from '../src/config.js';
import { cloudModels } from '../src/models.js';
import { LocalRuntime } from '../src/runtime.js';

assert(process.env.SILICONFLOW_API_KEY?.trim(), 'Set SILICONFLOW_API_KEY to run the live room check.');
const directory = await mkdtemp(join(tmpdir(), 'kada-live-room-'));
const workspace = join(directory, 'workspace');
const model = { provider: 'siliconflow', modelId: 'Qwen/Qwen2.5-7B-Instruct' };
const secondModel = { provider: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-V3.2' };
const config: Config = { dataDir: directory, port: 4317, model, maxSubagents: 0, maxDurationMs: 90_000,
  maxTotalTokens: 16000, discovery: false, web: false };
const models = cloudModels();
let runtime = new LocalRuntime(config, { models });

async function reply(id: string, input: { memberId: string; requestId: string; message: string }) {
  await runtime.sendRoomMessage(id, input);
  const deadline = Date.now() + config.maxDurationMs + 3000;
  while (Date.now() < deadline) {
    const view = await runtime.roomDetails(id);
    if (!view.active) {
      const receipt = await runtime.sendRoomMessage(id, input);
      assert.equal(receipt.status, 'answered');
      return { receipt, entry: view.messages.find(message => message.id === receipt.answerEntryId)! };
    }
    await setTimeout(250);
  }
  throw new Error('Timed out waiting for a SiliconFlow room reply.');
}

try {
  await mkdir(workspace);
  const reader = await runtime.assistants.create({ workspace, name: '记录员', instructions: '房间编号是 RIVER-341。主人询问编号时只回复该编号。', model, tools: [] });
  const reviewer = await runtime.assistants.create({ workspace, name: '复核员',
    instructions: '根据最近公开群组消息回答。用户明确要求交棒时调用 room_handoff，直接把这轮交给指定成员。', model: secondModel, tools: ['room_handoff'] });
  const room = await runtime.createRoom({ workspace, title: '发布校验', members: [reader, reviewer].map(({ id, revision }) => ({ id, revision })) });
  const firstInput = { memberId: reader.id, requestId: 'record-code', message: '请告诉我房间编号，只回复编号。' };
  const first = await reply(room.id, firstInput);
  assert.equal(first.entry.memberId, reader.id);
  assert.match(first.entry.text, /RIVER-341/);
  const beforeRestart = (await runtime.status(room.id)).budget.totalTokens;
  await runtime.close();
  runtime = new LocalRuntime(config, { models });
  await runtime.recover();
  assert.deepEqual(await runtime.sendRoomMessage(room.id, firstInput), first.receipt);
  assert.equal((await runtime.status(room.id)).budget.totalTokens, beforeRestart);
  const second = await reply(room.id, { memberId: reviewer.id, requestId: 'read-code', message: '只回复上一位助手发在群组里的房间编号。' });
  assert.equal(second.entry.memberId, reviewer.id);
  assert.match(second.entry.text, /RIVER-341/);
  const thirdInput = { memberId: reviewer.id, requestId: 'handoff-code', message: '调用 room_handoff 把这一轮交给记录员，让记录员只回复房间编号。' };
  const third = await reply(room.id, thirdInput);
  assert.equal(third.entry.memberId, reader.id);
  assert.match(third.entry.text, /RIVER-341/);
  const final = await runtime.roomDetails(room.id);
  assert.deepEqual(final.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user', 'handoff', 'assistant']);
  assert.equal(final.messages[5]?.toMemberId, reader.id);
  assert.equal(new Set(final.messages.map(message => message.id)).size, 7);
  const status = await runtime.status(room.id);
  console.log(JSON.stringify({ provider: 'siliconflow', models: final.members.map(member => member.model.modelId), passed: true,
    roomTurns: 3, rootMessages: final.messages.length, handoffs: 1, replayUsedAdditionalTokens: false, totalTokens: status.budget.totalTokens,
    money: null, answers: [first.entry.text, second.entry.text, third.entry.text] }, null, 2));
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
}
