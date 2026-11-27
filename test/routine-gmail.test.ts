import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { createClient } from '../src/client.js';
import { serve } from '../src/server.js';
import { atomicJson } from '../src/util.js';
import { fakeRoutineClock, scriptedFixture, until } from './helpers.js';

const search = 'search_gmail_messages', read = 'get_gmail_message_content';
const query = 'in:inbox from:receipts@example.invalid';
const start = Date.parse('2026-11-27T00:00:00Z'), step = 5 * 60_000;

const server = [
  "const fs = require('node:fs');",
  "require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
  "const request = JSON.parse(line); if (request.id === undefined) return;",
  "const tools = ['search_gmail_messages','get_gmail_message_content'].map(name => ({name,annotations:{readOnlyHint:true},inputSchema:{type:'object'}}));",
  "let result = {initialize:{protocolVersion:request.params?.protocolVersion,serverInfo:{name:'routine-mail-fixture',version:'1'},capabilities:{tools:{}}},'tools/list':{tools}}[request.method];",
  "if (request.method === 'tools/call') {",
  "const { name, arguments: args } = request.params;",
  "let valid = args.user_google_email === 'team@example.invalid', text;",
  "if (name === 'search_gmail_messages') {",
  "const sample = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));",
  "const page = args.page_token === undefined ? 0 : Number(args.page_token);",
  "const ids = sample.pages[page];",
  "valid &&= Array.isArray(ids) && args.include_headers === false && args.query === process.argv[2];",
  "const rows = ids?.map((id,i) => '  ' + (i+1) + '. Message ID: ' + id + '\\n     Thread ID: thread' + id) ?? [];",
  "text = rows.length ? ['Found ' + (rows.length + (sample.malformed ? 1 : 0)) + \" messages matching '\" + args.query + \"':\", '', '📧 MESSAGES:', ...rows, '', '💡 USAGE:'].join('\\n') : \"No messages found for query: '\" + args.query + \"'\";",
  "if (page + 1 < sample.pages.length) text += \"\\n📄 PAGINATION: To get the next page, call search_gmail_messages again with page_token='\" + (page+1) + \"'\";",
  "} else { valid &&= args.message_id === 'a003';",
  "text = JSON.stringify({message_id:args.message_id,body_format:'text',body:'Synthetic invoice amount 42',page_offset:0,next_offset:null,body_sha256:'a'.repeat(64),complete:true}); }",
  "result = {isError:!valid,content:[{type:'text',text:valid ? text : 'Bad fixture request'}]}; }",
  "console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));",
  "});",
].join('\n');

async function fixture(t: TestContext, respond = (_: TranscriptContext) => fauxAssistantMessage('Unused.')) {
  let modelCalls = 0;
  const f = await scriptedFixture(context => { modelCalls++; return respond(context); });
  await f.runtime.close();
  const clock = fakeRoutineClock(start);
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as {port: number}).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const settings = { ...f.settings, port };
  const open = () => serve(settings, { models: f.models, routineClock: clock });
  let host = await open();
  t.after(async () => { await host.close(); await f.close(); });
  const client = createClient(settings);
  const file = join(f.directory, 'gmail-pages.json');
  const sample = (pages: string[][], malformed = false) => atomicJson(file, { pages, malformed });
  await sample([['a001'], ['a002']]);
  await host.runtime.mcp.configure({id:'mail',transport:'stdio',command:process.execPath,args:['-e',server,file,query]});
  const { revision } = await host.runtime.mcp.test('mail');
  await host.runtime.mcp.enable('mail',[search,read],revision);
  await host.runtime.gmail.setSource(f.workspace, {id:'mail',revision,email:'team@example.invalid'});
  const input = { id:'new-mail', objective:'Review matching invoices.', workspace:f.workspace,
    schedule:{kind:'interval' as const, everyMinutes:5, anchorAt:new Date(start + step).toISOString()},
    precheck:{gmail:{query}} };
  const finish = (id: string) => until(async () => (await host.runtime.routines.history(input.id)).find(row => row.id === id && row.status !== 'claimed'), Boolean);
  async function advance(slot: number) {
    const at = start + slot * step;
    await until(async () => clock.waitingAt(at), Boolean);
    clock.advanceTo(at);
    return input.id + '/1/' + new Date(at).toISOString();
  }
  return {
    sample, revision, advance, finish, modelCalls: () => modelCalls, runtime: () => host.runtime,
    create: (action: 'notify' | 'task') => client.request('/v1/routines', 'POST', { ...input, action }),
    async restart() { await host.close(); host = await open(); },
    async tick(slot: number) { return finish(await advance(slot)); },
    async runNow(key: string) {
      const accepted = await host.runtime.routines.runNow(input.id,key);
      return finish(accepted.id);
    },
  };
}

