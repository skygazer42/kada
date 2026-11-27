import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Config } from "./config.js";
import { attachmentLimit } from "./remote.js";
import { hash, readChannelBytes, TransportError, withPairedChannel, type PairedState } from "./paired-channel.js";

type Document = { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
type Message = { message_id: number; chat?: { id: number; type: string }; from?: { id: number }; text?: string;
  caption?: string; document?: Document; reply_to_message?: { message_id: number } };
type Update = { update_id: number; message?: Message;
  callback_query?: { id: string; from?: { id: number }; data?: string; message?: Message } };
type TelegramState = PairedState & { userId: number; offset?: number; lastUpdateAt?: number };
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

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
  const userId = settings.userId;
  const log = options.log ?? console.warn;
  const signalWithTimeout = (ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)]);
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

  async function send(method: string, input: object | FormData) {
    const result = await bot(method, input) as { message_id?: number } | undefined;
    if (!integer(result?.message_id)) throw new TransportError("Telegram");
    return result.message_id;
  }
  async function document(file: Document) {
    if (typeof file.file_id !== "string" || !file.file_id || (file.file_size ?? 0) > attachmentLimit) return;
    const info = await bot("getFile", { file_id: file.file_id }) as { file_path?: string } | undefined;
    const parts = typeof info?.file_path === "string" ? info.file_path.split("/") : [];
    if (!parts.length || parts.some(part => !part || part === "." || part === "..")) return;
    const response = await telegram("/file/bot" + botToken + "/" + parts.map(encodeURIComponent).join("/"), {}, 30_000);
    const bytes = await readChannelBytes(response, "Telegram");
    if (!bytes) return;
    const name = typeof file.file_name === "string" && file.file_name ? file.file_name : parts.at(-1)!;
    return { name, mime: file.mime_type, bytes };
  }
  function permitted(message?: Message, sender?: number) {
    return sender === userId && message?.chat?.id === userId && message.chat.type === "private";
  }

  const file = join(config.dataDir, "telegram", botId + ".json");
  const prefix = "telegram-" + hash(botId + ":" + userId).slice(0, 20) + "-";
  await withPairedChannel<TelegramState>(config, signal, {
    pairingToken, file, prefix, log,
    initial: peer => ({ userId, peer, current: prefix + "initial", open: [], outbox: {} }),
    transport: {
      name: "Telegram", secret: botToken, commandPrefix: "/", textLimit: 3900,
      sendText(text, action) {
        const reply_markup = action === "confirm"
          ? { inline_keyboard: [[{ text: "Confirm this brief", callback_data: "confirm" }]] }
          : action === "answer" ? { force_reply: true } : undefined;
        return send("sendMessage", { chat_id: userId, text, reply_markup });
      },
      sendFile(path, bytes) {
        const form = new FormData();
        form.set("chat_id", String(userId));
        form.set("caption", path.slice(0, 900));
        form.set("document", new Blob([bytes]), path.split(/[\\/]/).at(-1));
        return send("sendDocument", form);
      },
    },
  }, async (state, relay) => {
    if (state.userId !== userId) throw new Error("The Telegram relay is already bound to another private user.");
    while (!signal.aborted) {
      try {
        // Telegram may choose a new update sequence after a week without updates.
        if (state.offset !== undefined && state.lastUpdateAt !== undefined && Date.now() - state.lastUpdateAt >= 6 * 24 * 60 * 60 * 1000) {
          delete state.offset;
          await relay.save();
        }
        const updates = await bot("getUpdates", { offset: state.offset, timeout: 3, allowed_updates: ["message", "callback_query"] });
        if (!Array.isArray(updates) || updates.some(update => !integer(update?.update_id))) throw new TransportError("Telegram");
        for (const update of (updates as Update[]).sort((a, b) => a.update_id - b.update_id)) {
          if (state.offset !== undefined && update.update_id < state.offset) continue;
          const callback = update.callback_query;
          const message = update.message;
          if (callback?.data === "confirm" && permitted(callback.message, callback.from?.id) && typeof callback.id === "string") {
            let confirmed = false;
            try { confirmed = await relay.confirm(callback.message?.message_id); }
            catch (error) { if (!(error instanceof TransportError) || error.status !== 409) throw error; }
            try {
              await bot("answerCallbackQuery", { callback_query_id: callback.id,
                text: confirmed ? "Brief confirmed." : "This brief is no longer current." });
            } catch (error) {
              // An expired callback can have an accepted confirmation on the daemon.
              if (!(error instanceof TransportError) || error.status !== 400) throw error;
            }
          } else if (permitted(message, message?.from?.id) && integer(message?.message_id)) {
            const attachment = message.document;
            const text = typeof message.text === "string" ? message.text : attachment && typeof message.caption === "string" ? message.caption : "";
            if ((text.trim() || attachment) && text.length <= 4096) await relay.consume({
              id: message.message_id, text, replyTo: message.reply_to_message?.message_id,
              documents: attachment ? [() => document(attachment)] : undefined,
            });
          }
          state.offset = update.update_id + 1;
          state.lastUpdateAt = Date.now();
          await relay.save();
        }
        await relay.sync();
      } catch (error) {
        if (signal.aborted) break;
        if (!(error instanceof TransportError) || error.status === 401 || error.status === 403) throw error;
        log(error.message);
        await setTimeout(1500, undefined, { signal }).catch(aborted => { if (!signal.aborted) throw aborted; });
      }
    }
  });
}
