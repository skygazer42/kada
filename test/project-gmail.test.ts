import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const download = 'get_gmail_attachment_content';
const digest = 'a'.repeat(64);
const mailServer = [
  "const fs=require('node:fs'); const writes=['draft_gmail_message','send_gmail_message','modify_gmail_message_labels'];",
  "const input=require('node:readline').createInterface({input:process.stdin});",
  "input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;",
  "const tools=['search_gmail_messages','get_gmail_message_content','get_gmail_attachment_content',...writes].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:!writes.includes(name)}}));",
  "let result={initialize:{protocolVersion:r.params?.protocolVersion,serverInfo:{name:'local-mail-fixture',version:'1'},capabilities:{tools:{}}},'tools/list':{tools}}[r.method];",
  "if(r.method==='tools/call'){const {name,arguments:a}=r.params;",
  "const hash='a'.repeat(64), p=a.page_offset||0;",
  "let valid=a.user_google_email==='team@example.invalid', text;",
  "if(name==='search_gmail_messages'){valid&&=a.query==='in:inbox' && a.include_headers===true && a.page_size===10 && (!a.page_token || a.page_token==='page-two');",
  "text=a.page_token?'Found the second page':'Found a message. Next page token: page-two';}",
  "else if(writes.includes(name)){fs.appendFileSync(process.argv[1],JSON.stringify({name,args:a})+'\\n');text='Confirmed '+name;}",
  "else if(name==='get_gmail_attachment_content'){valid&&=a.message_id==='abc123' && a.attachment_id==='file01' && a.attachment_index===0 && a.return_base64===true;",
  "text=\"Attachment downloaded successfully!\\nMessage ID: abc123\\nSize: 0.0 KB (4 bytes)\\nDownload URL: http://127.0.0.1:1/not-used\\n\\n📦 Base64 content (8 chars, standard base64):\\nAAEC/w==\";}",
  "else if(a.page_offset===undefined){valid&&=a.message_id==='abc123';",
  "text=\"--- BODY ---\\nbody\\n\\n--- ATTACHMENTS ---\\n1. receipt.bin (application/octet-stream, 0.0 KB)\\n   Attachment ID: file01\\n   Use get_gmail_attachment_content(message_id='abc123', attachment_id='file01', attachment_index=0) to download\";}",
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
  await mcp.enable('mail', [search, read, download], tested.revision);
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
  const listing = await client.request('/v1/gmail/attachments' + suffix,'POST',{id:'abc123'});
  assert.deepEqual(listing,{attachments:[{id:'file01',index:0,name:'receipt.bin',mimeType:'application/octet-stream'}]});
  const save = {id:'abc123',attachmentId:'file01',index:0,path:'mail/receipt.bin'};
  const { stdout: receipt } = await promisify(execFile)(process.execPath,['--import','tsx','src/cli.ts','gmail','download',
    save.id,save.attachmentId,save.path,'0','--workspace',f.workspace,'--config',file]);
  const saved = JSON.parse(receipt) as {path:string;bytes:number;sha256:string};
  assert.equal(saved.bytes,4);
  const original = Buffer.from([0,1,2,255]);
  assert.equal(saved.sha256,createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(await readFile(saved.path),original);
  assert.deepEqual(await client.request('/v1/gmail/attachment' + suffix,'POST',save),saved);
  await assert.rejects(client.request('/v1/gmail/attachment' + suffix,'POST',{...save,path:'../escape.bin'}),/outside.*workspace/i);
  await writeFile(saved.path,'keep this copy');
  await assert.rejects(client.request('/v1/gmail/attachment' + suffix,'POST',save),/already exists/i);
  assert.equal(await readFile(saved.path,'utf8'),'keep this copy');
  await daemon.runtime.mcp.setApproval('mail', [read,download], tested.revision);
  await assert.rejects(client.request(messagePath, 'POST', { id: 'abc123' }), /approval/i);
  await assert.rejects(client.request('/v1/gmail/attachment' + suffix,'POST',save),/approval/i);
  assert.deepEqual(await client.request(queryPath, 'POST', { query: 'in:inbox' }), found);
});

