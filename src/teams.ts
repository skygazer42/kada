import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { App, type IActivityEvent } from "@microsoft/teams.apps";
import type { Config, TeamsConfig } from "./config.js";
import { hash, readChannelBytes, TransportError, withPairedChannel, type PairedState } from "./paired-channel.js";
import { SerialQueue } from "./util.js";

const adaptive = "application/vnd.microsoft.card.adaptive";
const inputFile = "application/vnd.microsoft.teams.file.download.info";
const consentCard = "application/vnd.microsoft.teams.card.file.consent";
const fileInfo = "application/vnd.microsoft.teams.card.file.info";
const botOrigin = "https://smba.trafficmanager.net";

type Context = { conversationId: string; serviceUrl: string; from: string; recipient: string };
type Document = { name: string; url: string };
type Note = { kind: "note"; id: string; text: string; replyTo?: string; replyKey?: string; confirmation?: boolean; files: Document[] };
type Upload = { uploadUrl: string; contentUrl: string; uniqueId: string; name: string; fileType: string };
type Decision = { kind: "file"; id: string; sendId: string; upload?: Upload };
type Offer = { href: string; path: string; bytes: number; status: "offered" | "uploaded" | "notifying" | "sent" | "declined" | "failed" };
type TeamsState = PairedState & { userId: string; context?: Context; inbox: Record<string, Note | Decision>;
  handled: Record<string, true>; offers: Record<string, Offer> };
type Activity = { id?: string; type?: string; name?: string; channelId?: string; serviceUrl?: string; replyToId?: string; text?: string;
  from?: { id?: string; aadObjectId?: string }; recipient?: { id?: string };
  conversation?: { id?: string; tenantId?: string; conversationType?: string }; channelData?: { tenant?: { id?: string } };
  value?: { kadaAction?: string; sendId?: string; answer?: string; action?: string; context?: { sendId?: string };
    uploadInfo?: Partial<Upload> };
  attachments?: { contentType?: string; name?: string; content?: { downloadUrl?: string } }[];
};
type Receive = (activity: unknown) => Promise<{ status: number }>;
type TeamsSocket = { start(): Promise<unknown>; stop(): Promise<unknown>; token(): Promise<string | undefined> };

class TeamsSocketApp extends App {
  constructor(settings: TeamsConfig, secret: string, private readonly receive: Receive, log: (line: string) => void) {
    const logger = {
      debug() {}, trace() {}, info() {},
      warn() { log("Teams SDK reported a warning."); },
      error() { log("Teams SDK reported an error."); },
      log(level: string) { if (level === "error" || level === "warn") log("Teams SDK reported an error or warning."); },
      child() { return logger; },
    };
    super({ clientId: settings.clientId, tenantId: settings.tenantId, clientSecret: secret, socketMode: true,
      serviceUrl: botOrigin + "/teams", logger });
  }
  override onActivity(event: IActivityEvent) {
    return this.receive(event.body);
  }
}

function socketMode(receive: Receive, settings: TeamsConfig, secret: string, log: (line: string) => void): TeamsSocket {
  const app = new TeamsSocketApp(settings, secret, receive, log);
  return {
    async start() {
      try { await app.start(); }
      catch { throw new Error("The Microsoft Teams SDK could not start Socket Mode."); }
    },
    async stop() {
      try { await app.stop(); }
      catch { throw new Error("The Microsoft Teams SDK could not stop Socket Mode."); }
    },
    async token() {
      const token = await app.tokenProvider.getAppToken();
      return token ? String(token) : undefined;
    },
  };
}

const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const receiptId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function address(value: unknown) {
  const url = typeof value === "string" ? URL.parse(value) : null;
  return url?.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port ? url : undefined;
}
function fileAddress(value: unknown) {
  const url = address(value);
  return url && /(^|\.)(sharepoint|1drv|onedrive\.live)\.com$/.test(url.hostname) ? url : undefined;
}
function contextFor(activity: Activity, settings: TeamsConfig): Context | undefined {
  const dm = activity.conversation;
  const tenant = dm?.tenantId ?? activity.channelData?.tenant?.id;
  if (activity.channelId !== "msteams" || dm?.conversationType !== "personal" || !textId(dm.id) ||
    typeof tenant !== "string" || tenant.toLowerCase() !== settings.tenantId ||
    typeof activity.from?.aadObjectId !== "string" || activity.from.aadObjectId.toLowerCase() !== settings.userId ||
    !textId(activity.from.id) || typeof activity.recipient?.id !== "string" ||
    activity.recipient.id.toLowerCase() !== "28:" + settings.clientId) return;
  const url = address(activity.serviceUrl);
  if (!url || url.origin !== botOrigin || url.search) return;
  return { conversationId: dm.id, serviceUrl: url.href.replace(/\/+$/, ""), from: activity.from.id, recipient: activity.recipient.id };
}

