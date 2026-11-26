import { createInterface, clearLine, cursorTo } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Writable, type Readable } from "node:stream";
import type { HarnessClient, TaskMeta, TaskStatus } from "./client.js";
import type { LocalRuntime } from "./runtime.js";
import type { MemoryFactView } from "./user-memory.js";
import { errorText, SerialQueue } from "./util.js";
import { briefText, progressText, usageText, verificationText } from "./presentation.js";
import { isConfirmation } from "./preparation.js";
import { conversationAnswer as answer } from "./conversation.js";

type Message = TaskStatus["messages"][number];
export type ChatEvent = { kind: "info" | "answer" | "error"; text: string };

function answerKey(message: Message, text: string): string { return `${message.timestamp}:${text}`; }
const HELP = `直接输入消息：普通问答直接回复，需要实际交付时再提出任务说明与预算。\n\n/new [消息]       新建对话，原任务继续在后台运行\n/confirm          确认刚展示的任务说明与预算\n/run 目标         已有明确授权，沿用配置预算直接执行\n/memory list      查看当前项目记忆与来源\n/memory edit ID 内容 纠正一条记忆\n/memory forget ID 遗忘一条记忆\n/memory used      查看当前会话使用的记忆版本\n/tasks            列出最近的对话与任务\n/attach 任务ID    接回已有对话或任务\n/status           查看状态、预算、核验范围和进度\n/pause            暂停当前对话或任务\n/resume           恢复；显式补充一份配置/已确认预算，不代替目标确认\n/cancel           取消当前对话或任务\n/help             显示帮助\n/quit             退出聊天，后台任务继续运行`;

/** Conversation selection and delivery are independent of terminal rendering. */
export class ChatSession {
  taskId?: string;
  private printed = new Set<string>();
  private activity = "";
  private shownBrief?: { revision: number; digest: string };
  private shownApprovals = new Map<string, string>();
  constructor(private client: HarnessClient, private emit: (event: ChatEvent) => void, private workspace?: string, private protectedInput?: () => Promise<string>) {}
  private info(text: string): void { this.emit({ kind: "info", text }); }
  private select(id?: string): void { this.taskId = id; this.printed.clear(); this.activity = ""; this.shownBrief = undefined; this.shownApprovals.clear(); }
  async attach(id: string): Promise<void> {
    const status = await this.client.request<TaskStatus>(`/v1/tasks/${id}`);
    this.select(id);
    this.info(`已接入${status.interaction === "chat" ? "对话" : "任务"} ${id}\n${status.interaction === "chat" ? "首条消息" : "目标"}：${status.objective}\n输出目录：${status.workspace}`);
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
      if (command === "/help") { this.info(HELP+'\n\n/tasks pending|running|delivered  筛选待处理、执行或交付\n/inbox /read 通知ID  查看通知及标记已读\n/files /open 编号  查看和打开核验产物\n/approvals  查看动作参数\n/allow 动作ID /deny 动作ID  答复已展示的动作审批\n/choose 问题ID 编号  选择当前问题的一个选项\n/credential 问题ID  在交互终端无回显提供凭据，勿在命令中填值\n/decline-credential 问题ID  拒绝当前凭据请求\n/children  查看子会话 ID 和状态\n/stop-child 子会话ID  停止单个后台子任务\n/interrupt-child 子会话ID  中断该子任务当前工具\n/reply-child 子会话ID 问题ID 答复  回复原子会话\n/remind ISO时间 内容  保存带时区的单次提醒\n模型、Skills、MCP、每周规则和设备管理：npm run harness -- help'); return true; }
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
          const lines = [`${task.id}  [${task.status}]  ${task.objective.slice(0, 100).replace(/\s+/g, " ")}`];
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
      const task = await this.client.request<TaskMeta>("/v1/tasks", "POST", { objective: message, workspace: this.workspace, confirmed, ...(confirmed ? {} : { mode: "chat" }) });
      this.select(task.id);
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
    for (const message of status.goal ? [] : status.messages) {
      const text = answer(message);
      if (!text) continue;
      const key = answerKey(message, text);
      if (!this.printed.has(key)) {
        this.printed.add(key);
        this.emit({ kind: "answer", text });
      }
    }
    const goal = status.goal;
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
  taskId?: string; workspace?: string; input?: Readable; output?: Writable; intervalMs?: number;
} = {}): Promise<void> {
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
  }) : undefined);
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
