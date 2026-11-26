import { createServer, type IncomingMessage } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { Config } from "./config.js";
import { ComputerBridge } from "./computer.js";
import { VERSION } from "./version.js";
import { LocalRuntime, type RuntimeOptions } from "./runtime.js";
import { AssistantError, type AssistantRef } from './assistants.js';
import { cloudModels } from "./models.js";
import { errorText } from "./util.js";
import { taskView } from "./task-view.js";
import { MemoryMutationError } from "./user-memory.js";
import { createRemoteHandler,quarantineLegacyRemoteTasks } from './remote.js';
import { RemoteDevices } from './remote-devices.js';
import { artifactTarget, openLocalPath } from './artifacts.js';
import type { SkillSelection } from './skills.js';
import type { McpDefinition } from './mcp-tools.js';
import type { RoutineInput } from './routines.js';
import { watchGithubIssues } from "./github-routine-events.js";
import { githubWebhook } from './github-webhook.js';

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error("Request body exceeds 64 KiB");
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

export async function serve(config: Config, options?: RuntimeOptions) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(config.dataDir, { stale: 5000, update: 1000, retries: { retries: 6, minTimeout: 1000, maxTimeout: 1000 } });
  const computer = new ComputerBridge();
  let runtime: LocalRuntime | undefined;
  const devices = new RemoteDevices(config.dataDir);
  let remote: ReturnType<typeof createRemoteHandler>;
  let pushRun: Promise<void> | undefined;
  let pushTimer: NodeJS.Timeout | undefined;
  const githubAbort = new AbortController();
  let githubRun: Promise<void> | undefined;
  let token: string;
  const tokenFile = join(config.dataDir, "token");
  try { token = (await readFile(tokenFile, "utf8")).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await release(); throw error; }
    token = randomBytes(32).toString("hex");
    await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(token)) { await release(); throw new Error("Invalid daemon token file"); }
  let ready = false;
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      if (!ready || !runtime) return send(503, { error: "Runtime is starting" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
      if (url.pathname === "/health" && req.method === "GET") return send(200, { status: "ok", version: VERSION, capabilities: ["ordinary-chat", "work-memory-view",'assistant-settings','named-assistants','assistant-collaboration','local-threads','task-handoff','remote-web','routines'] });
      const hook = await githubWebhook(req, url.pathname, config.githubWebhooks ?? [], runtime.routines);
      if (hook) return send(hook.status, hook.data);
      if (await remote(req,res)) return;
      if (url.pathname === '/v1/settings/mcp/oauth/callback' && req.method === 'GET') {
        if (req.headers.host !== new URL(`http://127.0.0.1:${config.port}`).host) return send(403, { error: 'Use the local OAuth callback address.' });
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        await runtime.mcp.finishLogin(url.searchParams.get('state') ?? '', url.searchParams.get('code') ?? '', url.searchParams.has('error'));
        return send(200, { message: 'MCP account authorized. Return to Kada, test this connection and enable its tools.' });
      }
      const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: "Unauthorized" });
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${config.port}`) return send(403, { error: "Cross-origin requests are not allowed" });
      const controls = config.computer ? computer : options?.computer;
      if (url.pathname === '/v1/computer' && req.method === 'GET') return send(200,controls?.status?.() ?? {connected:false,mode:'disabled',owner:null,observed:false,busy:false,takingOver:false});
      if (['/v1/computer/takeover','/v1/computer/return'].includes(url.pathname) && req.method === 'POST') {
        if (!controls?.takeover || !controls.returnControl) throw new Error('Computer control is disabled. Select an existing driver before taking control.');
        return send(200,url.pathname.endsWith('/takeover') ? await controls.takeover() : await controls.returnControl());
      }
      if (url.pathname === "/v1/environment" && req.method === "GET") return send(200, await runtime.localSetup());
      if (url.pathname === "/v1/environment/memory" && req.method === "GET") return send(200, await runtime.localMemory(url.searchParams.get("workspace") ?? undefined));
      if (url.pathname === "/v1/settings/memory/capture") {
        if (req.method === "GET") return send(200, await runtime.memoryCapture(url.searchParams.get("workspace") ?? ""));
        if (req.method === "PUT") {
          const { workspace, enabled } = await body(req);
          if (typeof workspace !== "string" || typeof enabled !== "boolean") throw new MemoryMutationError(400, "Provide a workspace path and a boolean enabled setting.");
          return send(200, await runtime.memoryCapture(workspace, enabled));
        }
      }
      if (url.pathname === "/v1/settings/memory/review") {
        if (req.method === "GET") return send(200, await runtime.memoryReview(url.searchParams.get("workspace") ?? ""));
        if (req.method === "PUT") {
          const { workspace, enabled } = await body(req);
          if (typeof workspace !== "string" || typeof enabled !== "boolean") throw new MemoryMutationError(400, "Provide a workspace path and a boolean enabled setting.");
          return send(200, await runtime.memoryReview(workspace, enabled));
        }
      }
      if (url.pathname === "/v1/environment/memory/candidates" && req.method === "GET") {
        return send(200, await runtime.memoryCandidates(url.searchParams.get("workspace") ?? ""));
      }
      const candidate = /^\/v1\/environment\/memory\/candidates\/([a-f0-9]{24})\/(accept|reject)$/.exec(url.pathname);
      if (candidate && req.method === "POST") {
        return send(200, await runtime.memoryCandidates(url.searchParams.get("workspace") ?? "", candidate[1]!, candidate[2] as "accept" | "reject"));
      }
      const memory = /^\/v1\/environment\/memory\/([^/]+)(?:\/(forget))?$/.exec(url.pathname);
      if (memory && ((!memory[2] && req.method === "PATCH") || (memory[2] === "forget" && req.method === "POST"))) {
        const input = await body(req);
        if (typeof input.expectedRevision !== "string" || typeof input.requestId !== "string" || (req.method === "PATCH" && typeof input.text !== "string")) throw new MemoryMutationError(400, "Supply expectedRevision, requestId and correction text.");
        return send(200, await runtime.changeMemory(decodeURIComponent(memory[1]!), { action: memory[2] === "forget" ? "forget" : "correct", expectedRevision: input.expectedRevision, requestId: input.requestId, ...(typeof input.text === "string" ? { text: input.text } : {}) }, url.searchParams.get("workspace") ?? undefined));
      }
      if (url.pathname === "/v1/environment/refresh" && req.method === "POST") return send(200, await runtime.localSetup(true));
      if (url.pathname === '/v1/settings/models') {
        const workspace = url.searchParams.get('workspace') ?? undefined;
        if (req.method === 'GET') return send(200, await runtime.providers.list(config.model, workspace));
        if (req.method === 'DELETE') {
          if (!workspace) throw new Error('Provide the current workspace.');
          await runtime.providers.clear(workspace);
          return send(200, { model: await runtime.providers.selected(config.model, workspace) });
        }
      }
      if (['/v1/settings/models/check','/v1/settings/models/select'].includes(url.pathname) && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.provider !== 'string' || typeof input.modelId !== 'string') throw new Error('Provide provider and modelId.');
        const ref = {provider:input.provider,modelId:input.modelId};
        if (url.pathname.endsWith('/check')) return send(200, await runtime.providers.check(ref));
        if (input.workspace !== undefined && typeof input.workspace !== 'string') throw new Error('Provide a workspace path.');
        return send(200, await runtime.providers.select(ref, input.workspace));
      }
      if (url.pathname === '/v1/settings/skills' && req.method === 'GET') {
        const workspace = url.searchParams.get('workspace');
        if (!workspace) throw new Error('Provide the current workspace.');
        return send(200,await runtime.skillCatalog(workspace));
      }
      if (url.pathname === '/v1/settings/skills' && req.method === 'PATCH') {
        const input = await body(req);
        if (typeof input.workspace !== 'string' || typeof input.name !== 'string' || typeof input.enabled !== 'boolean') throw new Error('Provide workspace, name and enabled.');
        return send(200,await runtime.setSkillEnabled(input.workspace,input.name,input.enabled));
      }
      if (url.pathname === '/v1/settings/skills/rollback' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.name !== 'string' || typeof input.version !== 'string') throw new Error('Provide name and version.');
        return send(200,await runtime.rollbackSkill({name:input.name,version:input.version}));
      }
      if (url.pathname === '/v1/settings/mcp') {
        if (req.method === 'GET') return send(200,await runtime.mcp.list());
        if (req.method === 'POST') return send(201,await runtime.mcp.configure(await body(req) as McpDefinition));
      }
      if (url.pathname === '/v1/settings/mcp/project') {
        if (req.method === 'GET') {
          const workspace = url.searchParams.get('workspace');
          if (!workspace) throw new Error('Provide the current workspace.');
          return send(200, { tools: await runtime.mcp.projectTools(workspace) });
        }
        if (req.method === 'PUT') {
          const { workspace, tools } = await body(req);
          if (typeof workspace !== 'string') throw new Error('Provide a workspace path.');
          return send(200, { tools: await runtime.mcp.setProjectTools(workspace, tools) });
        }
      }
      const mcp = /^\/v1\/settings\/mcp\/([^/]+)\/(test|enable|disable|approval|login|logout)$/.exec(url.pathname);
      if (mcp && req.method === 'POST') {
        const id = decodeURIComponent(mcp[1]!);
        if (mcp[2] === 'test') return send(200,await runtime.mcp.test(id));
        if (mcp[2] === 'disable') return send(200,await runtime.mcp.disable(id));
        if (mcp[2] === 'login') return send(200, await runtime.mcp.login(id, `http://127.0.0.1:${config.port}/v1/settings/mcp/oauth/callback`));
        if (mcp[2] === 'logout') return send(200, await runtime.mcp.logout(id));
        const input = await body(req);
        if (!Array.isArray(input.tools) || !input.tools.every(tool => typeof tool === 'string') || typeof input.revision !== 'string') throw new Error('Enable the displayed tools with their tested revision.');
        if (mcp[2] === 'approval') return send(200, await runtime.mcp.setApproval(id, input.tools, input.revision));
        return send(200,await runtime.mcp.enable(id,input.tools,input.revision));
      }
      if (url.pathname === '/v1/assistants') {
        if (req.method === 'GET') return send(200, await runtime.assistants.list(url.searchParams.get('workspace')));
        if (req.method === 'POST') return send(201, await runtime.assistants.create(await body(req)));
        return send(405, { error: 'Use GET or POST for assistant definitions.' });
      }
      const assistant = /^\/v1\/assistants\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (assistant) {
        if (req.method === 'GET') return send(200, await runtime.assistants.get(assistant[1]!));
        if (req.method === 'PATCH') return send(200, await runtime.assistants.update(assistant[1]!, await body(req)));
        return send(405, { error: 'Use GET or PATCH for an assistant definition.' });
      }
      if (url.pathname === '/v1/work-items') {
        if (req.method === 'GET') return send(200, await runtime.workItems.list(url.searchParams.get('workspace')));
        if (req.method === 'POST') return send(201, await runtime.workItems.create(await body(req)));
      }
      const workItem = /^\/v1\/work-items\/([a-f0-9-]{36})(?:\/(runs|share|unshare|share-replies|unshare-replies|share-controls|unshare-controls))?$/.exec(url.pathname);
      if (workItem) {
        const id = workItem[1]!;
        if (workItem[2] === 'runs') {
          if (req.method === 'GET') return send(200, await runtime.workItems.runs(id));
          if (req.method === 'POST') return send(201, await runtime.workItems.run(id, await body(req)));
        } else if (workItem[2] && req.method === 'POST') {
          const { accountId, deviceId } = await body(req);
          if (typeof accountId !== 'string' || typeof deviceId !== 'string') throw new Error('Provide accountId and deviceId.');
          const shared = workItem[2].startsWith('share');
          if (shared) await runtime.workItems.get(id);
          const access = workItem[2].endsWith('-replies') ? 'replies' : workItem[2].endsWith('-controls') ? 'controls' : 'view';
          return send(200, await devices.setSharedWorkItem(accountId, deviceId, id, shared, access));
        } else if (!workItem[2] && req.method === 'PATCH') return send(200, await runtime.workItems.update(id, await body(req)));
      }
      if (url.pathname === '/v1/routines') {
        if (req.method === 'GET') return send(200,await runtime.routines.list());
        if (req.method === 'POST') return send(201,await runtime.routines.create(await body(req) as RoutineInput));
      }
      const occurrenceHistory=/^\/v1\/routines\/([^/]+)\/occurrences$/.exec(url.pathname);
      if (occurrenceHistory && req.method === 'GET') {
        return send(200, await runtime.routines.history(decodeURIComponent(occurrenceHistory[1]!), url.searchParams.get('includeTaskStatus') === 'true'));
      }
      const routineControl = /^\/v1\/routines\/([^/]+)\/(pause|resume)$/.exec(url.pathname);
      if (routineControl && req.method === 'POST') {
        const id = decodeURIComponent(routineControl[1]!);
        return send(200, routineControl[2] === 'pause' ? await runtime.routines.pause(id) : await runtime.routines.resume(id));
      }
      const manualRoutine = /^\/v1\/routines\/([^/]+)\/run$/.exec(url.pathname);
      if (manualRoutine && req.method === 'POST') {
        const { requestId } = await body(req);
        if (typeof requestId !== 'string') throw new Error('Provide a routine request ID.');
        return send(202, await runtime.routines.runNow(decodeURIComponent(manualRoutine[1]!), requestId));
      }
      const routineEvent = /^\/v1\/routines\/([^/]+)\/events$/.exec(url.pathname);
      if (routineEvent && req.method === 'POST') {
        const revision = url.searchParams.get('revision');
        const result = await runtime.routines.receiveEvent(decodeURIComponent(routineEvent[1]!), await body(req), revision === null ? undefined : Number(revision));
        return send(result.outcome === 'accepted' ? 202 : 200, result);
      }
      const routine = /^\/v1\/routines\/([^/]+)$/.exec(url.pathname);
      if (routine) {
        if (req.method === 'PATCH') return send(200,await runtime.routines.update(decodeURIComponent(routine[1]!),await body(req) as RoutineInput));
        if (req.method === 'DELETE') return send(200,await runtime.routines.cancel(decodeURIComponent(routine[1]!)));
      }
      if (url.pathname === '/v1/remote/devices') {
        if (req.method === 'GET') return send(200,await devices.list());
        if (req.method === 'POST') {
          const input = await body(req);
          if (typeof input.accountId !== 'string' || typeof input.deviceId !== 'string') throw new Error('Provide accountId and deviceId.');
          return send(201,await devices.pair(input.accountId,input.deviceId));
        }
      }
      const device = /^\/v1\/remote\/devices\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (device && req.method === 'DELETE') return send(200,await devices.revoke(decodeURIComponent(device[1]!),decodeURIComponent(device[2]!)));
      if (url.pathname === '/v1/notifications' && req.method === 'GET') return send(200,await runtime.notifications());
      const notification = /^\/v1\/notifications\/([a-f0-9]{64})\/read$/.exec(url.pathname);
      if (notification && req.method === 'POST') return send(200,await runtime.readNotification(notification[1]!));
      const taskNotification = /^\/v1\/tasks\/([a-f0-9-]{36})\/notifications\/read$/.exec(url.pathname);
      if (taskNotification && req.method === 'POST') return send(200,await runtime.readTaskNotifications(taskNotification[1]!));
      const artifacts = /^\/v1\/tasks\/([a-f0-9-]{36})\/artifacts(?:\/(\d+)\/open)?$/.exec(url.pathname);
      if (artifacts) {
        if (artifacts[2] === undefined && req.method === 'GET') return send(200,await runtime.artifacts(artifacts[1]!));
        if (artifacts[2] !== undefined && req.method === 'POST') {
          const input = await body(req);
          if (input.reveal !== undefined && typeof input.reveal !== 'boolean') throw new Error('reveal must be a boolean.');
          const artifact = await artifactTarget(await runtime.status(artifacts[1]!),Number(artifacts[2]));
          await openLocalPath(artifact.path,artifact.kind,input.reveal === true);
          return send(200,{ok:true,path:artifact.path});
        }
      }
      const capture = /^\/v1\/tasks\/([a-f0-9-]{36})\/skills\/capture$/.exec(url.pathname);
      if (capture && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.path !== 'string') throw new Error('Provide the verified Skill directory.');
        return send(200,await runtime.captureSkill(capture[1]!,input.path));
      }
      if (url.pathname === "/v1/tasks" && req.method === "GET") return send(200, await runtime.list(url.searchParams.get('filter') ?? 'all'));
      if (url.pathname === "/v1/tasks" && req.method === "POST") {
        const input = await body(req);
        if (typeof input.objective !== "string" || (input.workspace !== undefined && typeof input.workspace !== "string")) throw new Error("Expected objective and optional workspace strings");
        if (input.confirmed !== undefined && typeof input.confirmed !== "boolean") throw new Error("confirmed must be a boolean");
        if (input.mode !== undefined && input.mode !== "chat") throw new Error("mode must be chat when supplied");
        if (input.mode === "chat" && input.confirmed === true) throw new Error("An ordinary conversation cannot preconfirm a task");
        return send(201, await runtime.create(input.objective, input.workspace, input.acceptance, { prepare: input.confirmed !== true, chat: input.mode === "chat",skills:input.skills as SkillSelection[]|undefined,
          assistant: input.assistant as AssistantRef | undefined, collaborators: input.collaborators as AssistantRef[] | undefined }));
      }
      const threadRoute = /^\/v1\/tasks\/([a-f0-9-]{36})\/(threads?)$/.exec(url.pathname);
      if (threadRoute) {
        const [, taskId, route] = threadRoute;
        if (route === 'threads' && req.method === 'POST') return send(201, await runtime.startThread(taskId!, await body(req)));
        if (route === 'thread' && req.method === 'PATCH') return send(200, await runtime.editThread(taskId!, await body(req)));
        return send(405, { error: 'Method not allowed' });
      }
      const modelProposal = /^\/v1\/tasks\/([a-f0-9-]{36})\/model-proposals(?:\/([1-9]\d{0,19}))?$/.exec(url.pathname);
      if (modelProposal) {
        const [, taskId, id] = modelProposal;
        if (!id && req.method === 'GET') return send(200, await runtime.projectModelProposals(taskId!));
        if (id && req.method === 'POST') {
          const { decision } = await body(req);
          if (decision !== 'apply' && decision !== 'decline') throw new Error('Choose apply or decline.');
          return send(200, await runtime.decideProjectModel(taskId!, id, decision));
        }
        return send(405, { error: 'Method not allowed' });
      }
      const snapshotRoute = /^\/v1\/tasks\/([a-f0-9-]{36})\/snapshots(?:\/([a-f0-9-]{36})\/(preview|restore))?$/.exec(url.pathname);
      if (snapshotRoute) {
        const [, taskId, snapshotId, operation] = snapshotRoute;
        if (!operation && req.method === 'GET') return send(200, await runtime.workspaceSnapshots(taskId!));
        if (!operation && req.method === 'POST') {
          const { label } = await body(req);
          if (typeof label !== 'string') throw new Error('Provide a snapshot label.');
          return send(201, await runtime.saveWorkspaceSnapshot(taskId!, label));
        }
        if (operation === 'preview' && req.method === 'GET') return send(200, await runtime.previewWorkspaceRestore(taskId!, snapshotId!));
        if (operation === 'restore' && req.method === 'POST') {
          const { version } = await body(req);
          if (typeof version !== 'string') throw new Error('Provide the displayed preview version.');
          return send(200, await runtime.restoreWorkspace(taskId!, snapshotId!, version));
        }
        return send(405, { error: 'Method not allowed' });
      }
      const assistantWork = /^\/v1\/tasks\/([a-f0-9-]{36})\/assistant-work(?:\/(assign-(?:[a-f0-9-]{36}-)?\d+)(?:\/(stop|guide|questions\/(\d+)\/answer))?)?$/.exec(url.pathname);
      if (assistantWork) {
        const [, taskId, id, action, questionId] = assistantWork;
        if (!action && req.method === 'GET') {
          return send(200, id ? await runtime.assistantResult(taskId!, id) : (await runtime.status(taskId!)).assistantWork);
        }
        if (!id || !action || req.method !== 'POST') return send(405, { error: 'Method not allowed' });
        const input = await body(req);
        if (typeof input.requestId !== 'string') throw new Error('Provide the original request ID.');
        if (action === 'stop') {
          if (typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version)) throw new Error('Provide the displayed work version.');
          return send(200, await runtime.stopAssignedAssistant(taskId!, id, input.version, input.requestId));
        }
        const text = questionId ? input.answer : input.text;
        if (typeof text !== 'string') throw new Error('Provide the answer or guidance as text.');
        return send(200, await runtime.inputAssistantWork(taskId!, {
          id, requestId: input.requestId, text, ...(questionId ? { questionId } : {}),
        }, questionId ? 'answer' : 'guidance'));
      }
      const childControl = /^\/v1\/tasks\/([a-f0-9-]{36})\/delegations\/(\d+)\/(stop|interrupt)$/.exec(url.pathname);
      if (childControl && req.method === "POST") {
        const [, task, child, action] = childControl;
        if (action === "stop") return send(200, await runtime.stopChild(task!, Number(child)));
        const { toolTaskId } = await body(req);
        if (toolTaskId !== undefined && typeof toolTaskId !== "number") throw new Error("Provide a valid tool task ID.");
        return send(200, await runtime.interruptChild(task!, Number(child), { toolTaskId }));
      }
      const childAnswer = /^\/v1\/tasks\/([a-f0-9-]{36})\/delegations\/(\d+)\/questions\/(\d+)\/answer$/.exec(url.pathname);
      if (childAnswer && req.method === "POST") {
        const { requestId, answer } = await body(req);
        if (typeof requestId !== "string" || typeof answer !== "string") throw new Error("Provide requestId and answer strings.");
        return send(200, await runtime.answerChildQuestion(childAnswer[1]!, Number(childAnswer[2]), childAnswer[3]!, requestId, answer));
      }
      const approvalRoute = /^\/v1\/tasks\/([a-f0-9-]{36})\/approvals(?:\/(\d+)\/(allow|deny|share|unshare))?$/.exec(url.pathname);
      if (approvalRoute) {
        if (req.method === 'GET' && !approvalRoute[2]) return send(200, (await runtime.status(approvalRoute[1]!)).approvals);
        if (req.method === 'POST' && approvalRoute[2]) {
          const { digest, accountId, deviceId } = await body(req);
          if (typeof digest !== 'string') throw new Error('Provide the displayed action digest.');
          if (approvalRoute[3] === 'share' || approvalRoute[3] === 'unshare') {
            if (typeof accountId !== 'string' || typeof deviceId !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
              throw new Error('Provide the account, device and displayed action digest.');
            }
            const taskId = approvalRoute[1]!, approvalId = approvalRoute[2];
            const shared = approvalRoute[3] === 'share';
            if (shared && !await runtime.sharedApproval(taskId, approvalId, digest)) {
              return send(409, { error: 'This action is no longer available to share.' });
            }
            return send(200, await devices.setSharedApproval(accountId, deviceId, { taskId, approvalId, digest }, shared));
          }
          return send(200, await runtime.decideApproval(approvalRoute[1]!, approvalRoute[2], approvalRoute[3] as 'allow' | 'deny', digest));
        }
      }
      const questionAnswer = /^\/v1\/tasks\/([a-f0-9-]{36})\/questions\/(\d+)\/answer$/.exec(url.pathname);
      if (questionAnswer && req.method === 'POST') {
        const { requestId, answer } = await body(req);
        if (typeof requestId !== 'string' || typeof answer !== 'string') throw new Error('Provide requestId and answer strings.');
        await runtime.answerQuestion(questionAnswer[1]!, questionAnswer[2]!, requestId, answer);
        return send(200, { requestId });
      }
      const credentialInput = /^\/v1\/tasks\/([a-f0-9-]{36})\/credentials\/(\d+)$/.exec(url.pathname);
      if (credentialInput && req.method === 'POST') {
        const input = await body(req).catch(() => { throw new Error('Invalid protected credential input.'); });
        if (!((Object.keys(input).length === 1 && typeof input.value === 'string') || (Object.keys(input).length === 1 && input.decline === true))) throw new Error('Provide a protected credential value or decline.');
        await runtime.provideCredential(credentialInput[1]!, credentialInput[2]!, typeof input.value === 'string' ? input.value : undefined);
        return send(200, { accepted: true });
      }
      if (url.pathname === '/v1/credentials') {
        const project = await runtime.credentialScope(url.searchParams.get('workspace'));
        if (req.method === 'GET') return send(200, await runtime.credentials.list(project));
        if (req.method === 'DELETE') {
          const input = await body(req);
          if (typeof input.name !== 'string' || typeof input.revision !== 'number') throw new Error('Provide credential name and displayed revision.');
          await runtime.credentials.remove(project, input.name, input.revision); return send(200, { removed: true });
        }
      }
      const match = /^\/v1\/tasks\/([a-f0-9-]{36})(?:\/(pause|resume|cancel|messages|confirm|view|memory))?$/.exec(url.pathname);
      if (!match) return send(404, { error: "Not found" });
      const id = match[1]!;
      if (match[2] === "memory" && req.method === "GET") return send(200, await runtime.taskMemory(id));
      if (match[2] === "view" && req.method === "GET") return send(200, taskView(await runtime.status(id)));
      if (!match[2] && req.method === "GET") return send(200, await runtime.status(id));
      if (req.method !== "POST") return send(405, { error: "Method not allowed" });
      const input = await body(req);
      switch (match[2]) {
        case "pause": await runtime.pause(id); break;
        case "resume": await runtime.resume(id); break;
        case "cancel": await runtime.cancel(id); break;
        case "confirm":
          if (!Number.isSafeInteger(input.revision) || typeof input.digest !== "string") throw new Error("Confirm requires the displayed brief revision and digest");
          await runtime.confirm(id, input.revision as number, input.digest); break;
        case "messages":
          if (Object.hasOwn(input, 'assistant') || Object.hasOwn(input, 'collaborators')) {
            throw new AssistantError(409, 'An existing task keeps its original assistant selection. Select roles for a new task.');
          }
          if (typeof input.message !== "string" || (input.requestId !== undefined && typeof input.requestId !== "string")) throw new Error("Expected message and optional requestId strings");
          await runtime.followUp(id, input.message, input.requestId); break;
        default: return send(404, { error: "Not found" });
      }
      return send(200, { ok: true });
    } catch (error) {
      const details = error && typeof error === 'object' ? error as {status?:unknown;code?:unknown} : {};
      const status = typeof details.status === 'number' && details.status >= 400 && details.status < 600 ? details.status : details.code === 'ENOENT' ? 404 : 400;
      send(status, { error: errorText(error), ...(error instanceof MemoryMutationError && error.current ? { current: error.current } : {}) });
    }
  });
  try {
    const extensions = config.computer ? [await computer.connect(config.computer)] : [];
    runtime = new LocalRuntime(config, { ...options, models: options?.models ?? cloudModels(), extensions: [...extensions, ...(options?.extensions ?? [])], computer: config.computer ? computer : options?.computer });
    remote = createRemoteHandler(runtime,{directory:join(config.dataDir,'remote'),origin:config.remoteOrigin ?? `http://127.0.0.1:${config.port}`,devices:()=>devices.credentials(),sharedDevices:devices,push:config.remotePush && Boolean(config.remoteOrigin)});
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve); });
    await quarantineLegacyRemoteTasks(runtime,join(config.dataDir,'remote'));
    await runtime.recover();
    await runtime.localSetup();
    ready = true;
    if (config.remotePush && config.remoteOrigin) {
      pushTimer = setInterval(() => {
        if (pushRun) return;
        pushRun = remote.pollPush()?.catch(() => console.error("Could not check remote push updates."))
          .finally(() => { pushRun = undefined; });
      }, 5000);
      pushTimer.unref();
    }
    if (config.githubIssuePolling?.length) {
      githubRun = watchGithubIssues(config.dataDir, config.githubIssuePolling, runtime.routines, githubAbort.signal)
        .catch(error => console.error("GitHub issue watcher stopped. " + errorText(error)));
    }
  } catch (error) {
    server.close();
    await runtime?.close();
    await computer.close();
    await release();
    throw error;
  }
  let closing = false;
  return {
    runtime,
    async close() {
      if (closing) return;
      closing = true;
      ready = false;
      clearInterval(pushTimer);
      githubAbort.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { await Promise.all([pushRun, githubRun]); await runtime!.close(); await computer.close(); } finally { await release(); }
    },
  };
}
