import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {agentBrowserArguments} from '../scripts/agent-browser-stdio.js';

const scope={command:'agent-browser',url:'http://127.0.0.1:4318/',session:'kada-local-test',screenshot:resolve('fixture.png')};
test('browser CLI adapter fixes the selected local page, session and output path',()=>{
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_open',{url:'https://example.com/'}),/local|page/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_snapshot',{session:'some-other-session'}),/session/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_snapshot',{extraArgs:['--cdp','other']}),/argument/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_snapshot',{allowedDomains:['*']}),/domain/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_screenshot',{path:resolve('../private.png')}),/output/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_close',{all:true}),/argument/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_eval',{script:'anything'}),/tool/i);
  assert.throws(()=>agentBrowserArguments(scope,'toString',{}),/tool/i);
});
test('browser CLI adapter forwards literal text as one argument and refuses stale selectors',()=>{
  const text='a b\n$() ; " 中文';
  const args=agentBrowserArguments(scope,'agent_browser_fill',{selector:'@e3',text});
  assert.equal(args.at(-1),text);assert.equal(args.filter(value=>value===text).length,1);
  assert.equal(agentBrowserArguments(scope,'agent_browser_fill',{selector:'e3',text}).at(-2),'@e3');
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_fill',{selector:'body',text:'x'}),/snapshot/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_click',{selector:'@e1',timeoutMs:0}),/timeout/i);
  assert.throws(()=>agentBrowserArguments(scope,'agent_browser_fill',{selector:'@e3',text:'--version'}),/flag|literal/i);
});
