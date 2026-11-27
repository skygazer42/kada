import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { browserProfilePattern, loadConfig } from "./config.js";
import { cloudModels } from "./models.js";
import { errorText } from "./util.js";
import { createClient, type TaskMeta, type TaskStatus } from "./client.js";
import { loadEnvFile } from "node:process";
import { readFile } from "node:fs/promises";
import { assistantText, briefText, usageText, verificationText } from "./presentation.js";
import { assistantRef } from './assistants.js';
import type { Routine } from "./routines.js";

try { loadEnvFile(".env"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const args = parseArgs({ allowPositionals: true, options: {
  'browser-profile': { type: 'string' },
  'manage-sharing': { type: 'boolean' },
  config: { type: "string" }, workspace: { type: "string" }, acceptance: { type: "string" }, skills:{type:'string'}, assistant:{type:'string'}, collaborator:{type:'string',multiple:true}, "room-file":{type:'string',multiple:true}, filter:{type:'string'}, detach: { type: "boolean", default: false }, yes: { type: "boolean", default: false }, refresh: { type: "boolean", default: false }, help: { type: "boolean" }, "task-status": { type: "boolean" },
} });
const [command = "chat", id, ...rest] = args.positionals;
const browserProfile = args.values['browser-profile'];
if (browserProfile !== undefined && (!browserProfilePattern.test(browserProfile) || !['run', 'chat', 'computer'].includes(command))) {
  throw new Error('Use --browser-profile with run, chat or computer and a configured profile name.');
}
if (args.values['room-file'] && (command !== 'rooms' || id !== 'send')) throw new Error('Use --room-file with rooms send.');
if (args.values['manage-sharing'] && (command !== 'work-items' || id !== 'board-link')) {
  throw new Error('Use --manage-sharing with work-items board-link.');
}
const config = await loadConfig(args.values.config);
const client = createClient(config);
const { request } = client;
function parseAssistant(value: string) {
  const match = /^([a-f0-9-]{36})@([1-9]\d*)$/.exec(value);
  if (!match) throw new Error('Choose ID@REVISION from the project assistant list.');
  return assistantRef({ id: match[1], revision: Number(match[2]) });
}
const selectedAssistant = () => args.values.assistant === undefined ? undefined : parseAssistant(args.values.assistant);
function parseScopedAssistant(value: string) {
  const separator = value.indexOf('=');
  if (separator < 0) return parseAssistant(value);
  const path = value.slice(separator + 1);
  if (!path.trim()) throw new Error('请指定同事的项目工作目录。');
  return { ...parseAssistant(value.slice(0, separator)), workspace: resolve(path) };
}
const selectedCollaborators = () => args.values.collaborator?.map(parseScopedAssistant);

try {
  if (args.values.help || command === "help") {
    console.log(`Kada\n\n  npm run chat                             Chat in the terminal; starts/reuses the daemon\n  npm run harness -- chat [task-id]         Start chat or reconnect to a task\n  npm run dev                              Start only the local daemon\n  npm run demo                             Run the explicit offline simulation\n  npm run discover                         Inspect discovered local Agents/Skills/plugins\n  npm run discover -- --refresh             Refresh local discovery metadata\n  npm run harness -- models [provider]      List the installed Pi model catalog\n  npm run harness -- run "goal" --detach    Create a background task\n  npm run harness -- run "goal" --workspace /absolute/path\n  npm run harness -- status [task-id]       Inspect tasks, workers and usage\n  npm run harness -- pause <task-id>\n  npm run harness -- resume <task-id>       Resume with another configured task budget\n  npm run harness -- cancel <task-id>\n  npm run harness -- follow-up <task-id> "message"\n\nrun also accepts --acceptance <checks.json>. All commands accept --config <file>. Configure cloud model credentials through environment variables.`);
    console.log("\n默认 run 先准备待确认说明；在 chat 中 /attach 后确认。只有已有明确授权时使用 run --yes 或聊天 /run，沿用配置预算直接执行。");
    console.log("\n记忆审阅与事件入口（npm run harness -- …）\n  memory capture|review [on|off] --workspace 路径\n  memory candidates|accept 候选ID|reject 候选ID --workspace 路径\n  routines event 规则ID event.json\n  routines github-sync 规则ID");
    console.log(`\n个人助手入口（npm run harness -- …）：\n  memory list|edit ID 内容|forget ID|used 任务ID\n  tasks --filter pending|running|delivered\n  inbox [read 通知ID]\n  files 任务ID | files open 任务ID 编号\n  model list [provider] [--workspace 路径] | model check provider modelId\n  model select provider modelId [--workspace 路径] | model clear --workspace 路径\n  skills list|enable 名称|disable 名称 --workspace 路径\n  skills rollback 名称 版本 | skills capture 任务ID 目录\n  mcp list|add 配置.json|test ID|enable ID revision 工具…|disable ID\n  routines list|history ID [--task-status]|add 规则.json|update ID 规则.json\n  routines run ID [请求ID] | routines pause|resume|cancel ID\n  remote list|pair 账户ID 设备ID|revoke 账户ID 设备ID\n  computer status|takeover|return\n\nrun --skills 名称,名称@版本 可固定所选方法。空字符串表示不选方法。`);
    console.log("\nMCP 动作审批与工作项（npm run harness -- …）\n  mcp approval 连接ID revision 工具名…\n  work-items list [--workspace 路径] | work-items add 文件.json\n  work-items edit 工作项ID 文件.json | work-items runs 工作项ID\n  work-items run 工作项ID 修订 [请求ID] [--yes]\n在 chat 中用 /approvals 查看动作，再用 /allow 动作ID 或 /deny 动作ID 答复。");
    console.log("\n手机工作项权限（本机授权）\n  work-items share|unshare 工作项ID 账户ID 设备ID\n  work-items share-replies|unshare-replies 工作项ID 账户ID 设备ID\n  work-items share-controls|unshare-controls 工作项ID 账户ID 设备ID\n  work-items share-edits|unshare-edits 工作项ID 账户ID 设备ID\n先分享查看，再分别授予答复、控制或编辑权限。撤回查看会同时撤回这些权限。");
    console.log('  work-items accounts 工作项ID\n  work-items grant-account 工作项ID 账户ID viewer|participant [edits] [controls]\n  work-items revoke-account 工作项ID 账户ID');
    console.log("\n手机共享会话（本机授权）\n  remote share-thread|unshare-thread 会话ID 账户ID 设备ID\n  remote share-thread-replies|unshare-thread-replies 会话ID 账户ID 设备ID\n  remote share-thread-controls|unshare-thread-controls 会话ID 账户ID 设备ID");
    console.log('  remote thread-accounts 会话ID\n  remote grant-thread-account 会话ID 账户ID viewer|participant [files] [controls]\n  remote revoke-thread-account 会话ID 账户ID');
    console.log('work-items edit 的 JSON 可带 revision、title/objective、status（open/parked/done）、archived（布尔值）、priority（low/normal/high/urgent）、dueDate（YYYY-MM-DD）或 dueAt（带 UTC 偏移的 ISO 时刻）及 timeZone（IANA）。截止用 null 清空，切换种类须清空旧字段。保存、完成或设截止不启动/取消原运行，也不创建提醒。');
    console.log('work-items board-link --workspace 路径获取本机浏览器看板链接，--manage-sharing 打开账户授权管理。board 查看 JSON，edit-board 编辑.json 使用原看板版本。');
    console.log('\n应用 API 凭据（仅本机 owner）\n  credentials list --workspace 路径\n  credentials remove 名称 修订 --workspace 路径\n在 chat 中按原问题用 /credential 问题ID 无回显输入，或 /decline-credential 问题ID 拒绝；不要在聊天或命令参数中填写值。');
    console.log('\n命名助手（仅本机 owner，npm run harness -- …）\n  assistants list --workspace 路径\n  assistants add 定义.json | assistants show ID | assistants edit ID 修改.json\n  chat --assistant ID@修订 [--workspace 路径]\n  run "目标" --assistant ID@修订 [--workspace 路径]\n角色工具名单仅收窄原权限；新工作选明确版本，接回已有任务保留原角色。');
    console.log('\n工作区快照（本机）\n  snapshots save 任务ID "快照名称"\n  snapshots list 任务ID\n  snapshots preview 任务ID 快照ID\n  snapshots restore 任务ID 快照ID 预览版本');
    console.log('\nrun 或 chat 接受可重复的 --collaborator ID@修订。跨项目协作使用 --collaborator "ID@修订=接收项目目录"。确认任务后，主助手可向选定的同事派活。用 /assistant-work 查看工作，/reply-assistant 答复，/guide-assistant 补充说明，/stop-assistant 停止原工作。');
    console.log('\n本机助手群组\n  rooms list | rooms show 群组ID [历史游标]\n  rooms add "群组名称" 助手ID@修订 助手ID@修订 […] --workspace 路径\n  跨项目成员可填写 "助手ID@修订=成员项目目录"\n  rooms edit 群组ID 修改.json\n  rooms send 群组ID 助手ID "消息" [请求ID] [--room-file 路径]');
    console.log('  rooms share|unshare 群组ID 账户ID 设备ID\n  rooms share-replies|unshare-replies 群组ID 账户ID 设备ID\n  rooms share-files|unshare-files 群组ID 账户ID 设备ID');
    console.log('  rooms accounts 群组ID\n  rooms grant-account 群组ID 账户ID viewer|participant [files]\n  rooms revoke-account 群组ID 账户ID');
    console.log('  rooms file 群组ID 消息ID 附件编号');
    console.log('\n本机语音\n  voice transcribe 会话ID 工作区内WAV [请求ID]\n  voice show 会话ID 请求ID\n  voice send 会话ID 请求ID\n  voice render 会话ID [请求ID]\n  voice play 会话ID 请求ID');
    console.log('files chart 任务ID 编号　为已验收的 .chart.json 生成本机预览。');
    console.log('computer profiles 查看浏览器配置。run、chat 和 computer 可用 --browser-profile 名称选择。');
    console.log('skills import 目录 [当前版本] --workspace 路径\nskills export 名称 版本 目标目录 --workspace 路径');
    console.log('model browser --workspace 路径　生成本机项目模型设置链接。');
    console.log('assistants browser --workspace 路径　生成本机项目助手设置链接。');
    console.log('mcp browser --workspace 路径　生成本机项目 MCP 工具设置链接。');
    console.log('mcp connections　生成本机 MCP 连接管理链接。');
    console.log('snapshots browser 任务ID　生成对应工作区的本机快照链接。');
    console.log("\n例行任务 precheck 支持 command 参数数组、mcp: { id, revision, tool, arguments } 和 gmail: { query }。Gmail 规则按消息 ID 去重，可触发本机通知或任务。应用预检要求项目已启用、声明只读且无需单次审批。");
    console.log("循环项目任务可选 activity: { withinMinutes, minIntervalMinutes }，只在近期有本地项目用户请求且已满运行间隔时自动检查。默认关闭；routines run 为用户手动要求，不受活动门槛限制，仍遵守预算、预检和防重叠。");
    console.log("循环项目任务可选 accountBackoff: true；明确的模型账户拒绝后，按 5 分钟倍增至 24 小时跳过自动运行。routines list/history 可查 accountCooldown。手动运行仍遵守原预检、预算和防重叠，原任务完成后下一次检查清除降频；Pi 保留单次请求重试。");
    console.log("\nMCP 账户登录（HTTP 定义中设置 oauth: true）\n  mcp login 连接ID\n打开返回的 authorizationUrl，完成后运行 mcp test，再按返回修订 enable 工具。mcp logout 连接ID 清除本机凭据并停用工具；服务端授权需在对应应用撤销。");
    console.log("预注册客户端可将 oauth 配为 { clientId, issuer, clientSecretEnv?, scope? }。clientSecretEnv 是 daemon 环境变量名；不在配置中填入 secret。issuer 必须与服务发现的授权服务器一致。");
    console.log("\nGitHub Issue Webhook：daemon 配置 githubWebhooks: [{ routineId, secretEnv }]，入口 POST /hooks/github/规则ID；JSON 原始正文按 X-Hub-Signature-256 验签。默认关闭，外部代理只转发该 Webhook 路径。");
    console.log("GitHub PR Webhook 使用同一配置，规则类型为 pull_request.opened、pull_request.reopened、pull_request.synchronize、pull_request.closed 或 pull_request.ready_for_review。原任务保留仓库、编号、headSha/baseSha 及 draft/merged；可按这些标量精确匹配。");
  } else if (command === "chat") {
    const assistant = selectedAssistant(), collaborators = selectedCollaborators();
    if (id && (assistant || collaborators || browserProfile)) throw new Error('仅新会话可以选择助手、同事和浏览器。');
    const { ensureDaemon } = await import("./daemon.js");
    const { runChat } = await import("./chat.js");
    const daemon = await ensureDaemon(config, args.values.config);
    console.log(daemon.started ? `已启动后台服务（PID ${daemon.pid}），退出聊天后任务仍可继续。` : "已连接本地后台服务。");
    await runChat(createClient(config), { taskId: id, workspace: args.values.workspace ? resolve(args.values.workspace) : assistant || collaborators ? process.cwd() : undefined,
      assistant, collaborators, browserProfile });
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
    const memoryAssistantId = selectedAssistant()?.id;
    if (memoryAssistantId && !await client.healthy("assistant-memory")) throw new Error("请重启到支持助手私有记忆的后台版本。");
    if (id === "capture" || id === "review") {
      if (memoryAssistantId) throw new Error("记忆记录与复核设置以整个项目为范围。");
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
      const query = "?" + new URLSearchParams({ workspace, ...(memoryAssistantId ? { assistant: memoryAssistantId } : {}) });
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
      } else await session.handle("/memory " + [id ?? "list", ...rest].join(" "), memoryAssistantId);
    }
  } else if (command === "models") {
    const models = cloudModels().getModels(id);
    console.log(models.map(m => `${m.provider}/${m.id}`).join("\n"));
  } else if (['model','skills','mcp','routines','remote','inbox','files','computer','tasks','work-items','credentials','assistants','rooms','voice','snapshots','gmail'].includes(command)) {
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
    if (command === 'assistants') {
      if (!await client.healthy('named-assistants')) throw new Error('后台尚不支持命名助手；请重启到当前版本。');
      const path = '/v1/assistants';
      if (action === 'list') result = await request(path + '?workspace=' + encodeURIComponent(workspace));
      else if (action === 'browser') {
        if (!await client.healthy('project-assistants-page')) throw new Error('请重启到支持项目助手设置页面的后台版本。');
        result = await request(path + '/browser-link', 'POST', { workspace });
      }
      else if (action === 'show') result = await request(path + '/' + segment(rest[0]));
      else if (action === 'add') {
        const input = await json(rest[0]); result = await request(path, 'POST', { ...input, workspace: input.workspace ?? workspace });
      } else if (action === 'edit') result = await request(path + '/' + segment(rest[0]), 'PATCH', await json(rest[1]));
      else throw new Error('Use assistants list, browser, add FILE.json, show ID or edit ID FILE.json.');
    }
    else if (command === 'rooms') {
      if (!await client.healthy('assistant-rooms')) throw new Error('请重启到支持助手群组的后台版本。');
      const path = '/v1/assistant-rooms';
      const [roomOrTitle, memberId, message, requestId] = rest;
      if (action === 'list' && rest.length === 0) result = await request(path);
      else if (action === 'add' && roomOrTitle && rest.length >= 3) {
        result = await request(path, 'POST', { workspace, title: roomOrTitle, members: rest.slice(1).map(parseScopedAssistant) });
      } else if (action === 'show' && roomOrTitle && rest.length <= 2) {
        result = await request(path + '/' + segment(roomOrTitle) + (memberId === undefined ? '' : '?before=' + segment(memberId)));
      } else if (action === 'edit' && roomOrTitle && rest.length === 2) {
        result = await request(path + '/' + segment(roomOrTitle), 'PATCH', await json(memberId));
      } else if (action === 'send' && roomOrTitle && memberId && message && rest.length <= 4) {
        result = await request(path + '/' + segment(roomOrTitle) + '/messages', 'POST', { memberId, message,
          requestId: requestId ?? randomUUID(), files: args.values['room-file'] });
      } else if (action === 'file' && rest.length === 3) {
        result = await request(path + '/' + segment(roomOrTitle) + '/messages/' + segment(memberId) + '/attachments/' + segment(message));
      } else if (action === 'accounts' && rest.length === 1) {
        result = await request(path + '/' + segment(roomOrTitle) + '/accounts');
      } else if (action === 'grant-account' && (message === 'viewer' || message === 'participant') &&
        (rest.length === 3 || rest.length === 4 && requestId === 'files')) {
        result = await request(path + '/' + segment(roomOrTitle) + '/accounts/' + segment(memberId), 'PUT',
          { role: message, files: requestId === 'files' });
      } else if (action === 'revoke-account' && rest.length === 2) {
        result = await request(path + '/' + segment(roomOrTitle) + '/accounts/' + segment(memberId), 'DELETE');
      } else if (/^(?:un)?share(?:-replies|-files)?$/.test(action) && rest.length === 3) {
        result = await request(path + '/' + segment(roomOrTitle) + '/' + action, 'POST', { accountId: memberId, deviceId: message });
      } else throw new Error('Use rooms list, add, show, edit, send, file, share or unshare. See help for arguments.');
    }
    else if (command === 'voice') {
      if (!await client.healthy('voice-notes')) throw new Error('请重启到支持录音转写的后台版本。');
      const [taskId, sourceOrRequest, requestId] = rest;
      const taskPath = '/v1/tasks/' + segment(taskId), path = taskPath + '/voice-notes';
      if (action === 'transcribe' && sourceOrRequest && rest.length <= 3) {
        result = await request(path, 'POST', { file: sourceOrRequest, requestId: requestId ?? randomUUID() });
      } else if (action === 'show' && rest.length === 2) {
        result = await request(path + '/' + segment(sourceOrRequest));
      } else if (action === 'send' && rest.length === 2) {
        result = await request(path + '/' + segment(sourceOrRequest) + '/send', 'POST', {});
      } else if (action === 'render' && rest.length <= 2) {
        result = await request(taskPath + '/voice-speech', 'POST', { requestId: sourceOrRequest ?? randomUUID() });
      } else if (action === 'play' && rest.length === 2) {
        result = await request(taskPath + '/voice-speech/' + segment(sourceOrRequest) + '/play', 'POST', {});
      } else throw new Error('Use voice transcribe, show, send, render or play. See help for arguments.');
    }
    else if (command === 'credentials') {
      const path = '/v1/credentials?workspace=' + encodeURIComponent(workspace);
      if (action === 'list') result = await request(path);
      else if (action === 'remove') result = await request(path, 'DELETE', { name: rest[0], revision: Number(rest[1]) });
      else throw new Error('Use credentials list or credentials remove NAME REVISION --workspace PATH.');
    }
    else if (command === 'tasks') result = await request('/v1/tasks?filter='+encodeURIComponent(args.values.filter ?? 'all'));
    else if (command === 'snapshots') {
      const [taskId, value, version] = rest;
      const path = '/v1/tasks/' + segment(taskId) + '/snapshots';
      if (id === 'list' && rest.length === 1) result = await request(path);
      else if (id === 'browser' && rest.length === 1) {
        if (!await client.healthy('workspace-snapshot-page')) throw new Error('请重启到支持工作区快照页面的后台版本。');
        result = await request(path + '/link', 'POST', {});
      }
      else if (id === 'save' && value && rest.length === 2) result = await request(path, 'POST', { label: value });
      else if (id === 'preview' && rest.length === 2) result = await request(path + '/' + segment(value) + '/preview');
      else if (id === 'restore' && version && rest.length === 3) result = await request(path + '/' + segment(value) + '/restore', 'POST', { version });
      else throw new Error('Use snapshots list, browser, save, preview or restore. See help for arguments.');
    }
    else if (command === 'work-items') {
      const path = '/v1/work-items';
      if (action === 'list') result = await request(path + '?workspace=' + encodeURIComponent(workspace));
      else if (action === 'board') result = await request(path + '/board?workspace=' + encodeURIComponent(workspace));
      else if (action === 'board-link') result = await request(path + '/board-link', 'POST', {
        workspace, ...(args.values['manage-sharing'] ? { manageSharing: true } : {}),
      });
      else if (action === 'calendar') {
        if (!rest[0] || rest.length !== 1) throw new Error('Use work-items calendar YYYY-MM.');
        result = await request(path + '/calendar?' + new URLSearchParams({ workspace, month: rest[0] }));
      }
      else if (action === 'calendar-source') {
        const calendar = path + '/calendar-source?' + new URLSearchParams({ workspace });
        if (rest.length > 1) throw new Error('Use work-items calendar-source [SOURCE.json].');
        result = rest.length ? await request(calendar, 'PUT', await json(rest[0])) : await request(calendar);
      }
      else if (action === 'calendar-clear') result = await request(path + '/calendar-source?' + new URLSearchParams({ workspace }), 'DELETE');
      else if (action === 'edit-board') result = await request(path + '/board?workspace=' + encodeURIComponent(workspace), 'PATCH', await json(rest[0]));
      else if (action === 'add') result = await request(path, 'POST', await json(rest[0]));
      else if (action === 'edit') result = await request(path + '/' + segment(rest[0]), 'PATCH', await json(rest[1]));
      else if (action === 'runs') result = await request(path + '/' + segment(rest[0]) + '/runs');
      else if (action === 'run') result = await request(path + '/' + segment(rest[0]) + '/runs', 'POST', {
        revision: Number(rest[1]), requestId: rest[2] ?? randomUUID(), confirmed: args.values.yes,
      });
      else if (action === 'accounts' && rest.length === 1) {
        result = await request(path + '/' + segment(rest[0]) + '/accounts');
      } else if (action === 'grant-account') {
        const [id, accountId, role, ...permissions] = rest;
        if ((role !== 'viewer' && role !== 'participant') || permissions.length > 2 ||
          permissions.some(permission => permission !== 'edits' && permission !== 'controls')) {
          throw new Error('Use work-items grant-account ITEM ACCOUNT viewer|participant [edits] [controls].');
        }
        result = await request(path + '/' + segment(id) + '/accounts/' + segment(accountId), 'PUT', {
          role, edits: permissions.includes('edits'), controls: permissions.includes('controls'),
        });
      } else if (action === 'revoke-account' && rest.length === 2) {
        result = await request(path + '/' + segment(rest[0]) + '/accounts/' + segment(rest[1]), 'DELETE');
      } else if (/^(?:un)?share(?:-(?:replies|controls|edits))?$/.test(action)) {
        const [id, accountId, deviceId] = rest;
        if (rest.length !== 3) throw new Error('Use work-items ' + action + ' <work-item-id> <account-id> <device-id>.');
        result = await request(path + '/' + segment(id) + '/' + action, 'POST', { accountId, deviceId });
      }
      else throw new Error('Use work-items list, board, board-link, edit-board, calendar, calendar-source, calendar-clear, add, edit, runs, run, share or unshare.');
    }
    else if (command === 'gmail') {
      const query = '?' + new URLSearchParams({ workspace });
      const source = '/v1/gmail/source' + query;
      if (action === 'source' && rest.length <= 1) result = rest.length ? await request(source, 'PUT', await json(rest[0])) : await request(source);
      else if (action === 'clear' && !rest.length) result = await request(source, 'DELETE');
      else if (action === 'search' && rest[0] && rest.length <= 2) {
        result = await request('/v1/gmail/search' + query, 'POST', { query: rest[0], pageToken: rest[1] });
      } else if (action === 'read' && rest[0] && (rest.length === 1 || rest.length === 3)) {
        result = await request('/v1/gmail/message' + query, 'POST', {
          id: rest[0], ...(rest[1] === undefined ? {} : { offset: Number(rest[1]), sha256: rest[2] }),
        });
      } else if (action === 'attachments' && rest[0] && rest.length === 1) {
        result = await request('/v1/gmail/attachments' + query,'POST',{id:rest[0]});
      } else if (action === 'download' && rest[0] && rest[1] && rest[2] && rest.length <= 4) {
        result = await request('/v1/gmail/attachment' + query,'POST',{
          id:rest[0],attachmentId:rest[1],path:rest[2],...(rest[3] === undefined ? {} : {index:Number(rest[3])}),
        });
      } else throw new Error('Use gmail source [SOURCE.json], search QUERY [PAGE_TOKEN], read ID [OFFSET SHA256], attachments ID, download ID ATTACHMENT_ID PATH [INDEX] or clear.');
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
      } else if (action === 'browser') {
        if (!project) throw new Error('Provide --workspace for local project model settings.');
        if (!await client.healthy('project-model-page')) throw new Error('请重启到支持项目模型设置页的后台版本。');
        result = await request(modelsPath + '/link', 'POST', { workspace: project });
      } else throw new Error('Use model list, check, select, clear or browser.');
    } else if (command === 'skills') {
      if (action === 'list') result = await request('/v1/settings/skills?workspace='+encodeURIComponent(workspace));
      else if (action === 'enable' || action === 'disable') {
        if (!rest[0]) throw new Error('Provide a Skill name.');
        result = await request('/v1/settings/skills','PATCH',{workspace,name:rest[0],enabled:action === 'enable'});
      } else if (action === 'rollback') result = await request('/v1/settings/skills/rollback','POST',{name:rest[0],version:rest[1]});
      else if (action === 'capture') result = await request('/v1/tasks/'+segment(rest[0])+'/skills/capture','POST',{path:rest[1]});
      else if (action === 'import' && rest[0] && rest.length <= 2) result = await request('/v1/settings/skills/import', 'POST', { workspace, path: rest[0], version: rest[1] });
      else if (action === 'export' && rest.length === 3) result = await request('/v1/settings/skills/export', 'POST', { workspace, name: rest[0], version: rest[1], path: rest[2] });
      else throw new Error('Use skills list, enable, disable, capture, rollback, import or export.');
    } else if (command === 'mcp') {
      if (action === 'list') result = await request('/v1/settings/mcp');
      else if (action === 'connections' && !rest.length) {
        if (!await client.healthy('mcp-connections-page')) throw new Error('请重启到支持 MCP 连接管理页面的后台版本。');
        result = await request('/v1/settings/mcp/connections-link', 'POST', {});
      }
      else if (action === 'add') result = await request('/v1/settings/mcp','POST',await json(rest[0]));
      else if (action === 'browser') {
        if (!args.values.workspace) throw new Error('Provide --workspace for local project MCP settings.');
        if (!await client.healthy('project-mcp-page')) throw new Error('请重启到支持项目 MCP 工具设置页的后台版本。');
        result = await request('/v1/settings/mcp/link', 'POST', { workspace });
      }
      else if (['project', 'project-set', 'project-clear'].includes(action)) {
        if (!args.values.workspace) throw new Error('Provide --workspace for project MCP settings.');
        const projectPath = '/v1/settings/mcp/project';
        result = action === 'project'
          ? await request(projectPath + '?workspace=' + encodeURIComponent(workspace))
          : await request(projectPath, 'PUT', { workspace, tools: action === 'project-clear' ? null : await json(rest[0]) });
      } else if (['test','enable','disable','approval','login','logout'].includes(action)) result = await request('/v1/settings/mcp/'+segment(rest[0])+'/'+action,'POST',['enable','approval'].includes(action) ? {revision:rest[1],tools:rest.slice(2)} : {});
      else throw new Error('Use mcp list, connections, add, test, enable, disable, approval, login, logout, project, project-set, project-clear or browser.');
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
          dataDir: config.dataDir, routineId, repository, tokenEnv: config.githubIssueTokenEnv,
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
      else if (action === 'thread-accounts' && rest.length === 1) {
        result = await request('/v1/tasks/' + segment(rest[0]) + '/accounts');
      } else if (action === 'grant-thread-account') {
        const [taskId, accountId, role, ...permissions] = rest;
        if ((role !== 'viewer' && role !== 'participant') || permissions.length > 2 ||
          permissions.some(permission => permission !== 'files' && permission !== 'controls')) {
          throw new Error('Use remote grant-thread-account TASK ACCOUNT viewer|participant [files] [controls].');
        }
        result = await request('/v1/tasks/' + segment(taskId) + '/accounts/' + segment(accountId), 'PUT', {
          role, files: permissions.includes('files'), controls: permissions.includes('controls'),
        });
      } else if (action === 'revoke-thread-account' && rest.length === 2) {
        result = await request('/v1/tasks/' + segment(rest[0]) + '/accounts/' + segment(rest[1]), 'DELETE');
      }
      else if (action && /^(?:un)?share-thread(?:-replies|-controls)?$/.test(action)) {
        const [taskId, accountId, deviceId] = rest;
        if (rest.length !== 3) throw new Error('Use remote ' + action + ' <task-id> <account-id> <device-id>.');
        result = await request('/v1/tasks/' + segment(taskId) + '/' + action, 'POST', { accountId, deviceId });
      }
      else if (action === 'share-approval' || action === 'unshare-approval') {
        const [taskId, approvalId, accountId, deviceId, digest] = rest;
        if (rest.length !== 5) throw new Error('Use remote '+action+' <task-id> <approval-id> <account-id> <device-id> <digest>.');
        const route = action === 'share-approval' ? '/share' : '/unshare';
        result = await request('/v1/tasks/'+segment(taskId)+'/approvals/'+segment(approvalId)+route,'POST',{accountId,deviceId,digest});
      }
      else throw new Error('Use remote list, pair, revoke, share-approval, unshare-approval, or a share-thread or unshare-thread command.');
    } else if (command === 'computer') {
      if ((browserProfile || action === 'profiles') && !await client.healthy('browser-profiles')) throw new Error('请重启到支持浏览器配置的后台版本。');
      if (action === 'profiles') result = await request('/v1/computer/profiles');
      else {
        if (!['status','takeover','return'].includes(action)) throw new Error('Use computer profiles, status, takeover or return.');
        const query = browserProfile ? '?profile=' + encodeURIComponent(browserProfile) : '';
        result = action === 'status' ? await request('/v1/computer' + query) : await request('/v1/computer/' + action + query, 'POST', {});
      }
    } else {
      if (action === 'open' || action === 'chart') {
        if (action === 'chart' && !await client.healthy('chart-preview')) throw new Error('请重启到支持图表预览的后台版本。');
        const index = Number(rest[1]);
        if (!Number.isSafeInteger(index) || index < 1) throw new Error('Provide the artifact number from files (starting at 1).');
        result = await request('/v1/tasks/'+segment(rest[0])+'/artifacts/'+(index-1)+'/'+action,'POST',{});
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
    const assistant = selectedAssistant(), collaborators = selectedCollaborators();
    if (assistant && !await client.healthy('named-assistants')) throw new Error('后台尚不支持命名助手；角色请求不会降级为普通任务。');
    if (collaborators && !await client.healthy('assistant-collaboration')) throw new Error('请重启到支持助手协作的后台版本。');
    if (browserProfile && !await client.healthy('browser-profiles')) throw new Error('请重启到支持浏览器配置的后台版本。');
    const objective = [id, ...rest].filter(Boolean).join(" ");
    const acceptance = args.values.acceptance ? JSON.parse(await readFile(args.values.acceptance, "utf8")) : undefined;
    const skills = args.values.skills === undefined ? undefined : args.values.skills.split(',').filter(Boolean).map(ref => { const [name,version] = ref.split('@'); return {name,...(version ? {version} : {})}; });
    const task = await request<TaskMeta>("/v1/tasks", "POST", { objective, workspace: args.values.workspace ? resolve(args.values.workspace) : assistant || collaborators ? process.cwd() : undefined, acceptance, confirmed: args.values.yes,skills,
      ...(assistant ? { assistant } : {}), ...(collaborators ? { collaborators } : {}), ...(browserProfile ? { browserProfile } : {}) });
    console.log(`Task: ${task.id}\nWorkspace: ${task.workspace}`);
    if (task.assistant) console.log(assistantText(task));
    if (task.preparation) console.log(`先整理目标和预算；进入聊天 /attach ${task.id} 后确认。已有明确授权可使用 run --yes。`);
    if (!args.values.detach) {
      let previous = "";
      for (;;) {
        const status = await request<TaskStatus>(`/v1/tasks/${task.id}`);
        if (status.status !== previous) console.log(`Status: ${status.status}`);
        previous = status.status;
        if (!["running", "pending", "verifying"].includes(status.status)) {
          if (status.status === 'waiting_assistant') {
            console.log(`同事正在等待答复。进入 npm run chat 后使用 /attach ${task.id} 查看原问题。`);
            break;
          }
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
