import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool} from '@modelcontextprotocol/sdk/types.js';

export type AgentBrowserScope={command:string;url:string;session:string;screenshot:string};
const execute=promisify(execFile);
const methods={agent_browser_open:'open',agent_browser_snapshot:'snapshot',agent_browser_fill:'fill',agent_browser_click:'click',agent_browser_screenshot:'screenshot',agent_browser_close:'close'} as const;

/** A bounded stdio adapter for the installed CLI; agent-browser still owns every browser action. */
export function agentBrowserArguments(scope:AgentBrowserScope,name:string,input:Record<string,unknown>):string[] {
  const page=new URL(scope.url);
  if(page.protocol!=='http:' || page.hostname!=='127.0.0.1' || page.username || page.password || page.pathname!=='/' || page.search || page.hash) throw new Error('Only the configured local test page is allowed.');
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(scope.session)) throw new Error('Use an isolated test session.');
  if(!Object.hasOwn(methods,name)) throw new Error('This browser tool is not exposed.');
  const method=methods[name as keyof typeof methods];
  const fields:Record<string,string[]>={open:['url','headed','webmcp'],snapshot:['interactive'],fill:['selector','text'],click:['selector'],screenshot:['path'],close:[]};
  const allowed=new Set(['session','allowedDomains','timeoutMs',...fields[method]!]);
  if(Object.keys(input).some(key=>!allowed.has(key))) throw new Error('Unsupported browser argument.');
  if(input.session!==undefined && input.session!==scope.session) throw new Error('The browser session is fixed.');
  if(input.allowedDomains!==undefined && (!Array.isArray(input.allowedDomains) || input.allowedDomains.length!==1 || input.allowedDomains[0]!=='127.0.0.1')) throw new Error('The allowed domain is fixed.');
  if(input.timeoutMs!==undefined && (!Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number)<1 || (input.timeoutMs as number)>30000)) throw new Error('Use a timeout between 1 and 30000 ms.');
  const args=['--session',scope.session,'--allowed-domains','127.0.0.1','--no-webmcp'];
  if(method==='open') {
    if(input.url!==undefined && input.url!==scope.url) throw new Error('Only the configured local page can be opened.');
    if(input.headed!==undefined && typeof input.headed!=='boolean') throw new Error('headed must be a boolean.');
    if(input.headed===true) args.push('--headed');
    return [...args,'open',scope.url];
  }
  if(method==='snapshot') {
    if(input.interactive!==undefined && typeof input.interactive!=='boolean') throw new Error('interactive must be a boolean.');
    return [...args,'snapshot',...(input.interactive===false ? [] : ['-i'])];
  }
  if(method==='fill' || method==='click') {
    if(typeof input.selector!=='string' || !/^@?e\d+$/.test(input.selector)) throw new Error('Use a control ref from the latest snapshot, such as @e3.');
    if(method==='fill' && (typeof input.text!=='string' || input.text.length>4096)) throw new Error('Fill text must contain at most 4096 characters.');
    // shortcut: 0.38.1 treats flag-looking operands as options; relax when the CLI supports literal operands.
    if(method==='fill' && (input.text as string).trimStart().startsWith('-')) throw new Error('This CLI cannot safely fill flag-looking literal text.');
    const selector=input.selector.startsWith('@') ? input.selector : '@'+input.selector;
    return [...args,method,selector,...(method==='fill' ? [input.text as string] : [])];
  }
  if(method==='screenshot') {
    if(input.path!==undefined && (typeof input.path!=='string' || resolve(input.path)!==resolve(scope.screenshot))) throw new Error('The screenshot output path is fixed.');
    return [...args,'screenshot',resolve(scope.screenshot)];
  }
  return [...args,'close'];
}

async function main() {
  const [command,url,session,screenshot]=process.argv.slice(2);
  if(!command || !url || !session || !screenshot) throw new Error('Provide the installed CLI executable, local page, session and screenshot path.');
  const scope={command,url,session,screenshot};agentBrowserArguments(scope,'agent_browser_snapshot',{});
  const common={session:{type:'string'},allowedDomains:{type:'array',items:{type:'string'}},timeoutMs:{type:'integer',minimum:1,maximum:30000}};
  const selector={type:'string',pattern:'^@?e[0-9]+$',description:'Control ref from the latest snapshot, e.g. @e3. The displayed e3 form is also accepted.'};
  const tools:Tool[]=Object.entries(methods).map(([name,method])=>({name,description:`Use the installed agent-browser CLI to ${method} in this isolated local test page. For actions, use the latest @eN control ref.`,
    inputSchema:{type:'object',additionalProperties:false,properties:{...common,...(method==='open' ? {url:{type:'string'},headed:{type:'boolean'},webmcp:{type:'boolean'}} : method==='snapshot' ? {interactive:{type:'boolean'}} : method==='fill' ? {selector,text:{type:'string'}} : method==='click' ? {selector} : method==='screenshot' ? {path:{type:'string'}} : {})},
      ...(method==='fill' ? {required:['selector','text']} : method==='click' ? {required:['selector']} : {})},annotations:{readOnlyHint:method==='snapshot'}}));
  const server=new Server({name:'kada-agent-browser-cli',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(CallToolRequestSchema,async(request,context)=>{
    try {
      const input=request.params.arguments ?? {};
      const args=agentBrowserArguments(scope,request.params.name,input);
      const {stdout}=await execute(scope.command,args,{windowsHide:true,shell:false,encoding:'utf8',timeout:(input.timeoutMs as number|undefined) ?? 30000,maxBuffer:512000,signal:context.signal});
      return {content:[{type:'text',text:stdout}]};
    } catch(error) {
      const message=error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : 'The installed browser CLI could not complete. Observe the current page before retrying.';
      return {isError:true,content:[{type:'text',text:message}]};
    }
  });
  await server.connect(new StdioServerTransport());
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) void main().catch(()=>{console.error('Could not start the local browser CLI adapter.');process.exitCode=1;});
