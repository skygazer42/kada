import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { parseChart } from '../src/chart-preview.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

test('chart specs require finite aligned data and discard unrelated fields', () => {
  const base = { title: 'Chart', type: 'bar', labels: ['North'], series: [{ name: 'Net', values: [-1] }] };
  assert.deepEqual(parseChart(JSON.stringify({ ...base, external: 'ignored' })), base);
  assert.throws(() => parseChart(JSON.stringify({ ...base, series: [{ name: 'Wrong', values: [1, 2] }] })), /matching finite/i);
  assert.throws(() => parseChart(JSON.stringify(base).replace('[-1]', '[1e999]')), /matching finite/i);
});

test('local chart preview binds the verified original artifact and displays only trusted page code', async t => {
  let chartToolAvailable = false;
  const spec = { title: 'Original chart <2026>', type: 'line', labels: ['Nov', 'Dec'],
    series: [{ name: 'Revenue', values: [12, 17] }] };
  const fixture = await scriptedFixture(context => {
    chartToolAvailable = hasTool(context, 'save_chart');
    const wrote = context.messages.some(message => message.role === 'toolResult' && message.toolName === 'save_chart' && !message.isError);
    return fauxAssistantMessage(!chartToolAvailable || wrote
      ? fauxToolCall('task_submit', { summary: 'Original chart', artifacts: ['series.chart.json'] })
      : fauxToolCall('save_chart', { path: 'series.chart.json', spec }), { stopReason: 'toolUse' });
  });
  await fixture.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const settings = { ...fixture.settings, port };
  const server = await serve(settings, { models: fixture.models });
  t.after(async () => { await server.close(); await fixture.close(); });
  const path = join(fixture.workspace, 'series.chart.json');
  const task = await server.runtime.create('Deliver the original chart.', fixture.workspace);
  await until(async () => chartToolAvailable || (await server.runtime.status(task.id)).messages.some(message => message.role === 'assistant'), Boolean);
  assert.equal(chartToolAvailable, true);
  await until(() => server.runtime.status(task.id), value => value.status === 'completed');
  const route = '/v1/tasks/' + task.id + '/artifacts/0/chart';
  const client = createClient(settings);
  const link = await client.request<{ url: string }>(route, 'POST', {});
  assert.equal((await fetch('http://127.0.0.1:' + port + route, { method: 'POST' })).status, 401);
  const preview = await fetch(link.url);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy') ?? '', /default-src 'none'.*script-src 'nonce-/);
  const page = await preview.text();
  assert.match(page, /Original chart \\u003c2026>/);
  assert.match(page, /"values":\[12,17\]/);
  await writeFile(path, 'a different artifact');
  await assert.rejects(client.request(route, 'POST', {}), /changed after verification/i);
  assert.match(await (await fetch(link.url)).text(), /"values":\[12,17\]/);
});