test('scheduled Gmail notifications use a persisted baseline and report each matching message once across pages and restart', async t => {
  const f = await fixture(t);
  await f.create('notify');
  const baseline = await f.tick(1);
  assert.equal(baseline?.status,'skipped');
  assert.equal(baseline?.precheck?.status,'baseline');
  assert.deepEqual(await f.runtime().notifications(),[]);

  await f.sample([['a002']]);
  assert.equal((await f.tick(2))?.precheck?.status,'unchanged');
  await f.restart();
  await f.sample([['a002','a001'],['a003']]);
  let persisted = false;
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const inbox = f.runtime().inbox, notify = inbox.notify.bind(inbox);
  inbox.notify = async (...args) => { await notify(...args); persisted = true; await release.promise; };
  const originalSlot = await f.advance(3);
  await until(async () => persisted, Boolean);
  await f.restart();
  release.resolve();
  const arrival = await f.finish(originalSlot);
  assert.equal(arrival?.status,'notified');
  assert.deepEqual(arrival?.gmail,{messageIds:['a003']});
  const notifications = await f.runtime().notifications();
  assert.equal(notifications.length,1);
  assert.match(notifications[0]?.detail ?? '', /1 new Gmail match/);

  await f.sample([['a003','a002','a001']]);
  assert.equal((await f.tick(4))?.precheck?.status,'unchanged');
  await f.sample([['a004']],true);
  assert.equal((await f.tick(5))?.precheck?.status,'failed');
  await f.sample([['a004']]);
  assert.deepEqual((await f.tick(6))?.gmail,{messageIds:['a004']});
  await f.runtime().mcp.setApproval('mail',[search],f.revision);
  assert.equal((await f.tick(7))?.precheck?.status,'failed');
  assert.equal((await f.runtime().notifications()).length,2);
  assert.equal(f.modelCalls(),0);
});

test('a Gmail-triggered task can read its matched original and rejects other message IDs', async t => {
  let calls = 0;
  const f = await fixture(t, context => {
    assert.match(JSON.stringify(context.messages), /External Gmail.*a003/);
    assert(!getCurrentTools(context.messages).some(tool => tool.name.startsWith('mcp_') && /gmail/.test(tool.name)));
    const tool = 'project_gmail_read';
    const results = context.messages.filter(message => message.role === 'toolResult' && message.toolName === tool);
    if (results.length === 0) return fauxAssistantMessage(fauxToolCall(tool,{id:'a001'}),{stopReason:'toolUse'});
    if (results.length === 1) {
      assert.equal(results[0]?.isError,true);
      assert.match(JSON.stringify(results[0]),/not part of this Gmail occurrence/);
      return fauxAssistantMessage(fauxToolCall(tool,{id:'a003'}),{stopReason:'toolUse'});
    }
    assert.equal(results[1]?.isError,false);
    assert.match(JSON.stringify(results[1]),/Synthetic invoice amount 42/);
    calls++;
    return fauxAssistantMessage(fauxToolCall('task_submit',{summary:'Read the matched invoice.',artifacts:[]}),{stopReason:'toolUse'});
  });
  await f.create('task');
  assert.equal((await f.runNow('baseline'))?.precheck?.status,'baseline');
  await f.sample([['a003','a001']]);
  const receipt = await f.runNow('arrival');
  assert.deepEqual(receipt?.gmail,{messageIds:['a003']});
  assert.equal(receipt?.status,'started');
  await until(() => f.runtime().status(receipt!.taskId!), row => row.status==='completed');
  assert.equal(calls,1);
  await f.restart();
  assert.equal((await f.runNow('again'))?.precheck?.status,'unchanged');
  assert.equal((await f.runtime().list()).length,1);
});
