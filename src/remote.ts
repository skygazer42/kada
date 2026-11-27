import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { EntryId } from "@earendil-works/pi-durable";
import { DelegationInputError } from "./delegation.js";
import { ApprovalError } from "./approvals.js";
import type { RemoteComputer } from "./config.js";
import type { RemoteDevices, SharedApproval } from "./remote-devices.js";
import { TaskConflictError, type LocalRuntime } from "./runtime.js";
import { remotePage, remoteScript } from "./remote-page.js";
import { remoteManifest, remoteWorker } from "./remote-worker.js";
import { RemotePush, RemotePushError, type PushEvent, type PushScope, type PushSender } from "./remote-push.js";
import { taskGroup, taskView } from "./task-view.js";
import { QuestionError } from './questions.js';
import { readJson, redactCredentials, SerialQueue } from "./util.js";
import { RoomError } from './assistant-rooms.js';
import { Workspace } from "./workspace.js";
import { WorkItemError, workItemOverdue, type WorkItem } from './work-items.js';
import { VoiceNoteError, voiceClipLimit } from './voice-notes.js';

function sharedWorkItem(item: WorkItem) {
  const { id, title, revision, updatedAt, status, archived, completedAt, priority, dueDate, dueAt, timeZone } = item;
  return { id, title, revision, updatedAt, status, archived, completedAt, priority, dueDate, dueAt, timeZone, overdue: workItemOverdue(item) };
}

export interface RemoteDevice {
  accountId: string;
  deviceId: string;
  tokenHash: string;
  sharedApprovals?: SharedApproval[];
  sharedWorkItems?: string[];
  sharedWorkItemReplies?: string[];
  sharedWorkItemControls?: string[];
  sharedWorkItemEdits?: string[];
  sharedThreads?: { taskId: string; replies?: true; controls?: true; files?: true }[];
}

export interface RemoteOptions {
  directory: string;
  workspace?: string;
  origin: string;
  computers?: readonly RemoteComputer[];
  devices: readonly RemoteDevice[] | (() => readonly RemoteDevice[] | Promise<readonly RemoteDevice[]>);
  push?: boolean;
  pushSender?: PushSender;
  sharedDevices?: Pick<RemoteDevices, "withPairedDevice">;
}

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function createRemoteCredential() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: digest(token) };
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const shaPattern = /^[0-9a-f]{64}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const attachmentLimit = 5 * 1024 * 1024;
const originalArchiveLimit = 50 * 1024 * 1024;
const downloadLimit = 25 * 1024 * 1024;
const uploadLifetime = 60 * 60_000;
const maxAttachments = 4;
const supportedTypes = new Set([
  "application/octet-stream", "application/json", "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp",
  "text/plain", "text/csv", "text/markdown", "text/tab-separated-values",
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Receipt = {
  messageId: string;
  requestId: string;
  fingerprint: string;
  state: "accepted" | "submitted" | "interrupted";
  original?: { text: string; attachments: OriginalAttachment[]; expiresAt?: number };
};

type Upload = { id: string; name: string; type: string; bytes: number; sha256: string; expiresAt: number; used?: true };
type OriginalAttachment = Pick<Upload, "id" | "name" | "type" | "bytes" | "sha256">;
type Scope = { channel: "web"; accountId: string; deviceId: string };
type Conversation = Scope & {
  conversationId: string;
  taskId: string;
  title: string;
  updatedAt: number;
  receipts: Receipt[];
  uploads: Upload[];
};

type TaskStatus = Awaited<ReturnType<LocalRuntime["status"]>>;

function sharedThreadBrief(status: TaskStatus) {
  const goal = status.goal, brief = goal?.brief;
  if (status.status !== 'awaiting_confirmation' || status.thread?.archivedAt || !goal || !brief) return null;
  const checks = [...goal.checks.map(({ check }) => check), ...brief.checks].map(check => redactCredentials(JSON.stringify(check)));
  return {
    revision: brief.revision, outcome: redactCredentials(brief.outcome),
    deliverables: brief.deliverables.map(redactCredentials), inputs: brief.inputs.map(redactCredentials),
    scope: brief.scope.map(redactCredentials), assumptions: brief.assumptions.map(redactCredentials),
    criteria: brief.criteria.map(({ text, method, verification }) => ({ text: redactCredentials(text), method,
      ...(verification ? { verification: { command: redactCredentials(verification.command), inputs: verification.inputs.map(redactCredentials),
        outputs: verification.outputs.map(redactCredentials) } } : {}),
    })),
    checks: [...new Set(checks)], budget: brief.budget, usedTokens: status.budget.totalTokens, priceKnown: status.budget.priceKnown,
  };
}

function piMessageRequest(conversation: Conversation, receipt: Receipt) {
  return conversation.receipts[0] === receipt ? "initial" : "user:" + receipt.requestId;
}

function remoteOrigin(input: string): URL {
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("The remote portal needs an HTTPS origin or an HTTP loopback origin.");
  }
  return url;
}

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > limit) {
    request.resume();
    throw new HttpError(413, "The request exceeds the size limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "The request exceeds the size limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Expected application/json.");
  }
  const bytes = await body(request, 64 * 1024);
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // The caller receives the same error for a malformed or non-object body.
  }
  throw new HttpError(400, "Expected a JSON object.");
}

function attachmentName(value: unknown): string {
  let name = "";
  try { if (typeof value === "string") name = decodeURIComponent(value); } catch { /* invalid header */ }
  if (
    !name || Buffer.byteLength(name) > 160 || /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(name) ||
    /^[ .]|[ .]$/.test(name) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/iu.test(name)
  ) throw new HttpError(400, "The filename is invalid.");
  return name;
}

function validateType(type: string, bytes: Buffer) {
  if (!supportedTypes.has(type)) throw new HttpError(415, "This attachment type is unavailable.");
  if (type === "application/octet-stream") return;
  if (type.startsWith("text/") || type === "application/json") {
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (value.includes("\0")) throw new Error("binary input");
      if (type === "application/json" && value) JSON.parse(value);
      return;
    } catch {
      throw new HttpError(415, "The file does not match its declared text type.");
    }
  }
  const signature = {
    "application/pdf": "255044462d",
    "image/png": "89504e470d0a1a0a",
    "image/jpeg": "ffd8ff",
    "image/gif": "47494638",
    "image/webp": "52494646",
  }[type];
  if (
    !signature || !bytes.subarray(0, signature.length / 2).equals(Buffer.from(signature, "hex")) ||
    (type === "image/webp" && bytes.toString("ascii", 8, 12) !== "WEBP")
  ) throw new HttpError(415, "The file does not match its declared type.");
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function verifiedBytes(path: string, file: { bytes: number; sha256: string }) {
  const opened = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ELOOP") throw error;
  });
  if (!opened) return;
  try {
    const stat = await opened.stat();
    if (!stat.isFile() || stat.size !== file.bytes) return;
    const buffer = Buffer.alloc(file.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await opened.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    if (bytes.length === file.bytes && digest(bytes) === file.sha256) return bytes;
  } finally { await opened.close(); }
}

