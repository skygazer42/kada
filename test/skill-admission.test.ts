import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {scriptedFixture,hasTool,until} from './helpers.js';
import {LocalRuntime} from '../src/runtime.js';

test('F09 invalid explicit selection is not admitted and cannot poison recovery',async()=>{
  const f=await scriptedFixture(()=>fauxAssistantMessage('unused'));
  let reopened:LocalRuntime|undefined;
  try {
    await assert.rejects(f.runtime.create('Invalid Skill',f.workspace,[],{skills:[{name:'missing-skill'}]}),/Unknown Skill/);
    assert.deepEqual(await f.runtime.list(),[]);
    await f.runtime.close();
    reopened=new LocalRuntime(f.settings,{models:f.models});await reopened.recover();
    assert.deepEqual(await reopened.list(),[]);
  } finally {await reopened?.close();await f.close();}
});

test('F09 one historical invalid task is quarantined and can be repaired without blocking healthy recovery',async()=>{
  const f=await scriptedFixture(()=>fauxAssistantMessage(fauxToolCall('task_submit',{summary:'Complete',artifacts:[]}),{stopReason:'toolUse'}));
  let reopened:LocalRuntime|undefined;
  try {
    const healthy=await f.runtime.create('Healthy task',f.workspace);
    await until(()=>f.runtime.status(healthy.id),status=>status.status==='completed');
    await f.runtime.close();
    const id=randomUUID(),directory=join(f.directory,'tasks',id);await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'task.json'),JSON.stringify({...healthy,id,objective:'Historical invalid Skill',skillPins:undefined,skillSelection:[{name:'missing-skill'}]}));
    reopened=new LocalRuntime(f.settings,{models:f.models});await reopened.recover();
    const broken=await reopened.status(id);
    assert.equal(broken.status,'paused');assert.match(broken.initializationError ?? '',/Unknown Skill/);
    assert.equal((await reopened.status(healthy.id)).status,'completed');
    const source=join(f.workspace,'.pi/skills/missing-skill');await mkdir(source,{recursive:true});
    await writeFile(join(source,'SKILL.md'),'---\nname: missing-skill\ndescription: Repaired synthetic method.\n---\nUse only for this synthetic fixture.\n');
    await reopened.resume(id);
    const fixed=await until(()=>reopened!.status(id),status=>status.status==='completed');
    assert.equal(fixed.initializationError,undefined);
    assert(fixed.goal!.skills!.pins.some(pin=>pin.name==='missing-skill'));
  } finally {await reopened?.close();await f.close();}
});

test('F09 a prepared task keeps the selected Skill version through disable, source edit and confirmation',async()=>{
  const f=await scriptedFixture(context=>fauxAssistantMessage(fauxToolCall(hasTool(context,'task_prepare') ? 'task_prepare' : 'task_submit',hasTool(context,'task_prepare') ? {
    outcome:'Answer a short question',deliverables:['Text answer in summary'],inputs:[],criteria:[{text:'A text answer is returned',method:'inspect'}],scope:['text only'],assumptions:[],questions:[],
  } : {summary:'Verified text answer',artifacts:[],criteria:[{id:1,status:'passed',evidence:'Answered in the delivery summary'}]}),{stopReason:'toolUse'}));
  try {
    const source=join(f.workspace,'.pi/skills/example');await mkdir(source,{recursive:true});
    const original='---\nname: example\ndescription: A synthetic text method.\n---\nOriginal instructions.\n';
    await writeFile(join(source,'SKILL.md'),original);
    const task=await f.runtime.create('Answer using the selected method',f.workspace,[],{prepare:true,skills:[{name:'example'}]});
    const ready=await until(()=>f.runtime.status(task.id),status=>status.status==='awaiting_confirmation');
    const version=task.skillPins!.pins[0]!.version;
    await f.runtime.setSkillEnabled(f.workspace,'example',false);
    await writeFile(join(source,'SKILL.md'),original+'Changed original.\n');
    await f.runtime.confirm(task.id,ready.goal!.brief!.revision,ready.briefDigest!);
    const done=await until(()=>f.runtime.status(task.id),status=>status.status==='completed');
    const pin=done.goal!.skills!.pins[0]!;
    assert.equal(pin.version,version);assert.equal(await readFile(pin.filePath,'utf8'),original);
  } finally {await f.close();}
});
