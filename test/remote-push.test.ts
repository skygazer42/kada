import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import webpush from "web-push";
import { RemotePush } from "../src/remote-push.js";

test("the browser relay receives a VAPID-authenticated encrypted request without following redirects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kada-push-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = { accountId: "owner", deviceId: "phone", pairingId: "a".repeat(64) };
  const endpoint = "https://fcm.googleapis.com/fcm/send/synthetic";
  const browserKey = createECDH("prime256v1");
  browserKey.generateKeys();
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    return new Response(null, { status: 201 });
  });
  const push = new RemotePush(directory, "https://kada.example", async () => [scope], async (_scope, _since, cursors) =>
    cursors.task ? [] : [{ taskId: "task", conversationId: "private-report", sequence: 1 }]);
  await push.subscribe(scope, {
    endpoint, keys: { p256dh: browserKey.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  });
  await push.poll();
  await push.poll();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request!.url, endpoint);
  assert.equal(request!.method, "POST");
  assert.equal(request!.redirect, "error");
  assert.equal(request!.headers.get("Content-Encoding"), "aes128gcm");
  assert.match(request!.headers.get("Authorization") ?? "", /^vapid t=.+, k=/);
  const ciphertext = Buffer.from(await request!.arrayBuffer());
  assert(ciphertext.length > 100);
  assert(!ciphertext.includes("private-report"));
  assert(!ciphertext.includes(scope.pairingId));
});

test("push retries the original event across reopen and stops when the pairing is revoked", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kada-push-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = webpush.generateVAPIDKeys();
  const scope = { accountId: "owner", deviceId: "phone", pairingId: "a".repeat(64) };
  const other = { accountId: "owner", deviceId: "tablet", pairingId: "b".repeat(64) };
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/synthetic",
    keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 7).toString("base64url") },
  };
  let authorized = true;
  let events = [{ taskId: "task", conversationId: "report", sequence: 1, timestamp: 0 }];
  const calls: unknown[] = [];
  let offline = false;
  let replaceSubscription: (() => Promise<void>) | undefined;
  const open = () => new RemotePush(directory, "https://kada.example", async () => authorized ? [scope, other] : [other],
    async (_scope, since, cursors) => events.filter(event => event.sequence > (cursors[event.taskId] ?? 0) && event.timestamp > since),
    async (_subscription, event, options) => {
      assert.equal(options.vapidDetails?.subject, "https://kada.example");
      calls.push(JSON.parse(event));
      if (replaceSubscription) {
        await replaceSubscription();
        throw Object.assign(new Error("old subscription gone"), { statusCode: 410 });
      }
      if (offline) throw new Error("offline");
    });
  let push = open();
  await assert.rejects(push.subscribe(scope, { ...subscription, endpoint: "https://fcm.googleapis.com.evil.example/a" }), { status: 400 });
  await push.subscribe(scope, subscription);
  assert.equal((await push.status(scope)).subscribed, true);
  await assert.rejects(push.subscribe(other, subscription), { status: 409 });
  await push.poll();
  assert.deepEqual(calls, []);
  events = [{ ...events[0]!, sequence: 2, timestamp: Number.MAX_SAFE_INTEGER }];
  offline = true;
  await push.poll();
  offline = false;
  push = open();
  await push.poll();
  await push.poll();
  const alert = { conversationId: "report", pairingId: scope.pairingId };
  assert.deepEqual(calls, [alert, alert]);
  events = [{ ...events[0]!, sequence: 3 }];
  replaceSubscription = async () => {
    await push.unsubscribe(scope);
    await push.subscribe(scope, subscription);
  };
  await push.poll();
  assert.equal((await push.status(scope)).subscribed, true);
  replaceSubscription = undefined;
  authorized = false;
  await push.poll();
  assert.equal((await push.status(scope)).subscribed, false);
  assert.equal(calls.length, 3);
});
