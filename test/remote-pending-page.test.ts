import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { remoteScript } from "../src/remote-page.js";

type Handler = (event: { preventDefault(): void }) => Promise<void> | void;
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  handlers = new Map<string, Handler>();
  classList = { add() {} };
  textContent = "";
  value = "";
  files: File[] = [];
  hidden = true;
  disabled = false;
  remove() {}
  focus() {}

  addEventListener(type: string, handler: Handler) { this.handlers.set(type, handler); }
  querySelector() { return this.children.find((child) => child.dataset.draft); }
  append(child: Element) {
    this.children.push(child);
    child.remove = () => { this.children = this.children.filter((item) => item !== child); };
  }
  replaceChildren() { this.children = []; }
  async trigger(type: string) { await this.handlers.get(type)!({ preventDefault() {} }); }
}

function storage(values: Map<string, string>) {
  return { getItem: values.get.bind(values), setItem: values.set.bind(values), removeItem: values.delete.bind(values) };
}

type Message = { messageId: string; text: string; attachmentIds: string[] };
const draft = "Keep this exact draft after reconnect\nwith the attachment.";
const conversationId = "draft-conversation";
const receiptUrl = "/remote/api/conversations/" + conversationId + "?messageId=";

function harness() {
  const local = new Map([["kada:conversation:account:phone", conversationId]]);
  const session = new Map([["kada-device-token", "phone"]]);
  const messages: Message[] = [];
  const requests: string[] = [];
  let uploads = 0;
  let receipt: "unknown" | "submitted" = "unknown";
  let failure: "request" | "response" | "expired" | undefined = "request";
  let authorizationExpired = false;
  let listUnavailable = false;
  return {
    local, session, messages, requests,
    uploads: () => uploads,
    failNext: (mode: typeof failure) => { failure = mode; },
    confirm: () => { receipt = "submitted"; },
    expireAuthorization: () => { authorizationExpired = true; },
    failList: () => { listUnavailable = true; },
    async open() {
      const nodes = new Map<string, Element>();
      let poll: () => Promise<void>;
      const field = (id: string) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id)!;
      };
      runInNewContext(remoteScript, {
        document: { getElementById: field, createElement: () => new Element(), addEventListener() {} },
        window: { addEventListener() {} },
        localStorage: storage(local), sessionStorage: storage(session), crypto: webcrypto,
        setInterval(callback: () => Promise<void>) { poll = callback; },
        async fetch(url: string, init: RequestInit) {
          requests.push(url);
          if (url === "/remote/api/session") {
            const deviceToken = (init.headers as Record<string, string>).Authorization.slice("Bearer ".length);
            const [deviceId, accountId = "account"] = deviceToken.split("/");
            return Response.json({ channel: "web", accountId, deviceId });
          }
          if (url === "/remote/api/conversations") {
            return listUnavailable ? Response.json({ error: "List unavailable." }, { status: 503 }) : Response.json([]);
          }
          if (url.endsWith("/uploads")) {
            uploads++;
            return Response.json({ id: "uploaded-file" }, { status: 201 });
          }
          if (url.endsWith("/messages")) {
            messages.push(JSON.parse(init.body as string));
            const mode = failure;
            failure = undefined;
            if (mode === "request") throw new TypeError("Request dropped");
            if (mode === "expired") return Response.json({ error: "An attachment expired." }, { status: 422 });
            receipt = "submitted";
            if (mode === "response") throw new TypeError("Response dropped");
          }
          if (url.includes("?messageId=") && authorizationExpired) {
            return Response.json({ error: "Device revoked." }, { status: 401 });
          }
          if (url.includes("?messageId=") || url.endsWith("/messages")) return Response.json({ state: receipt });
          return Response.json({ error: "Conversation not found." }, { status: 404 });
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        field,
        poll: () => poll(),
        receiptText: () => field("uncertain").children.map((child) => child.textContent),
        action: (label: string) => field("uncertain").children.find((child) => child.textContent === label),
        async send() {
          field("prompt").value = draft;
          field("files").files = [new File(["fixture"], "data.txt", { type: "text/plain" })];
          await field("composer").trigger("submit");
        },
      };
    },
  };
}

