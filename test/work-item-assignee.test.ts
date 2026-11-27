import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { LocalRuntime } from '../src/runtime.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('work items keep the chosen assistant revision and each original run across role edits and restart', async t => {
  let calls = 0;
  const f = await scriptedFixture(context => {
    calls++;
    assert(hasTool(context, 'task_prepare'));
    assert(JSON.stringify(context.messages).includes('ORIGINAL_ASSIGNEE_ROLE'));
    return fauxAssistantMessage(fauxToolCall('task_prepare', {
      outcome: 'Check the assigned task.', deliverables: ['A result'], inputs: [],
      criteria: [{ text: 'Review the example', method: 'inspect' }], scope: ['The workspace'],
      assumptions: [], questions: [],
    }), { stopReason: 'toolUse' });
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const workspace = f.workspace;
  const other = join(f.directory, 'foreign-project');
  await mkdir(other);
  const first = await runtime.assistants.create({ workspace, name: 'Reviewer', instructions: 'ORIGINAL_ASSIGNEE_ROLE', tools: ['read'] });
  const foreign = await runtime.assistants.create({ workspace: other, name: 'Foreign', instructions: 'Foreign role.', tools: [] });
  const ref = ({ id, revision }: { id: string; revision: number }) => ({ id, revision });
  const input = { workspace, title: 'Review the notes', objective: 'Check the sample notes.' };
  await assert.rejects(runtime.workItems.create({ ...input, assignee: ref(foreign) }), /this project/i);
  const created = await runtime.workItems.create({ ...input, assignee: ref(first) });
  assert.deepEqual(created.assignee, { ...ref(first), name: first.name });
  assert.equal(calls, 0);
  assert.deepEqual((await runtime.workItems.board(workspace)).assistants, [{ ...ref(first), name: first.name }]);
  assert.deepEqual(await runtime.workItems.runs(created.id), []);
  const runInput = { revision: created.revision, requestId: 'first-run' };
  const run = await runtime.workItems.run(created.id, runInput);
  assert.equal(run.assistant?.id, first.id);
  assert.equal(run.assistant?.revision, first.revision);
  await until(() => runtime.status(run.id), value => value.status === 'awaiting_confirmation');
  const revised = await runtime.assistants.update(first.id, { revision: first.revision, instructions: 'Revised role.' });
  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  assert.equal((await runtime.workItems.get(created.id)).assignee?.revision, first.revision);
  assert.equal((await runtime.workItems.run(created.id, runInput)).id, run.id);
  await assert.rejects(runtime.workItems.run(created.id, { ...runInput, requestId: 'stale-role' }), /current unarchived assistant revision/i);
  const reassigned = await runtime.workItems.update(created.id, { revision: created.revision, assignee: ref(revised) });
  assert.equal(reassigned.assignee?.revision, revised.revision);
  const unassigned = await runtime.workItems.update(created.id, { revision: reassigned.revision, assignee: null });
  assert.equal(unassigned.assignee, undefined);
  assert.equal((await runtime.metadata(run.id)).assistant?.instructions, 'ORIGINAL_ASSIGNEE_ROLE');
  assert.equal((await runtime.workItems.runs(created.id)).length, 1);
  assert.equal(calls, 1);
});
