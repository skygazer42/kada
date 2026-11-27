import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { Config } from "./config.js";
import type { TaskBrief } from "./preparation.js";
import { attachmentLimit, maxAttachments, supportedTypes } from "./remote.js";
import { atomicJson, readJson, redactCredentials, SerialQueue } from "./util.js";

type Peer = { accountId: string; deviceId: string };
type MessageId = number | string;
type ChannelName = "Telegram" | "Discord" | "Slack";
type Action = { kind: "confirm"; revision: number; digest: string } |
  { kind: "answer"; questionId?: string; cursor: number | null; childId?: number };
type Outbox = { conversation: string; action?: Action; messageId?: MessageId };
export type PairedState = { peer: Peer; current: string; open: string[]; outbox: Record<string, Outbox> };
export type ChannelDocument = { name: string; mime?: string; bytes: Buffer };
export type ChannelMessage = {
  id: MessageId;
  text: string;
  replyTo?: MessageId;
  confirmation?: boolean;
  documents?: readonly (() => Promise<ChannelDocument | undefined>)[];
};
type ChannelTransport = {
  name: ChannelName;
  secrets: readonly string[];
  commandPrefix: "/" | "!";
  textLimit: number;
  sendText(text: string, action: Action["kind"] | undefined, sendId: string): Promise<MessageId>;
  sendFile(path: string, bytes: ArrayBuffer, sendId: string): Promise<MessageId>;
};
type Relay = {
  consume(message: ChannelMessage): Promise<void>;
  confirm(replyTo?: MessageId): Promise<boolean>;
  sync(): Promise<void>;
  save(): Promise<void>;
  restore(sendId: string, messageId: string): Promise<void>;
};
type Artifact = { href: string; name: string; kind?: "file" | "directory" };
type PortalView = {
  cursor: number | null;
  messages: { sequence: number; role: string; text?: string }[];
  task?: { status: string; reason?: string; brief?: TaskBrief; briefDigest?: string; confirmed?: boolean; question?: string;
    userQuestion?: { id: string; options: string[]; detail?: string; credential?: unknown; browserSignIn?: unknown };
    childQuestions?: { childId: number; questionId: string; name: string; text: string; options?: string[]; detail?: string }[];
    delivery?: { summary: string; verification?: string; artifacts: Artifact[] } };
};

export class TransportError extends Error {
  constructor(readonly service: ChannelName | "Kada", readonly status?: number, readonly retryInMs?: number) {
    super(service + " request failed" + (status === undefined ? "." : " (HTTP " + status + ")."));
  }
}

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const route = (conversation: string) => "/remote/api/conversations/" + conversation;
const outboxKey = (conversation: string, source: string) => hash(JSON.stringify([conversation, source]));

function briefText(brief: TaskBrief) {
  const list = (label: string, values: string[]) => values.length ? label + "\n- " + values.join("\n- ") : "";
  const budget = brief.budget;
  return [brief.outcome, list("Deliverables", brief.deliverables), list("Inputs", brief.inputs), list("Scope", brief.scope),
    list("Acceptance", brief.criteria.map(item => item.text)), list("Checks", brief.checks.map(item => JSON.stringify(item))),
    list("Assumptions", brief.assumptions), list("Questions", brief.questions),
    "Total budget: " + budget.maxDurationMs / 1000 + " s, $" + budget.maxEstimatedCostUsd +
      (budget.maxTotalTokens === undefined ? "" : ", " + budget.maxTotalTokens + " tokens"),
  ].filter(Boolean).join("\n\n");
}

