import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { scriptedFixture } from './helpers.js';

const calendarServer = `
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const event = (id, summary, start, end, accountId = 'work') => ({ id, summary, start, end, accountId, description: 'private event notes' });
    const results = {
      initialize: { protocolVersion: request.params?.protocolVersion, serverInfo: {name:'calendar-fixture',version:'1'}, capabilities: {tools:{}} },
      'tools/list': { tools: [{ name: 'list-events', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] },
      'tools/call': { content: [{ type: 'text', text: JSON.stringify({ events: [
        event('all-day', 'All-day event', { date: '2026-10-31' }, { date: '2026-11-02' }),
        event('timed', 'Afternoon review', { dateTime: '2026-11-10T03:00:00Z' }, { dateTime: '2026-11-10T04:00:00Z' }),
        event('foreign', 'Other account', { date: '2026-11-18' }, { date: '2026-11-19' }, 'private'),
        event('outside', 'Other month', { date: '2026-12-02' }, { date: '2026-12-03' }),
      ] }) }] },
    };
    if (request.method === 'tools/call') {
      const args = request.params.arguments;
      if (request.params.name !== 'list-events' || args.account !== 'work' || args.calendarId !== 'primary' ||
          args.timeMin !== '2026-11-01T00:00:00' || args.timeMax !== '2026-12-01T00:00:00' || args.timeZone !== 'America/New_York') {
        results['tools/call'] = { isError: true, content: [{ type: 'text', text: 'Incorrect calendar query' }] };
      }
    }
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}));
  });
`;

test('the workboard reads one bound calendar in the selected month and honors current MCP permission', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('No model request is needed.'));
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port }, origin = `http://127.0.0.1:${port}`;
  let daemon = await serve(config, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(config);
  const mcp = daemon.runtime.mcp;
  await mcp.configure({ id: 'calendar', transport: 'stdio', command: process.execPath, args: ['-e', calendarServer] });
  const tested = await mcp.test('calendar');
  await mcp.enable('calendar', ['list-events'], tested.revision);
  const path = '/v1/work-items/calendar-source?workspace=' + encodeURIComponent(f.workspace);
  await client.request(path, 'PUT', { id: 'calendar', revision: tested.revision, account: 'work', calendarId: 'primary', timeZone: 'America/New_York' });
  await daemon.close();
  daemon = await serve(config, { models: f.models });
  const restored = await client.request<{source: {account: string}}>(path);
  assert.equal(restored.source.account, 'work');
  const foreign = join(f.directory, 'another-project');
  await mkdir(foreign);
  assert.deepEqual(await client.request('/v1/work-items/calendar?workspace=' + encodeURIComponent(foreign) + '&month=2026-11'),
    { configured: false, timeZone: null, events: [] });

  const { url } = await client.request<{ url: string }>('/v1/work-items/board-link', 'POST', { workspace: f.workspace });
  const session = await fetch(origin + '/workboard/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }) });
  const { token } = await session.json();
  const pathInBoard = origin + '/workboard/calendar?month=2026-11';
  assert.equal((await fetch(pathInBoard)).status, 401);
  const calendar = () => fetch(pathInBoard, { headers: { authorization: 'Bearer ' + token } });
  const result = await calendar();
  assert.equal(result.status, 200);
  const view = await result.json();
  assert.deepEqual(view.events.map(({ id, day }: { id: string; day: string }) => [id, day]), [['all-day', '2026-11-01'], ['timed', '2026-11-09']]);
  assert.doesNotMatch(JSON.stringify(view), /private event notes|Other account|Other month/);
  assert.equal(view.timeZone, 'America/New_York');
  const configPath = join(f.directory, 'calendar-config.json');
  await writeFile(configPath, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts',
    'work-items', 'calendar', '2026-11', '--workspace', f.workspace, '--config', configPath]);
  assert.deepEqual(JSON.parse(stdout), view);

  await daemon.runtime.mcp.setApproval('calendar', ['list-events'], tested.revision);
  const revoked = await calendar();
  assert.equal(revoked.status, 409);
  assert.match((await revoked.json()).error, /approval|审批/i);
});
