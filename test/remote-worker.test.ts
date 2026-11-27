import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { remoteWorker } from "../src/remote-worker.js";

test("push shows a generic notification and opens the original paired conversation", async () => {
  const handlers = new Map<string, (event: object) => void>();
  const target = { conversationId: "report", pairingId: "a".repeat(64) };
  const notifications: { title: string; body: string; data: object }[] = [];
  const opened: string[] = [];
  let claimed = false, focused = false, useClients = true, canFocus = true;
  const origin = "https://kada.example";
  runInNewContext(remoteWorker, {
    URL,
    self: {
      location: { origin },
      addEventListener(name: string, handler: (event: object) => void) { handlers.set(name, handler); },
      registration: {
        async showNotification(title: string, { body, data }: { body: string; data: object }) {
          notifications.push({ title, body, data: JSON.parse(JSON.stringify(data)) });
        },
      },
      clients: {
        async claim() { claimed = true; },
        async matchAll(options: { type?: string; includeUncontrolled?: boolean }) {
          assert.equal(claimed,true);
          assert.equal(options.type,'window');
          assert.equal(options.includeUncontrolled,undefined);
          if (!useClients) return [];
          return [
            { url: origin + "/other" },
            { url: "https://other.example/remote/" },
            { url: origin + "/remote/", async navigate() { throw new Error('The first tab was closed.'); } },
            { url: origin + "/remote/", async navigate(path: string) {
              opened.push(path);
              return { async focus() {
                if (!canFocus) throw new Error('The browser denied focus.');
                focused = true;
              } };
            } },
          ];
        },
        async openWindow(path: string) { opened.push(path); },
      },
    },
  });
  const wait = (name: string, input: object) => {
    let operation: Promise<void> | undefined;
    handlers.get(name)!({ ...input, waitUntil(promise: Promise<void>) { operation = promise; } });
    return operation;
  };
  await wait('activate',{});
  assert.equal(claimed,true);
  await wait("push", { data: { json: () => ({ ...target, conversationId: "//foreign.example" }) } });
  assert.deepEqual(notifications, []);
  await wait("push", { data: { json: () => ({ ...target, question: "Private question" }) } });
  assert.deepEqual(notifications, [{ title: "Kada", body: "A task has an update.", data: target }]);
  let closed = false;
  await wait("notificationclick", { notification: { data: target, close() { closed = true; } } });
  assert.equal(closed, true);
  assert.equal(focused, true);
  assert.deepEqual(opened, [origin + "/remote/#conversation=report&pairing=" + target.pairingId]);
  canFocus = false;
  await wait("notificationclick", { notification: { data:target, close() {} } });
  assert.equal(opened.length,2);
  assert.equal(opened[1],opened[0]);
  useClients = false;
  await wait("notificationclick", { notification: { data:target, close() {} } });
  assert.equal(opened.at(-1),"/remote/#conversation=report&pairing=" + target.pairingId);
});
