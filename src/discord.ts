import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { discordSnowflake, type Config } from "./config.js";
import { attachmentLimit } from "./remote.js";
import { hash, readChannelBytes, TransportError, withPairedChannel, type PairedState } from "./paired-channel.js";

type Channel = { id?: string; type?: number; recipients?: { id: string }[] };
type DiscordFile = { filename?: string; content_type?: string; size?: number; url?: string };
type DiscordMessage = { id: string; channel_id?: string; author?: { id?: string }; content?: string;
  message_reference?: { message_id?: string; channel_id?: string }; attachments?: DiscordFile[] };
type DiscordState = PairedState & { userId: string; channelId: string; after: string };

const api = "https://discord.com/api/v10";
const cdnOrigins = new Set(["https://cdn.discordapp.com", "https://media.discordapp.net"]);

export async function runDiscord(config: Config, signal: AbortSignal, options: {
  fetchDiscord?: typeof fetch;
  log?: (line: string) => void;
} = {}) {
  const settings = config.discord;
  if (!settings) throw new Error("Configure discord before starting the Discord connector.");
  const botToken = process.env[settings.botTokenEnv]?.trim() ?? "";
  const pairingToken = process.env[settings.pairingTokenEnv]?.trim() ?? "";
  if (!/^[A-Za-z0-9_.-]+$/.test(botToken) || !/^[A-Za-z0-9_-]{43}$/.test(pairingToken)) {
    throw new Error("Provide the configured Discord Bot token and Kada pairing token.");
  }
  const userId = settings.userId;
  const log = options.log ?? console.warn;
  const fetchDiscord = options.fetchDiscord ?? fetch;

  async function request(url: string, init: RequestInit, timeout = 20_000) {
    let response: Response;
    try {
      response = await fetchDiscord(url, { ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    } catch { throw new TransportError("Discord"); }
    if (!response.ok) {
      const seconds = Number(response.headers.get("Retry-After"));
      throw new TransportError("Discord", response.status, seconds > 0 && Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined);
    }
    return response;
  }
  async function rest(path: string, input?: object | FormData) {
    const form = input instanceof FormData;
    const response = await request(api + path, {
      method: input ? "POST" : "GET",
      headers: { Authorization: "Bot " + botToken, ...(input && !form ? { "Content-Type": "application/json" } : {}) },
      ...(input ? { body: form ? input : JSON.stringify(input) } : {}),
    }, form ? 90_000 : 20_000);
    try { return await response.json(); }
    catch { throw new TransportError("Discord"); }
  }
  const identity = await rest("/users/@me") as { id?: string; bot?: boolean } | null;
  if (!discordSnowflake(identity?.id) || identity.bot !== true || identity.id === userId) {
    throw new Error("Discord must provide a Bot identity distinct from the configured private user.");
  }
  const botId = identity.id;
  let channelId: string;
  async function bindChannel() {
    const channel = await rest("/users/@me/channels", { recipient_id: userId }) as Channel | null;
    if (!discordSnowflake(channel?.id) || channel.type !== 1 || !Array.isArray(channel.recipients) ||
      !channel.recipients.some(recipient => recipient?.id === userId) ||
      channel.recipients.some(recipient => recipient?.id !== userId && recipient?.id !== botId)) {
      throw new Error("Discord did not return a private DM with the authorized user.");
    }
    channelId = channel.id;
    return channelId;
  }
  const messages = () => "/channels/" + channelId + "/messages";
  async function history(limit: number, after?: string) {
    const query = new URLSearchParams({ limit: String(limit), ...(after !== undefined ? { after } : {}) });
    const rows = await rest(messages() + "?" + query);
    if (!Array.isArray(rows) || rows.some(row => !discordSnowflake(row?.id))) throw new TransportError("Discord");
    return rows as DiscordMessage[];
  }
  async function send(body: object | FormData) {
    const result = await rest(messages(), body) as { id?: string; channel_id?: string } | null;
    if (!discordSnowflake(result?.id) || result.channel_id !== channelId) throw new TransportError("Discord");
    return result.id;
  }
  const receipt = (sendId: string) => ({
    nonce: Buffer.from(sendId, "hex").toString("base64url").slice(0, 25),
    enforce_nonce: true, allowed_mentions: { parse: [], replied_user: false },
  });
  async function document(file: DiscordFile) {
    if (typeof file?.url !== "string" || typeof file.filename !== "string" || !file.filename || (file.size ?? 0) > attachmentLimit) return;
    const url = URL.parse(file.url);
    if (!url || !cdnOrigins.has(url.origin) || url.username || url.password || url.hash ||
      !url.pathname.startsWith("/attachments/" + channelId + "/")) return;
    const bytes = await readChannelBytes(await request(url.href, {}, 30_000), "Discord");
    return bytes ? { name: file.filename, mime: file.content_type, bytes } : undefined;
  }

  const file = join(config.dataDir, "discord", botId + ".json");
  const prefix = "discord-" + hash(botId + ":" + userId).slice(0, 20) + "-";
  await withPairedChannel<DiscordState>(config, signal, {
    pairingToken, file, prefix, log,
    async initial(peer) {
      const channelId = await bindChannel();
      const [latest] = await history(1);
      return { userId, channelId, after: latest?.id ?? "0", peer, current: prefix + "initial", open: [], outbox: {} };
    },
    transport: {
      name: "Discord", secret: botToken, commandPrefix: "!", textLimit: 1900,
      sendText(text, action, sendId) {
        const content = action === "confirm" ? text + "\n\nReply !confirm to this message." : text;
        return send({ content, ...receipt(sendId) });
      },
      sendFile(path, bytes, sendId) {
        const filename = path.split(/[\\/]/).at(-1)!;
        const form = new FormData();
        form.set("payload_json", JSON.stringify({ content: path.slice(0, 900), attachments: [{ id: 0, filename }], ...receipt(sendId) }));
        form.set("files[0]", new Blob([bytes]), filename);
        return send(form);
      },
    },
  }, async (state, relay) => {
    if (state.userId !== userId || (channelId ?? await bindChannel()) !== state.channelId) {
      throw new Error("The Discord relay is already bound to another private DM.");
    }
    while (!signal.aborted) {
      let delay = 1500;
      try {
        for (;;) {
          const page = await history(100, state.after);
          const rows = page.filter(message => BigInt(message.id) > BigInt(state.after))
            .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
          for (const message of rows) {
            if (BigInt(message.id) <= BigInt(state.after)) continue;
            const files = Array.isArray(message.attachments) ? message.attachments : [];
            const text = typeof message.content === "string" ? message.content : "";
            if (message.channel_id === channelId && message.author?.id === userId && text.length <= 4096 && (text.trim() || files.length)) {
              const reference = message.message_reference;
              const replyTo = (reference?.channel_id === undefined || reference.channel_id === channelId) &&
                discordSnowflake(reference?.message_id) ? reference.message_id : undefined;
              await relay.consume({ id: message.id, text, replyTo,
                confirmation: files.length === 0 && text.trim() === "!confirm", documents: files.map(item => () => document(item)),
              });
            }
            state.after = message.id;
            await relay.save();
          }
          await relay.sync();
          if (page.length < 100 || !rows.length) break;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof TransportError) || error.status === 401 || error.status === 403) throw error;
        log(error.message);
        delay = error.retryInMs ?? delay;
      }
      await setTimeout(delay, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
  });
}
