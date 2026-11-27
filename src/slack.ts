import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Config } from "./config.js";
import { attachmentLimit } from "./remote.js";
import { hash, readChannelBytes, TransportError, withPairedChannel, type PairedState } from "./paired-channel.js";
import { SerialQueue } from "./util.js";

const metadataType = "kada_task_delivery";
const timestamp = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{8,10}\.\d{6}$/.test(value);
const slackId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && value.startsWith(prefix) && /^[A-Z0-9]{3,32}$/.test(value);
const now = () => (Date.now() / 1000).toFixed(6);
const compare = (left: string, right: string) => left.length - right.length || left.localeCompare(right);

type SlackMessage = {
  type?: string; subtype?: string; channel?: string; user?: string; bot_id?: string; ts?: string; text?: string;
  thread_ts?: string; files?: { id?: string }[]; latest_reply?: string;
  metadata?: { event_type?: string; event_payload?: { send_id?: string } };
};
type Pending = { ts: string; replyTo?: string; text: string; files: string[] };
type SlackState = PairedState & {
  userId: string; channel: string; since: string; inbox: Record<string, Pending>; handled: Record<string, true>;
};
type Envelope = { type?: string; envelope_id?: string; payload?: { team_id?: string; event?: SlackMessage } };

async function connect(
  url: string, openSocket: (url: string) => WebSocket, signal: AbortSignal,
  receive: (message: Envelope) => Promise<void>,
) {
  let socket: WebSocket;
  try { socket = openSocket(url); }
  catch { throw new TransportError("Slack"); }
  const incoming = new SerialQueue();
  let rejectOpen!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    socket.addEventListener("open", () => resolve(), { once: true });
  });
  let failure: unknown;
  function close() {
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }
  function disconnect() { rejectOpen(new TransportError("Slack")); }
  function abortOpen() { close(); disconnect(); }
  const startup = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const onMessage = (event: MessageEvent) => {
    let envelope: Envelope;
    try {
      if (typeof event.data !== "string") return;
      envelope = JSON.parse(event.data);
    } catch { return; }
    if (envelope?.type === "disconnect") { close(); return; }
    const id = envelope?.envelope_id;
    if (typeof id !== "string" || !id) return;
    void incoming.run(async () => {
      if (failure) return;
      await receive(envelope);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: id }));
    }).catch(error => { failure = error; close(); });
  };
  socket.addEventListener("close", disconnect, { once: true });
  socket.addEventListener("error", abortOpen, { once: true });
  socket.addEventListener("message", onMessage);
  startup.addEventListener("abort", abortOpen, { once: true });
  if (startup.aborted) abortOpen();
  try { await opened; }
  catch (error) {
    socket.removeEventListener("message", onMessage);
    close();
    await incoming.run(async () => {});
    throw error;
  } finally { startup.removeEventListener("abort", abortOpen); }
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return {
    live: () => socket.readyState === WebSocket.OPEN,
    drain: () => incoming.run(async () => {}),
    async stop() {
      socket.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", close);
      close();
      await incoming.run(async () => {});
      if (failure) throw failure;
    },
  };
}

