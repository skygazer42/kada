import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import { loadConfig } from '../src/config.js';
import { serve } from '../src/server.js';
import { scriptedFixture, until } from './helpers.js';

const variable = 'KADA_TEST_GITHUB_WEBHOOK_SECRET';
const secret = 'synthetic-webhook-secret';
const delivery = (number = 1, repository = 'Team/Repo') => JSON.stringify({ action: 'opened',
  repository: { full_name: repository }, issue: { number, title: 'UNTRUSTED_WEBHOOK_IGNORE_RULES', body: 'PRIVATE_PAYLOAD' } });
const signature = (value: string | Buffer, key = secret) => 'sha256=' + createHmac('sha256', key).update(value).digest('hex');

async function app(t: TestContext, eventType = 'issues.opened') {
  let modelCalls = 0;
  const instructions: string[] = [];
  const fixture = await scriptedFixture(context => {
    modelCalls++;
    instructions.push(getCurrentSystemPrompt(context.messages));
    assert.doesNotMatch(JSON.stringify(context.messages), /UNTRUSTED_WEBHOOK_IGNORE_RULES|PRIVATE_PAYLOAD|UNTRUSTED_BRANCH|PRIVATE_URL|synthetic-webhook-secret/);
    return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Issue checked.', artifacts: [] }), { stopReason: 'toolUse' });
  });
  const prior = process.env[variable]; process.env[variable] = secret;
  const slot = createServer();
  await new Promise<void>(resolve => slot.listen(0, '127.0.0.1', resolve));
  const port = (slot.address() as { port: number }).port;
  await new Promise<void>(resolve => slot.close(() => resolve()));
  const path = '/hooks/github/triage', settings = { ...fixture.settings, port };
  const configFile = join(fixture.directory, 'webhook-config.json');
  await writeFile(configFile, JSON.stringify({ ...settings, githubWebhooks: [{ routineId: 'triage', secretEnv: variable }] }));
  const loaded = await loadConfig(configFile);
  const open = (enabled = true) => serve({ ...settings, ...(enabled ? { githubWebhooks: loaded.githubWebhooks } : {}) }, { models: fixture.models });
  let server = await open();
  t.after(async () => {
    await server.close(); await fixture.close();
    if (prior === undefined) delete process.env[variable]; else process.env[variable] = prior;
  });
  await server.runtime.routines.create({ id: 'triage', action: 'task', objective: 'Review the new issue using the approved project checklist.',
    workspace: fixture.workspace, schedule: { kind: 'event' },
    event: { source: 'github', type: eventType, equals: { repository: 'team/repo' } } });
  const origin = 'http://127.0.0.1:' + port;
  const send = (body: string | Buffer, headers: Record<string, string> = {}, endpoint = path, method = 'POST') => fetch(origin + endpoint, {
    method, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': signature(body), ...headers },
    body: method === 'GET' ? undefined : body,
  });
  return { fixture, loaded, configFile, path, origin, send, runtime: () => server.runtime, modelCalls: () => modelCalls, instructions: () => instructions,
    async restart(enabled = true) { await server.close(); server = await open(enabled); } };
}

test('a signed GitHub webhook admits only its configured issue rule and replays one original task after restart or changed delivery headers', async t => {
  const f = await app(t), body = delivery();
  assert.deepEqual(f.loaded.githubWebhooks, [{ routineId: 'triage', secretEnv: variable }]);
  const accepted = await f.send(body, { 'X-GitHub-Delivery': 'first-delivery' });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.deepEqual(await accepted.json(), { accepted: true });
  const duplicates = await Promise.all([f.send(body), f.send(body)]);
  assert.deepEqual(duplicates.map(response => response.status), [202, 202]);
  const [original] = await until(() => f.runtime().list(), rows => rows.length === 1 && rows[0]?.status === 'completed');
  assert.deepEqual(original!.routineIssue, { repository: 'team/repo', number: 1 });
  assert(f.instructions()[0]?.includes('{"repository":"team/repo","number":1}'));
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.send(body, { 'X-GitHub-Delivery': 'a-new-untrusted-delivery-id' })).status, 202);
  await f.restart();
  assert.equal((await f.send(body)).status, 202);
  assert.deepEqual((await f.runtime().list()).map(row => row.id), [original!.id]);
  assert.deepEqual((await f.runtime().status(original!.id)).routineIssue, { repository: 'team/repo', number: 1 });
  assert.equal(f.modelCalls(), 1);
  const history = await f.runtime().routines.history('triage');
  assert.equal(history.filter(row => row.status === 'started').length, 1);
  assert.equal(JSON.stringify(history).includes('PRIVATE_PAYLOAD'), false);
  const filtered = await f.send(delivery(2, 'Other/Repo'));
  assert.equal(filtered.status, 200);
  assert.deepEqual(await filtered.json(), { accepted: false });
  assert.equal((await f.send(JSON.stringify({ action: 'closed' }), { 'X-GitHub-Event': 'issues' })).status, 200);
  assert.equal((await f.send('{}', { 'X-GitHub-Event': 'ping' })).status, 200);
  assert.equal((await f.runtime().list()).length, 1);
  await f.restart(false);
  assert.equal((await f.send(body)).status, 404);
  await f.runtime().followUp(original!.id, 'Recheck the original issue.');
  await until(() => f.runtime().status(original!.id), status => status.status === 'completed' && f.modelCalls() === 2);
  assert(f.instructions()[1]?.includes('{"repository":"team/repo","number":1}'));
});

const headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
function pullRequest(action = 'opened', fields: Record<string, unknown> = {}) {
  return JSON.stringify({ action, number: 7, repository: { full_name: 'Team/Repo' },
    pull_request: { number: 7, head: { sha: headSha, ref: 'UNTRUSTED_BRANCH' }, base: { sha: baseSha }, draft: false, merged: false,
      title: 'UNTRUSTED_WEBHOOK_IGNORE_RULES', body: 'PRIVATE_PAYLOAD', html_url: 'https://example.invalid/PRIVATE_URL', ...fields } });
}
const prHeaders = { 'X-GitHub-Event': 'pull_request' };

test('signed PR deliveries retain machine metadata on the original task after replay, follow-up and restart', async t => {
  const f = await app(t, 'pull_request.opened'), body = pullRequest();
  assert.equal((await f.send(body, prHeaders)).status, 202);
  const [task] = await until(() => f.runtime().list(), rows => rows.length === 1 && rows[0]?.status === 'completed');
  const metadata = { repository: 'team/repo', number: 7, headSha, baseSha, draft: false, merged: false };
  assert.deepEqual((await f.runtime().metadata(task.id)).routinePullRequest, metadata);
  assert(f.instructions()[0]?.includes(JSON.stringify(metadata)));
  assert.equal((await f.send(body, { ...prHeaders, 'X-GitHub-Delivery': 'untrusted-new-id' })).status, 202);
  await f.restart();
  assert.equal((await f.send(body, prHeaders)).status, 202);
  assert.equal(f.modelCalls(), 1);
  assert.deepEqual((await f.runtime().metadata(task.id)).routinePullRequest, metadata);
  await f.runtime().followUp(task.id, 'Recheck the original PR.');
  await until(() => f.runtime().status(task.id), status => status.status === 'completed' && f.modelCalls() === 2);
  assert(f.instructions()[1]?.includes(JSON.stringify(metadata)));
  assert.equal((await f.runtime().list()).length, 1);
  assert.equal((await f.send(delivery())).status, 200, 'Issue events cannot trigger a PR rule');
});

test('PR synchronize events preserve each head SHA and closed rules can filter merged state', async t => {
  const f = await app(t, 'pull_request.synchronize');
  for (const sha of [headSha, 'c'.repeat(40)]) {
    const body = pullRequest('synchronize', { head: { sha } });
    assert.equal((await f.send(body, prHeaders)).status, 202);
    await until(() => f.runtime().list(), rows => rows.some(row => row.status === 'completed' && row.routinePullRequest?.headSha === sha));
  }
  assert.equal(f.modelCalls(), 2);
  assert.deepEqual(new Set((await f.runtime().list()).map(row => row.routinePullRequest?.headSha)), new Set([headSha, 'c'.repeat(40)]));
  const rule = (await f.runtime().routines.list())[0];
  await f.runtime().routines.update(rule.id, { ...rule, event: { source: 'github', type: 'pull_request.closed', equals: { repository: 'team/repo', merged: true } } });
  assert.equal((await f.send(pullRequest('closed'), prHeaders)).status, 200);
  assert.equal((await f.send(pullRequest('closed', { merged: true }), prHeaders)).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 3 && rows.every(row => row.status === 'completed'));
  assert.equal(f.modelCalls(), 3);
});