function note(activity: Activity, id: string): Note | undefined {
  if (activity.type !== "message") return;
  const value = activity.value;
  if (value?.kadaAction === "confirm" || value?.kadaAction === "answer") {
    if (!receiptId(value.sendId)) return;
    if (value.kadaAction === "confirm") return { kind: "note", id, text: "!confirm", replyKey: value.sendId, confirmation: true, files: [] };
    if (typeof value.answer !== "string" || !value.answer.trim() || value.answer.length > 16_000) return;
    return { kind: "note", id, text: value.answer, replyKey: value.sendId, files: [] };
  }
  const text = typeof activity.text === "string" ? activity.text : "";
  const files = Array.isArray(activity.attachments) ? activity.attachments.flatMap(file => {
    const url = fileAddress(file?.content?.downloadUrl);
    return file?.contentType === inputFile && typeof file.name === "string" && file.name && url ? [{ name: file.name, url: url.href }] : [];
  }) : [];
  if ((!text.trim() && !files.length) || text.length > 16_000) return;
  return { kind: "note", id, text, files, ...(textId(activity.replyToId) ? { replyTo: activity.replyToId } : {}) };
}
function decision(activity: Activity, id: string): Decision | undefined {
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") return;
  const value = activity.value;
  if (!receiptId(value?.context?.sendId)) return;
  const sendId = value.context.sendId;
  if (value.action === "decline") return { kind: "file", id, sendId };
  const upload = value.uploadInfo;
  const uploadUrl = fileAddress(upload?.uploadUrl), contentUrl = fileAddress(upload?.contentUrl);
  if (value.action !== "accept" || !uploadUrl || !contentUrl || !textId(upload?.uniqueId) ||
    !textId(upload?.name) || typeof upload.fileType !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(upload.fileType)) return;
  return { kind: "file", id, sendId, upload: { uploadUrl: uploadUrl.href, contentUrl: contentUrl.href,
    uniqueId: upload.uniqueId, name: upload.name, fileType: upload.fileType } };
}