export async function runSlack(config: Config, signal: AbortSignal, options: {
  fetchSlack?: typeof fetch;
  openSocket?: (url: string) => WebSocket;
  log?: (line: string) => void;
} = {}) {
  const settings = config.slack;
  if (!settings) throw new Error("Configure slack before starting the Slack connector.");
  const appToken = process.env[settings.appTokenEnv]?.trim() ?? "";
  const botToken = process.env[settings.botTokenEnv]?.trim() ?? "";
  const pairingToken = process.env[settings.pairingTokenEnv]?.trim() ?? "";
  if (!/^xapp-[A-Za-z0-9-]+$/.test(appToken) || !/^xoxb-[A-Za-z0-9-]+$/.test(botToken) || !/^[A-Za-z0-9_-]{43}$/.test(pairingToken)) {
    throw new Error("Provide the configured Slack App, Bot and Kada pairing tokens.");
  }
  const userId = settings.userId;
  const log = options.log ?? console.warn;
  const fetchSlack = options.fetchSlack ?? fetch;
  const openSocket = options.openSocket ?? (url => new WebSocket(url));

  async function request(url: string | URL, init: RequestInit, timeout = 20_000) {
    let response: Response;
    try {
      response = await fetchSlack(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    } catch { throw new TransportError("Slack"); }
    if (!response.ok) {
      const seconds = Number(response.headers.get("Retry-After"));
      throw new TransportError("Slack", response.status, Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined);
    }
    return response;
  }
  function fileUrl(value: unknown) {
    const url = typeof value === "string" ? URL.parse(value) : null;
    return url?.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port &&
      /(^|\.)(slack|slack-files)\.com$/.test(url.hostname) ? url : undefined;
  }
  async function api(method: string, input?: object, authorization = botToken) {
    const json = method === "chat.postMessage" || method === "files.completeUploadExternal";
    const body = input === undefined ? undefined
      : json ? JSON.stringify(input) : new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
    const response = await request("https://slack.com/api/" + method, {
      method: "POST", headers: { Authorization: "Bearer " + authorization, ...(json ? { "Content-Type": "application/json" } : {}) },
      body,
    });
    let data: { ok?: boolean; error?: string } | null;
    try { data = await response.json(); }
    catch { throw new TransportError("Slack"); }
    if (data?.ok !== true) {
      const error = data?.error ?? "";
      const status = ["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(error) ? 401
        : ["missing_scope", "no_permission"].includes(error) ? 403
        : ["thread_not_found", "message_not_found", "channel_not_found", "file_not_found"].includes(error) ? 404
        : error === "ratelimited" ? 429 : 400;
      throw new TransportError("Slack", status);
    }
    return data;
  }

  const identity = await api("auth.test") as { team_id?: string; user_id?: string; bot_id?: string };
  if (!slackId(identity.team_id, "T") || !slackId(identity.user_id, "U") || !slackId(identity.bot_id, "B") || identity.user_id === userId) {
    throw new Error("Slack must provide the Bot identity and workspace for the configured private user.");
  }
  const team = identity.team_id;
  const bot = identity.user_id;
  const botId = identity.bot_id;
  let channel: string | undefined;
  async function bindChannel() {
    const result = await api("conversations.open", { users: userId, return_im: true }) as { channel?: { id?: string; is_im?: boolean; user?: string } };
    const dm = result.channel;
    if (!slackId(dm?.id, "D") || dm.is_im !== true || dm.user !== userId) throw new Error("Slack did not return a private DM with the authorized user.");
    channel = dm.id;
    return channel;
  }
  async function document(id: string) {
    const result = await api("files.info", { file: id }) as { file?: {
      id?: string; name?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string } };
    const file = result.file;
    if (file?.id !== id || typeof file.name !== "string" || !file.name || (file.size ?? 0) > attachmentLimit) return;
    const url = fileUrl(file.url_private_download ?? file.url_private);
    if (!url) return;
    const response = await request(url, { headers: { Authorization: "Bearer " + botToken } }, 30_000);
    if (response.headers.get("Content-Type")?.startsWith("text/html") && file.mimetype !== "text/html") {
      await response.body?.cancel();
      return;
    }
    const bytes = await readChannelBytes(response, "Slack");
    return bytes ? { name: file.name, mime: file.mimetype, bytes } : undefined;
  }
  async function socketUrl() {
    const result = await api("apps.connections.open", undefined, appToken) as { url?: string };
    const url = typeof result.url === "string" ? URL.parse(result.url) : null;
    if (!url || url.protocol !== "wss:" || url.username || url.password || url.port || url.hash ||
      !/^wss(?:-[a-z]+)?\.slack\.com$/.test(url.hostname)) throw new Error("Slack returned an invalid Socket Mode endpoint.");
    return url.href;
  }

  const file = join(config.dataDir, "slack", team + "-" + botId + ".json");
  const prefix = "slack-" + hash(team + ":" + botId + ":" + userId).slice(0, 20) + "-";
  await withPairedChannel<SlackState>(config, signal, {
    pairingToken, file, prefix, log,
    async initial(peer) {
      const channel = await bindChannel();
      return { userId, channel, since: now(), peer, current: prefix + "initial", open: [], outbox: {}, inbox: {}, handled: {} };
    },
    transport: {
      name: "Slack", secrets: [botToken, appToken], commandPrefix: "!", textLimit: 3800,
      async sendText(text, action, sendId) {
        const content = action === "confirm" ? text + "\n\nReply in this thread with !confirm." :
          action === "answer" ? text + "\n\nReply in this thread." : text;
        const sent = await api("chat.postMessage", {
          channel, text: content, mrkdwn: false, unfurl_links: false, unfurl_media: false,
          metadata: { event_type: metadataType, event_payload: { send_id: sendId } },
        }) as { channel?: string; ts?: string };
        if (sent.channel !== channel || !timestamp(sent.ts)) throw new TransportError("Slack");
        return sent.ts;
      },
      async sendFile(path, bytes) {
        const filename = path.split(/[\\/]/).at(-1)!;
        const slot = await api("files.getUploadURLExternal", { filename, length: bytes.byteLength }) as { file_id?: string; upload_url?: string };
        const upload = fileUrl(slot.upload_url);
        if (!slackId(slot.file_id, "F") || !upload) throw new TransportError("Slack");
        const response = await request(upload, {
          method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
        }, 90_000);
        await response.arrayBuffer();
        await api("files.completeUploadExternal", { files: [{ id: slot.file_id, title: path }], channel_id: channel });
        return slot.file_id;
      },
    },
  }, async (state, relay) => {
    if (state.userId !== userId || (channel ?? await bindChannel()) !== state.channel) {
      throw new Error("The Slack relay is already bound to another private DM.");
    }
    async function accept(message: SlackMessage) {
      const ts = message?.ts;
      if (message?.type !== "message" || !timestamp(ts)) return;
      const sentId = message.metadata?.event_payload?.send_id;
      if ((message.user === bot || message.bot_id === botId) && message.metadata?.event_type === metadataType &&
        typeof sentId === "string" && /^[0-9a-f]{64}$/.test(sentId)) {
        await relay.restore(sentId, ts);
        return;
      }
      if (message.user !== userId || message.bot_id || message.subtype && message.subtype !== "file_share" ||
        state.handled[ts] || state.inbox[ts]) return;
      const text = typeof message.text === "string" ? message.text : "";
      const files = Array.isArray(message.files) ? message.files.flatMap(item => slackId(item?.id, "F") ? [item.id] : []) : [];
      if ((!text.trim() && !files.length) || text.length > 32_000) return;
      state.inbox[ts] = { ts, text, files, ...(timestamp(message.thread_ts) ? { replyTo: message.thread_ts } : {}) };
      await relay.save();
    }
    async function backfill() {
      const latest = now();
      const threads = new Set<string>();
      const backlog: SlackMessage[] = [];
      async function readMessages(thread?: string) {
        let cursor: string | undefined;
        let upper = latest;
        const cursors = new Set<string>();
        for (;;) {
          const page = await api(thread ? "conversations.replies" : "conversations.history", {
            channel, oldest: state.since, latest: upper, limit: 100, include_all_metadata: true,
            ...(thread ? { ts: thread } : {}), ...(cursor ? { cursor } : {}),
          }) as { messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
          if (!Array.isArray(page.messages)) throw new TransportError("Slack");
          backlog.push(...page.messages.filter(message => timestamp(message?.ts) &&
            compare(message.ts, state.since) > 0 && compare(message.ts, latest) <= 0));
          if (!thread) for (const message of page.messages) {
            if (timestamp(message?.ts) && timestamp(message.latest_reply)) threads.add(message.ts);
          }
          cursor = page.response_metadata?.next_cursor?.trim();
          if (!cursor) {
            if (!page.has_more) break;
            const boundary = page.messages.at(-1)?.ts;
            if (!timestamp(boundary) || compare(boundary, state.since) <= 0 || compare(boundary, upper) >= 0) {
              throw new TransportError("Slack");
            }
            upper = boundary;
            cursors.clear();
            continue;
          }
          if (cursors.has(cursor)) throw new TransportError("Slack");
          cursors.add(cursor);
        }
      }
      await readMessages();
      // A recovered Bot post can be the parent of an answer sent during downtime.
      for (const message of backlog) await accept(message);
      backlog.length = 0;
      for (const post of Object.values(state.outbox)) {
        if (timestamp(post.messageId) && state.open.includes(post.conversation)) threads.add(post.messageId);
      }
      for (const thread of threads) {
        try { await readMessages(thread); }
        catch (error) {
          if (!(error instanceof TransportError) || error.status !== 404) throw error;
          log("Slack could not read a previous task thread.");
        }
      }
      for (const message of backlog.sort((a, b) => compare(a.ts!, b.ts!))) await accept(message);
      state.since = latest;
      await relay.save();
    }
    while (!signal.aborted) {
      let delay = 1200;
      let connection: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        connection = await connect(await socketUrl(), openSocket, signal, async envelope => {
          const event = envelope.payload?.event;
          if (envelope.type === "events_api" && envelope.payload?.team_id === team && event && event.channel === channel) await accept(event);
        });
        await backfill();
        while (connection.live() && !signal.aborted) {
          const pending = Object.values(state.inbox).sort((a, b) => compare(a.ts, b.ts));
          await connection.drain();
          for (const item of pending) {
            await relay.consume({
              id: item.ts.replace(".", "-"), text: item.text, replyTo: item.replyTo,
              confirmation: item.files.length === 0 && item.text.trim() === "!confirm",
              documents: item.files.map(id => () => document(id)),
            });
            state.handled[item.ts] = true;
            delete state.inbox[item.ts];
            await relay.save();
          }
          await relay.sync();
          await setTimeout(500, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof TransportError) || error.status === 401 || error.status === 403) throw error;
        log(error.message);
        delay = error.retryInMs ?? delay;
      } finally { await connection?.stop(); }
      await setTimeout(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  });
}
