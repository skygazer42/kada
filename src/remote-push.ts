import { createHash, ECDH, randomUUID } from "node:crypto";
import { join } from "node:path";
import webpush, { type PushSubscription, type RequestOptions, type VapidKeys } from "web-push";
import { atomicJson, readJson, SerialQueue } from "./util.js";

export type PushScope = { pairingId: string; accountId: string; deviceId: string };
export type PushEvent = { taskId: string; conversationId: string; sequence: number };
export type PushSender = (subscription: PushSubscription, body: string, options: RequestOptions) => Promise<void>;

type Subscription = { revision: string; subscription: PushSubscription; since: number; cursors: Record<string, number> };
type PushState = { keys: VapidKeys; subscriptions: Record<string, Subscription> };

const providerHosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);

export class RemotePushError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function subscriptionFrom(input: unknown): PushSubscription {
  const supplied = input as Partial<PushSubscription> | undefined;
  const { endpoint, keys } = supplied ?? {};
  const url = typeof endpoint === "string" && endpoint.length <= 4096 ? URL.parse(endpoint) : null;
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
    !(providerHosts.has(url.hostname) || url.hostname.endsWith(".notify.windows.com")) ||
    typeof keys?.p256dh !== "string" || !/^[\w-]{87}$/.test(keys.p256dh) ||
    typeof keys.auth !== "string" || !/^[\w-]{22}$/.test(keys.auth)) {
    throw new RemotePushError(400, "This browser returned an unsupported push subscription.");
  }
  try { ECDH.convertKey(Buffer.from(keys.p256dh, "base64url"), "prime256v1"); }
  catch { throw new RemotePushError(400, "The push subscription key is invalid."); }
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

const sendPush: PushSender = async (subscription, body, options) => {
  const request = webpush.generateRequestDetails(subscription, body, options);
  const response = await fetch(request.endpoint, {
    method: request.method,
    headers: request.headers as Record<string, string>,
    body: request.body && new Uint8Array(request.body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw Object.assign(new Error("Push service refused delivery."), { statusCode: response.status });
};

export class RemotePush {
  private readonly changes = new SerialQueue();
  private readonly path: string;
  private polling = false;

  constructor(directory: string, private readonly subject: string,
    private readonly pairings: () => Promise<PushScope[]>,
    private readonly events: (scope: PushScope, since: number, cursors: Record<string, number>) => Promise<PushEvent[]>,
    private readonly send: PushSender = sendPush) {
    this.path = join(directory, "push.json");
  }

  private async load() {
    try { return await readJson<PushState>(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async status(scope: PushScope) {
    return this.changes.run(async () => {
      let state = await this.load();
      if (!state) {
        state = { keys: webpush.generateVAPIDKeys(), subscriptions: {} };
        await atomicJson(this.path, state);
      }
      return { publicKey: state.keys.publicKey, subscribed: Boolean(state.subscriptions[scope.pairingId]) };
    });
  }

  async subscribe(scope: PushScope, input: unknown) {
    const subscription = subscriptionFrom(input);
    return this.changes.run(async () => {
      const state = await this.load() ?? { keys: webpush.generateVAPIDKeys(), subscriptions: {} };
      const authorized = await this.pairings();
      if (!authorized.some(item => item.pairingId === scope.pairingId)) {
        throw new RemotePushError(401, "This pairing is unavailable.");
      }
      for (const [id, saved] of Object.entries(state.subscriptions)) {
        if (!authorized.some(item => item.pairingId === id)) delete state.subscriptions[id];
        else if (id !== scope.pairingId && saved.subscription.endpoint === subscription.endpoint) {
          throw new RemotePushError(409, "This browser already receives notifications for another pairing.");
        }
      }
      const previous = state.subscriptions[scope.pairingId];
      state.subscriptions[scope.pairingId] = {
        revision: randomUUID(), subscription, since: previous?.since ?? Date.now(), cursors: previous?.cursors ?? {},
      };
      await atomicJson(this.path, state);
      return { subscribed: true };
    });
  }

  async unsubscribe(scope: PushScope) {
    return this.changes.run(async () => {
      const state = await this.load();
      if (state?.subscriptions[scope.pairingId]) {
        delete state.subscriptions[scope.pairingId];
        await atomicJson(this.path, state);
      }
      return { subscribed: false };
    });
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const state = await this.load();
      if (!state || !Object.keys(state.subscriptions).length) return;
      const pairings = await this.pairings();
      for (const [id, saved] of Object.entries(state.subscriptions)) {
        const scope = pairings.find(item => item.pairingId === id);
        if (!scope) {
          await this.update(id, saved.revision, () => undefined);
          continue;
        }
        for (const event of await this.events(scope, saved.since, saved.cursors)) {
          const active = (await this.load())?.subscriptions[id];
          if (active?.revision !== saved.revision ||
            !(await this.pairings()).some(item => item.pairingId === id)) break;
          try {
            const topic = createHash("sha256").update(event.conversationId).digest("base64url").slice(0, 32);
            await this.send(saved.subscription, JSON.stringify({ conversationId: event.conversationId, pairingId: id }), {
              vapidDetails: { subject: this.subject, ...state.keys }, TTL: 600, topic,
            });
          } catch (error) {
            const status = (error as { statusCode?: number } | null)?.statusCode;
            if (status === 404 || status === 410) {
              await this.update(id, saved.revision, () => undefined);
              break;
            }
            continue;
          }
          await this.update(id, saved.revision, subscription => {
            subscription.cursors[event.taskId] = event.sequence;
            return subscription;
          });
        }
      }
    } finally { this.polling = false; }
  }

  private async update(id: string, revision: string, change: (value: Subscription) => Subscription | undefined) {
    await this.changes.run(async () => {
      const state = await this.load();
      const saved = state?.subscriptions[id];
      if (!state || !saved || saved.revision !== revision) return;
      const next = change(saved);
      if (next) state.subscriptions[id] = next;
      else delete state.subscriptions[id];
      await atomicJson(this.path, state);
    });
  }
}
