import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { defineExtension, hook, ToolTask } from '@earendil-works/pi-durable';
import { LocalRuntime } from '../../src/runtime.js';
import { until } from '../helpers.js';

const [phase, directory, stage] = process.argv.slice(2) as [string, string, string];
const effects = join(directory, 'effects.txt');
const faux = fauxProvider({ provider: 'approval-recovery', models: [{ id: 'scripted' }] });
faux.setResponses(Array.from({ length: 20 }, () => context => {
  if (!context.messages.some(message => message.role === 'toolResult' && message.toolName.startsWith('mcp_counter_'))) {
    const tool = getCurrentTools(context.messages).find(tool => tool.name.startsWith('mcp_counter_'))!;
    return fauxAssistantMessage(fauxToolCall(tool.name, { text: 'crash-once' }), { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage(fauxToolCall('task_submit', { summary: 'Inspected recovered approval outcome', artifacts: [] }), { stopReason: 'toolUse' });
}));
const models = createModels(); models.setProvider(faux.provider);
let approvalStored = false;
const extensions = phase === 'create' && stage === 'pending' ? [defineExtension({ name: 'hold_approval_result', hooks: [hook(ToolTask, {
  afterTool: async call => {
    if (!call.name.startsWith('mcp_counter_')) return;
    approvalStored = true;
    await setTimeout(60_000);
  },
})] })] : [];
const runtime = new LocalRuntime({ dataDir: directory, port: 4317, model: { provider: faux.provider.id, modelId: 'scripted' },
  maxSubagents: 0, maxDurationMs: 120_000, web: false, review: false, discovery: false }, { models, extensions });
const script = `const fs=require('node:fs');const input=require('node:readline').createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,serverInfo:{name:'approval-fixture',version:'1'},capabilities:{tools:{}}};
if(r.method==='tools/list')result={tools:[{name:'append',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if(r.method==='tools/call'){fs.appendFileSync(process.argv[1],r.params.arguments.text+'\\n');if(process.argv[2]==='hold')return;result={content:[{type:'text',text:'Appended'}]};}
console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;
try {
  if (phase === 'create') {
    if (stage === 'pending') clearInterval(runtime['timer']);
    await runtime.mcp.configure({ id: 'counter', transport: 'stdio', command: process.execPath, args: ['-e', script, effects, 'hold'] });
    const checked = await runtime.mcp.test('counter');
    await runtime.mcp.enable('counter', ['append'], checked.revision);
    await runtime.mcp.setApproval('counter', ['append'], checked.revision);
    const task = await runtime.create('Verify an action across process loss', join(directory, 'workspace'), [], { skills: [] });
    const waiting = await until(() => runtime.status(task.id), status => status.approvals.length > 0 && (stage !== 'pending' || approvalStored));
    const approval = waiting.approvals[0]!;
    if (stage !== 'pending') {
      await until(() => runtime.status(task.id), status => status.tasks.length === 0 && status.submission?.status === 'done');
      await runtime.decideApproval(task.id, approval.id, 'allow', approval.digest);
      await until(async () => readFile(effects, 'utf8').catch(() => ''), text => text === 'crash-once\n');
      await writeFile(join(directory, 'action-ready'), 'ready');
    }
    console.log(JSON.stringify({ type: 'ready', taskId: task.id, approvalId: approval.id, digest: approval.digest }));
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const [task] = await runtime.list();
    if (!task) throw new Error('Missing recovered task');
    const status = await runtime.status(task.id);
    const approval = status.approvals[0]!;
    if (stage === 'pending') await runtime.decideApproval(task.id, approval.id, 'deny', approval.digest);
    const result = await until(() => runtime.status(task.id), current => current.status === 'completed');
    console.log(JSON.stringify({ type: 'completed', taskId: task.id, approvalId: approval.id, status: result.approvals[0]!.status,
      reports: result.messages.filter(message => message.role === 'user' && (typeof message.content === 'string' ? message.content
        : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).startsWith('MCP action approval')).length,
      effects: await readFile(effects, 'utf8').catch(() => '') }));
  }
} finally { await runtime.close(); }
