import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { cloudModels } from "./models.js";
import { errorText } from "./util.js";
import { createClient, type TaskMeta, type TaskStatus } from "./client.js";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { briefText, usageText, verificationText } from "./presentation.js";
import type { Routine } from "./routines.js";

try { loadEnvFile(".env"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const args = parseArgs({ allowPositionals: true, options: {
  config: { type: "string" }, workspace: { type: "string" }, acceptance: { type: "string" }, skills:{type:'string'}, filter:{type:'string'}, detach: { type: "boolean", default: false }, yes: { type: "boolean", default: false }, refresh: { type: "boolean", default: false }, help: { type: "boolean" }, "task-status": { type: "boolean" },
} });
const [command = "chat", id, ...rest] = args.positionals;
const config = await loadConfig(args.values.config);
const client = createClient(config);
const { request } = client;

try {
  if (args.values.help || command === "help") {
    console.log(`Kada\n\n  npm run chat                             Chat in the terminal; starts/reuses the daemon\n  npm run harness -- chat [task-id]         Start chat or reconnect to a task\n  npm run dev                              Start only the local daemon\n  npm run demo                             Run the explicit offline simulation\n  npm run discover                         Inspect discovered local Agents/Skills/plugins\n  npm run discover -- --refresh             Refresh local discovery metadata\n  npm run harness -- models [provider]      List the installed Pi model catalog\n  npm run harness -- run "goal" --detach    Create a background task\n  npm run harness -- run "goal" --workspace /absolute/path\n  npm run harness -- status [task-id]       Inspect tasks, workers and usage\n  npm run harness -- pause <task-id>\n  npm run harness -- resume <task-id>       Resume with another configured task budget\n  npm run harness -- cancel <task-id>\n  npm run harness -- follow-up <task-id> "message"\n\nrun also accepts --acceptance <checks.json>. All commands accept --config <file>. Configure cloud model credentials through environment variables.`);
    console.log("\n默认 run 先准备待确认说明；在 chat 中 /attach 后确认。只有已有明确授权时使用 run --yes 或聊天 /run，沿用配置预算直接执行。");
    console.log("\n记忆审阅与事件入口（npm run harness -- …）\n  memory capture|review [on|off] --workspace 路径\n  memory candidates|accept 候选ID|reject 候选ID --workspace 路径\n  routines event 规则ID event.json\n  routines github-sync 规则ID");
    console.log(`\n个人助手入口（npm run harness -- …）：\n  memory list|edit ID 内容|forget ID|used 任务ID\n  tasks --filter pending|running|delivered\n  inbox [read 通知ID]\n  files 任务ID | files open 任务ID 编号\n  model list [provider] [--workspace 路径] | model check provider modelId\n  model select provider modelId [--workspace 路径] | model clear --workspace 路径\n  skills list|enable 名称|disable 名称 --workspace 路径\n  skills rollback 名称 版本 | skills capture 任务ID 目录\n  mcp list|add 配置.json|test ID|enable ID revision 工具…|disable ID\n  routines list|history ID [--task-status]|add 规则.json|update ID 规则.json\n  routines run ID [请求ID] | routines pause|resume|cancel ID\n  remote list|pair 账户ID 设备ID|revoke 账户ID 设备ID\n  computer status|takeover|return\n\nrun --skills 名称,名称@版本 可固定所选方法。空字符串表示不选方法。`);
    console.log("\nMCP 动作审批与工作项（npm run harness -- …）\n  mcp approval 连接ID revision 工具名…\n  work-items list [--workspace 路径] | work-items add 文件.json\n  work-items edit 工作项ID 文件.json | work-items runs 工作项ID\n  work-items run 工作项ID 修订 [请求ID] [--yes]\n在 chat 中用 /approvals 查看动作，再用 /allow 动作ID 或 /deny 动作ID 答复。");
    console.log("\n手机工作项权限（本机授权）\n  work-items share|unshare 工作项ID 账户ID 设备ID\n  work-items share-replies|unshare-replies 工作项ID 账户ID 设备ID\n先分享查看，再单独授予答复权限。撤回查看会同时撤回答复权限。");
  } else if (command === "chat") {
    const { ensureDaemon } = await import("./daemon.js");
    const { runChat } = await import("./chat.js");
    const daemon = await ensureDaemon(config, args.values.config);
    console.log(daemon.started ? `已启动后台服务（PID ${daemon.pid}），退出聊天后任务仍可继续。` : "已连接本地后台服务。");
    await runChat(createClient(config), { taskId: id, workspace: args.values.workspace ? resolve(args.values.workspace) : undefined });
  } else if (command === "serve") {
    const { serve } = await import("./server.js");
    const server = await serve(config);
    console.log(`Kada: http://127.0.0.1:${config.port}\nState: ${config.dataDir}\nCloud model: ${config.model ? `${config.model.provider}/${config.model.modelId}` : "not configured"}`);
    const stop = () => { void server.close().then(() => process.exit(0), error => { console.error(errorText(error)); process.exit(1); }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else if (command === "memory") {
    const { ensureDaemon } = await import("./daemon.js");
    await ensureDaemon(config, args.values.config);
    const workspace = args.values.workspace ? resolve(args.values.workspace) : process.cwd();
    if (id === "capture" || id === "review") {
      const setting = rest[0];
      if (rest.length > 1 || (setting !== undefined && setting !== "on" && setting !== "off")) {
        throw new Error("Use memory capture|review [on|off] --workspace PATH.");
      }
      const path = "/v1/settings/memory/" + id;
      const state = setting === undefined
        ? await request(path + "?workspace=" + encodeURIComponent(workspace))
        : await request(path, "PUT", { workspace, enabled: setting === "on" });
      console.log(JSON.stringify(state, null, 2));
    } else if (["candidates", "accept", "reject"].includes(id ?? "")) {
      const path = "/v1/environment/memory/candidates";
      const query = "?workspace=" + encodeURIComponent(workspace);
      if (id !== "candidates" && (!rest[0] || !/^[a-f0-9]{24}$/.test(rest[0]))) throw new Error("Provide the displayed memory candidate ID.");
      console.log(JSON.stringify(id === "candidates" ? await request(path + query)
        : await request(path + "/" + rest[0] + "/" + id + query, "POST", {}), null, 2));
    } else {
      const { ChatSession } = await import("./chat.js");
      const session = new ChatSession(client, event => console.log(event.text), workspace);
      if (id === "used") {
        if (!rest[0]) throw new Error("Provide a task ID after memory used.");
        await session.attach(rest[0]);
        await session.handle("/memory used");
      } else await session.handle("/memory " + [id ?? "list", ...rest].join(" "));
    }
  } else if (command === "models") {
    const models = cloudModels().getModels(id);
    console.log(models.map(m => `${m.provider}/${m.id}`).join("\n"));
  } else if (['model','skills','mcp','routines','remote','inbox','files','computer','tasks','work-items'].includes(command)) {
    const {ensureDaemon} = await import('./daemon.js');
    await ensureDaemon(config,args.values.config);
    const action = id ?? 'list';
    const workspace = args.values.workspace ? resolve(args.values.workspace) : process.cwd();
    const segment = (value:string|undefined) => {
      if (!value) throw new Error('Missing argument; run help for command syntax.');
      return encodeURIComponent(value);
    };
    const json = async (file:string|undefined) => {
      if (!file) throw new Error('Provide a JSON configuration file.');
      return JSON.parse(await readFile(file,'utf8'));
    };
    let result:unknown;
    if (command === 'tasks') result = await request('/v1/tasks?filter='+encodeURIComponent(args.values.filter ?? 'all'));
    else if (command === 'work-items') {
      const path = '/v1/work-items';
      if (action === 'list') result = await request(path + '?workspace=' + encodeURIComponent(workspace));
      else if (action === 'add') result = await request(path, 'POST', await json(rest[0]));
      else if (action === 'edit') result = await request(path + '/' + segment(rest[0]), 'PATCH', await json(rest[1]));
      else if (action === 'runs') result = await request(path + '/' + segment(rest[0]) + '/runs');
      else if (action === 'run') result = await request(path + '/' + segment(rest[0]) + '/runs', 'POST', {
        revision: Number(rest[1]), requestId: rest[2] ?? randomUUID(), confirmed: args.values.yes,
      });
      else if (['share', 'unshare', 'share-replies', 'unshare-replies'].includes(action!)) {
        const [id, accountId, deviceId] = rest;
        if (rest.length !== 3) throw new Error('Use work-items ' + action + ' <work-item-id> <account-id> <device-id>.');
        result = await request(path + '/' + segment(id) + '/' + action, 'POST', { accountId, deviceId });
      }
      else throw new Error('Use work-items list, add, edit, runs, run, share, unshare, share-replies or unshare-replies.');
    }
    else if (command === 'inbox') result = action === 'read' ? await request('/v1/notifications/'+segment(rest[0])+'/read','POST',{}) : await request('/v1/notifications');
    else if (command === 'model') {
      const project = args.values.workspace ? workspace : undefined;
      const modelsPath = '/v1/settings/models';
      const scopedPath = project ? modelsPath + '?workspace=' + encodeURIComponent(project) : modelsPath;
      if (action === 'list') {
        const providers = await request<{id:string}[]>(scopedPath);
        result = rest[0] ? providers.filter(provider => provider.id === rest[0]) : providers;
      } else if (action === 'check' || action === 'select') {
        if (!rest[0] || !rest[1]) throw new Error('Provide provider and modelId.');
        result = await request(modelsPath + '/' + action, 'POST', {
          provider: rest[0], modelId: rest[1], ...(action === 'select' && project ? { workspace: project } : {}),
        });
      } else if (action === 'clear') {
        if (!project) throw new Error('Provide --workspace to clear a project default.');
        result = await request(scopedPath, 'DELETE');
      } else throw new Error('Use model list, check, select or clear.');
    } else if (command === 'skills') {
      if (action === 'list') result = await request('/v1/settings/skills?workspace='+encodeURIComponent(workspace));
      else if (action === 'enable' || action === 'disable') {
        if (!rest[0]) throw new Error('Provide a Skill name.');
        result = await request('/v1/settings/skills','PATCH',{workspace,name:rest[0],enabled:action === 'enable'});
      } else if (action === 'rollback') result = await request('/v1/settings/skills/rollback','POST',{name:rest[0],version:rest[1]});
      else if (action === 'capture') result = await request('/v1/tasks/'+segment(rest[0])+'/skills/capture','POST',{path:rest[1]});
      else throw new Error('Use skills list, enable, disable, capture or rollback.');
    } else if (command === 'mcp') {
      if (action === 'list') result = await request('/v1/settings/mcp');
      else if (action === 'add') result = await request('/v1/settings/mcp','POST',await json(rest[0]));
      else if (['project', 'project-set', 'project-clear'].includes(action)) {
        if (!args.values.workspace) throw new Error('Provide --workspace for project MCP settings.');
        const projectPath = '/v1/settings/mcp/project';
        result = action === 'project'
          ? await request(projectPath + '?workspace=' + encodeURIComponent(workspace))
          : await request(projectPath, 'PUT', { workspace, tools: action === 'project-clear' ? null : await json(rest[0]) });
      } else if (['test','enable','disable','approval'].includes(action)) result = await request('/v1/settings/mcp/'+segment(rest[0])+'/'+action,'POST',['enable','approval'].includes(action) ? {revision:rest[1],tools:rest.slice(2)} : {});
      else throw new Error('Use mcp list, add, test, enable, disable, approval, project, project-set or project-clear.');
    } else if (command === 'routines') {
      if (action === 'list') result = await request('/v1/routines');
      else if (action === 'history') result = await request('/v1/routines/'+segment(rest[0])+'/occurrences'+(args.values['task-status'] ? '?includeTaskStatus=true' : ''));
      else if (action === 'add') result = await request('/v1/routines','POST',await json(rest[0]));
      else if (action === 'update') result = await request('/v1/routines/'+segment(rest[0]),'PATCH',await json(rest[1]));
      else if (action === 'run') result = await request('/v1/routines/'+segment(rest[0])+'/run','POST',{requestId:rest[1] ?? randomUUID()});
      else if (action === 'event') result = await request('/v1/routines/'+segment(rest[0])+'/events','POST',await json(rest[1]));
      else if (action === 'github-sync') {
        const routineId = rest[0];
        if (!routineId || rest.length !== 1) throw new Error('Use routines github-sync <routine-id>.');
        const rule = (await request<Routine[]>('/v1/routines')).find(item => item.id === routineId);
        const { githubIssueRepository, syncGithubRoutineEvents } = await import('./github-routine-events.js');
        const repository = githubIssueRepository(rule);
        if (!rule || !repository) {
          throw new Error('Select an active github/issues.opened routine with a lowercase repository filter.');
        }
        result = await syncGithubRoutineEvents({
          dataDir: config.dataDir, routineId, repository,
          deliver: event => request('/v1/routines/' + segment(routineId) + '/events?revision=' + rule.revision, 'POST', event),
        });
      }
      else if (action === 'pause' || action === 'resume') result = await request('/v1/routines/'+segment(rest[0])+'/'+action,'POST');
      else if (action === 'cancel') result = await request('/v1/routines/'+segment(rest[0]),'DELETE');
      else throw new Error('Use routines list, history, add, update, run, event, github-sync, pause, resume or cancel.');
    } else if (command === 'remote') {
      if (action === 'list') result = {url:(config.remoteOrigin ?? `http://127.0.0.1:${config.port}`)+'/remote',devices:await request('/v1/remote/devices')};
      else if (action === 'pair') result = await request('/v1/remote/devices','POST',{accountId:rest[0],deviceId:rest[1]});
      else if (action === 'revoke') result = await request('/v1/remote/devices/'+segment(rest[0])+'/'+segment(rest[1]),'DELETE');
      else if (action === 'share-approval' || action === 'unshare-approval') {
        const [taskId, approvalId, accountId, deviceId, digest] = rest;
        if (rest.length !== 5) throw new Error('Use remote '+action+' <task-id> <approval-id> <account-id> <device-id> <digest>.');
        const route = action === 'share-approval' ? '/share' : '/unshare';
        result = await request('/v1/tasks/'+segment(taskId)+'/approvals/'+segment(approvalId)+route,'POST',{accountId,deviceId,digest});
      }
      else throw new Error('Use remote list, pair, revoke, share-approval or unshare-approval.');
    } else if (command === 'computer') {
      if (!['status','takeover','return'].includes(action)) throw new Error('Use computer status, takeover or return.');
      result = await request('/v1/computer'+(action === 'status' ? '' : '/'+action),action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : {});
    } else {
      if (action === 'open') {
        const index = Number(rest[1]);
        if (!Number.isSafeInteger(index) || index < 1) throw new Error('Provide the artifact number from files (starting at 1).');
        result = await request('/v1/tasks/'+segment(rest[0])+'/artifacts/'+(index-1)+'/open','POST',{});
      } else result = await request('/v1/tasks/'+segment(id)+'/artifacts');
    }
    console.log(JSON.stringify(result,null,2));
  } else if (command === "discover") {
    if (!config.discovery) console.log("本机环境发现已关闭（discovery: false）。");
    else {
      const { LocalDiscovery } = await import("./discovery.js");
      // Prefer the running daemon so its in-memory cache is refreshed too.
      const view = await client.healthy() ? await request<Awaited<ReturnType<InstanceType<typeof LocalDiscovery>["view"]>>>(args.values.refresh ? "/v1/environment/refresh" : "/v1/environment", args.values.refresh ? "POST" : "GET", args.values.refresh ? {} : undefined)
        : await new LocalDiscovery(config.dataDir).view(args.values.refresh);
      console.log(`已发现 ${view.agents} 份 Agent/共享配置、${view.skills} 个 Skills、${view.plugins} 条插件/MCP 记录。\n本机概况：${view.overview}\nSkills 目录：${view.catalogue}\n用户记忆：${view.memory ?? "暂不可用"}（${view.memoryFacts ?? 0} 条来源线索）`);
      for (const notice of view.notices) console.log(notice);
    }
  } else if (command === "demo") {
    const { runDemo } = await import("./demo.js");
    await runDemo(resolve(config.dataDir, "demos", randomUUID()));
  } else if (command === "status") {
    console.log(JSON.stringify(await request(id ? `/v1/tasks/${id}` : "/v1/tasks"), null, 2));
  } else if (command === "run") {
    if (!await client.healthy()) throw new Error("后台未就绪或版本不匹配，请先用 npm run chat 启动/连接当前版本的后台。");
    const objective = [id, ...rest].filter(Boolean).join(" ");
    const acceptance = args.values.acceptance ? JSON.parse(await readFile(args.values.acceptance, "utf8")) : undefined;
    const skills = args.values.skills === undefined ? undefined : args.values.skills.split(',').filter(Boolean).map(ref => { const [name,version] = ref.split('@'); return {name,...(version ? {version} : {})}; });
    const task = await request<TaskMeta>("/v1/tasks", "POST", { objective, workspace: args.values.workspace ? resolve(args.values.workspace) : undefined, acceptance, confirmed: args.values.yes,skills });
    console.log(`Task: ${task.id}\nWorkspace: ${task.workspace}`);
    if (task.preparation) console.log(`先整理目标和预算；进入聊天 /attach ${task.id} 后确认。已有明确授权可使用 run --yes。`);
    if (!args.values.detach) {
      let previous = "";
      for (;;) {
        const status = await request<TaskStatus>(`/v1/tasks/${task.id}`);
        if (status.status !== previous) console.log(`Status: ${status.status}`);
        previous = status.status;
        if (!["running", "pending", "verifying"].includes(status.status)) {
          if (["clarifying", "awaiting_confirmation"].includes(status.status)) {
            console.log(`${briefText(status)}\n进入 npm run chat，/attach ${task.id} 后补充信息或确认。`);
            break;
          }
          console.log(`${verificationText(status)}\n${usageText(status)}`);
          const answer = [...status.messages].reverse().find(m => m.role === "assistant");
          console.log(status.status === "completed" ? status.goal?.candidate?.summary : status.goal?.question ?? status.goal?.reason ?? answer?.content?.filter(b => b.type === "text").map(b => b.text).join("\n") ?? JSON.stringify(status.submission));
          if (status.status !== "completed") process.exitCode = 1;
          break;
        }
        await setTimeout(1000);
      }
    }
  } else if (["pause", "resume", "cancel"].includes(command)) {
    if (!id) throw new Error("Provide a task ID");
    await request(`/v1/tasks/${id}/${command}`, "POST", {});
    console.log(`${command}: ${id}`);
  } else if (command === "follow-up") {
    if (!id) throw new Error("Provide a task ID and a message");
    await request(`/v1/tasks/${id}/messages`, "POST", { message: rest.join(" "), requestId: randomUUID() });
    console.log(`Follow-up admitted: ${id}`);
  } else { throw new Error(`Unknown command: ${command}`); }
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
