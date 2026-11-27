import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { LocalRuntime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { hasTool, scriptedFixture, until } from './helpers.js';

const search = 'search_gmail_messages', read = 'get_gmail_message_content';
const digest = 'a'.repeat(64);
const mailServer = [
  "const input=require('node:readline').createInterface({input:process.stdin});",
  "input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;",
  "const tools=['search_gmail_messages','get_gmail_message_content'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}));",
  "let result={initialize:{protocolVersion:r.params?.protocolVersion,serverInfo:{name:'local-mail-fixture',version:'1'},capabilities:{tools:{}}},'tools/list':{tools}}[r.method];",
  "if(r.method==='tools/call'){const {name,arguments:a}=r.params;",
  "const hash='a'.repeat(64), p=a.page_offset||0;",
  "let valid=a.user_google_email==='team@example.invalid', text;",
  "if(name==='search_gmail_messages'){valid&&=a.query==='in:inbox' && a.include_headers===true && a.page_size===10 && (!a.page_token || a.page_token==='page-two');",
  "text=a.page_token?'Found the second page':'Found a message. Next page token: page-two';}",
  "else {valid&&=a.message_id==='abc123' && a.body_format==='text' && a.full===false && a.include_links===false && a.format==='full' && (p===0 || p===5 && a.expected_sha256===hash);",
  "text=JSON.stringify({message_id:'abc123',body_format:'text',body:p?'world':'hello',page_offset:p,next_offset:p?null:5,total_chars:10,body_sha256:hash,complete:!!p});}",
  "const changed=name==='get_gmail_message_content' && a.expected_sha256 && a.expected_sha256!==hash;",
  "result={isError:!valid,content:[{type:'text',text:valid?text:changed?'Message representation changed; restart at page_offset=0.':'Request did not match the configured mailbox'}]};}",
  "console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});",
].join('\n');

test('Gmail search and message pages use one authorized project mailbox and its current read permissions', async t => {
  const f = await scriptedFixture(() => fauxAssistantMessage('Unused.'));
  await f.runtime.close();
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...f.settings, port };
  let daemon = await serve(config, { models: f.models });
  t.after(async () => { await daemon.close(); await f.close(); });
  const client = createClient(config);
  const mcp = daemon.runtime.mcp;
  await mcp.configure({ id: 'mail', transport: 'stdio', command: process.execPath, args: ['-e', mailServer] });
  const tested = await mcp.test('mail');
  await mcp.enable('mail', [search, read], tested.revision);
  const suffix = '?workspace=' + encodeURIComponent(f.workspace);
  const sourcePath = '/v1/gmail/source' + suffix;
  const source = { id: 'mail', revision: tested.revision, email: 'team@example.invalid' };
  await client.request(sourcePath, 'PUT', source);
  await daemon.close();
  daemon = await serve(config, { models: f.models });
  assert.deepEqual((await client.request<{source:unknown}>(sourcePath)).source, source);

  const other = join(f.directory, 'another-project');
  await mkdir(other);
  await assert.rejects(client.request('/v1/gmail/search?workspace=' + encodeURIComponent(other), 'POST', { query: 'in:inbox' }), /mailbox/i);
  const queryPath = '/v1/gmail/search' + suffix;
  assert.equal((await fetch('http://127.0.0.1:' + port + queryPath, { method: 'POST' })).status, 401);
  await assert.rejects(client.request(queryPath, 'POST', { query: 'in:inbox', email: 'wrong@example.invalid' }), /Gmail search/i);
  const found = await client.request<{text:string}>(queryPath, 'POST', { query: 'in:inbox' });
  assert.match(found.text, /page-two/);
  assert.match((await client.request<{text:string}>(queryPath, 'POST', { query: 'in:inbox', pageToken: 'page-two' })).text, /second page/);
  const messagePath = '/v1/gmail/message' + suffix;
  const first = await client.request<{next_offset:number;body_sha256:string}>(messagePath, 'POST', { id: 'abc123' });
  assert.equal(first.next_offset, 5);
  assert.equal(first.body_sha256, digest);
  await assert.rejects(client.request(messagePath, 'POST', { id: 'abc123', offset: 5 }), /SHA-256/i);
  await assert.rejects(client.request(messagePath, 'POST', { id: 'abc123', offset: 5, sha256: 'b'.repeat(64) }), /message changed/i);
  assert.equal((await client.request<{body:string}>(messagePath, 'POST', { id: 'abc123', offset: first.next_offset, sha256: first.body_sha256 })).body, 'world');
  const file = join(f.directory, 'gmail-config.json');
  await writeFile(file, JSON.stringify(config));
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'gmail', 'search', 'in:inbox', '--workspace', f.workspace, '--config', file]);
  assert.deepEqual(JSON.parse(stdout), found);
  await daemon.runtime.mcp.setApproval('mail', [read], tested.revision);
  await assert.rejects(client.request(messagePath, 'POST', { id: 'abc123' }), /approval/i);
  assert.deepEqual(await client.request(queryPath, 'POST', { query: 'in:inbox' }), found);
});