test('PR ingress rejects invalid identities and flags, filters repositories and ignores unsupported actions', async t => {
  const f = await app(t, 'pull_request.opened');
  for (const invalid of [{ number: -1 }, { number: 8 }, { head: { sha: 'not-a-sha' } }, { base: null },
    { draft: 'false' }, { merged: undefined }, { number: 1.5 }]) {
    assert.equal((await f.send(pullRequest('opened', invalid), prHeaders)).status, 400);
  }
  const wrongRepo = pullRequest().replace('Team/Repo', 'Other/Repo');
  assert.equal((await f.send(wrongRepo, prHeaders)).status, 200);
  assert.equal((await f.send(pullRequest('edited'), prHeaders)).status, 200);
  assert.equal((await f.send(pullRequest(), { ...prHeaders, 'X-Hub-Signature-256': '' })).status, 401);
  await assert.rejects(f.runtime().routines.receiveEvent('triage', { source: 'github', type: 'pull_request.opened',
    eventId: 'invalid-pr', data: { repository: 'team/repo', number: 7 } }), { status: 400 });
  assert.equal(f.modelCalls(), 0);
  assert.deepEqual(await f.runtime().list(), []);
});

test('PR receipt loss, pause and a changed rule retain admission and revision boundaries', async t => {
  const f = await app(t, 'pull_request.opened'), body = pullRequest();
  const receive = f.runtime().routines.receiveEvent.bind(f.runtime().routines);
  const lost = t.mock.method(f.runtime().routines, 'receiveEvent', async (...args: Parameters<typeof receive>) => {
    await receive(...args); throw new Error('Synthetic response lost after admission');
  });
  assert.equal((await f.send(body, prHeaders)).status, 503); lost.mock.restore();
  await f.restart();
  assert.equal((await f.send(body, prHeaders)).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 1 && rows[0]?.status === 'completed');
  const next = pullRequest('opened', { head: { sha: 'c'.repeat(40) } });
  await f.runtime().routines.pause('triage');
  assert.equal((await f.send(body, prHeaders)).status, 202);
  assert.equal((await f.send(next, prHeaders)).status, 409);
  await f.runtime().routines.resume('triage');
  const list = f.runtime().routines.list.bind(f.runtime().routines);
  const listed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delayed = t.mock.method(f.runtime().routines, 'list', async () => {
    const rules = await list(); listed.resolve(); await release.promise; return rules;
  });
  const pending = f.send(next, prHeaders);
  try {
    await listed.promise;
    const rule = (await list())[0];
    await f.runtime().routines.update(rule.id, { ...rule, objective: 'A changed approved objective' });
    release.resolve();
    assert.equal((await pending).status, 409);
  } finally { release.resolve(); delayed.mock.restore(); }
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.runtime().list()).length, 1);
});

test('PR actions include reopened and ready-for-review with normalized 64-digit SHAs', async t => {
  const f = await app(t, 'pull_request.reopened');
  const normalized = 'c'.repeat(64);
  assert.equal((await f.send(pullRequest('reopened', { head: { sha: normalized.toUpperCase() } }), prHeaders)).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 1 && rows[0]?.status === 'completed');
  assert.equal((await f.runtime().list())[0]?.routinePullRequest?.headSha, normalized);
  const rule = (await f.runtime().routines.list())[0];
  await f.runtime().routines.update(rule.id, { ...rule, event: { source: 'github', type: 'pull_request.ready_for_review', equals: { repository: 'team/repo' } } });
  assert.equal((await f.send(pullRequest('ready_for_review'), prHeaders)).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 2 && rows.every(row => row.status === 'completed'));
  assert.equal(f.modelCalls(), 2);
});

