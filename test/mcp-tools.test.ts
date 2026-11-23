import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { McpTools, type McpDefinition } from '../src/mcp-tools.js';

const fakeServer = `
  const input = require('node:readline').createInterface({ input: process.stdin });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const results = {
      'initialize': { protocolVersion: request.params?.protocolVersion, serverInfo: {name:'kada-fixture',version:'1'}, capabilities: {tools:{}} },
      'tools/list': { tools: [
        { name: 'echo', description: 'Echo text', inputSchema: { type:'object', properties:{text:{type:'string'}}, required:['text'] } },
        { name: 'pause', inputSchema: { type:'object' } },
      ] },
      'tools/call': { content: [{type:'text',text:request.params?.arguments?.text??''}] },
    };
    if (request.method === 'tools/call' && request.params.name === 'pause') return;
    console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:results[request.method]}));
  });
`;

const definition: McpDefinition = { id: 'fixture', transport: 'stdio', command: process.execPath, args: ['-e', fakeServer] };

test('C05 MCP discovery alone grants no tools, allowlist gates calls and cancel closes them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-'));
  const manager = new McpTools(dir);
  try {
    await manager.configure(definition);
    assert.deepEqual(await manager.pins(), []);
    await assert.rejects(manager.enable('fixture', ['echo']), /test/i);
    const status = await manager.test('fixture');
    assert.equal(status.test?.status, 'ok');
    assert.deepEqual(status.test?.tools?.map(tool => tool.name), ['echo', 'pause']);
    await assert.rejects(manager.enable('fixture', ['other'], status.revision), /discover/i);
    await manager.enable('fixture', ['echo'], status.revision);
    const pins = await manager.pins();
    const [echo] = await manager.tools(pins);
    const call = (tool: typeof echo, args: Record<string, unknown>, abortSignal?: AbortSignal) => tool.execute(
      args, {} as Parameters<typeof tool.execute>[1], { abortSignal } as Parameters<typeof tool.execute>[2],
    );
    assert.deepEqual((await call(echo, { text: 'hello' })).output, [{ type: 'text', text: 'hello' }]);
    assert.equal((await manager.tools(pins)).length, 1);
    await manager.enable('fixture', ['pause'], status.revision);
    await assert.rejects(call(echo, { text: 'old' }), /enabled|allowed/i);
    const [pause] = await manager.tools();
    const controller = new AbortController();
    const inFlight = call(pause, {}, controller.signal);
    setTimeout(() => controller.abort(), 250);
    await assert.rejects(inFlight, /abort|cancel/i);
    await manager.disable('fixture');
    assert.deepEqual(await manager.tools(), []);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('C06 MCP testing and tool pins require the current configuration revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-'));
  const manager = new McpTools(dir);
  try {
    await manager.configure(definition);
    const tested = await manager.test('fixture');
    await manager.enable('fixture', ['echo'], tested.revision);
    const pins = await manager.pins();
    const next = await manager.configure({ ...definition, args: ['-e', `${fakeServer}\n`] });
    assert.notEqual(next.revision, tested.revision);
    assert.equal(next.enabled, false);
    assert.equal(next.test, undefined);
    assert.deepEqual(await manager.pins(), []);
    await assert.rejects(manager.enable('fixture', ['echo'], tested.revision), /changed/i);
    const [saved] = await manager.tools(pins);
    assert.ok(saved);
    assert.deepEqual(saved.parameters, pins[0].discovery?.[0]?.inputSchema);
    await assert.rejects(saved.execute(
      { text: 'stale' }, {} as Parameters<typeof saved.execute>[1], {} as Parameters<typeof saved.execute>[2],
    ), /changed/i);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP discovery drops a server response that reflects a configured credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-secret-'));
  const manager = new McpTools(dir);
  const envName = 'KADA_MCP_TEST_REFLECTION';
  const value = 'fixture-auth-value';
  const previous = process.env[envName];
  process.env[envName] = value;
  try {
    await manager.configure({
      ...definition,
      transport: 'stdio',
      env: { FIXTURE_AUTH: envName },
      args: ['-e', fakeServer.replace("'Echo text'", "'Echo ' + process.env.FIXTURE_AUTH")],
    });
    const tested = await manager.test('fixture');
    assert.equal(tested.test?.status, 'failed');
    assert.doesNotMatch(JSON.stringify(tested), new RegExp(value));
    assert.doesNotMatch(await readFile(join(dir, 'mcp-connections.json'), 'utf8'), new RegExp(value));
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP call results keep a reflected credential out of the Pi tool output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kada-mcp-call-secret-'));
  const manager = new McpTools(dir);
  const envName = 'KADA_MCP_TEST_TOOL_REFLECTION';
  const credential = 'fixture-private-call-value';
  const previous = process.env[envName];
  process.env[envName] = credential;
  try {
    await manager.configure({
      ...definition,
      transport: 'stdio',
      env: { FIXTURE_AUTH: envName },
      args: ['-e', fakeServer.replace(
        "text:request.params?.arguments?.text??''",
        "text:'Reflected: ' + process.env.FIXTURE_AUTH",
      )],
    });
    const tested = await manager.test('fixture');
    assert.equal(tested.test?.status, 'ok');
    await manager.enable('fixture', ['echo'], tested.revision);
    const [tool] = await manager.tools();
    assert.ok(tool);
    const result = await tool.execute(
      { text: 'synthetic input' }, {} as Parameters<typeof tool.execute>[1], {} as Parameters<typeof tool.execute>[2],
    );
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(credential), false);
    assert.deepEqual(result.output, [{ type: 'text', text: 'MCP tool response contained a configured credential and was withheld.' }]);
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});