export async function runTeams(config: Config, signal: AbortSignal, options: {
  fetchTeams?: typeof fetch;
  log?: (line: string) => void;
} = {}) {
  const settings = config.teams;
  if (!settings) throw new Error("Configure teams before starting the Teams connector.");
  const secret = process.env[settings.clientSecretEnv]?.trim() ?? "";
  const pairingToken = process.env[settings.pairingTokenEnv]?.trim() ?? "";
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(pairingToken)) throw new Error("Provide the configured Teams App secret and Kada pairing token.");
  const fetchTeams = options.fetchTeams ?? fetch;
  const log = options.log ?? console.warn;
  const file = join(config.dataDir, "teams", settings.tenantId + "-" + settings.clientId + ".json");
  const prefix = "teams-" + hash(settings.tenantId + ":" + settings.clientId + ":" + settings.userId).slice(0, 20) + "-";
  let state!: TeamsState;
  let save!: () => Promise<void>;
  let socket!: TeamsSocket;

  async function request(url: string, init: RequestInit, timeout: number) {
    let response: Response;
    try {
      response = await fetchTeams(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    } catch { throw new TransportError("Teams"); }
    if (!response.ok) {
      const seconds = Number(response.headers.get("Retry-After"));
      throw new TransportError("Teams", response.status, Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined);
    }
    return response;
  }
  async function post(activity: object) {
    if (!state.context) throw new Error("Send a message to the Teams Bot before using its private chat.");
    const { serviceUrl, conversationId, from, recipient } = state.context;
    let bearer: string | undefined;
    try { bearer = await socket.token(); }
    catch { throw new TransportError("Teams"); }
    if (!bearer) throw new TransportError("Teams", 401);
    const result = await request(serviceUrl + "/v3/conversations/" + encodeURIComponent(conversationId) + "/activities", {
      method: "POST", headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message", from: { id: recipient }, recipient: { id: from }, conversation: { id: conversationId }, ...activity }),
    }, 25_000);
    let sent: { id?: string } | null;
    try { sent = await result.json(); }
    catch { throw new TransportError("Teams"); }
    if (!textId(sent?.id)) throw new TransportError("Teams");
    return sent.id;
  }
  async function document(file: Document) {
    const response = await request(file.url, {}, 35_000);
    const bytes = await readChannelBytes(response, "Teams");
    return bytes ? { name: file.name, bytes } : undefined;
  }
  await withPairedChannel<TeamsState>(config, signal, {
    pairingToken, file, prefix, log,
    initial: peer => ({ peer, userId: settings.userId, current: prefix + "initial", outbox: {}, open: [], inbox: {}, handled: {}, offers: {} }),
    transport: {
      name: "Teams", secrets: [secret], commandPrefix: "!", textLimit: 3600,
      sendText(text, action, sendId) {
        if (!action) return post({ text, textFormat: "plain" });
        const body: object[] = [{ type: "TextBlock", text, wrap: true }];
        if (action === "answer") body.push({ type: "Input.Text", id: "answer", label: "Answer", isRequired: true, isMultiline: true });
        return post({ attachments: [{ contentType: adaptive, content: {
          type: "AdaptiveCard", version: "1.3", body,
          actions: [{ type: "Action.Submit", title: action === "confirm" ? "Confirm this brief" : "Send answer",
            data: { kadaAction: action, sendId } }],
        } }] });
      },
      async sendFile(path, bytes, sendId, href) {
        state.offers[sendId] = { path, href, bytes: bytes.byteLength, status: "offered" };
        await save();
        return post({ attachments: [{ contentType: consentCard, name: path.split(/[\\/]/).at(-1), content: {
          description: "Verified Kada artifact " + path, sizeInBytes: bytes.byteLength,
          acceptContext: { sendId }, declineContext: { sendId },
        } }] });
      },
    },
  }, async (loaded, relay) => {
    state = loaded;
    save = relay.save;
    if (state.userId !== settings.userId) throw new Error("The Teams connector is already bound to another private user.");
    const incoming = new SerialQueue();
    const receive: Receive = input => incoming.run(async () => {
      if (!input || typeof input !== "object" || signal.aborted) return { status: 200 };
      const activity = input as Activity;
      const context = contextFor(activity, settings);
      if (!context || !textId(activity.id) ||
        state.context && (state.context.conversationId !== context.conversationId || state.context.from !== context.from)) return { status: 200 };
      const id = hash(context.conversationId + "\0" + activity.id).slice(0, 40);
      if (state.handled[id] || state.inbox[id]) return { status: 200 };
      const item = note(activity, id) ?? decision(activity, id);
      if (!item) return { status: 200 };
      state.context = context;
      state.inbox[id] = item;
      await save();
      return { status: 200 };
    });
    socket = socketMode(receive, settings, secret, log);

    async function finishFile(item: Decision) {
      const offer = state.offers[item.sendId];
      if (!offer || !state.outbox[item.sendId] || offer.status !== "offered" && offer.status !== "uploaded") return;
      const accepted = item.upload;
      if (!accepted) {
        if (offer.status === "offered") { offer.status = "declined"; await save(); }
        return;
      }
      if (offer.status === "offered") {
        try {
          const bytes = await relay.readArtifact(offer.href);
          if (bytes.byteLength !== offer.bytes) throw new Error("The file offer no longer matches the verified artifact.");
          const response = await request(accepted.uploadUrl, { method: "PUT", headers: {
            "Content-Type": "application/octet-stream", "Content-Length": String(bytes.byteLength),
            ...(bytes.byteLength ? { "Content-Range": "bytes 0-" + (bytes.byteLength - 1) + "/" + bytes.byteLength } : {}),
          }, body: bytes }, 90_000);
          await response.arrayBuffer();
          if (response.status === 202) throw new TransportError("Teams", 502);
          offer.status = "uploaded";
          await save();
        } catch (error) {
          if (!(error instanceof TransportError) || ![400, 401, 403, 404, 409, 410, 413].includes(error.status ?? 0)) throw error;
          offer.status = "failed";
          await save();
          await post({ text: "The approved file could not be uploaded. Use !delivery to request the verified artifact again.", textFormat: "plain" });
          return;
        }
      }
      // Teams has no lookup for an activity whose send response disappeared.
      offer.status = "notifying";
      await save();
      try {
        await post({ attachments: [{ contentType: fileInfo, contentUrl: accepted.contentUrl, name: accepted.name,
          content: { uniqueId: accepted.uniqueId, fileType: accepted.fileType } }] });
        offer.status = "sent";
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        if (error.status === 429) {
          offer.status = "uploaded";
          await save();
          throw error;
        }
        if (!signal.aborted) log("Teams file notification outcome unresolved. Use !delivery in the configured chat.");
      }
      await save();
    }

    try {
      await socket.start();
      while (!signal.aborted) {
        let delay = 500;
        try {
          const batch = Object.values(state.inbox);
          await incoming.run(async () => {});
          for (const item of batch) {
            if (item.kind === "file") await finishFile(item);
            else await relay.consume({ id: item.id, text: item.text, replyTo: item.replyTo, replyKey: item.replyKey,
              confirmation: item.confirmation, documents: item.files.map(file => () => document(file)),
            });
            state.handled[item.id] = true;
            delete state.inbox[item.id];
            await save();
          }
          await relay.sync();
        } catch (error) {
          if (signal.aborted) break;
          if (!(error instanceof TransportError) || error.status === 401 || error.status === 403) throw error;
          log(error.message);
          delay = error.retryInMs ?? 1500;
        }
        await setTimeout(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
      }
    } finally {
      await socket.stop();
      await incoming.run(async () => {});
    }
  });
}
