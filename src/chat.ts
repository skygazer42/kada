import { createInterface, clearLine, cursorTo } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Writable, type Readable } from "node:stream";
import type { HarnessClient, TaskMeta, TaskStatus } from "./client.js";
import type { LocalRuntime } from "./runtime.js";
import type { ModelProposal } from './provider-settings.js';
import type { McpSettingsProposal } from './mcp-tools.js';
import type { MemoryFactView } from "./user-memory.js";
import { errorText, SerialQueue } from "./util.js";
import { assistantText, briefText, progressText, usageText, verificationText } from "./presentation.js";
import type { AssistantRef } from './assistants.js';
import { isConfirmation } from "./preparation.js";
import { conversationAnswer as answer } from "./conversation.js";

type Message = TaskStatus["messages"][number];
export type ChatEvent = { kind: "info" | "answer" | "error"; text: string };

function answerKey(message: Message, text: string): string { return `${message.timestamp}:${text}`; }
const HELP = `直接输入消息：普通问答直接回复，需要实际交付时再提出任务说明与预算。\n\n/new [消息]       新建对话，原任务继续在后台运行\n/confirm          确认刚展示的任务说明与预算\n/run 目标         已有明确授权，沿用配置预算直接执行\n/memory list      查看当前项目记忆与来源\n/memory edit ID 内容 纠正一条记忆\n/memory forget ID 遗忘一条记忆\n/memory used      查看当前会话使用的记忆版本\n/tasks            列出最近的对话与任务\n/attach 任务ID    接回已有对话或任务\n/status           查看状态、预算、核验范围和进度\n/pause            暂停当前对话或任务\n/resume           恢复；显式补充一份配置/已确认预算，不代替目标确认\n/cancel           取消当前对话或任务\n/help             显示帮助\n/quit             退出聊天，后台任务继续运行`;
const ASSISTANT_WORK_HELP = '/assistant-work [工作ID] 查看同事工作或原结果\n/reply-assistant 工作ID 问题ID 答复\n/guide-assistant 工作ID 补充说明\n/stop-assistant 工作ID 停止已查看的工作';
const THREAD_HELP = '/thread [--model provider/modelId] 标题 | 任务说明  从当前会话打开独立工作\n/thread-report [--model provider/modelId] 标题 | 任务说明  验收后回传原会话\n/title 标题  修改当前会话的标题\n/archive  归档当前会话\n/unarchive  将当前会话移回列表\n/tasks archived  查找已归档会话';
const MODEL_PROPOSAL_HELP = '/model-proposals  查看当前会话的项目模型建议\n/apply-model 建议ID  检查连通性并应用\n/decline-model 建议ID  拒绝建议';
const MCP_PROPOSAL_HELP = '/mcp-proposals  查看当前会话的 MCP 连接与范围建议\n/apply-mcp 建议ID  应用建议\n/decline-mcp 建议ID  拒绝建议';