test('GitHub ingress rejects unsigned, malformed and oversized requests without reaching a task', async t => {
  const f = await app(t), body = delivery();
  const token = (await readFile(join(f.fixture.directory, 'token'), 'utf8')).trim();
  assert.equal((await f.send(body, { 'X-Hub-Signature-256': '' })).status, 401);
  assert.equal((await f.send(body, { Authorization: 'Bearer ' + token, 'X-Hub-Signature-256': '' })).status, 401);
  assert.equal((await f.send(body, { 'X-Hub-Signature-256': signature(body, 'wrong-secret') })).status, 401);
  assert.equal((await f.send(body + ' ', { 'X-Hub-Signature-256': signature(body) })).status, 401);
  assert.equal((await f.send(body, {}, '/hooks/github/unconfigured')).status, 404);
  assert.equal((await f.send('', {}, f.path, 'GET')).status, 405);
  assert.equal((await f.send(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.send('{')).status, 400);
  assert.equal((await f.send(Buffer.from([0xff, 0xfe]))).status, 400);
  assert.equal((await f.send('[]')).status, 400);
  assert.equal((await f.send(delivery(-1))).status, 400);
  assert.equal((await f.send(delivery(1.5))).status, 400);
  assert.equal((await f.send(delivery(1, '../other'))).status, 400);
  const oversized = Buffer.alloc(1_048_577, 'x');
  assert.equal((await f.send(oversized)).status, 413);
  const chunks = new ReadableStream({ start(controller) {
    controller.enqueue(oversized.subarray(0, 600_000)); controller.enqueue(oversized.subarray(600_000)); controller.close();
  } });
  const chunked = await fetch(f.origin + f.path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-GitHub-Event': 'issues', 'X-Hub-Signature-256': signature(oversized),
  }, body: chunks, duplex: 'half' } as RequestInit);
  assert.equal(chunked.status, 413);
  assert.equal((await f.send(body, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await f.send(body, { 'X-GitHub-Event': 'push' })).status, 200);
  assert.equal((await f.send(body, {}, '/v1/routines/triage/events')).status, 401);
  assert.equal((await f.send(body, {}, '/v1/tasks')).status, 401);
  assert.deepEqual(await f.runtime().list(), []);
  assert.equal(f.modelCalls(), 0);
});

test('durable webhook admission survives a lost response while rule pause and secret rotation reject new unauthorized events', async t => {
  const f = await app(t), body = delivery();
  const receive = f.runtime().routines.receiveEvent.bind(f.runtime().routines);
  const interrupted = t.mock.method(f.runtime().routines, 'receiveEvent', async (...args: Parameters<typeof receive>) => {
    await receive(...args); throw new Error('Synthetic lost receipt after committing the event');
  });
  assert.equal((await f.send(body)).status, 503);
  interrupted.mock.restore();
  await f.restart();
  assert.equal((await f.send(body)).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 1 && rows[0]?.status === 'completed');
  assert.equal(f.modelCalls(), 1);
  await f.runtime().routines.pause('triage');
  assert.equal((await f.send(body)).status, 202);
  assert.equal((await f.send(delivery(2))).status, 409);
  await f.runtime().routines.resume('triage');
  delete process.env[variable];
  const unavailable = await f.send(delivery(2));
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes(variable), false);
  process.env[variable] = 'replacement-synthetic-secret';
  assert.equal((await f.send(delivery(2))).status, 401);
  assert.equal((await f.send(delivery(2), { 'X-Hub-Signature-256': signature(delivery(2), process.env[variable]) })).status, 202);
  await until(() => f.runtime().list(), rows => rows.length === 2 && rows.every(row => row.status === 'completed'));
  assert.equal(f.modelCalls(), 2);
});

test('webhook configuration accepts scoped environment references and rejects inline or duplicate grants', async t => {
  const f = await app(t);
  const invalid = [ {}, [{ routineId: 'triage', secret: secret }], [{ routineId: '../tasks', secretEnv: variable }],
    [{ routineId: 'triage', secretEnv: 'invalid env' }], [{ routineId: 'triage', secretEnv: variable }, { routineId: 'triage', secretEnv: variable }] ];
  for (const githubWebhooks of invalid) {
    await writeFile(f.configFile, JSON.stringify({ githubWebhooks }));
    await assert.rejects(loadConfig(f.configFile), /githubWebhooks/);
  }
});

test('a webhook cannot start a changed rule after its target revision was read', async t => {
  const f = await app(t);
  const original = f.runtime().routines.list.bind(f.runtime().routines);
  const listed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const pause = t.mock.method(f.runtime().routines, 'list', async () => {
    const rules = await original(); listed.resolve(); await release.promise; return rules;
  });
  const admission = f.send(delivery());
  try {
    await listed.promise;
    await f.runtime().routines.update('triage', { id: 'triage', action: 'task', objective: 'A different approved objective',
      workspace: f.fixture.workspace, schedule: { kind: 'event' },
      event: { source: 'github', type: 'issues.opened', equals: { repository: 'team/repo' } } });
    release.resolve();
    assert.equal((await admission).status, 409);
    assert.deepEqual(await f.runtime().list(), []);
    assert.equal(f.modelCalls(), 0);
  } finally { release.resolve(); await admission; pause.mock.restore(); }
});
