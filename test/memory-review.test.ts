import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalDiscovery } from '../src/discovery.js';

test('reviewed memory stays out of recall until accepted and decisions survive reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-memory-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home'), project = join(directory, 'project'), other = join(directory, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  const data = join(directory, 'data');
  let discovery = new LocalDiscovery(data, { home });
  const quote = 'Use a short review summary.';
  await discovery.memoryView(project);
  await discovery.memory.setReview(project, true);
  const writer = () => discovery.memory.extension('review-task', home, () => discovery.load(), async () => [quote], project)
    .tools!.find(tool => tool.name === 'user_remember')!;
  const args = { facts: [{ text: quote, category: 'preferences', scope: 'project', certainty: 'stated',
    evidence: [{ sourceId: 'user', quote }] }] };
  await writer().execute(args, { taskId: 7 }, {});
  assert.equal((await discovery.memoryView(project)).facts.some(fact => fact.text === quote), false);
  const [candidate] = await discovery.memory.listCandidates(home, project);
  assert.equal(candidate.text, quote);
  assert.equal(candidate.status, 'pending');
  await writer().execute(args, { taskId: 7 }, {});
  assert.equal((await discovery.memory.listCandidates(home, project)).length, 1);
  await assert.rejects(discovery.memory.decideCandidate(home, other, candidate.id, 'accept'), { status: 404 });
  await discovery.memory.setCapture(project, false);
  await assert.rejects(discovery.memory.decideCandidate(home, project, candidate.id, 'accept'), { status: 409 });
  await discovery.memory.setCapture(project, true);
  const accepted = await discovery.memory.decideCandidate(home, project, candidate.id, 'accept');
  assert.equal(accepted.status, 'accepted');
  assert.equal((await discovery.memoryView(project)).facts.filter(fact => fact.text === quote).length, 1);
  discovery = new LocalDiscovery(data, { home });
  assert.deepEqual(await discovery.memory.decideCandidate(home, project, candidate.id, 'accept'), accepted);
  await assert.rejects(discovery.memory.decideCandidate(home, project, candidate.id, 'reject'), { status: 409 });
  assert.equal((await discovery.memory.reviewSettings(project)).enabled, true);

  const rejectedArgs = { facts: [{ ...args.facts[0], text: 'A different derived preference', certainty: 'inferred' }] };
  await writer().execute(rejectedArgs, { taskId: 8 }, {});
  const rejected = (await discovery.memory.listCandidates(home, project)).find(item => item.status === 'pending')!;
  await discovery.memory.decideCandidate(home, project, rejected.id, 'reject');
  const snapshots = await readdir(join(discovery.directory, 'memory-snapshots'), { recursive: true });
  await discovery.memory.setReview(project, false);
  await writer().execute(rejectedArgs, { taskId: 8 }, {});
  assert.equal((await discovery.memory.listCandidates(home, project)).find(item => item.id === rejected.id)?.status, 'rejected');
  assert.equal((await discovery.memoryView(project)).facts.some(fact => fact.text === 'A different derived preference'), false);
  assert.deepEqual(await readdir(join(discovery.directory, 'memory-snapshots'), { recursive: true }), snapshots);
  await discovery.memory.setReview(project, true);
  const otherWriter = discovery.memory.extension('another-review-task', home, () => discovery.load(), async () => [quote], project).tools![0]!;
  await otherWriter.execute(rejectedArgs, { taskId: 8 }, {});
  assert.equal((await discovery.memory.listCandidates(home, project)).filter(item => item.text === 'A different derived preference').length, 2);
});

test('a changed source cannot approve an earlier memory candidate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kada-memory-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home'), project = join(directory, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  const path = join(project, 'AGENTS.md');
  await writeFile(path, 'Write the project report in Chinese.');
  const discovery = new LocalDiscovery(join(directory, 'data'), { home });
  const original = (await discovery.memoryView(project)).facts.find(fact => fact.scope === 'project')!;
  await discovery.memory.setReview(project, true);
  const tool = discovery.memory.extension('review-task', home, () => discovery.load(), async () => [], project).tools![0]!;
  await tool.execute({ facts: [{ text: 'Chinese project reports', category: 'preferences', scope: 'project', certainty: 'stated',
    evidence: [{ sourceId: original.evidence[0].sourceId, quote: 'Write the project report in Chinese.' }] }] }, { taskId: 9 }, {});
  const [candidate] = await discovery.memory.listCandidates(home, project);
  await writeFile(path, 'Write the project report in English.');
  await discovery.memoryView(project);
  await assert.rejects(discovery.memory.decideCandidate(home, project, candidate.id, 'accept'), { status: 409 });
  assert.equal((await discovery.memoryView(project)).facts.some(fact => fact.text === candidate.text), false);
});