/** Conversation selection and delivery are independent of terminal rendering. */
export class ChatSession {
  taskId?: string;
  private printed = new Set<string>();
  private activity = "";
  private shownBrief?: { revision: number; digest: string };
  private shownApprovals = new Map<string, string>();
  private shownAssistantWork = new Map<string, string>();
  private pendingThread?: { source: string; title: string; message: string; reportBack: boolean; modelId?: string; requestId: string };
  constructor(private client: HarnessClient, private emit: (event: ChatEvent) => void, private workspace?: string, private protectedInput?: () => Promise<string>, private assistant?: AssistantRef, private collaborators?: AssistantRef[]) {}
  private info(text: string): void { this.emit({ kind: "info", text }); }
  private select(id?: string): void { this.taskId = id; this.printed.clear(); this.activity = ""; this.shownBrief = undefined; this.shownApprovals.clear(); this.shownAssistantWork.clear(); }
  async attach(id: string): Promise<void> {
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${id}`);
    this.select(id);
    if (status.assistant) this.info(assistantText(status));
    this.info(`已接入${status.interaction === "chat" ? "对话" : "任务"} ${id}\n${status.interaction === "chat" ? "首条消息" : "目标"}：${status.objective}\n输出目录：${status.workspace}`);
    if (status.thread?.title) this.info(`标题 · ${status.thread.title}`);
    if (status.thread?.modelSelection) this.info(`独立工作模型 · ${status.model.provider}/${status.model.modelId}`);
    if (status.thread?.sourceTaskId) this.info(`原会话 · /attach ${status.thread.sourceTaskId}`);
    if (status.thread?.archivedAt) this.info('会话已归档。输入 /unarchive 恢复后可继续。');
    if (!status.goal) {
      const answers = status.messages.map(m => ({ m, text: answer(m) })).filter(v => v.text !== undefined);
      for (const item of answers) this.printed.add(answerKey(item.m, item.text!));
      const last = answers.at(-1);
      if (last) this.emit({ kind: "answer", text: last.text! });
    }
    await this.poll();
    await this.client.request(`/v1/tasks/${id}/notifications/read`,'POST',{});
  }
  /** false means exit the client; the daemon and tasks are left running. */
  async handle(line: string): Promise<boolean> {
    const text = line.trim();
    if (!text) return true;
    if (text.startsWith("/")) {
      const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (!match) throw new Error("未知命令，输入 /help 查看帮助。");
      const command = match[1], argument = match[2]?.trim();
      if (command === "/quit" || command === "/exit") return false;
      if (command === '/mcp-proposals' || command === '/apply-mcp' || command === '/decline-mcp') {
        if (!this.taskId) throw new Error('先用 /attach 选择会话。');
        const path = `/v1/tasks/${this.taskId}/mcp-proposals`;
        if (command === '/mcp-proposals') {
          const proposals = await this.client.request<McpSettingsProposal[]>(path);
          this.info(proposals.length ? proposals.map(proposal => {
            const { id, state } = proposal;
            const details = 'tools' in proposal
              ? `当前项目工具 ${proposal.previous === null ? '继承全局选择' : proposal.previous.map(item => `${item.id}/${item.tool}`).join('、') || '空名单'}\n建议 ${proposal.tools === null ? '继承全局选择 · ' : ''}${proposal.effective.map(item => `${item.id}/${item.tool}`).join('、') || '空名单'}`
              : `${proposal.connectionId} · ${proposal.transport}\n${proposal.endpoint}`;
            return `${id} · ${state} · ${details}` + (state === 'pending' ? `\n/apply-mcp ${id} · /decline-mcp ${id}` : '');
          }).join('\n\n') : '当前会话没有 MCP 设置建议。');
        } else {
          if (!argument || !/^[1-9]\d{0,19}$/.test(argument)) throw new Error(`用法：${command} 建议ID`);
          const proposal = await this.client.request<McpSettingsProposal>(`${path}/${argument}`, 'POST', { decision: command === '/apply-mcp' ? 'apply' : 'decline' });
          this.info(proposal.state === 'registered' ? `连接 ${proposal.connectionId} 已登记，可用 npm run harness -- mcp test ${proposal.connectionId} 测试。`
            : proposal.state === 'applied' ? '项目工具范围已更新，供新任务使用。' : '已拒绝 MCP 设置建议。');
        }
        return true;
      }
      if (command === '/model-proposals' || command === '/apply-model' || command === '/decline-model') {
        if (!this.taskId) throw new Error('先用 /attach 选择会话。');
        const path = `/v1/tasks/${this.taskId}/model-proposals`;
        if (command === '/model-proposals') {
          const proposals = await this.client.request<ModelProposal[]>(path);
          this.info(proposals.length ? proposals.map(({ id, previous, model, reason, state }) => {
            const before = previous ? `${previous.provider}/${previous.modelId}` : '未设置';
            return `${id} · ${state} · ${before} → ${model.provider}/${model.modelId}\n${reason}` +
              (state === 'pending' ? `\n/apply-model ${id} · /decline-model ${id}` : '');
          }).join('\n\n') : '当前会话没有模型建议。');
        } else {
          if (!argument || !/^[1-9]\d{0,19}$/.test(argument)) throw new Error(`用法：${command} 建议ID`);
          const proposal = await this.client.request<ModelProposal>(`${path}/${argument}`, 'POST', { decision: command === '/apply-model' ? 'apply' : 'decline' });
          this.info(proposal.state === 'applied' ? `项目默认模型已更新为 ${proposal.model.provider}/${proposal.model.modelId}，供新任务使用。` : '已拒绝模型建议。');
        }
        return true;
      }
      const reportBack = command === '/thread-report';
      if (reportBack || command === '/thread' || command === '/title' || command === '/archive' || command === '/unarchive') {
        const source = this.taskId;
        if (!source) throw new Error('先用 /attach 选择会话。');
        const path = `/v1/tasks/${source}`;
        if (command === '/thread' || reportBack) {
          const option = /^--model\s+([^/\s]+)\/(\S+)\s+([\s\S]+)$/.exec(argument ?? '');
          const modelSelection = option ? { provider: option[1]!, modelId: option[2]! } : undefined;
          const thread = option?.[3] ?? argument;
          const separator = thread?.indexOf('|') ?? -1;
          if (!thread || separator < 1 || !option && /^--model(?:\s|$)/.test(thread)) throw new Error(`用法：${command} [--model provider/modelId] 标题 | 任务说明`);
          if (!await this.client.healthy(modelSelection ? 'thread-models' : reportBack ? 'thread-reports' : 'local-threads')) throw new Error('请连接支持该会话操作的当前版本后台。');
          const title = thread.slice(0, separator).trim(), message = thread.slice(separator + 1).trim();
          const modelId = modelSelection ? `${modelSelection.provider}/${modelSelection.modelId}` : undefined;
          const pending = this.pendingThread;
          const requestId = pending?.source === source && pending.title === title && pending.message === message && pending.reportBack === reportBack && pending.modelId === modelId ? pending.requestId : randomUUID();
          this.pendingThread = { source, title, message, reportBack, modelId, requestId };
          const task = await this.client.request<{ id: string }>(`${path}/threads`, 'POST', { title, message, requestId,
            ...(reportBack ? { reportBack } : {}), ...(modelSelection ? { modelSelection } : {}) });
          this.pendingThread = undefined;
          this.info(`已打开独立工作 · /attach ${task.id}`);
          await this.attach(task.id);
        } else {
          if (!await this.client.healthy('local-threads')) throw new Error('请连接支持该会话操作的当前版本后台。');
          if (command === '/title' ? !argument : argument) throw new Error(command === '/title' ? '用法：/title 标题' : `用法：${command}`);
          const status = await this.client.request<TaskStatus>(path);
          const patch = command === '/title' ? { title: argument } : { archived: command === '/archive' };
          await this.client.request(`${path}/thread`, 'PATCH', { revision: status.thread?.revision ?? 0, ...patch });
          this.info(command === '/title' ? `标题 · ${argument}` : command === '/archive' ? '会话已归档。' : '会话已移回任务列表。');
        }
        return true;
      }
      if (['/assistant-work', '/reply-assistant', '/guide-assistant', '/stop-assistant'].includes(command!)) {
        if (!this.taskId) throw new Error('先用 /attach 选择任务。');
        const path = `/v1/tasks/${this.taskId}/assistant-work`;
        if (command === '/assistant-work') {
          if (argument && !/^assign-(?:[a-f0-9-]{36}-)?\d+$/.test(argument)) throw new Error('使用原工作 ID。');
          const work = await this.client.request<TaskStatus['assistantWork'][number] & { answer: string | null } | TaskStatus['assistantWork']>(argument ? `${path}/${argument}` : path);
          const rows = Array.isArray(work) ? work : [work];
          for (const row of rows) this.shownAssistantWork.set(row.id, row.controlVersion);
          this.info(rows.length ? JSON.stringify(work, null, 2) : '当前任务没有同事工作。');
          return true;
        }
        if (command === '/stop-assistant') {
          const version = this.shownAssistantWork.get(argument ?? '');
          if (!version) throw new Error('先用 /assistant-work 查看要停止的工作。');
          await this.client.request(`${path}/${argument}/stop`, 'POST', { version, requestId: `terminal-stop-${argument}` });
          this.info('已确认停止该工作。');
        } else if (command === '/reply-assistant') {
          const reply = /^(assign-(?:[a-f0-9-]{36}-)?\d+)\s+(\d+)\s+([\s\S]+)$/.exec(argument ?? '');
          if (!reply) throw new Error('用法：/reply-assistant 工作ID 问题ID 答复');
          await this.client.request(`${path}/${reply[1]}/questions/${reply[2]}/answer`, 'POST', { requestId: `terminal-answer-${reply[2]}`, answer: reply[3] });
          this.info('答复已保存到原工作。');
        } else {
          const guide = /^(assign-(?:[a-f0-9-]{36}-)?\d+)\s+([\s\S]+)$/.exec(argument ?? '');
          if (!guide) throw new Error('用法：/guide-assistant 工作ID 补充说明');
          await this.client.request(`${path}/${guide[1]}/guide`, 'POST', { requestId: randomUUID(), text: guide[2] });
          this.info('补充说明已保存到原工作。');
        }
        await this.poll();
        return true;
      }
      if (command === '/credential' || command === '/decline-credential') {
        if (!this.taskId || !/^\d+$/.test(argument ?? '')) throw new Error('使用当前凭据问题 ID，不要在命令中填写密钥。');
        const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`), question = status.userQuestion;
        if (!question?.credential || question.id !== argument) throw new Error('该凭据请求已变化，请刷新查看。');
        if (command === '/credential' && !this.protectedInput) throw new Error('凭据输入需要交互终端；不能通过普通聊天或管道提供。');
        const value = command === '/credential' ? await this.protectedInput!() : undefined;
        await this.client.request(`/v1/tasks/${this.taskId}/credentials/${question.id}`, 'POST', value === undefined ? { decline: true } : { value });
        this.info(value === undefined ? '已拒绝凭据请求。' : '已保存凭据并接回原会话。');
        await this.poll(); return true;
      }
      if (command === '/choose') {
        if (!this.taskId) throw new Error('先用 /attach 选择任务。');
        const selected = /^(\d+)\s+([1-4])$/.exec(argument ?? '');
        const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`), question = status.userQuestion;
        if (!selected || !question || question.id !== selected[1] || !question.options[Number(selected[2]) - 1]) throw new Error('请用当前问题 ID 和显示的选项编号。');
        await this.client.request(`/v1/tasks/${this.taskId}/questions/${question.id}/answer`, 'POST', {
          requestId: 'terminal-question-' + question.id, answer: question.options[Number(selected[2]) - 1],
        });
        await this.poll(); return true;
      }
      if (command === "/children") {
        if (!this.taskId) throw new Error("先用 /attach 选择任务。");
        const { delegations } = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`);
        this.info(delegations.length ? delegations.map(child => `${child.conversationId} [${child.status}] ${child.name}`).join("\n") : "当前任务没有子任务。");
        return true;
      }
      if (command === "/stop-child" || command === "/interrupt-child") {
        if (!this.taskId) throw new Error("先用 /attach 选择任务。");
        if (!argument || !/^\d+$/.test(argument)) throw new Error(`用法：${command} 子会话ID`);
        const path = `/v1/tasks/${this.taskId}/delegations/${argument}`;
        if (command === "/stop-child") {
          await this.client.request(path + "/stop", "POST", {});
          this.info("已停止该子任务。");
        } else {
          const { interrupted, pending } = await this.client.request<{ interrupted: number; pending: number }>(path + "/interrupt", "POST", {});
          if (interrupted) this.info(`已中断 ${interrupted} 个工具调用，子会话继续运行。`);
          if (pending) this.info(`有 ${pending} 个工具调用的中断尚未确认，请查看任务状态。`);
          if (!interrupted && !pending) this.info("没有需要中断的工具调用。");
        }
        await this.poll();
        return true;
      }
      if (command === "/reply-child") {
        if (!this.taskId) throw new Error("先用 /attach 选择任务。");
        const reply = /^(\d+)\s+(\d+)\s+([\s\S]+)$/.exec(argument ?? "");
        if (!reply) throw new Error("用法：/reply-child 子会话ID 问题ID 答复");
        const [, child, question, answer] = reply;
        await this.client.request(`/v1/tasks/${this.taskId}/delegations/${child}/questions/${question}/answer`,
          "POST", { requestId: "terminal-" + question, answer });
        this.info("答复已接收，子任务会从原会话继续。");
        await this.poll();
        return true;
      }
      if (command === "/help") { this.info(HELP+'\n\n'+THREAD_HELP+'\n'+MODEL_PROPOSAL_HELP+'\n'+MCP_PROPOSAL_HELP+'\n/tasks pending|running|delivered  筛选待处理、执行或交付\n/inbox /read 通知ID  查看通知及标记已读\n/files /open 编号  查看和打开核验产物\n/approvals  查看动作参数\n/allow 动作ID /deny 动作ID  答复已展示的动作审批\n/choose 问题ID 编号  选择当前问题的一个选项\n/credential 问题ID  在交互终端无回显提供凭据，勿在命令中填值\n/decline-credential 问题ID  拒绝当前凭据请求\n/children  查看子会话 ID 和状态\n/stop-child 子会话ID  停止单个后台子任务\n/interrupt-child 子会话ID  中断该子任务当前工具\n/reply-child 子会话ID 问题ID 答复  回复原子会话\n'+ASSISTANT_WORK_HELP+'\n/remind ISO时间 内容  保存带时区的单次提醒\n模型、Skills、MCP、每周规则和设备管理：npm run harness -- help'); return true; }
      if (command === "/confirm") { await this.confirm(); return true; }
      if (['/approvals', '/allow', '/deny'].includes(command!)) {
        if (!this.taskId) throw new Error('先用 /attach 选择任务。');
        const path = `/v1/tasks/${this.taskId}/approvals`;
        const approvals = await this.client.request<TaskStatus['approvals']>(path);
        if (command === '/approvals') {
          this.shownApprovals = new Map(approvals.map(item => [item.id, item.digest]));
          this.info(approvals.length ? approvals.map(item => `${item.id} [${item.status}] ${item.connection}/${item.tool}\n参数 ${JSON.stringify(item.arguments)}\nSHA-256 ${item.digest}\n有效至 ${new Date(item.expiresAt).toISOString()}${item.result ? '\n结果 ' + item.result : ''}`).join('\n\n') : '当前任务没有待审批动作。');
        } else {
          const action = approvals.find(item => item.id === argument);
          if (!action) throw new Error('从 /approvals 选择动作 ID。');
          if (this.shownApprovals.get(action.id) !== action.digest) throw new Error('先用 /approvals 查看该动作的参数，再答复。');
          await this.client.request(`${path}/${action.id}/${command === '/allow' ? 'allow' : 'deny'}`, 'POST', { digest: action.digest });
          this.info(command === '/allow' ? '已允许该动作执行一次。' : '已拒绝该动作。');
          await this.poll();
        }
        return true;
      }
      if (command === "/run") {
        if (!argument) throw new Error("用法：/run 已明确授权的目标（沿用当前配置预算）");
        this.select(); await this.send(argument, true); return true;
      }
      if (command === "/new") {
        this.select();
        this.info("已切换到新对话。原任务会继续在后台运行。");
        if (argument) await this.send(argument);
        return true;
      }
      if (command === "/attach") {
        if (!argument) throw new Error("用法：/attach 任务ID");
        await this.attach(argument);
        return true;
      }
      if (command === "/memory") {
        const [action = "list", memoryId, ...words] = (argument ?? "").split(/\s+/).filter(Boolean);
        if (action === "used") {
          if (!this.taskId) throw new Error("先用 /attach 选择任务，再查看记忆引用。");
          const used = await this.client.request<{ current: string[]; references: { factId: string; revision: string; text: string; evidence: { path: string; quote: string }[] }[] }>("/v1/tasks/" + this.taskId + "/memory");
          this.info(used.references.length ? used.references.map(reference =>
            (used.current.includes(reference.factId + "@" + reference.revision) ? "[当前背景] " : "[历史背景] ") +
            reference.factId + " " + reference.text + "\n  来源：" + reference.evidence.map(item => item.path).join("、")).join("\n") : "当前会话尚未引入记忆背景。");
          return true;
        }
        const workspace = this.taskId ? (await this.client.request<TaskStatus>("/v1/tasks/" + this.taskId)).workspace : this.workspace ?? process.cwd();
        const query = "?workspace=" + encodeURIComponent(workspace);
        const view = await this.client.request<{ facts: MemoryFactView[] }>("/v1/environment/memory" + query);
        if (action === "list") {
          this.info(view.facts.length ? view.facts.map(fact => [
            `${fact.id} [${fact.scope}] ${fact.text}`,
            `  确定性 ${fact.certainty} · 状态 ${fact.state} · 版本 ${fact.revision}`,
            ...fact.evidence.map(item => `  来源 ${item.path} · SHA-256 ${item.sha256}\n  摘录 ${item.quote}`),
          ].join("\n")).join("\n") : "当前项目尚无有效记忆。");
          return true;
        }
        const fact = view.facts.find(item => item.id === memoryId);
        if (!fact) throw new Error("请从 /memory list 选择当前项目的记忆 ID。");
        if (action !== "edit" && action !== "forget") throw new Error("用法：/memory list、/memory edit ID 新内容、/memory forget ID、/memory used");
        const text = words.join(" ");
        if (action === "edit" && !text) throw new Error("在记忆 ID 后输入纠正后的内容。");
        await this.client.request("/v1/environment/memory/" + fact.id + (action === "forget" ? "/forget" : "") + query,
          action === "forget" ? "POST" : "PATCH", {
            expectedRevision: fact.revision, requestId: randomUUID(), ...(action === "edit" ? { text } : {}),
          });
        this.info(action === "forget" ? "已遗忘该记忆，后续检索和自动背景停止采用它。原始文件和历史对话可在各自入口管理。" : "已保存纠正后的记忆，来源和历史版本可追溯。");
        return true;
      }
      if (command === "/tasks") {
        const tasks = (await this.client.request<Awaited<ReturnType<LocalRuntime["list"]>>>("/v1/tasks?filter=" + encodeURIComponent(argument ?? "all"))).slice(0, 10);
        if (!tasks.length) this.info("还没有对话，直接输入消息即可开始。");
        else for (const task of tasks) {
          const cost = task.budget.estimatedCostUsd === null ? "费用未知" : `$${task.budget.estimatedCostUsd.toFixed(4)}`;
          const limit = task.budget.costLimit === null ? "" : ` / $${task.budget.costLimit}`;
          const lines = [`${task.id}  [${task.thread?.archivedAt ? 'archived' : task.status}]  ${task.thread?.title ?? task.objective.slice(0, 100).replace(/\s+/g, " ")}`];
          if (task.summary) lines.push(`  ${task.summary}`);
          if (task.step && task.step !== task.summary) lines.push(`  当前步骤 ${task.step}`);
          lines.push(`  用量 ${task.budget.totalTokens} token · ${cost}${limit}`);
          if (task.artifacts.length) lines.push(`  产物 ${task.artifacts.join("、")}`);
          this.info(lines.join("\n"));
        }
        return true;
      }
      if (command === '/inbox' || command === '/read') {
        if (command === '/read') {
          if (!argument) throw new Error('用法：/read 通知ID');
          await this.client.request('/v1/notifications/'+encodeURIComponent(argument)+'/read','POST',{});
          this.info('通知已读。');
        } else {
          const items = await this.client.request<{id:string;taskId?:string;detail:string;readAt:number|null}[]>('/v1/notifications');
          this.info(items.length ? items.map(item => `${item.readAt === null ? '[未读]' : '[已读]'} ${item.id}\n${item.detail}${item.taskId ? '\n/attach '+item.taskId : ''}`).join('\n\n') : '暂无通知。');
        }
        return true;
      }
      if (command === '/files' || command === '/open') {
        if (!this.taskId) throw new Error('先用 /attach 选择任务。');
        if (command === '/open') {
          const index = Number(argument);
          if (!argument || !Number.isSafeInteger(index) || index < 1) throw new Error('用法：/open 文件编号（从 1 开始）');
          await this.client.request(`/v1/tasks/${this.taskId}/artifacts/${index-1}/open`,'POST',{});
          this.info('已打开产物或所在文件夹。');
        } else {
          const files = await this.client.request<{index:number;path:string;state:string;reason?:string}[]>(`/v1/tasks/${this.taskId}/artifacts`);
          this.info(files.length ? files.map(file => `${file.index+1}. [${file.state}] ${file.path}${file.reason ? '\n  '+file.reason : ''}`).join('\n') : '当前任务尚未提交产物。');
        }
        return true;
      }
      if (command === '/remind') {
        const [at,...words] = (argument ?? '').split(/\s+/);
        if (!at || !/(Z|[+-]\d{2}:\d{2})$/i.test(at) || !words.length) throw new Error('用法：/remind 2026-12-01T17:00:00-05:00 提醒内容');
        const rule = await this.client.request<{id:string;nextRunAt:string}>('/v1/routines','POST',{action:'notify',objective:words.join(' '),schedule:{kind:'once',at}});
        this.info(`提醒已保存：${rule.id}\n到期：${rule.nextRunAt}`);
        return true;
      }
      if (["/status", "/pause", "/resume", "/cancel"].includes(command!)) {
        if (!this.taskId) throw new Error("还未选择对话。直接输入消息，或使用 /attach 任务ID。");
        if (command === "/status") {
          const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`);
          const goal = status.goal;
          if (status.assistant) this.info(assistantText(status));
          this.info(`${status.interaction === "chat" ? "对话" : "任务"}：${status.id}\n状态：${status.status === "completed" ? "已交付（核验范围见下）" : status.status}\n子 Agent：${status.activeWorkerCount} 个运行 / ${status.workerCount} 个累计\n输出目录：${status.workspace}\n${usageText(status)}${goal ? `\n目标修订：${goal.revision}${goal.reason ? `\n原因：${goal.reason}` : ""}${goal.question ? `\n待回答：${goal.question}` : ""}` : ""}\n${verificationText(status)}${goal?.brief ? `\n${briefText(status)}${goal.confirmation ? "\n该版本已确认；预算不会因普通消息或重复确认补充。" : ""}` : ""}`);
          const progress = progressText(status);
          if (progress) this.info(progress);
        } else {
          await this.client.request(`/v1/tasks/${this.taskId}/${command!.slice(1)}`, "POST", {});
          this.activity = "";
          this.info(command === "/pause" ? "已暂停。" : command === "/resume" ? "已恢复。" : "已取消；输入 /new 开始新对话。");
        }
        return true;
      }
      throw new Error("未知命令，输入 /help 查看帮助。");
    }
    if (this.taskId && this.shownBrief && isConfirmation(text)) await this.confirm();
    else if (!this.taskId && /^(?:直接执行|直接开始|按默认预算执行)[：:]/u.test(text)) await this.send(text, true);
    else await this.send(text);
    return true;
  }
  private async confirm(): Promise<void> {
    if (!this.taskId) throw new Error("还没有待确认的任务。");
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${this.taskId}`);
    if (!this.shownBrief || this.shownBrief.digest !== status.briefDigest || this.shownBrief.revision !== status.goal?.brief?.revision) {
      await this.poll();
      throw new Error("请先查看当前版本的任务说明与预算，再回复确认开始。");
    }
    await this.client.request(`/v1/tasks/${this.taskId}/confirm`, "POST", this.shownBrief);
    this.activity = "";
    this.info(status.goal?.confirmation ? "该版本已确认；保留原预算与执行进度。" : "任务说明与预算已确认，Agent 将自主执行、验证和修正。");
  }
  private async send(message: string, confirmed = false): Promise<void> {
    if (!this.taskId) {
      if (this.assistant && !await this.client.healthy('named-assistants')) throw new Error('后台尚不支持命名助手；请重启到当前版本，角色请求不会降级为普通任务。');
      if (this.collaborators && !await this.client.healthy('assistant-collaboration')) throw new Error('请重启到支持助手协作的后台版本。');
      const task = await this.client.request<TaskMeta>("/v1/tasks", "POST", { objective: message, workspace: this.workspace ?? (this.assistant || this.collaborators ? process.cwd() : undefined), confirmed,
        ...(this.assistant ? { assistant: this.assistant } : {}), ...(this.collaborators ? { collaborators: this.collaborators } : {}), ...(confirmed ? {} : { mode: "chat" }) });
      this.select(task.id);
      if (task.assistant) this.info(assistantText(task));
      this.info(confirmed ? `任务：${task.id}\n输出目录：${task.workspace}\n沿用已有授权与配置预算直接执行。费用上限 $${task.maxEstimatedCostUsd ?? 1}，配置时限 ${(task.deadlineAt - task.createdAt) / 60_000} 分钟。`
        : `对话：${task.id}\n普通问答直接回复，需要实际交付时再确认任务说明与预算。`);
    } else {
      await this.client.request(`/v1/tasks/${this.taskId}/messages`, "POST", { message, requestId: randomUUID() });
      this.info("消息已发送，Agent 会继续当前对话。");
    }
    this.activity = "";
  }
  async poll(): Promise<void> {
    const id = this.taskId;
    if (!id) return;
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${id}`);
    if (this.taskId !== id) return;
    for (const post of status.threadPosts ?? []) {
      const key = 'thread-post:' + post.id;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.info(`关联会话留言 · ${post.sourceTitle}\n${post.message}\n/attach ${post.sourceTaskId}`);
      }
      if (status.goal && post.reply && !this.printed.has(key + ':reply')) {
        this.printed.add(key + ':reply');
        this.emit({ kind: 'answer', text: post.reply });
      }
    }
    for (const report of status.threadReports ?? []) {
      const key = `thread-report:${report.taskId}`;
      if (this.printed.has(key)) continue;
      this.printed.add(key);
      const model = report.model ? ` · ${report.model.provider}/${report.model.modelId}` : '';
      this.info(`独立工作回传 · ${report.title}${model}\n${report.summary}\n/attach ${report.taskId}`);
    }
    for (const message of status.goal ? [] : status.messages) {
      if (message.role === 'toolResult' && ['propose_mcp_connection', 'propose_project_mcp_tools'].includes(message.toolName) && !message.isError) {
        const block = message.content.find(item => item.type === 'text');
        if (block?.type !== 'text') continue;
        let proposal: McpSettingsProposal;
        try { proposal = JSON.parse(block.text); } catch { continue; }
        if (proposal?.sourceTaskId !== id || !/^[1-9]\d{0,19}$/.test(proposal.id)) continue;
        const key = `mcp-proposal:${proposal.id}`;
        if (!this.printed.has(key)) {
          this.printed.add(key);
          this.info(`MCP 设置建议 ${proposal.id} · /mcp-proposals`);
        }
        continue;
      }
      if (message.role === 'toolResult' && message.toolName === 'propose_model' && !message.isError) {
        const block = message.content.find(item => item.type === 'text');
        if (block?.type !== 'text') continue;
        let proposal: ModelProposal;
        try { proposal = JSON.parse(block.text); } catch { continue; }
        if (proposal?.sourceTaskId !== id || !/^[1-9]\d{0,19}$/.test(proposal.id)) continue;
        const key = `model-proposal:${proposal.id}`;
        if (!this.printed.has(key)) {
          this.printed.add(key);
          this.info(`项目模型建议 ${proposal.id} · /model-proposals`);
        }
        continue;
      }
      if (message.role === 'toolResult' && message.toolName === 'start_thread' && !message.isError) {
        const block = message.content.find(item => item.type === 'text');
        if (block?.type !== 'text') continue;
        let receipt: { id?: string; thread?: TaskMeta['thread'] };
        try { receipt = JSON.parse(block.text); } catch { continue; }
        if (typeof receipt?.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id) || receipt.thread?.sourceTaskId !== id) continue;
        const key = `thread:${receipt.id}`;
        if (!this.printed.has(key)) {
          this.printed.add(key);
          this.info(`${receipt.thread.title ?? '独立工作'} · /attach ${receipt.id}`);
        }
        continue;
      }
      const text = answer(message);
      if (!text) continue;
      const key = answerKey(message, text);
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.emit({ kind: "answer", text });
      }
    }
    const goal = status.goal;
    if (status.status === 'waiting_assistant') for (const work of status.assistantWork) {
      if (work.stop || work.result || work.origin.revision !== goal?.revision || work.origin.epoch !== goal?.epoch) continue;
      for (const question of work.questions) {
        const key = `assistant-question:${work.id}:${question.id}`;
        if (question.answer || this.printed.has(key)) continue;
        this.printed.add(key);
        this.shownAssistantWork.set(work.id, work.controlVersion);
        this.info(`${work.assistant.name} · ${work.id}\n${question.text}${question.detail ? '\n' + question.detail : ''}${question.options?.length ? '\n' + question.options.join(' / ') : ''}\n/reply-assistant ${work.id} ${question.id} 答复`);
      }
    }
    if (status.status === "running") for (const child of status.delegations ?? []) {
      if (child.status !== "waiting_input" || !child.question) continue;
      const key = `child-question:${child.conversationId}:${child.question.id}`;
      if (this.printed.has(key)) continue;
      this.printed.add(key);
      this.info(`子任务 ${child.name} 等待答复：${child.question.text}${child.question.detail ? '\n' + child.question.detail : ''}${child.question.options ? '\n' + child.question.options.map((option, i) => `${i + 1}. ${option}`).join('\n') : ''}\n/reply-child ${child.conversationId} ${child.question.id} 答复`);
    }
    if (status.userQuestion) {
      const question = status.userQuestion, key = 'question:' + question.id;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.info(question.credential ? `${question.text}\n${question.detail ?? ''}\n${question.credential.name} · ${question.credential.origin} · ${question.credential.auth.type}\n/credential ${question.id} 进入无回显输入；/decline-credential ${question.id} 拒绝。不要在聊天中发送密钥。`
          : `${question.text}${question.detail ? '\n' + question.detail : ''}\n${question.options.map((option, index) => `${index + 1}. ${option}`).join('\n')}\n/choose ${question.id} 编号，或直接输入其他答复。`);
      }
    }
    if (["clarifying", "awaiting_confirmation"].includes(status.status) && goal?.brief) {
      const key = `brief:${goal.brief.revision}:${status.briefDigest}`;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.emit({ kind: "answer", text: briefText(status) });
      }
      if (status.status === "awaiting_confirmation" && status.briefDigest) this.shownBrief = { revision: goal.brief.revision, digest: status.briefDigest };
      else this.shownBrief = undefined;
    }
    if (status.status === "completed" && goal?.candidate) {
      const key = `goal:${goal.revision}:${goal.candidate.id}`;
      if (!this.printed.has(key)) {
        this.printed.add(key);
        const { priceKnown, estimatedCostUsd, totalTokens, cachedTokens } = status.budget;
        const cost = priceKnown === false ? "费用未知。" : `估算费用 $${estimatedCostUsd.toFixed(4)}。`;
        this.info(`已提交结果。\n${verificationText(status)}\n${cost}累计 ${totalTokens} token（含缓存读取 ${cachedTokens}）。`);
        this.emit({ kind: "answer", text: goal.candidate.summary });
      }
    }
    const progress = progressText(status);
    const activity = JSON.stringify([status.status, status.workerCount, goal?.brief?.revision, goal?.reworks, goal?.reason, goal?.question, progress]);
    if (activity === this.activity) return;
    this.activity = activity;
    if (status.status === "running" || status.status === "pending") {
      this.info(status.interaction === "chat" ? "正在回复…" : status.preparation && !goal?.confirmation ? "正在整理目标、交付标准与预算…" : goal?.reworks ? `正在修正验收问题，第 ${goal.reworks} 次自动返工…` : status.workerCount ? `正在处理，已创建 ${status.workerCount} 个子 Agent…` : "正在处理…");
    } else if (status.status === "verifying") this.info(status.schemaVersion === 3 && !status.review ? "已提交结果，正在检查交付物…" : "已提交结果，正在检查交付物并独立评审…");
    else if (status.status === "completed" && !goal?.candidate) this.info(`已提交结果。\n${verificationText(status)}`);
    else if (status.status === "waiting_user" && !status.userQuestion) this.info(`需要补充信息：${goal?.question ?? goal?.reason}`);
    else if (["blocked", "needs_attention"].includes(status.status)) this.info(`任务已停止自动推进：${goal?.reason}\n可补充要求，或输入 /resume 重试。`);
    else if (status.status === "failed") this.emit({ kind: "error", text: `执行失败：${goal?.reason ?? (status.submission?.status === "unanswered" ? status.submission.reason : "未知原因")}。可以补充要求重试，或输入 /resume。` });
    else if (status.status === "budget_limited") this.info(`任务预算已耗尽：${goal?.reason ?? "达到时限"}。输入 /resume 可按配置补充一份任务预算后继续。`);
    if (progress) this.info(progress);
  }
}

export async function runChat(client: HarnessClient, options: {
  taskId?: string; workspace?: string; input?: Readable; output?: Writable; intervalMs?: number; assistant?: AssistantRef; collaborators?: AssistantRef[];
} = {}): Promise<void> {
  if (options.taskId && (options.assistant || options.collaborators)) throw new Error('仅新会话可以选择助手与同事。');
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  let hidden: { resolve(value: string): void; reject(error: Error): void } | undefined;
  const display = new Writable({ write(chunk, _encoding, done) { if (hidden) done(); else { output.write(chunk); done(); } } });
  let rl = createInterface({ input, output: display, terminal, prompt: "你 > " });
  rl.pause();
  let closed = false;
  let exiting = false;
  let finished = false;
  let lastPollError = "";
  const queue = new SerialQueue();
  const render = (event: ChatEvent) => {
    if (finished || hidden) return;
    if (terminal) { clearLine(output, 0); cursorTo(output, 0); }
    output.write(event.kind === "answer" ? `\nAgent > ${event.text}\n\n` : `${event.kind === "error" ? "错误：" : ""}${event.text}\n`);
    if (terminal && !closed) rl.prompt(true);
  };
  const session = new ChatSession(client, render, options.workspace, terminal ? () => new Promise<string>((resolve, reject) => {
    hidden = { resolve, reject };
    output.write('受保护凭据输入（无回显，按 Enter 保存，Ctrl+C 取消）> ');
  }) : undefined, options.assistant, options.collaborators);
  output.write("Kada · 终端聊天\n直接聊天，需要实际交付时再确认任务说明与预算。/help 查看命令，/quit 退出。\n\n");
  let finish: () => void;
  const end = new Promise<void>(resolve => { finish = resolve; });
  function onClose() { closed = true; const pending = hidden; hidden = undefined; pending?.reject(new Error('凭据输入已取消。')); finish(); }
  function renewReadline() {
    // A fresh editor drops private text, undo and kill/yank buffers as well as history.
    rl.off('close', onClose).off('SIGINT', onInterrupt).off('line', onLine).close();
    rl = createInterface({ input, output: display, terminal, prompt: '你 > ' });
    bindReadline();
  }
  function onInterrupt() {
    if (hidden) { const pending = hidden; renewReadline(); hidden = undefined; pending.reject(new Error('凭据输入已取消。')); output.write('\n'); }
    else rl.close();
  }
  let commandWork: Promise<unknown> = Promise.resolve();
  function onLine(line: string) {
    if (hidden) {
      const pending = hidden; renewReadline(); hidden = undefined;
      output.write('\n'); pending.resolve(line); return;
    }
    commandWork = queue.run(async () => {
      if (exiting) return;
      try {
        const keepGoing = await session.handle(line);
        if (!keepGoing) { exiting = true; rl.close(); return; }
      } catch (error) { render({ kind: "error", text: errorText(error) }); }
      if (!closed && terminal) { clearLine(output, 0); cursorTo(output, 0); rl.prompt(); }
    });
  }
  function bindReadline() { rl.once('close', onClose).on('SIGINT', onInterrupt).on('line', onLine); }
  bindReadline();
  if (options.taskId) {
    try { await session.attach(options.taskId); }
    catch (error) { rl.close(); throw error; }
  }
  rl.resume();
  if (terminal && !closed) { clearLine(output, 0); cursorTo(output, 0); rl.prompt(); }
  const polling = (async () => {
    while (!closed) {
      try { await session.poll(); lastPollError = ""; }
      catch (error) {
        const message = errorText(error);
        if (message !== lastPollError) render({ kind: "error", text: `无法获取进度：${message}。任务仍保存在后台服务中。` });
        lastPollError = message;
      }
      await setTimeout(options.intervalMs ?? 750);
    }
  })();
  await end;
  await commandWork;
  await polling;
  finished = true;
  output.write(`已退出聊天。会话保存在后台；已确认的任务继续执行，待确认任务不会开始执行。${session.taskId ? `重新运行 npm run chat，再输入 /attach ${session.taskId} 可继续。` : ""}\n`);
}