function sendFile(response: ServerResponse, file: { name: string; bytes: number; sha256: string }, bytes: Buffer) {
  const name = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16));
  response.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment; filename*=UTF-8''" + name,
    "Content-Length": file.bytes,
    "X-Kada-SHA256": file.sha256,
  });
  response.end(bytes);
}

async function readConversation(path: string): Promise<Conversation | undefined> {
  try { return await readJson<Conversation>(path); }
  catch (error) { if (!isMissing(error)) throw error; }
}

async function writeDurable(path: string, bytes: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), ".kada-" + randomUUID());
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function saveConversation(path: string, conversation: Conversation) {
  return writeDurable(path, JSON.stringify(conversation));
}

function belongs(conversation: Conversation, scope: Scope) {
  return conversation.channel === scope.channel &&
    conversation.accountId === scope.accountId && conversation.deviceId === scope.deviceId;
}

function requireConversation(conversation: Conversation | undefined, scope: Scope): Conversation {
  if (!conversation || !belongs(conversation, scope)) throw new HttpError(404, "Conversation not found.");
  return conversation;
}

function matchesSnapshot(
  current: { path: string; bytes: number; sha256: string; entries?: number },
  saved: { path: string; bytes: number; sha256: string; entries?: number },
) {
  return current.path === saved.path && current.bytes === saved.bytes &&
    current.sha256 === saved.sha256 && current.entries === saved.entries;
}

function verifiedArtifacts(status: TaskStatus, basePath: string) {
  const view = taskView(status);
  const proof = status.goal?.mechanical;
  if (!view.delivery || !proof?.passed) return [];
  return view.delivery.artifacts.flatMap((artifact, index) => {
    const path = resolve(status.workspace, artifact);
    const file = proof.files.find((snapshot) => snapshot.path === path);
    const directory = proof.directories?.find((snapshot) => snapshot.path === path);
    const snapshot = file ?? directory;
    if (!snapshot) return [];
    const binding = digest(JSON.stringify({ revision: status.goal!.revision, candidate: status.goal!.candidate,
      proof, verification: status.goal!.verification, path, snapshot }));
    return [{
      path: relative(status.workspace, path),
      name: basename(path),
      kind: directory ? "directory" as const : "file" as const,
      bytes: snapshot.bytes,
      sha256: snapshot.sha256,
      href: basePath + "/artifacts/" + index + "/" + binding,
      snapshot,
    }];
  });
}

/** Run before daemon recovery: historical remote tasks must never resume with local capabilities. */
export async function quarantineLegacyRemoteTasks(runtime: LocalRuntime, directory: string): Promise<void> {
  const root = join(directory, "conversations");
  let accounts;
  try { accounts = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const account of accounts) {
    if (!account.isDirectory() || !shaPattern.test(account.name)) continue;
    for (const file of await readdir(join(root, account.name), { withFileTypes: true })) {
      if (!file.isFile() || !/^[0-9a-f]{64}\.json$/.test(file.name)) continue;
      const conversation = await readConversation(join(root, account.name, file.name));
      if (!conversation || conversation.channel !== "web") continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversation.taskId)) {
        throw new Error("The saved remote conversation has an invalid task ID.");
      }
      const meta = await runtime.metadata(conversation.taskId).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      if (meta?.control === "active" && meta.remotePolicy !== "workspace") await runtime.pause(conversation.taskId);
    }
  }
}