function textParts(text: string, limit: number) {
  const parts: string[] = [];
  let part = "";
  for (const character of redactCredentials(text)) {
    if (part.length + character.length > limit) {
      parts.push(part);
      part = "";
    }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}

export async function readChannelBytes(response: Response, service: ChannelName) {
  const reader = response.body?.getReader();
  if (!reader) throw new TransportError(service);
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => { throw new TransportError(service); });
    if (done) break;
    length += value.length;
    if (length > attachmentLimit) {
      await reader.cancel();
      return;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

export async function withPairedChannel<State extends PairedState>(
  config: Config,
  signal: AbortSignal,
  settings: { pairingToken: string; file: string; prefix: string; transport: ChannelTransport;
    log: (line: string) => void; initial(peer: Peer): State | Promise<State> },
  run: (state: State, relay: Relay) => Promise<void>,
) {
  const { pairingToken, file, prefix, transport, log } = settings;
  const direct = "http://127.0.0.1:" + config.port;
  const host = new URL(config.remoteOrigin ?? direct).host;
  const signalWithTimeout = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  function portal(path: string, input?: object | Buffer, headers?: Record<string, string>) {
    return new Promise<Response>((resolve, reject) => {
      const req = httpRequest(direct + path, { method: input ? "POST" : "GET", signal: signalWithTimeout(35_000),
        headers: { Host: host, Authorization: "Bearer " + pairingToken, "Content-Type": "application/json", ...headers },
      }, response => {
        const status = response.statusCode ?? 500;
        response.on("error", () => reject(new TransportError("Kada")));
        if (status >= 300) {
          response.resume();
          reject(new TransportError("Kada", status));
          return;
        }
        const parts: Buffer[] = [];
        response.on("data", part => parts.push(Buffer.from(part)));
        response.on("end", () => {
          const sha256 = response.headers["x-kada-sha256"];
          resolve(new Response(new Uint8Array(Buffer.concat(parts)), {
            status, headers: typeof sha256 === "string" ? { "X-Kada-SHA256": sha256 } : undefined,
          }));
        });
      });
      req.on("error", () => reject(new TransportError("Kada"))).end(Buffer.isBuffer(input) ? input : input && JSON.stringify(input));
    });
  }
  let state: State;
  const writes = new SerialQueue();
  const save = () => writes.run(() => atomicJson(file, state));
  async function restore(sendId: string, messageId: string) {
    const existing = state.outbox[sendId];
    if (!existing || existing.messageId !== undefined) return;
    existing.messageId = messageId;
    await save();
  }
  const view = async (conversation: string) => (await (await portal(route(conversation))).json()) as PortalView;
  const anchor = (id?: MessageId) => id === undefined ? undefined : Object.values(state.outbox).find(post => post.messageId === id);
  const keepOpen = (conversation: string) => { if (!state.open.includes(conversation)) state.open.push(conversation); };

  async function uploadDocument(conversation: string, loadDocument: () => Promise<ChannelDocument | undefined>) {
    const file = await loadDocument();
    if (!file || file.bytes.length > attachmentLimit) return;
    const mime = file.mime ?? "application/octet-stream";
    const accepted = await portal(route(conversation) + "/uploads", file.bytes, {
      "Content-Type": supportedTypes.has(mime) ? mime : "application/octet-stream",
      "X-Kada-Filename": encodeURIComponent(file.name),
      "X-Kada-Sha256": createHash("sha256").update(file.bytes).digest("hex"),
    });
    return (await accepted.json() as { id: string }).id;
  }

  async function publish(conversation: string, source: string, send: (key: string) => Promise<MessageId>, action?: Action) {
    signal.throwIfAborted();
    const key = outboxKey(conversation, source);
    if (state.outbox[key]) return;
    // Record the attempt before sending because an accepted request can lose its response.
    const post: Outbox = { conversation, action };
    state.outbox[key] = post;
    await save();
    try {
      post.messageId = await send(key);
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      if (post.messageId !== undefined) return;
      if ((error.service === "Discord" || error.service === "Slack") && error.status === 429) {
        delete state.outbox[key];
        await save();
        throw error;
      }
      if (!signal.aborted) log(error.message + " Send outcome unresolved. Use " + transport.commandPrefix + "status in the configured chat.");
      return;
    }
    await save();
  }

  async function say(conversation: string, source: string, text: string, action?: Action) {
    const redacted = [...transport.secrets, pairingToken].reduce((value, secret) => value.replaceAll(secret, "[credential]"), text);
    const parts = textParts(redacted, transport.textLimit);
    for (const [index, part] of parts.entries()) {
      const target = index === parts.length - 1 ? action : undefined;
      await publish(conversation, source + ":" + index, key => transport.sendText(part, target?.kind, key), target);
    }
  }

  async function deliver(conversation: string, delivery: NonNullable<NonNullable<PortalView["task"]>["delivery"]>, source: string) {
    await say(conversation, source + ":summary", [delivery.summary, delivery.verification].filter(Boolean).join("\n"));
    for (const artifact of delivery.artifacts) {
      if (!artifact.href.startsWith(route(conversation) + "/artifacts/")) throw new Error("Kada returned an invalid artifact link.");
      try {
        const members = artifact.kind === "directory"
          ? (await (await portal(artifact.href)).json() as { files: { path: string; href: string }[] }).files
          : [{ path: artifact.name, href: artifact.href }];
        for (const file of members) {
          if (file.href !== artifact.href && !file.href.startsWith(artifact.href + "?file=")) throw new Error("Kada returned an invalid directory member link.");
          const key = source + ":" + file.href;
          if (state.outbox[outboxKey(conversation, key)]) continue;
          const response = await portal(file.href);
          const bytes = await response.arrayBuffer();
          if (createHash("sha256").update(Buffer.from(bytes)).digest("hex") !== response.headers.get("X-Kada-SHA256")) {
            throw new Error("The downloaded Kada artifact failed its digest check.");
          }
          await publish(conversation, key, sendId => transport.sendFile(file.path, bytes, sendId));
        }
      } catch (error) {
        if (!(error instanceof TransportError) || error.service !== "Kada" || ![404, 409, 413].includes(error.status ?? 0)) throw error;
        await say(conversation, source + ":unavailable:" + artifact.href, "Kada could not retrieve the verified artifact " + artifact.name + ".");
      }
    }
  }

  async function presentPending(conversation: string, { task, cursor }: PortalView, source = "") {
    if (task?.status === "awaiting_confirmation" && task.brief && task.briefDigest) {
      await say(conversation, source + "brief:" + task.briefDigest, briefText(task.brief), {
        kind: "confirm", revision: task.brief.revision, digest: task.briefDigest,
      });
    }
    if (task?.status === "waiting_user" && task.question && !task.userQuestion?.credential && !task.userQuestion?.browserSignIn) {
      const question = task.userQuestion;
      await say(conversation, source + "question:" + (question?.id ?? cursor), [task.question, question?.detail, ...(question?.options ?? [])]
        .filter(Boolean).join("\n"), { kind: "answer", questionId: question?.id, cursor });
    }
    for (const question of task?.childQuestions ?? []) {
      await say(conversation, source + "child:" + question.childId + ":" + question.questionId,
        [question.name, question.text, question.detail, ...(question.options ?? [])].filter(Boolean).join("\n"),
        { kind: "answer", childId: question.childId, questionId: question.questionId, cursor });
    }
  }
  async function sync(conversation: string) {
    const snapshot = await view(conversation);
    const { messages, task, cursor } = snapshot;
    for (const message of messages) {
      if (message.role === "assistant" && message.text) await say(conversation, "reply:" + message.sequence, message.text);
    }
    await presentPending(conversation, snapshot);
    if (task?.delivery) await deliver(conversation, task.delivery, "delivery:" + cursor);
    if (task && ["answered", "completed", "cancelled", "failed"].includes(task.status)) {
      if (task.status === "failed" || task.status === "cancelled") await say(conversation, "terminal:" + cursor, task.reason ?? task.status);
      state.open = state.open.filter(id => id !== conversation);
      await save();
    }
  }

  async function confirm(replyTo?: MessageId) {
    const post = anchor(replyTo);
    if (post?.action?.kind !== "confirm") return false;
    const { conversation, action } = post;
    const task = (await view(conversation)).task;
    if (task?.briefDigest !== action.digest) return false;
    if (!task.confirmed) await portal(route(conversation) + "/confirm", { revision: action.revision, digest: action.digest });
    return true;
  }
  async function consume(message: ChannelMessage) {
    const source = "message:" + message.id;
    const documents = message.documents ?? [];
    const hasFiles = documents.length > 0;
    const text = message.text;
    const command = hasFiles ? "" : text.trim();
    const commandPrefix = transport.commandPrefix;
    const post = anchor(message.replyTo);
    const conversation = post?.conversation ?? state.current;

    if (message.confirmation) {
      let accepted = false;
      try { accepted = await confirm(message.replyTo); }
      catch (error) { if (!(error instanceof TransportError) || error.status !== 409) throw error; }
      await say(conversation, source, accepted ? "Brief confirmed." : "Reply to the original task brief that is still pending.");
      return;
    }
    if (command === commandPrefix + "new") {
      state.current = prefix + message.id;
      await say(state.current, source, "New Kada conversation. Send a message to begin.");
      return;
    }
    if (command === commandPrefix + "start") {
      await say(conversation, source, "Send a message to Kada. Reply to a Kada message to continue its original conversation. Use " +
        commandPrefix + "new, " + commandPrefix + "status or " + commandPrefix + "delivery.");
      return;
    }
    if (command === commandPrefix + "status" || command === commandPrefix + "delivery") {
      const response = await portal(route(conversation)).catch(error => {
        if (error instanceof TransportError && error.status === 404) return undefined;
        throw error;
      });
      const snapshot = response ? await response.json() as PortalView : undefined;
      const current = snapshot?.task;
      if (command === commandPrefix + "delivery" && current?.delivery) await deliver(conversation, current.delivery, source);
      else {
        const unresolved = Object.values(state.outbox).filter(item => item.conversation === conversation && item.messageId === undefined).length;
        await say(conversation, source, "Kada task: " + (current?.status ?? "No messages yet.") + "\nUnconfirmed " + transport.name + " sends: " + unresolved);
        if (command === commandPrefix + "status" && snapshot) await presentPending(conversation, snapshot, source + ":");
      }
      return;
    }
    if (documents.length > maxAttachments) {
      await say(conversation, source, "Kada supports up to " + maxAttachments + " documents per message.");
      return;
    }
    if (hasFiles && post?.action?.kind === "answer") {
      await say(conversation, source, "Reply with the answer text. Send any document in a separate message.");
      return;
    }
    const messageId = transport.name.toLowerCase() + "-" + message.id;
    if (post?.action?.kind === "answer" && post.action.questionId) {
      const { childId, questionId } = post.action;
      try {
        await portal(route(conversation) + (childId === undefined ? "/question-answers" : "/child-answers"), {
          questionId, childId, requestId: messageId, answer: text,
        });
      } catch (error) {
        if (!(error instanceof TransportError) || error.status !== 409) throw error;
        await say(conversation, source, "This question is no longer current. Open the latest Kada message.");
        return;
      }
    } else {
      if (post?.action?.kind === "answer" || hasFiles) {
        const receipt = await (await portal(route(conversation) + "?messageId=" + messageId)).json() as { state?: string };
        if (receipt.state === "submitted" || receipt.state === "accepted") {
          keepOpen(conversation);
          return;
        }
        if (receipt.state === "interrupted") {
          await say(conversation, source, "Kada could not start the original submission. Use " + commandPrefix + "status to check it.");
          return;
        }
      }
      if (post?.action?.kind === "answer") {
        const current = await view(conversation);
        if (current.task?.status !== "waiting_user" || current.cursor !== post.action.cursor) {
          await say(conversation, source, "This question is no longer current. Open the latest Kada message.");
          return;
        }
      }
      const attachmentIds = new Set<string>();
      for (const loadDocument of documents) {
        const attachment = await uploadDocument(conversation, loadDocument).catch(error => {
          if (!(error instanceof TransportError) || ![400, 404, 409, 413, 415, 422].includes(error.status ?? 0)) throw error;
          return undefined;
        });
        if (!attachment) {
          await say(conversation, source, "Kada could not use this document. Check the file and the 5 MiB attachment limit.");
          return;
        }
        attachmentIds.add(attachment);
      }
      const response = await portal(route(conversation) + "/messages", { messageId, text, attachmentIds: [...attachmentIds] }).catch(error => {
        if (!(error instanceof TransportError) || ![400, 409, 413, 422].includes(error.status ?? 0)) throw error;
        return undefined;
      });
      if (!response) {
        await say(conversation, source, "Kada could not use this message. Check the current task with " + commandPrefix + "status.");
        return;
      }
      const receipt = await response.json() as { state?: string };
      if (receipt.state === "interrupted") {
        await say(conversation, source, "Kada could not start the original submission. Use " + commandPrefix + "status to check it.");
        return;
      }
    }
    keepOpen(conversation);
  }

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(file, { realpath: false });
  try {
    const peer = await (await portal("/remote/api/session")).json() as Peer;
    state = await readJson<State>(file).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = await settings.initial({ accountId: peer.accountId, deviceId: peer.deviceId });
      await atomicJson(file, initial);
      return initial;
    });
    if (state.peer.accountId !== peer.accountId || state.peer.deviceId !== peer.deviceId) {
      throw new Error("The " + transport.name + " relay is already bound to another paired device.");
    }
    await run(state, { consume, confirm, save, restore, async sync() {
      for (const conversation of state.open) await sync(conversation);
    } });
  } finally { await release(); }
}
