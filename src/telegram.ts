import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { Config } from "./config.js";
import type { TaskBrief } from "./preparation.js";
import { attachmentLimit, supportedTypes } from "./remote.js";
import { atomicJson, readJson, redactCredentials } from "./util.js";

type Peer = { accountId: string; deviceId: string };
type Document = { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
type Message = { message_id: number; chat?: { id: number; type: string }; from?: { id: number }; text?: string;
  caption?: string; document?: Document; reply_to_message?: { message_id: number } };
type Update = { update_id: number; message?: Message;
  callback_query?: { id: string; from?: { id: number }; data?: string; message?: Message } };
type Action = { kind: "confirm"; revision: number; digest: string } |
  { kind: "answer"; questionId?: string; cursor: number | null; childId?: number };
type Outbox = { conversation: string; action?: Action; messageId?: number };
type TelegramState = { userId: number; peer: Peer; offset?: number; lastUpdateAt?: number;
  current: string; open: string[]; outbox: Record<string, Outbox> };
type Artifact = { href: string; name: string; kind?: "file" | "directory" };
type PortalView = {
  cursor: number | null;
  messages: { sequence: number; role: string; text?: string }[];
  task?: { status: string; reason?: string; brief?: TaskBrief; briefDigest?: string; confirmed?: boolean; question?: string;
    userQuestion?: { id: string; options: string[]; detail?: string; credential?: unknown; browserSignIn?: unknown };
    childQuestions?: { childId: number; questionId: string; name: string; text: string; options?: string[]; detail?: string }[];
    delivery?: { summary: string; verification?: string; artifacts: Artifact[] } };
};

class TransportError extends Error {
  constructor(readonly service: "Telegram" | "Kada", readonly status?: number) {
    super(service + " request failed" + (status === undefined ? "." : " (HTTP " + status + ")."));
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function textParts(text: string) {
  const parts: string[] = [];
  let part = "";
  for (const character of redactCredentials(text)) {
    if (part.length + character.length > 3900) {
      parts.push(part);
      part = "";
    }
    part += character;
  }
  if (part) parts.push(part);
  return parts;
}

export async function runTelegram(config: Config, signal: AbortSignal, options: {
  fetchTelegram?: typeof fetch;
  log?: (text: string) => void;
} = {}) {
  const settings = config.telegram;
  if (!settings) throw new Error("Configure telegram before starting the Telegram connector.");
  const botToken = process.env[settings.botTokenEnv]?.trim() ?? "";
  const botId = botToken.match(/^([1-9]\d*):[A-Za-z0-9_-]+$/)?.[1];
  const pairingToken = process.env[settings.pairingTokenEnv]?.trim() ?? "";
  if (!botId || !/^[A-Za-z0-9_-]{43}$/.test(pairingToken)) {
    throw new Error("Provide the configured Telegram Bot API and Kada pairing tokens.");
  }
  const log = options.log ?? console.warn;
  const userId = settings.userId;
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
  async function telegram(path: string, init: RequestInit, timeout: number) {
    let response: Response;
    try {
      response = await (options.fetchTelegram ?? fetch)("https://api.telegram.org" + path, {
        ...init, redirect: "error", signal: signalWithTimeout(timeout),
      });
    } catch { throw new TransportError("Telegram"); }
    if (!response.ok) throw new TransportError("Telegram", response.status);
    return response;
  }
  async function bot(method: string, input: object | FormData) {
    const form = input instanceof FormData;
    const response = await telegram("/bot" + botToken + "/" + method, {
      method: "POST", body: form ? input : JSON.stringify(input),
      ...(form ? {} : { headers: { "Content-Type": "application/json" } }),
    }, method === "sendDocument" ? 90_000 : 20_000);
    let result: { ok?: boolean; result?: unknown; error_code?: number } | null;
    try { result = await response.json(); }
    catch { throw new TransportError("Telegram"); }
    if (result?.ok !== true) throw new TransportError("Telegram", result?.error_code);
    return result.result;
  }

  const file = join(config.dataDir, "telegram", botId + ".json");
  const prefix = "telegram-" + hash(botId + ":" + userId).slice(0, 20) + "-";
  let state: TelegramState;
  const save = () => atomicJson(file, state);
  const view = async (conversation: string) => (await (await portal(route(conversation))).json()) as PortalView;
  const anchor = (id?: number) => id === undefined ? undefined : Object.values(state.outbox).find(post => post.messageId === id);
  const keepOpen = (conversation: string) => { if (!state.open.includes(conversation)) state.open.push(conversation); };

  async function uploadDocument(conversation: string, file: Document) {
    if (typeof file.file_id !== "string" || !file.file_id || (file.file_size ?? 0) > attachmentLimit) return;
    const info = await bot("getFile", { file_id: file.file_id }) as { file_path?: string };
    const parts = typeof info?.file_path === "string" ? info.file_path.split("/") : [];
    if (!parts.length || parts.some(part => !part || part === "." || part === "..")) return;
    const result = await telegram("/file/bot" + botToken + "/" + parts.map(encodeURIComponent).join("/"), {}, 30_000);
    const reader = result.body?.getReader();
    if (!reader) throw new TransportError("Telegram");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read().catch(() => { throw new TransportError("Telegram"); });
      if (done) break;
      length += value.length;
      if (length > attachmentLimit) {
        await reader.cancel();
        return;
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, length);
    const name = typeof file.file_name === "string" && file.file_name ? file.file_name : parts.at(-1)!;
    const mime = file.mime_type ?? "application/octet-stream";
    const accepted = await portal(route(conversation) + "/uploads", bytes, {
      "Content-Type": supportedTypes.has(mime) ? mime : "application/octet-stream",
      "X-Kada-Filename": encodeURIComponent(name),
      "X-Kada-Sha256": createHash("sha256").update(bytes).digest("hex"),
    });
    return (await accepted.json() as { id: string }).id;
  }

  async function publish(conversation: string, source: string, send: () => Promise<unknown>, action?: Action) {
    signal.throwIfAborted();
    const key = outboxKey(conversation, source);
    if (state.outbox[key]) return;
    // Telegram cannot look up a sent message when its response is lost.
    const post: Outbox = { conversation, action };
    state.outbox[key] = post;
    await save();
    try {
      const result = await send() as { message_id?: number } | undefined;
      if (!integer(result?.message_id)) throw new TransportError("Telegram");
      post.messageId = result.message_id;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      if (!signal.aborted) log(error.message + " Send outcome unresolved. Use /status in the configured chat.");
      return;
    }
    await save();
  }

  async function say(conversation: string, source: string, text: string, action?: Action) {
    const parts = textParts(text.replaceAll(botToken, "[credential]").replaceAll(pairingToken, "[credential]"));
    for (const [index, part] of parts.entries()) {
      const target = index === parts.length - 1 ? action : undefined;
      const reply_markup = target?.kind === "confirm"
        ? { inline_keyboard: [[{ text: "Confirm this brief", callback_data: "confirm" }]] }
        : target?.kind === "answer" ? { force_reply: true } : undefined;
      await publish(conversation, source + ":" + index, () => bot("sendMessage", { chat_id: userId, text: part, reply_markup }), target);
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
          const form = new FormData();
          form.set("chat_id", String(userId));
          form.set("caption", file.path.slice(0, 900));
          form.set("document", new Blob([bytes]), file.path.split(/[\\/]/).at(-1));
          await publish(conversation, key, () => bot("sendDocument", form));
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

  function permitted(message?: Message, sender?: number) {
    return sender === userId && message?.chat?.id === userId && message.chat.type === "private";
  }
  async function confirm(post: Outbox | undefined) {
    if (post?.action?.kind !== "confirm") return false;
    const { conversation, action } = post;
    const task = (await view(conversation)).task;
    if (task?.briefDigest !== action.digest) return false;
    if (!task.confirmed) await portal(route(conversation) + "/confirm", { revision: action.revision, digest: action.digest });
    return true;
  }
  async function consume(update: Update) {
    const callback = update.callback_query;
    if (callback?.data === "confirm" && permitted(callback.message, callback.from?.id) && typeof callback.id === "string") {
      let confirmed = false;
      try { confirmed = await confirm(anchor(callback.message?.message_id)); }
      catch (error) { if (!(error instanceof TransportError) || error.status !== 409) throw error; }
      try {
        await bot("answerCallbackQuery", { callback_query_id: callback.id,
          text: confirmed ? "Brief confirmed." : "This brief is no longer current." });
      } catch (error) {
        // An expired callback can have an accepted confirmation on the daemon.
        if (!(error instanceof TransportError) || error.status !== 400) throw error;
      }
      return;
    }
    const message = update.message;
    if (!permitted(message, message?.from?.id) || !integer(message?.message_id)) return;
    const document = message.document;
    const text = typeof message.text === "string" ? message.text : document && typeof message.caption === "string" ? message.caption : "";
    if ((!text.trim() && !document) || text.length > 4096) return;
    const source = "message:" + message.message_id;
    const command = document ? "" : text.trim();
    const post = anchor(message.reply_to_message?.message_id);
    const conversation = post?.conversation ?? state.current;
    if (command === "/new") {
      state.current = prefix + message.message_id;
      await say(state.current, source, "New Kada conversation. Send a message to begin.");
      return;
    }
    if (command === "/start") {
      await say(conversation, source, "Send a message to Kada. Reply to a Kada message to continue its original conversation. Use /new, /status or /delivery.");
      return;
    }
    if (command === "/status" || command === "/delivery") {
      const response = await portal(route(conversation)).catch(error => {
        if (error instanceof TransportError && error.status === 404) return undefined;
        throw error;
      });
      const snapshot = response ? await response.json() as PortalView : undefined;
      const current = snapshot?.task;
      if (command === "/delivery" && current?.delivery) await deliver(conversation, current.delivery, source);
      else {
        const unresolved = Object.values(state.outbox).filter(item => item.conversation === conversation && item.messageId === undefined).length;
        await say(conversation, source, "Kada task: " + (current?.status ?? "No messages yet.") + "\nUnconfirmed Telegram sends: " + unresolved);
        if (command === "/status" && snapshot) await presentPending(conversation, snapshot, source + ":");
      }
      return;
    }
    if (document && post?.action?.kind === "answer") {
      await say(conversation, source, "Reply with the answer text. Send any document in a separate message.");
      return;
    }
    if (post?.action?.kind === "answer" && post.action.questionId) {
      const { childId, questionId } = post.action;
      try {
        await portal(route(conversation) + (childId === undefined ? "/question-answers" : "/child-answers"), {
          questionId, childId, requestId: "telegram-" + message.message_id, answer: text,
        });
      } catch (error) {
        if (!(error instanceof TransportError) || error.status !== 409) throw error;
        await say(conversation, source, "This question is no longer current. Open the latest Kada message.");
        return;
      }
    } else {
      const messageId = "telegram-" + message.message_id;
      if (post?.action?.kind === "answer" || document) {
        const receipt = await (await portal(route(conversation) + "?messageId=" + messageId)).json() as { state?: string };
        if (receipt.state === "submitted" || receipt.state === "accepted") {
          keepOpen(conversation);
          return;
        }
        if (receipt.state === "interrupted") {
          await say(conversation, source, "Kada could not start the original submission. Use /status to check it.");
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
      const attachment = document ? await uploadDocument(conversation, document).catch(error => {
        if (!(error instanceof TransportError) || ![400, 404, 409, 413, 415, 422].includes(error.status ?? 0)) throw error;
        return undefined;
      }) : undefined;
      if (document && !attachment) {
        await say(conversation, source, "Kada could not use this document. Check the file and the 5 MiB attachment limit.");
        return;
      }
      const response = await portal(route(conversation) + "/messages", { messageId, text, attachmentIds: attachment ? [attachment] : [] }).catch(error => {
        if (!(error instanceof TransportError) || ![400, 409, 413, 422].includes(error.status ?? 0)) throw error;
        return undefined;
      });
      if (!response) {
        await say(conversation, source, "Kada could not use this message. Check the current task with /status.");
        return;
      }
      const receipt = await response.json() as { state?: string };
      if (receipt.state === "interrupted") {
        await say(conversation, source, "Kada could not start the original submission. Use /status to check it.");
        return;
      }
    }
    keepOpen(conversation);
  }

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(file, { realpath: false });
  try {
    const { accountId, deviceId } = await (await portal("/remote/api/session")).json() as Peer;
    state = await readJson<TelegramState>(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { userId, peer: { accountId, deviceId }, current: prefix + "initial", open: [], outbox: {} };
    });
    if (state.userId !== userId || state.peer.accountId !== accountId || state.peer.deviceId !== deviceId) {
      throw new Error("The Telegram relay is already bound to another private user or paired device.");
    }
    while (!signal.aborted) {
      try {
        // Telegram may choose a new update sequence after a week without updates.
        if (state.offset !== undefined && state.lastUpdateAt !== undefined && Date.now() - state.lastUpdateAt >= 6 * 24 * 60 * 60 * 1000) {
          delete state.offset;
          await save();
        }
        const updates = await bot("getUpdates", { offset: state.offset, timeout: 3, allowed_updates: ["message", "callback_query"] });
        if (!Array.isArray(updates) || updates.some(update => !integer(update?.update_id))) throw new TransportError("Telegram");
        for (const update of (updates as Update[]).sort((a, b) => a.update_id - b.update_id)) {
          if (state.offset !== undefined && update.update_id < state.offset) continue;
          await consume(update);
          state.offset = update.update_id + 1;
          state.lastUpdateAt = Date.now();
          await save();
        }
        for (const conversation of state.open) await sync(conversation);
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof TransportError) || error.status === 401 || error.status === 403) throw error;
        log(error.message);
        await setTimeout(1500, undefined, { signal }).catch(aborted => { if (!signal.aborted) throw aborted; });
      }
    }
  } finally { await release(); }
}