export function createRemoteHandler(runtime: LocalRuntime, options: RemoteOptions) {
  const origin = remoteOrigin(options.origin);
  const base = options.workspace ?? join(options.directory, "workspaces");
  const queues = new Map<string, { queue: SerialQueue; references: number }>();
  const dispatching = new Set<string>();
  const transcribing = new Set<string>();

  const accountPath = (scope: Scope) => join(options.directory, "conversations", digest(scope.accountId));
  const recordPath = (scope: Scope, id: string) => join(accountPath(scope), digest(id) + ".json");
  const uploadPath = (id: string) => join(options.directory, "uploads", id);
  const pairedDevices = async () => typeof options.devices === "function" ? options.devices() : options.devices;
  const pairingIdFor = (device: RemoteDevice) => digest("kada:browser-pairing:" + device.tokenHash);
  const push = options.push ? new RemotePush(options.directory, origin.origin, async () =>
    (await pairedDevices()).map(device => ({
      pairingId: pairingIdFor(device), accountId: device.accountId, deviceId: device.deviceId,
    })), pushEvents, options.pushSender) : undefined;

  async function exclusive<T>(path: string, action: () => Promise<T>) {
    const entry = queues.get(path) ?? { queue: new SerialQueue(), references: 0 };
    queues.set(path, entry);
    entry.references++;
    try { return await entry.queue.run(action); }
    finally { if (--entry.references === 0) queues.delete(path); }
  }

  async function authenticate(request: IncomingMessage): Promise<Scope & { pairingId: string; tokenHash: string }> {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!token || !tokenPattern.test(token)) throw new HttpError(401, "Enter this device’s pairing token.");
    const supplied = Buffer.from(digest(token), "hex");
    const devices = await pairedDevices();
    const device = devices.find((item) => shaPattern.test(item.tokenHash) &&
      timingSafeEqual(supplied, Buffer.from(item.tokenHash, "hex")));
    if (!device || !idPattern.test(device.accountId) || !idPattern.test(device.deviceId)) {
      throw new HttpError(401, "Enter this device’s pairing token.");
    }
    return { channel: "web", accountId: device.accountId, deviceId: device.deviceId,
      pairingId: pairingIdFor(device), tokenHash: device.tokenHash };
  }

  function freshConversation(scope: Scope, conversationId: string): Conversation {
    return { ...scope, conversationId, taskId: randomUUID(), title: "", updatedAt: Date.now(), receipts: [], uploads: [] };
  }

  async function privateWorkspace(conversation: Conversation, create: boolean) {
    const parent = await Workspace.open(base, { create });
    const root = await parent.path(conversation.taskId);
    const workspace = await Workspace.open(root, { create });
    const marker = await workspace.path(".kada-project");
    try {
      const file = await open(marker, "wx", 0o600);
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await lstat(marker)).isFile()) throw new HttpError(409, "The remote workspace’s project boundary is unavailable.");
    }
    return workspace;
  }

  async function conversationTask(conversation: Conversation) {
    const workspace = await privateWorkspace(conversation, false);
    const meta = await runtime.metadata(conversation.taskId);
    if (meta.remotePolicy !== "workspace") throw new HttpError(409, "This conversation predates remote workspace isolation. Start a new conversation.");
    if (meta.workspace !== workspace.root) throw new HttpError(409, "The original workspace is unavailable.");
  }

  async function taskStatus(conversation: Conversation): Promise<TaskStatus | undefined> {
    if (!conversation.receipts.length) return;
    try {
      await conversationTask(conversation);
      return await runtime.status(conversation.taskId);
    }
    catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async function overview(conversation: Conversation) {
    try {
      await conversationTask(conversation);
      const { status, reason, question, childQuestion } = await runtime.taskOverview(conversation.taskId);
      const group = childQuestion ? "pending" : taskGroup(status);
      return { status, group, reason: group === "pending" ? reason : null, question: group === "pending" ? question ?? childQuestion ?? null : null };
    } catch (error) {
      if (isMissing(error) || error instanceof HttpError && error.status === 409) return null;
      throw error;
    }
  }

  async function receiptView(conversation: Conversation, receipt: Receipt, status?: TaskStatus) {
    let state = receipt.state;
    if (state === "submitted" && !status) {
      state = "interrupted";
    } else if (state !== "submitted" && !dispatching.has(receipt.requestId)) {
      const first = conversation.receipts[0]?.requestId === receipt.requestId;
      const submitted = status && (first
        ? status.messages.some((message) => message.role === "user")
        : await runtime.hasRequest(conversation.taskId, receipt.requestId));
      state = submitted ? "submitted" : "interrupted";
    }
    return {
      channel: conversation.channel, accountId: conversation.accountId, deviceId: conversation.deviceId,
      conversationId: conversation.conversationId, taskId: conversation.taskId,
      messageId: receipt.messageId, requestId: receipt.requestId, state,
    };
  }

  async function ownedConversations(scope: Scope) {
    let names: string[];
    try { names = await readdir(accountPath(scope)); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const rows = await Promise.all(names.filter((name) => shaPattern.test(name.slice(0, -5)) && name.endsWith(".json"))
      .map((name) => readConversation(join(accountPath(scope), name))));
    return rows.filter((row): row is Conversation => Boolean(row?.receipts.length && belongs(row, scope)));
  }

  async function pushEvents(scope: PushScope, since: number, cursors: Record<string, number>) {
    const events: PushEvent[] = [];
    for (const row of await ownedConversations({ channel: "web", ...scope })) {
      try {
        await conversationTask(row);
        const sequence = await runtime.remoteAlertSequence(row.taskId, since, cursors[row.taskId] ?? 0);
        if (sequence !== undefined) events.push({ taskId: row.taskId, conversationId: row.conversationId, sequence });
      } catch (error) {
        if (!isMissing(error) && !(error instanceof HttpError && error.status === 409)) throw error;
      }
    }
    return events;
  }

  async function list(scope: Scope) {
    const conversations = [];
    for (const row of await ownedConversations(scope)) {
      const { conversationId, taskId, title, updatedAt } = row;
      conversations.push({ conversationId, taskId, title, updatedAt, task: await overview(row) });
    }
    return conversations.sort((a, b) => Number(b.task?.group === "pending") - Number(a.task?.group === "pending") ||
      b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId));
  }

  async function history(conversation: Conversation, cursors: string[]) {
    const raw = cursors[0];
    const after = raw === undefined ? undefined : Number(raw) as EntryId;
    if (cursors.length > 1 || raw !== undefined && (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(after))) {
      throw new HttpError(400, "Invalid history cursor.");
    }
    const status = await taskStatus(conversation);
    const view = status ? taskView(status) : undefined;
    const originals = new Map(conversation.receipts.flatMap((receipt) => receipt.original ?
      [[piMessageRequest(conversation, receipt), receipt] as const] : []));
    const history = status ? await runtime.conversationHistory(conversation.taskId, after, [...originals.keys()]) :
      after === undefined ? { cursor: null, messages: [], progressEvents: [], messageEntries: new Map<number, string>() } : undefined;
    if (!history) throw new HttpError(400, "Invalid history cursor.");
    const { messages, messageEntries, ...historyView } = history;
    const delivery = status && view?.delivery ? {
      ...view.delivery,
      artifacts: verifiedArtifacts(status, "/remote/api/conversations/" + conversation.conversationId).map(({ snapshot: _snapshot, ...artifact }) => artifact),
    } : null;
    return {
      channel: conversation.channel, accountId: conversation.accountId, deviceId: conversation.deviceId,
      conversationId: conversation.conversationId, taskId: conversation.taskId, title: conversation.title,
      ...historyView,
      messages: messages.map((message) => {
        const receipt = originals.get(messageEntries.get(message.sequence) ?? "");
        if (!receipt?.original) return message;
        return { ...message, text: receipt.original.text, attachments: receipt.original.attachments.map((attachment) => ({
          ...attachment, href: "/remote/api/conversations/" + conversation.conversationId + "/attachments/" + receipt.messageId + "/" + attachment.id,
        })) };
      }),
      receipts: await Promise.all(conversation.receipts.map((receipt) => receiptView(conversation, receipt, status))),
      task: status && view ? {
        status: view.status, reason: view.reason, question: view.question, userQuestion: view.userQuestion, brief: view.brief,
        briefDigest: view.briefDigest, confirmed: view.confirmed, progress: view.progress, delivery, budget:view.budget,
        controls: status.remoteControls, controlVersion: status.remoteControlVersion,
        childQuestions: status.status === "running" ? status.delegations.flatMap(child => child.question
          ? [{ childId: child.conversationId, questionId: child.question.id, name: child.name, text: child.question.text,
            ...(child.question.options ? { options: child.question.options } : {}), ...(child.question.detail ? { detail: child.question.detail } : {}) }] : []) : [],
        stoppableChildren: view.stoppableChildren, interruptibleChildTools: view.interruptibleChildTools,
      } : null,
    };
  }

  async function upload(request: IncomingMessage, scope: Scope, conversationId: string, path: string) {
    const name = attachmentName(request.headers["x-kada-filename"]);
    const type = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    const sha256 = request.headers["x-kada-sha256"];
    if (typeof sha256 !== "string" || !shaPattern.test(sha256)) throw new HttpError(400, "A SHA-256 is required.");
    const bytes = await body(request, attachmentLimit);
    validateType(type, bytes);
    if (digest(bytes) !== sha256) throw new HttpError(422, "The attachment hash does not match.");
    return exclusive(path, async () => {
      const prior = await readConversation(path);
      const conversation = prior ? requireConversation(prior, scope) : freshConversation(scope, conversationId);
      const now = Date.now();
      const pending = conversation.uploads.filter((item) => !item.used && item.expiresAt > now);
      const existing = pending.find((item) => item.name === name && item.type === type && item.sha256 === sha256);
      if (existing) return existing;
      if (pending.length >= maxAttachments * 4) {
        throw new HttpError(409, "This conversation has too many pending attachments. They expire after one hour.");
      }
      const expired = conversation.uploads.filter((item) => !pending.includes(item));
      conversation.uploads = pending;
      const unplaced = await reclaimOriginals(conversation, now);
      const item: Upload = { id: randomUUID(), name, type, sha256, bytes: bytes.length, expiresAt: now + uploadLifetime };
      try {
        await writeDurable(uploadPath(item.id), bytes);
        conversation.uploads.push(item);
        await saveConversation(path, conversation);
      } catch (error) {
        await rm(uploadPath(item.id), { force: true });
        throw error;
      }
      const retained = new Set(conversation.receipts.flatMap((receipt) => receipt.original?.attachments.map((attachment) => attachment.id) ?? []));
      const removed = new Set([...unplaced, ...expired.filter((old) => !retained.has(old.id)).map((old) => old.id)]);
      await Promise.all([...removed].map((id) => rm(uploadPath(id), { force: true })));
      return item;
    });
  }

  async function reclaimOriginals(conversation: Conversation, now: number) {
    const expired: string[] = [];
    for (const receipt of conversation.receipts) {
      if (receipt.original?.expiresAt === undefined || receipt.original.expiresAt > now) continue;
      const requestId = piMessageRequest(conversation, receipt);
      const recoverable = await runtime.hasRequest(conversation.taskId, requestId, "recoverable").catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        return false;
      });
      if (recoverable) {
        if (await runtime.hasRequest(conversation.taskId, requestId, "placed")) delete receipt.original.expiresAt;
      } else {
        expired.push(...receipt.original.attachments.map((attachment) => attachment.id));
        delete receipt.original;
      }
    }
    return expired;
  }

  async function stageAttachments(workspace: Workspace, attachments: Upload[]) {
    const paths: string[] = [];
    for (const attachment of attachments) {
      const bytes = await readFile(uploadPath(attachment.id)).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
        throw new HttpError(422, "An attachment is no longer available.");
      });
      if (bytes.length !== attachment.bytes || digest(bytes) !== attachment.sha256) {
        throw new HttpError(422, "The attachment’s saved bytes do not match.");
      }
      const rel = "attachments/" + attachment.id + "/" + attachment.name;
      const target = await workspace.path(rel);
      await mkdir(dirname(target), { recursive: true });
      const checked = await workspace.path(rel);
      await writeDurable(checked, bytes);
      const copied = await workspace.inspect(rel);
      if (copied.bytes !== attachment.bytes || copied.sha256 !== attachment.sha256) {
        throw new HttpError(422, "The attachment workspace copy does not match.");
      }
      paths.push(rel);
    }
    return paths;
  }

  async function submit(request: IncomingMessage, scope: Scope, conversationId: string, path: string) {
    const value = await json(request);
    const { messageId, text, attachmentIds = [] } = value;
    if (
      typeof messageId !== "string" || !idPattern.test(messageId) || typeof text !== "string" ||
      !Array.isArray(attachmentIds) || attachmentIds.length > maxAttachments ||
      attachmentIds.some((id) => typeof id !== "string" || !idPattern.test(id)) ||
      new Set(attachmentIds).size !== attachmentIds.length || (!text.trim() && !attachmentIds.length)
    ) throw new HttpError(400, "Enter a message or choose up to four attachments.");
    const fingerprint = digest(JSON.stringify([text, attachmentIds]));
    return exclusive(path, async () => {
      const prior = await readConversation(path);
      const conversation = prior ? requireConversation(prior, scope) : freshConversation(scope, conversationId);
      const existing = conversation.receipts.find((item) => item.messageId === messageId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpError(409, "This message ID already has different content.");
        return { duplicate: true, receipt: await receiptView(conversation, existing, await taskStatus(conversation)) };
      }
      const first = !conversation.receipts.length;
      const task = await taskStatus(conversation);
      if (!first && !task) throw new HttpError(409, "The original task is unavailable. Start a new conversation.");
      if (task?.control === "paused" || task?.control === "cancelled") {
        throw new HttpError(409, "This task is " + task.control + ".");
      }
      const attachments = attachmentIds.map((id) => {
        const item = conversation.uploads.find((upload) => upload.id === id);
        if (!item || item.used || item.expiresAt <= Date.now()) {
          throw new HttpError(422, "An attachment expired, was already used, or belongs to a different conversation.");
        }
        return item;
      });
      if (attachments.length) {
        const archived = conversation.receipts.flatMap((receipt) => receipt.original?.attachments ?? []);
        if ([...archived, ...attachments].reduce((total, file) => total + file.bytes, 0) > originalArchiveLimit) {
          throw new HttpError(413, "This conversation has reached its 50 MiB original attachment limit. Start a new conversation to attach more files.");
        }
      }
      const workspace = await privateWorkspace(conversation, true);
      if (task && task.workspace !== workspace.root) throw new HttpError(409, "The original workspace is unavailable.");
      const files = await stageAttachments(workspace, attachments);
      const prompt = files.length ? text + "\n\nAttached files in this workspace:\n" + files.map((file) => "- " + file).join("\n") : text;
      const images = attachments.filter(attachment => attachment.type.startsWith("image/")).map(attachment => ({
        path: uploadPath(attachment.id), mimeType: attachment.type, bytes: attachment.bytes, sha256: attachment.sha256,
      }));
      const receipt: Receipt = { messageId, requestId: randomUUID(), fingerprint, state: "accepted" };
      if (attachments.length) receipt.original = { text, expiresAt: Date.now() + uploadLifetime,
        attachments: attachments.map(({ id, name, type, bytes, sha256 }) => ({ id, name, type, bytes, sha256 })) };
      conversation.receipts.push(receipt);
      if (first) conversation.title = (text.trim() || attachments[0]?.name || "Conversation").split(/\r?\n/)[0]!.slice(0, 88);
      conversation.updatedAt = Date.now();
      for (const attachment of attachments) attachment.used = true;
      dispatching.add(receipt.requestId);
      try {
        await saveConversation(path, conversation);
        try {
          if (first) await runtime.create(prompt, workspace.root, undefined, { chat: true, prepare: false, remote: true, id: conversation.taskId, images });
          else await runtime.followUp(conversation.taskId, prompt, receipt.requestId, images);
          receipt.state = "submitted";
        } catch {
          receipt.state = "interrupted";
        }
        await saveConversation(path, conversation);
      } finally {
        dispatching.delete(receipt.requestId);
      }
      return { duplicate: false, receipt: await receiptView(conversation, receipt, await taskStatus(conversation)) };
    });
  }

  async function downloadAttachment(response: ServerResponse, conversation: Conversation, messageId: string, id: string) {
    const receipt = conversation.receipts.find((item) => item.messageId === messageId);
    const attachment = receipt?.original?.attachments.find((item) => item.id === id);
    if (!receipt || !attachment) throw new HttpError(404, "Original attachment not found.");
    const requestId = piMessageRequest(conversation, receipt);
    try {
      await conversationTask(conversation);
      if (!await runtime.hasRequest(conversation.taskId, requestId, "placed")) throw new HttpError(404, "Original attachment not found.");
    } catch (error) {
      if (isMissing(error)) throw new HttpError(404, "Original attachment not found.");
      throw error;
    }
    const bytes = await verifiedBytes(uploadPath(id), attachment);
    if (!bytes) throw new HttpError(409, "Original attachment is unavailable or has changed.");
    sendFile(response, attachment, bytes);
  }

  async function download(response: ServerResponse, status: TaskStatus | undefined, basePath: string, href: string, filename: string | null) {
    const artifact = status ? verifiedArtifacts(status, basePath).find((item) => item.href === href) : undefined;
    if (!status || !artifact) throw new HttpError(404, "Verified artifact not found.");
    const workspace = await Workspace.open(status.workspace);
    const tree = artifact.kind === "directory"
      ? await workspace.inspectTree(artifact.path).catch(() => undefined) : undefined;
    const current = tree?.root ?? (artifact.kind === "file" ? await workspace.inspect(artifact.path).catch(() => undefined) : undefined);
    if (!current || !matchesSnapshot(current, artifact.snapshot)) {
      throw new HttpError(409, "This artifact changed after verification.");
    }
    if (tree && filename === null) {
      return send(response, 200, {
        name: artifact.name,
        files: tree.files.map((file) => ({
          path: relative(artifact.snapshot.path, file.path),
          bytes: file.bytes, sha256: file.sha256,
          href: href + "?file=" + encodeURIComponent(relative(artifact.snapshot.path, file.path)),
        })),
      });
    }
    const file = tree ? tree.files.find((item) => relative(artifact.snapshot.path, item.path) === filename)
      : filename === null ? artifact.snapshot : undefined;
    if (!file) throw new HttpError(404, "Verified artifact not found.");
    if (file.bytes > downloadLimit) throw new HttpError(413, "This artifact exceeds the download size limit.");
    const bytes = await verifiedBytes(await workspace.path(file.path), file);
    if (!bytes) throw new HttpError(409, "This artifact changed after verification.");
    sendFile(response, { ...file, name: basename(file.path) }, bytes);
  }

  async function handleRemote(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = URL.parse(request.url ?? "/", origin);
    if (!url) return false;
    const route = url.pathname;
    if (route !== "/remote" && !route.startsWith("/remote/")) return false;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; media-src blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const method = request.method;
      const portalDocument = method === "GET" && (route === "/remote" || route === "/remote/");
      const topLevelNavigation = portalDocument && request.headers["sec-fetch-mode"] === "navigate" &&
        request.headers["sec-fetch-dest"] === "document";
      if (url.origin !== origin.origin || request.headers.host?.toLowerCase() !== origin.host ||
        (request.headers["sec-fetch-site"] === "cross-site" && !topLevelNavigation) ||
        (request.headers.origin !== undefined && request.headers.origin !== origin.origin)) {
        throw new HttpError(403, "This portal must be accessed from its configured origin.");
      }
      if (method === "GET" && route === "/remote/sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        response.end(remoteWorker);
        return true;
      }
      if (method === "GET" && route === "/remote/manifest.webmanifest") {
        response.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
        response.end(JSON.stringify(remoteManifest));
        return true;
      }
      if (portalDocument || method === "GET" && route === "/remote/app.js") {
        const script = route.endsWith(".js");
        response.writeHead(200, { "Content-Type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
        response.end(script ? remoteScript : remotePage);
        return true;
      }
      const { pairingId, tokenHash, ...scope } = await authenticate(request);
      const actionApproval = /^\/remote\/api\/action-approvals\/([a-f0-9-]{36})\/(\d+)$/.exec(route);
      const workItem = /^\/remote\/api\/work-items(?:\/([a-f0-9-]{36})(?:\/runs\/([a-f0-9-]{36})(?:\/(answers|child-answers|control))?)?)?$/.exec(route);
      const sharedThread = /^\/remote\/api\/shared-threads(?:\/([a-f0-9-]{36})(?:\/(answers|confirm|control|artifacts\/[0-9]+\/[a-f0-9]{64}))?)?$/.exec(route);
      const sharedRoom = /^\/remote\/api\/shared-rooms(?:\/([a-f0-9-]{36})(?:\/(messages)|\/attachments\/(\d+)\/(\d+))?)?$/.exec(route);
      if (method === "GET" && route === "/remote/api/session") {
        send(response, 200, { ...scope, pairingId, ...(runtime.voiceInputAvailable ? { voiceInput: true } : {}),
          ...(runtime.voiceOutputAvailable ? { voiceOutput: true } : {}),
          ...(options.computers?.length ? { computers: options.computers } : {}),
          ...(options.sharedDevices ? { actionApprovals: true, workItems: true, sharedThreads: true, sharedRooms: true } : {}) });
      } else if (method === "POST" && route === "/remote/api/transcriptions") {
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "audio/wav") {
          request.resume();
          throw new HttpError(415, "Expected audio/wav.");
        }
        const clip = await body(request, voiceClipLimit);
        if (transcribing.has(pairingId)) throw new HttpError(409, "This device is already transcribing a recording.");
        transcribing.add(pairingId);
        try { send(response, 200, { text: await runtime.transcribeRecording(clip) }); }
        finally { transcribing.delete(pairingId); }
      } else if (options.sharedDevices && sharedRoom) {
        const [, id, messages, entryId, attachmentId] = sharedRoom;
        if (method !== (messages ? 'POST' : 'GET')) throw new HttpError(405, 'This method is unavailable for shared rooms.');
        const input = messages ? await json(request) : undefined;
        const result = await options.sharedDevices.withPairedDevice(tokenHash, async device => {
          const grants = device.sharedThreads ?? [];
          if (!id) {
            const rows = [];
            for (const grant of grants) {
              const metadata = await runtime.metadata(grant.taskId).catch(error => { if (!isMissing(error)) throw error; });
              if (metadata?.room) rows.push({ id: metadata.id, title: redactCredentials(metadata.objective), createdAt: metadata.createdAt });
            }
            return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
          }
          const grant = grants.find(item => item.taskId === id);
          if (!grant) throw new HttpError(404, 'Shared room not found.');
          const metadata = await runtime.metadata(id).catch(error => { if (!isMissing(error)) throw error; });
          if (!metadata?.room) throw new HttpError(404, 'Shared room not found.');
          if (entryId && attachmentId) {
            if (!grant.files) throw new HttpError(403, 'The host has not shared attachment downloads for this room.');
            const { file, data } = await runtime.readRoomAttachment(id, Number(entryId), Number(attachmentId));
            sendFile(response, { ...file, name: redactCredentials(file.name) }, data);
            return true;
          }
          if (input) {
            if (!grant.replies) throw new HttpError(403, 'The host has not shared reply access to this room.');
            const { memberId, requestId, message, roomRevision } = input;
            if (typeof requestId !== 'string' || !idPattern.test(requestId) || typeof roomRevision !== 'number' ||
              Object.keys(input).some(key => !['memberId', 'requestId', 'message', 'roomRevision'].includes(key))) {
              throw new HttpError(400, 'Provide the displayed room revision and a request ID.');
            }
            const receipt = await runtime.sendRoomMessage(id, { memberId, message, roomRevision,
              requestId: digest(JSON.stringify(['shared-room', pairingId, requestId])) }, 'paired');
            return { ...receipt, requestId };
          }
          const before = url.searchParams.get('before');
          const view = await runtime.roomDetails(id, before === null ? undefined : Number(before));
          return { id, title: redactCredentials(view.title), revision: view.revision, control: view.control,
            canSend: !!grant.replies && view.control === 'active',
            members: view.members.map(({ id, name, revision }) => ({ id, name: redactCredentials(name), revision })),
            messages: view.messages.map(({ requestId: _request, originalAnswerId: _answer, text, name, toName, attachments, ...message }) =>
              ({ ...message, text: redactCredentials(text), name: redactCredentials(name), ...(toName === undefined ? {} : { toName: redactCredentials(toName) }),
                ...(attachments ? { attachments: attachments.map(file => ({ ...file, name: redactCredentials(file.name),
                  ...(grant.files ? { href: `/remote/api/shared-rooms/${id}/attachments/${message.id}/${file.id}` } : {}) })) } : {}) })),
            active: view.active ? { memberId: view.active.memberId } : null, nextBefore: view.nextBefore,
          };
        }, 'shared-rooms');
        if (!result) throw new HttpError(401, 'Enter this device’s pairing token.');
        if (result !== true) send(response, 200, result);
      } else if (options.sharedDevices && sharedThread) {
        const [, id, action] = sharedThread;
        const update = action === 'answers' || action === 'confirm' || action === 'control';
        if (method !== (update ? 'POST' : 'GET')) throw new HttpError(405, 'This method is unavailable for shared threads.');
        const input = update ? await json(request) : undefined;
        const result = await options.sharedDevices.withPairedDevice(tokenHash, async device => {
          const grants = device.sharedThreads ?? [];
          if (!id) {
            const rows = [];
            for (const grant of grants) {
              const meta = await runtime.metadata(grant.taskId).catch(error => { if (!isMissing(error)) throw error; });
              if (!meta || meta.remotePolicy || meta.room) continue;
              const overview = await runtime.taskOverview(meta.id);
              rows.push({ id: meta.id, title: redactCredentials((meta.thread?.title ?? meta.objective).slice(0, 120)),
                status: overview.status, archived: !!meta.thread?.archivedAt, createdAt: meta.createdAt });
            }
            return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
          }
          const grant = grants.find(item => item.taskId === id);
          if (!grant) throw new HttpError(404, 'Shared thread not found.');
          const meta = await runtime.metadata(id).catch(error => {
            if (isMissing(error)) throw new HttpError(404, 'Shared thread not found.');
            throw error;
          });
          if (meta.remotePolicy || meta.room) throw new HttpError(404, 'Shared thread not found.');
          if (action?.startsWith('artifacts/') && !grant.files) throw new HttpError(403, 'The host has not shared artifact downloads for this thread.');
          if (input && (action === 'confirm' || action === 'control')) {
            if (!grant.controls) throw new HttpError(403, 'The host has not shared control access to this thread.');
            if (action === 'confirm') {
              const { revision, digest: shownDigest } = input;
              if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 ||
                typeof shownDigest !== 'string' || !shaPattern.test(shownDigest) || Object.keys(input).some(key => !['revision', 'digest'].includes(key))) {
                throw new HttpError(400, 'Provide the displayed brief revision and digest.');
              }
              try { await runtime.confirm(id, revision, shownDigest); }
              catch { throw new HttpError(409, 'The brief changed or cannot be confirmed. Review the current brief.'); }
              return { confirmed: true };
            }
            const { action: control, version } = input;
            if ((control !== 'pause' && control !== 'continue' && control !== 'cancel') || typeof version !== 'string' || !shaPattern.test(version) ||
              Object.keys(input).some(key => !['action', 'version'].includes(key))) throw new HttpError(400, 'Provide an action and the displayed control version.');
            await runtime.controlRemoteTask(id, 'shared-thread', control, version);
            return { updated: true };
          }
          if (input) {
            if (!grant.replies) throw new HttpError(403, 'The host has not shared reply access to this thread.');
            const { questionId, requestId, answer } = input;
            if (typeof questionId !== 'string' || !/^\d{1,20}$/.test(questionId) || typeof requestId !== 'string' || !idPattern.test(requestId) ||
              typeof answer !== 'string' || !answer.trim() || answer.length > 32000 || answer.includes('\0') ||
              Object.keys(input).some(key => !['questionId', 'requestId', 'answer'].includes(key))) throw new HttpError(400, 'Provide the question, request ID and answer.');
            await runtime.answerQuestion(id, questionId, digest(JSON.stringify(['shared-thread', pairingId, requestId])), answer);
            return { questionId, requestId };
          }
          const status = await runtime.status(id, grant.controls ? 'shared-thread' : undefined), basePath = '/remote/api/shared-threads/' + id;
          if (action?.startsWith('artifacts/')) {
            await download(response, status, basePath, route, url.searchParams.get('file'));
            return true;
          }
          const cursor = url.searchParams.get('before');
          if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) < 1)) {
            throw new HttpError(400, 'Invalid thread history cursor.');
          }
          const history = await runtime.sharedThreadMessages(id, cursor === null ? undefined : Number(cursor) as EntryId);
          const question = status.userQuestion && !status.userQuestion.credential && !status.userQuestion.browserSignIn ? {
            id: status.userQuestion.id, text: redactCredentials(status.userQuestion.text),
            options: status.userQuestion.options.map(redactCredentials),
          } : null;
          const notes = status.threadPosts.map(post => ({ id: post.id, message: redactCredentials(post.message), at: post.at,
            ...(grants.some(item => item.taskId === post.sourceTaskId) ? {
              sourceTaskId: post.sourceTaskId, sourceTitle: redactCredentials(post.sourceTitle),
            } : {}),
          }));
          const brief = grant.controls ? sharedThreadBrief(status) : null;
          return { id, title: redactCredentials((meta.thread?.title ?? meta.objective).slice(0, 120)), status: status.status,
            archived: !!meta.thread?.archivedAt, ...history, notes, question, canReply: !!grant.replies && !!question && status.status === 'waiting_user' && !meta.thread?.archivedAt,
            brief, briefDigest: brief ? status.briefDigest : null, controls: grant.controls ? status.remoteControls : [],
            controlVersion: grant.controls ? status.remoteControlVersion : null,
            summary: status.status === 'completed' ? redactCredentials(status.goal?.candidate?.summary ?? '') : null,
            artifacts: grant.files ? verifiedArtifacts(status, basePath).map(({ snapshot: _snapshot, ...artifact }) => artifact) : [],
          };
        }, 'shared-threads');
        if (!result) throw new HttpError(401, 'Enter this device’s pairing token.');
        if (result !== true) send(response, 200, result);
      } else if (options.sharedDevices && workItem) {
        const [, id, runId, action] = workItem;
        const editing = method === 'PATCH' && id !== undefined && !runId;
        if (!editing && method !== (action ? "POST" : "GET")) throw new HttpError(405, "This method is unavailable for shared work items.");
        const input = action || editing ? await json(request) : undefined;
        const result = await options.sharedDevices.withPairedDevice(tokenHash, async device => {
          const grants = device.sharedWorkItems ?? [];
          if (id === undefined) {
            return (await runtime.workItems.shared(grants)).map(sharedWorkItem);
          }
          if (!grants.includes(id)) throw new HttpError(404, "Shared work item not found.");
          const canEdit = device.sharedWorkItemEdits?.includes(id);
          if (editing && input) {
            if (!canEdit) throw new HttpError(403, 'The host has not shared editing access to this work item.');
            const { requestId, ...fields } = input;
            const allowed = ['revision', 'title', 'objective', 'status', 'priority', 'dueDate', 'dueAt', 'timeZone'];
            if (typeof requestId !== 'string' || !idPattern.test(requestId) || Object.keys(fields).some(key => !allowed.includes(key))) {
              throw new HttpError(400, 'Provide a request ID and valid planning fields for this work item.');
            }
            const original = await runtime.workItems.get(id);
            const receipt = await runtime.workItems.update(id, fields, {
              project: original.project, requestId: digest(JSON.stringify(['shared-work-item-edit', pairingId, requestId])),
            });
            return { ...sharedWorkItem(receipt), objective: receipt.objective };
          }
          if (runId) {
            const meta = await runtime.metadata(runId).catch(error => {
              if (isMissing(error)) throw new HttpError(404, "Shared work item run not found.");
              throw error;
            });
            if (meta.workItem?.id !== id) throw new HttpError(404, "Shared work item run not found.");
            const canReply = device.sharedWorkItemReplies?.includes(id);
            const canControl = device.sharedWorkItemControls?.includes(id);
            if (input) {
              if (action === "control") {
                if (!canControl) throw new HttpError(403, "The host has not shared control access to this work item.");
                const { action: control, version } = input;
                if ((control !== "pause" && control !== "continue" && control !== "cancel") || typeof version !== "string" || !shaPattern.test(version) ||
                  Object.keys(input).some(key => !["action", "version"].includes(key))) throw new HttpError(400, "Provide an action and the displayed control version.");
                await runtime.controlRemoteTask(runId, 'shared-work-item', control, version);
                return { updated: true };
              }
              if (!canReply) throw new HttpError(403, "The host has not shared reply access to this work item.");
              if (action === "child-answers") {
                const { childId, questionId, requestId, answer } = input;
                if (typeof childId !== "number" || typeof questionId !== "string" || typeof requestId !== "string" || !idPattern.test(requestId) ||
                  typeof answer !== "string" || answer.includes("\0") || Object.keys(input).some(key => !["childId", "questionId", "requestId", "answer"].includes(key))) {
                  throw new HttpError(400, "Provide a child, question, request ID and answer.");
                }
                await runtime.answerChildQuestion(runId, childId, questionId, digest(JSON.stringify(["shared-child", pairingId, requestId])), answer);
                return { childId, questionId, requestId };
              }
              const { requestId, answer, version } = input;
              if (typeof requestId !== "string" || !idPattern.test(requestId) || typeof answer !== "string" ||
                !answer.trim() || answer.length > 32_000 || answer.includes("\0") || typeof version !== "string" || !shaPattern.test(version) ||
                Object.keys(input).some(key => !["requestId", "answer", "version"].includes(key))) {
                throw new HttpError(400, "Provide an answer, request ID and displayed question version.");
              }
              await runtime.followUp(runId, answer, "shared:" + pairingId + ":" + requestId, undefined, version);
              return { requestId };
            }
            const run = await runtime.status(runId);
            const childQuestions = run.status === "running" ? run.delegations.flatMap(child => child.question
              ? [{ name: child.name, text: child.question.text,
                ...(child.question.options ? { options: child.question.options } : {}), ...(child.question.detail ? { detail: child.question.detail } : {}),
                ...(canReply ? { childId: child.conversationId, questionId: child.question.id } : {}) }] : []) : [];
            return {
              id: run.id, revision: meta.workItem.revision, objective: run.objective, status: run.status,
              reason: run.goal?.reason ?? run.initializationError ?? null, question: run.goal?.question ?? null,
              ...(run.userQuestion && !run.userQuestion.browserSignIn ? { userQuestion: run.userQuestion } : {}),
              summary: run.status === "completed" ? run.goal?.candidate?.summary ?? null : null,
              steps: (run.goal?.plan ?? []).map(({ id, title, status }) => ({ id, title, status })),
              childQuestions,
              answerVersion: canReply && !run.userQuestion?.browserSignIn ? run.workItemAnswerVersion : null,
              controls: canControl ? run.remoteControls : [], controlVersion: canControl ? run.remoteControlVersion : null,
            };
          }
          const item = await runtime.workItems.get(id);
          const runs = await Promise.all((await runtime.workItems.runs(id)).map(async run => {
            const { status, reason, question, childQuestion, summary } = await runtime.taskOverview(run.id);
            return {
              id: run.id, revision: run.workItem!.revision, status, reason, question: question ?? childQuestion ?? null, summary,
              pending: Boolean(childQuestion) || taskGroup(status) === "pending", createdAt: run.createdAt,
            };
          }));
          runs.sort((a, b) => Number(b.pending) - Number(a.pending) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
          return { ...sharedWorkItem(item), objective: item.objective, ...(canEdit ? { canEdit: true } : {}),
            runs: runs.map(({ pending, createdAt, ...run }) => run) };
        }, 'shared-work-items');
        if (!result) throw new HttpError(401, "Enter this device’s pairing token.");
        send(response, 200, result);
      } else if (options.sharedDevices && method === "GET" && route === "/remote/api/action-approvals") {
        const rows = await options.sharedDevices.withPairedDevice(tokenHash, async device => {
          const previews = [];
          for (const grant of device.sharedApprovals ?? []) {
            const approval = await runtime.sharedApproval(grant.taskId, grant.approvalId, grant.digest);
            if (approval) previews.push(approval);
          }
          return previews;
        });
        if (!rows) throw new HttpError(401, "Enter this device’s pairing token.");
        send(response, 200, rows);
      } else if (options.sharedDevices && method === "POST" && actionApproval) {
        const [, taskId, approvalId] = actionApproval;
        const { decision, digest } = await json(request);
        if ((decision !== "allow" && decision !== "deny") || typeof digest !== "string" || !shaPattern.test(digest)) {
          throw new HttpError(400, "Provide the decision and displayed digest.");
        }
        const receipt = await options.sharedDevices.withPairedDevice(tokenHash, async device => {
          const grant = device.sharedApprovals?.find(item => item.taskId === taskId && item.approvalId === approvalId);
          if (!grant) throw new HttpError(404, "Shared action approval not found.");
          if (grant.digest !== digest) throw new HttpError(409, "The displayed action does not match this approval.");
          return runtime.decideApproval(taskId!, approvalId!, decision, digest);
        });
        if (!receipt) throw new HttpError(401, "Enter this device’s pairing token.");
        send(response, 200, receipt);
      }
      else if (route === "/remote/api/push") {
        const pairing = { ...scope, pairingId };
        if (method === "GET") send(response, 200, push ? await push.status(pairing) : { publicKey: null, subscribed: false });
        else if (push && method === "PUT") send(response, 200, await push.subscribe(pairing, await json(request)));
        else if (push && method === "DELETE") send(response, 200, await push.unsubscribe(pairing));
        else throw new HttpError(push ? 405 : 404, "Push notifications are unavailable.");
      }
      else if (method === "GET" && route === "/remote/api/conversations") send(response, 200, await list(scope));
      else {
        const match = /^\/remote\/api\/conversations\/([^/]+)(?:\/(messages|uploads|confirm|control|question-answers|child-answers|child-stop|child-interrupt|voice-speech|attachments\/[A-Za-z0-9_-]{1,80}\/[a-f0-9-]{36}|artifacts\/[0-9]+\/[a-f0-9]{64}))?$/.exec(route);
        const conversationId = match?.[1];
        if (!conversationId || !idPattern.test(conversationId)) throw new HttpError(404, "Remote endpoint not found.");
        const action = match?.[2];
        const path = recordPath(scope, conversationId);
        if (method === "POST" && action === "messages") {
          const result = await submit(request, scope, conversationId, path);
          send(response, result.duplicate ? 200 : 202, result.receipt);
        } else if (method === "POST" && action === "uploads") {
          send(response, 201, await upload(request, scope, conversationId, path));
        } else {
          const prior = await readConversation(path);
          const messageId = url.searchParams.get("messageId");
          if (method === "GET" && !action && messageId !== null) {
            if (!idPattern.test(messageId)) throw new HttpError(400, "Invalid message ID.");
            const row = prior ? requireConversation(prior, scope) : undefined;
            const receipt = row?.receipts.find((item) => item.messageId === messageId);
            send(response, 200, row && receipt ? await receiptView(row, receipt, await taskStatus(row)) : {
              ...scope, conversationId, messageId, state: "unknown",
            });
          } else {
            const row = requireConversation(prior, scope);
            if (method === "GET" && !action) send(response, 200, await history(row, url.searchParams.getAll("after")));
            else if (method === "GET" && action?.startsWith("attachments/")) {
              const [, message, id] = action.split("/");
              await downloadAttachment(response, row, message!, id!);
            }
            else if (method === "GET" && action?.startsWith("artifacts/")) {
              await download(response, await taskStatus(row), "/remote/api/conversations/" + row.conversationId, route, url.searchParams.get("file"));
            } else if (method === "POST" && action === "voice-speech") {
              const { entryId, requestId } = await json(request);
              if (typeof entryId !== "number" || !Number.isSafeInteger(entryId) || entryId < 1 || typeof requestId !== "string") {
                throw new HttpError(400, "Provide an assistant reply ID and a speech request ID.");
              }
              const { root } = await privateWorkspace(row, false);
              const audio = await runtime.remoteVoiceReply(row.taskId, requestId, { workspace: root, entryId: entryId as EntryId });
              response.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": audio.length });
              response.end(audio);
            } else if (method === "POST" && action === "control") {
              const { action: control, version } = await json(request);
              if ((control !== "pause" && control !== "continue" && control !== "cancel") || typeof version !== "string" || !shaPattern.test(version)) {
                throw new HttpError(400, "Invalid task action or version.");
              }
              await exclusive(path, async () => {
                try {
                  const workspace = await privateWorkspace(row, false);
                  await runtime.controlRemoteTask(row.taskId, { workspace: workspace.root }, control, version);
                } catch (error) {
                  if (error instanceof TaskConflictError) throw new HttpError(409, error.message);
                  if (isMissing(error)) throw new HttpError(409, "The original task is unavailable.");
                  throw error;
                }
              });
              send(response, 200, { updated: true });
            } else if (method === 'POST' && action === 'question-answers') {
              const { questionId, requestId, answer } = await json(request);
              if (typeof questionId !== 'string' || typeof requestId !== 'string' || typeof answer !== 'string') throw new HttpError(400, 'Provide questionId, requestId and answer strings.');
              await exclusive(path, async () => {
                const workspace = await privateWorkspace(row, false);
                await runtime.answerQuestion(row.taskId, questionId, requestId, answer, workspace.root);
              });
              send(response, 200, { questionId, requestId });
            } else if (method === "POST" && action === "child-interrupt") {
              const { childId, toolTaskId } = await json(request);
              if (typeof childId !== "number" || typeof toolTaskId !== "number") throw new HttpError(400, "Invalid child or tool task ID.");
              const receipt = await exclusive(path, async () => {
                const workspace = await privateWorkspace(row, false);
                return runtime.interruptChild(row.taskId, childId, { workspace: workspace.root, toolTaskId });
              });
              send(response, 200, receipt);
            } else if (method === "POST" && action === "child-stop") {
              const { childId } = await json(request);
              if (typeof childId !== "number") throw new HttpError(400, "Invalid child ID.");
              const receipt = await exclusive(path, async () => {
                const workspace = await privateWorkspace(row, false);
                return runtime.stopChild(row.taskId, childId, workspace.root);
              });
              send(response, 200, receipt);
            } else if (method === "POST" && action === "child-answers") {
              const { childId, questionId, requestId, answer } = await json(request);
              if (typeof childId !== "number" || typeof questionId !== "string" ||
                  typeof requestId !== "string" || typeof answer !== "string") throw new HttpError(400, "Invalid child answer.");
              const receipt = await exclusive(path, async () => {
                const workspace = await privateWorkspace(row, false);
                return runtime.answerChildQuestion(row.taskId, childId, questionId, requestId, answer, workspace.root);
              });
              send(response, 200, receipt);
            } else if (method === "POST" && action === "confirm") {
              const { revision, digest: briefDigest } = await json(request);
              if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
                typeof briefDigest !== "string" || !shaPattern.test(briefDigest)) throw new HttpError(400, "Invalid brief revision.");
              if (!await taskStatus(row)) throw new HttpError(409, "The original task is unavailable. Start a new conversation.");
              try { await runtime.confirm(row.taskId, revision, briefDigest); }
              catch { throw new HttpError(409, "The brief changed or cannot be confirmed. Review the current brief."); }
              send(response, 200, { confirmed: true });
            } else throw new HttpError(404, "Remote endpoint not found.");
          }
        }
      }
    } catch (error) {
      if (response.destroyed) return true;
      if (response.headersSent) response.destroy();
      else if (error instanceof HttpError || error instanceof RemotePushError || error instanceof DelegationInputError || error instanceof ApprovalError || error instanceof TaskConflictError || error instanceof QuestionError || error instanceof RoomError || error instanceof WorkItemError || error instanceof VoiceNoteError) send(response, error.status, { error: error.message });
      else send(response, 500, { error: "The portal could not complete this request." });
    }
    return true;
  }
  return Object.assign(handleRemote, { pollPush: () => push?.poll() });
}