test('only opted-in local chats can read the current authorized project mailbox', async t => {
  const searchName = 'project_gmail_search', readName = 'project_gmail_read';
  const f = await scriptedFixture(context => {
    if (!hasTool(context, searchName)) return fauxAssistantMessage('No chat mailbox.');
    const input = context.messages.findLastIndex(message => message.role === 'user');
    const results = context.messages.slice(input + 1).filter(message => message.role === 'toolResult');
    if (results.at(-1)?.isError) return fauxAssistantMessage('Mailbox permission changed.');
    if (!results.some(result => result.toolName === searchName)) {
      return fauxAssistantMessage(fauxToolCall(searchName, { query: 'in:inbox' }), { stopReason: 'toolUse' });
    }
    if (!results.some(result => result.toolName === readName)) {
      return fauxAssistantMessage(fauxToolCall(readName, { id: 'abc123' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('Read the original mailbox.');
  });
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const mcp = runtime.mcp;
  await mcp.configure({ id: 'mail', transport: 'stdio', command: process.execPath, args: ['-e', mailServer] });
  const { revision } = await mcp.test('mail');
  await mcp.enable('mail', [search, read], revision);
  const source = { id: 'mail', revision, email: 'team@example.invalid' };
  await runtime.gmail.setSource(f.workspace, source);
  const ask = 'Check my inbox and read the matching mail.';
  const old = await runtime.create(ask, f.workspace, [], { chat: true });
  const answered = (id: string, request = 'initial') => until(() => runtime.status(id), row => row.status === 'answered' && row.submission?.requestId === request);
  assert.doesNotMatch(JSON.stringify((await answered(old.id)).messages), /"toolName":"project_gmail_/);

  await runtime.gmail.setSource(f.workspace, { ...source, allowAssistant: true });
  const newTask = await runtime.create(ask, f.workspace, [], { chat: true });
  const result = await answered(newTask.id);
  assert.match(JSON.stringify(result.messages), /page-two.*hello/);
  assert.equal(result.goal, undefined);
  await runtime.followUp(old.id, ask, 'old-mail');
  assert.doesNotMatch(JSON.stringify((await answered(old.id, 'user:old-mail')).messages), /"toolName":"project_gmail_/);
  const remote = await runtime.create(ask, f.workspace, [], { chat: true, remote: true });
  assert.doesNotMatch(JSON.stringify((await answered(remote.id)).messages), /"toolName":"project_gmail_/);

  await runtime.close();
  runtime = new LocalRuntime(f.settings, { models: f.models });
  await runtime.recover();
  await runtime.followUp(newTask.id, ask, 'reopened-mail');
  assert.equal((await answered(newTask.id, 'user:reopened-mail')).messages.filter(message => message.role === 'toolResult' && message.toolName === readName && !message.isError).length, 2);

  await runtime.gmail.setSource(f.workspace, { ...source, allowAssistant: true, email: 'changed@example.invalid' });
  await runtime.followUp(newTask.id, ask, 'changed-mail');
  const changed = await answered(newTask.id, 'user:changed-mail');
  assert.match(JSON.stringify(changed.messages), /Mailbox permission changed/);
  assert.match(JSON.stringify(changed.messages), /The authorized project mailbox changed/);
  assert.doesNotMatch(JSON.stringify(changed.messages), /changed@example\.invalid/);
});
