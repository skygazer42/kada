import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { remoteWorker } from "../src/remote-worker.js";

test("push shows a generic notification and opens the original paired conversation", async () => {
  const handlers = new Map<string, (event: object) => void>();
  const target = { conversationId: "report", pairingId: "a".repeat(64) };
  const notifications: { title: string; body: string; data: object }[] = [];
  const opened: string[] = [];
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
        async matchAll() { return [{ url: origin + "/other" }, { url: "https://other.example/remote/" }]; },
        async openWindow(path: string) { opened.push(path); },
      },
    },
  });
  const wait = (name: string, input: object) => {
    let operation: Promise<void> | undefined;
    handlers.get(name)!({ ...input, waitUntil(promise: Promise<void>) { operation = promise; } });
    return operation;
  };
  await wait("push", { data: { json: () => ({ ...target, conversationId: "//foreign.example" }) } });
  assert.deepEqual(notifications, []);
  await wait("push", { data: { json: () => ({ ...target, question: "Private question" }) } });
  assert.deepEqual(notifications, [{ title: "Kada", body: "A task has an update.", data: target }]);
  let closed = false;
  await wait("notificationclick", { notification: { data: target, close() { closed = true; } } });
  assert.equal(closed, true);
  assert.deepEqual(opened, ["/remote/#conversation=report&pairing=" + target.pairingId]);
});