test('a local execution task can use the mailbox attachment receipt as its checked binary artifact', async t => {
  const path = 'mail/receipt.bin';
  const f = await scriptedFixture(context => {
    const listing = 'project_gmail_attachments', save = 'project_gmail_download_attachment';
    if (!hasTool(context,save)) return fauxAssistantMessage(fauxToolCall('task_submit',{summary:'Attachment tool unavailable.',artifacts:[]}),{stopReason:'toolUse'});
    const calls = context.messages.filter(entry => entry.role === 'toolResult');
    if (!calls.some(entry => entry.toolName === listing)) return fauxAssistantMessage(fauxToolCall(listing,{id:'abc123'}),{stopReason:'toolUse'});
    if (!calls.some(entry => entry.toolName === save)) {
      assert.match(JSON.stringify(calls),/receipt\.bin.*octet-stream/);
      return fauxAssistantMessage(fauxToolCall(save,{id:'abc123',attachmentId:'file01',index:0,path}),{stopReason:'toolUse'});
    }
    assert.equal(calls.find(entry => entry.toolName === save)?.isError,false);
    return fauxAssistantMessage(fauxToolCall('task_submit',{summary:'Saved the original attachment.',artifacts:[path]}),{stopReason:'toolUse'});
  });
  t.after(() => f.close());
  const runtime = f.runtime, mcp = runtime.mcp;
  await mcp.configure({id:'mail',transport:'stdio',command:process.execPath,args:['-e',mailServer]});
  const {revision} = await mcp.test('mail');
  await mcp.enable('mail',[search,read,download],revision);
  await runtime.gmail.setSource(f.workspace,{id:'mail',revision,email:'team@example.invalid',allowAssistant:true});
  const task = await runtime.create('Download the original receipt attachment.',f.workspace);
  const result = await until(() => runtime.status(task.id), row => row.status==='completed' || row.status==='failed');
  assert.equal(result.goal?.candidate?.summary,'Saved the original attachment.');
  assert.deepEqual(await readFile(join(f.workspace,path)),Buffer.from([0,1,2,255]));
});

test('project Gmail drafts, sends and labels use exact approval parameters and reject a later mailbox change', async t => {
  const message = { to:['recipient@example.invalid'], cc:['copy@example.invalid'],subject:'Invoice summary',body:'Total 42.' };
  const f = await scriptedFixture(context => {
    const initial = JSON.stringify(context.messages.find(entry => entry.role === 'user')?.content) ?? '';
    const operation = initial.includes('Send') ? 'send' : initial.includes('Label') ? 'labels' : 'draft';
    const name = 'project_gmail_' + operation;
    const called = context.messages.some(entry => entry.role === 'toolResult' && entry.toolName === name);
    if (called || !hasTool(context,name)) {
      return fauxAssistantMessage(fauxToolCall('task_submit',{ summary:'Reviewed the Gmail action.',artifacts:[] }),{ stopReason:'toolUse' });
    }
    const args = operation === 'labels' ? {id:'abc123',remove:['INBOX']} : message;
    return fauxAssistantMessage(fauxToolCall(name,args),{ stopReason:'toolUse' });
  },{maxDurationMs:90_000});
  let runtime = f.runtime;
  t.after(async () => { await runtime.close(); await f.close(); });
  const log = join(f.directory,'mail-actions.jsonl');
  await writeFile(log,'');
  await runtime.mcp.configure({ id:'mail', transport:'stdio',command:process.execPath,args:['-e',mailServer,log] });
  const { revision } = await runtime.mcp.test('mail');
  const writes = ['draft_gmail_message','send_gmail_message','modify_gmail_message_labels'];
  await runtime.mcp.enable('mail',[search,read,...writes],revision);
  await runtime.mcp.setApproval('mail',writes,revision);
  const source = {id:'mail',revision,email:'team@example.invalid',allowAssistant:true};
  await runtime.gmail.setSource(f.workspace,source);
  const calls = async () => (await readFile(log,'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const request = async (objective: string) => {
    const task = await runtime.create(objective,f.workspace);
    const status = await until(() => runtime.status(task.id), row => ['waiting_user','completed','failed'].includes(row.status));
    assert.equal(status.status,'waiting_user');
    return { id:task.id, approval:status.approvals[0]! };
  };
  const decide = ({id,approval}: Awaited<ReturnType<typeof request>>, decision:'allow'|'deny') =>
    runtime.decideApproval(id,approval.id,decision,approval.digest);
  const settle = (id: string,state:string) => until(() => runtime.status(id), row => row.approvals[0]?.status === state);
  const draft = await request('Draft the invoice summary.');
  const compose = { user_google_email:source.email,from_email:source.email,to:message.to[0],
    cc:message.cc[0],subject:message.subject,body:message.body,body_format:'plain' };
  assert.deepEqual(draft.approval.arguments,compose);
  assert.deepEqual(await calls(),[]);
  await decide(draft,'allow');
  await settle(draft.id,'completed');
  assert.deepEqual(await calls(),[{name:writes[0],args:compose}]);

  const denied = await request('Send the invoice summary.');
  await decide(denied,'deny');
  await settle(denied.id,'denied');
  assert.equal((await calls()).length,1);
  const send = await request('Send the approved invoice summary.');
  await runtime.close();
  runtime = new LocalRuntime(f.settings,{models:f.models});
  await runtime.recover();
  await decide(send,'allow');
  await decide(send,'allow');
  await settle(send.id,'completed');
  assert.deepEqual((await calls())[1],{name:writes[1],args:compose});

  const label = await request('Label the original message.');
  await decide(label,'allow');
  await settle(label.id,'completed');
  assert.deepEqual((await calls())[2],{name:writes[2],args:{user_google_email:source.email,message_id:'abc123',remove_label_ids:['INBOX']}});
  const stale = await request('Send the invoice summary once more.');
  await runtime.gmail.setSource(f.workspace,{...source,email:'other@example.invalid'});
  await decide(stale,'allow');
  await settle(stale.id,'stale');
  assert.equal((await calls()).length,3);
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