test("reload restores the pending text and retries the original message only on demand", async () => {
  const device = harness();
  const original = await device.open();
  await original.send();
  assert.equal(original.action("Retry send"), undefined);
  assert.ok([...device.local.values()].every((value) => !value.includes("Keep this exact draft")));
  const reload = await device.open();
  assert.ok(reload.receiptText().includes(draft), "the restored receipt shows the original text");
  assert.equal(device.messages.length, 1);
  assert.ok(device.requests.includes(receiptUrl + device.messages[0]!.messageId));
  assert.equal(device.messages[0]!.text, draft);
  assert.deepEqual(device.messages[0]!.attachmentIds, ["uploaded-file"]);
  await reload.action("Retry send")!.trigger("click");
  assert.deepEqual(device.messages, [device.messages[0], device.messages[0]]);
  assert.equal(device.uploads(), 1);
  assert.equal(reload.field("uncertain").hidden, true);
  assert.equal((await device.open()).field("send").disabled, false);
});

test("reload resolves a lost response without replaying the submitted message", async () => {
  const device = harness();
  device.failNext("response");
  await (await device.open()).send();
  const reload = await device.open();
  assert.ok(device.requests.includes(receiptUrl + device.messages[0]!.messageId));
  assert.equal(reload.field("uncertain").hidden, true);
  assert.equal(reload.field("send").disabled, false);
  assert.equal(device.messages.length, 1);
});

test("retry checks for a receipt that arrived after the last delivery check", async () => {
  const device = harness();
  await (await device.open()).send();
  const reload = await device.open();
  device.confirm();
  await reload.action("Retry send")!.trigger("click");
  assert.equal(device.messages.length, 1);
  assert.equal(reload.field("uncertain").hidden, true);
});

test("an expired attachment allows the user to reattach files with their text intact", async () => {
  const device = harness();
  await (await device.open()).send();
  const reload = await device.open();
  device.failNext("expired");
  await reload.action("Retry send")!.trigger("click");
  assert.match(reload.field("status").textContent, /expired.*attach/i);
  assert.equal(reload.field("prompt").value, draft);
  assert.equal(reload.field("files").disabled, false);
  assert.equal(reload.field("send").disabled, false);
});

test("pending content stays with the paired account and device in the original tab", async () => {
  const device = harness();
  await (await device.open()).send();
  for (const token of ["other", "phone/other-account"]) {
    device.session.set("kada-device-token", token);
    const other = await device.open();
    assert.equal(other.field("uncertain").hidden, true);
    assert.equal(other.field("send").disabled, false);
    assert.ok(!other.receiptText().includes(draft));
  }
  device.session.clear();
  device.session.set("kada-device-token", "phone");
  assert.equal((await device.open()).field("uncertain").hidden, true);
  assert.equal(device.messages.length, 1);
});

test("pairing another device clears the previous device view before loading conversations", async () => {
  const device = harness();
  await (await device.open()).send();
  const page = await device.open();
  assert.ok(page.receiptText().includes(draft));
  page.field("prompt").value = "Unsent text from the previous device";
  page.field("files").files = [new File(["previous file"], "previous.txt")];
  page.field("conversation").append(new Element());
  page.field("messages").append(new Element());
  page.field("task-events").append(new Element());
  device.expireAuthorization();
  await page.poll();
  assert.equal(page.field("assistant").hidden, true);
  device.failList();
  page.field("token").value = "other";
  await page.field("pair-form").trigger("submit");
  assert.equal(page.field("assistant").hidden, false);
  assert.equal(page.field("uncertain").hidden, true);
  assert.ok(!page.receiptText().includes(draft));
  assert.equal(page.field("prompt").value, "");
  assert.equal(page.field("files").value, "");
  for (const id of ["conversation", "messages", "task-events"]) assert.deepEqual(page.field(id).children, [], id);
});

test("legacy pending IDs can be checked and dismissed without a retry payload", async () => {
  const device = harness();
  device.local.set("kada:pending:account:phone", JSON.stringify([[conversationId, "legacy-id"]]));
  const reload = await device.open();
  assert.ok(device.requests.includes(receiptUrl + "legacy-id"));
  assert.equal(reload.action("Retry send"), undefined);
  await reload.action("Dismiss")!.trigger("click");
  assert.equal((await device.open()).field("send").disabled, false);
  assert.deepEqual(device.messages, []);
});
