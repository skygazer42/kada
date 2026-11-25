import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { remoteScript } from "../src/remote-page.js";

type Handler = (event: { preventDefault(): void }) => Promise<void> | void;
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  dataset: Record<string, string> = {};
  handlers = new Map<string, Handler>();
  classList = { add() {} };
  textContent = "";
  value = "";
  files: File[] = [];
  hidden = true;
  disabled = false;
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  focus() {}

  addEventListener(type: string, handler: Handler) { this.handlers.set(type, handler); }
  setAttribute() {}
  querySelector() { return this.children.find((child) => child.dataset.emptyConversation); }
  append(child: Element) {
    child.remove();
    this.children.push(child);
    child.parentNode = this;
  }
  replaceChildren() {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  async trigger(type: string) { await this.handlers.get(type)!({ preventDefault() {} }); }
}

function storage(values: Map<string, string>, beforeSet?: (key: string) => void) {
  return { getItem: values.get.bind(values), setItem(key: string, value: string) {
    beforeSet?.(key);
    values.set(key, value);
  }, removeItem: values.delete.bind(values) };
}

type Message = { messageId: string; text: string; attachmentIds: string[] };
const draft = "Keep this exact draft after reconnect\nwith the attachment.";
const conversationId = "draft-conversation";
const receiptUrl = "/remote/api/conversations/" + conversationId + "?messageId=";

function harness(history?: (url: URL, init: RequestInit) => Response | Promise<Response>, sessionWait?: (token: string) => Promise<void>, list = () => Response.json([])) {
  const local = new Map([["kada:conversation:account:phone", conversationId]]);
  const session = new Map([["kada-device-token", "phone"]]);
  const messages: Message[] = [];
  const requests: string[] = [];
  const locks = new Map<string, Promise<unknown>>();
  let uploads = 0;
  let receipt: "unknown" | "submitted" = "unknown";
  let failure: "request" | "response" | "expired" | undefined = "request";
  let authorizationExpired = false;
  let listUnavailable = false;
  let failComposerWrite = false;
  return {
    local, session, messages, requests,
    uploads: () => uploads,
    failNext: (mode: typeof failure) => { failure = mode; },
    confirm: () => { receipt = "submitted"; },
    expireAuthorization: () => { authorizationExpired = true; },
    failList: () => { listUnavailable = true; },
    failDraftWrite: () => { failComposerWrite = true; },
    async open(hash = "", push?: {
      serviceWorker: object;
      permission: () => Promise<string>;
      request: (init: RequestInit) => Response;
    }) {
      const location = Object.assign(new URL("http://localhost/remote" + hash), {
        reload() { reloaded = true; },
      });
      let reloaded = false;
      const nodes = new Map<string, Element>();
      const windowHandlers = new Map<string, () => void>();
      let poll: () => Promise<void>;
      const field = (id: string) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id)!;
      };
      runInNewContext(remoteScript, {
        document: { getElementById: field, createElement: () => new Element(), addEventListener() {} },
        window: { addEventListener(type: string, handler: () => void) { windowHandlers.set(type, handler); } },
        ...(push ? { PushManager: {}, Notification: { requestPermission: push.permission } } : {}),
        location, history: { replaceState(_state: unknown, _title: string, path: string) {
          location.href = new URL(path, location).href;
        } }, URLSearchParams,
        AbortSignal,
        localStorage: storage(local, (key) => {
          if (!failComposerWrite || !key.startsWith("kada:composer:")) return;
          failComposerWrite = false;
          throw new DOMException("Storage quota reached", "QuotaExceededError");
        }), sessionStorage: storage(session), crypto: webcrypto,
        navigator: { serviceWorker: push?.serviceWorker, locks: { request(name: string, fn: () => unknown) {
          const result = (locks.get(name) ?? Promise.resolve()).then(fn);
          locks.set(name, result.catch(() => {}));
          return result;
        } } },
        confirm: () => true,
        setInterval(callback: () => Promise<void>) { poll = callback; },
        async fetch(url: string, init: RequestInit) {
          requests.push(url);
          if (url === "/remote/api/push" && push) return push.request(init);
          if (url === "/remote/api/session") {
            const deviceToken = (init.headers as Record<string, string>).Authorization.slice("Bearer ".length);
            await sessionWait?.(deviceToken);
            const [deviceId, accountId = "account"] = deviceToken.split("/");
            const pairingId = createHash("sha256").update("fixture:" + deviceToken).digest("hex");
            return Response.json({ channel: "web", accountId, deviceId, pairingId });
          }
          if (url === "/remote/api/conversations") {
            return listUnavailable ? Response.json({ error: "List unavailable." }, { status: 503 }) : list();
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
          if (history) return history(new URL(url, "http://localhost"), init);
          return Response.json({ error: "Conversation not found." }, { status: 404 });
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        field,
        location,
        reloaded: () => reloaded,
        async navigate(hash: string) {
          location.hash = hash;
          windowHandlers.get("hashchange")?.();
          await new Promise<void>(resolve => setImmediate(resolve));
        },
        poll: () => poll(),
        receiptText: () => field("uncertain").children.map((child) => child.textContent),
        action: (label: string) => field("uncertain").children.find((child) => child.textContent === label),
        async type(text: string) {
          field("prompt").value = text;
          await field("prompt").trigger("input");
        },
        async send() {
          await this.type(draft);
          field("files").files = [new File(["fixture"], "data.txt", { type: "text/plain" })];
          await field("composer").trigger("submit");
        },
      };
    },
  };
}

test("a task link waits for pairing and only selects a conversation listed for that device", async () => {
  const linked = "shared-report";
  const device = harness((url) => Response.json({
    cursor: 1, messages: [{ role: "user", sequence: 1, text: url.pathname.endsWith("/" + linked) ? "Linked report" : "First chat" }],
    progressEvents: [], task: null,
  }), undefined, () => Response.json([
    { conversationId, title: "First chat" },
    { conversationId: linked, title: "Report" },
  ]));
  device.session.clear();
  const page = await device.open("#conversation=" + linked);
  assert.deepEqual(device.requests, []);
  page.field("token").value = "phone";
  await page.field("pair-form").trigger("submit");
  assert.equal(page.field("conversation").value, linked);
  assert.equal(page.field("messages").children[0]!.children[1]!.textContent, "Linked report");
  assert.equal(page.location.hash, "");

  const blocked = await device.open("#conversation=other-device-task");
  assert.equal(blocked.field("conversation").value, linked);
  assert.match(blocked.field("status").textContent, /unavailable on this device/i);
  assert.equal(device.requests.some(path => path.includes("other-device-task")), false);
  await blocked.navigate("#conversation=" + conversationId + "&pairing=" + "b".repeat(64));
  assert.equal(blocked.field("conversation").value, linked);
  await blocked.navigate("#conversation=" + conversationId + "&pairing=" + createHash("sha256").update("fixture:phone").digest("hex"));
  assert.equal(blocked.field("conversation").value, conversationId);
});

test("a paired browser registers its push worker only after opt-in and can disable delivery", async () => {
  let subscribed = false;
  const calls: string[] = [];
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { p256dh: "client-key", auth: "client-auth" } };
  const page = await harness().open("", {
    permission: async () => { calls.push("permission"); return "granted"; },
    serviceWorker: { async register(path: string, options: { scope: string }) {
      assert.equal(path, "/remote/sw.js");
      assert.equal(options.scope, "/remote/");
      calls.push("register");
      return { active: true, pushManager: {
        getSubscription: async () => null,
        async subscribe(input: { userVisibleOnly: boolean; applicationServerKey: string }) {
          assert.equal(input.applicationServerKey, "server-key");
          assert.equal(input.userVisibleOnly, true);
          return subscription;
        },
      } };
    } },
    request(init) {
      if (init.method === "PUT") {
        calls.push("put");
        assert.deepEqual(JSON.parse(String(init.body)), subscription);
        subscribed = true;
      } else if (init.method === "DELETE") {
        calls.push("delete");
        subscribed = false;
      }
      return Response.json({ publicKey: "server-key", subscribed });
    },
  });
  const control = page.field("task-notifications");
  assert.equal(control.hidden, false);
  assert.deepEqual(calls, []);
  await control.trigger("click");
  assert.equal(control.textContent, "Disable task notifications");
  await control.trigger("click");
  assert.equal(control.textContent, "Enable task notifications");
  assert.deepEqual(calls, ["permission", "register", "put", "delete"]);
});

test("sign-out clears the local pairing even when disabling notifications is unreachable", async () => {
  const device = harness();
  const page = await device.open("", {
    permission: async () => "granted",
    serviceWorker: {},
    request(init) {
      if (init.method === "DELETE") {
        assert.equal(device.session.has("kada-device-token"), false);
        throw new TypeError("offline");
      }
      return Response.json({ publicKey: "server-key", subscribed: true });
    },
  });
  await page.field("signout").trigger("click");
  assert.equal(device.session.has("kada-device-token"), false);
  assert.equal(page.reloaded(), true);
});

test("the pending list opens the original conversation and drops tasks that are no longer pending", async () => {
  let waiting = true;
  const device = harness((url) => Response.json({
    cursor: 1, messages: [{ role: "user", sequence: 1, text: url.pathname.endsWith("/report") ? "Original report request" : "First chat" }],
    progressEvents: [], task: null,
  }), undefined, () => Response.json([
    { conversationId, title: "First chat", task: { group: "running", status: "running" } },
    { conversationId: "report", title: "Daily report", task: { group: waiting ? "pending" : "delivered", status: waiting ? "waiting_user" : "completed" } },
  ]));
  const page = await device.open();
  await page.type("Unsent first-chat draft");
  const list = page.field("pending-tasks");
  assert.equal(page.field("pending-work").hidden, false);
  assert.deepEqual(list.children.map(row => row.children[0]!.textContent), ["Daily report · Waiting for you"]);
  await list.children[0]!.children[0]!.trigger("click");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(page.field("conversation").value, "report");
  assert.equal(page.field("messages").children[0]!.children[1]!.textContent, "Original report request");
  waiting = false;
  await page.field("refresh-conversations").trigger("click");
  assert.equal(page.field("pending-work").hidden, true);
  assert.equal(page.field("conversation").value, "report");
  page.field("conversation").value = conversationId;
  await page.field("conversation").trigger("change");
  assert.equal(page.field("prompt").value, "Unsent first-chat draft");
});

test("polling appends new history, updates an idle task, and discards a late response from the previous chat", async () => {
  const initial = { role: "user", sequence: 1, text: "Original request" };
  const reply = { role: "assistant", sequence: 4, text: "Original reply" };
  const progress = { sequence: 3, label: "Working", timestamp: 1 };
  const late = Promise.withResolvers<Response>();
  let step = 0;
  const device = harness((url) => {
    if (url.pathname.endsWith("/other")) {
      assert.equal(url.search, "");
      return Response.json({ cursor: 8, messages: [{ ...initial, text: "Other chat" }], progressEvents: [], task: null });
    }
    switch (++step) {
      case 1: return Response.json({ cursor: 2, messages: [initial], progressEvents: [], task: { status: "running" } });
      case 2: return Response.json({ cursor: 5, messages: [reply], progressEvents: [progress], task: { status: "running" } });
      case 3: return Response.json({ cursor: 5, messages: [], progressEvents: [], task: { status: "completed" } });
      default: return late.promise;
    }
  });
  const page = await device.open();
  const shown = () => page.field("messages").children.map((article) => article.children[1]!.textContent);
  assert.deepEqual(shown(), ["Original request"]);
  await page.poll();
  await page.poll();
  assert.deepEqual(shown(), ["Original request", "Original reply"]);
  assert.equal(page.field("task-events").children.length, 1);
  assert.equal(page.field("task").children[0]!.textContent, "Completed");
  assert.deepEqual(device.requests.slice(-2), [
    "/remote/api/conversations/" + conversationId + "?after=2",
    "/remote/api/conversations/" + conversationId + "?after=5",
  ]);
  const stale = page.poll();
  await new Promise<void>((resolve) => setImmediate(resolve));
  page.field("conversation").value = "other";
  await page.field("conversation").trigger("change");
  await new Promise<void>((resolve) => setImmediate(resolve));
  late.resolve(Response.json({ cursor: 6, messages: [reply], progressEvents: [progress], task: { status: "running" } }));
  await stale;
  assert.deepEqual(shown(), ["Other chat"]);
  assert.equal(page.field("task-events").children.length, 0);
});

test("a rejected cursor rebuilds history and a connection failure preserves the last cursor", async () => {
  const address = "/remote/api/conversations/" + conversationId;
  let step = 0;
  const device = harness(() => {
    switch (++step) {
      case 1: return Response.json({ cursor: 2, messages: [{ sequence: 2, role: "user", text: "Original" }], progressEvents: [], task: null });
      case 2: throw new TypeError("Connection dropped");
      case 3: return Response.json({ error: "Invalid history cursor." }, { status: 400 });
      default: return Response.json({ cursor: 1, messages: [{ sequence: 1, role: "user", text: "Restored" }], progressEvents: [], task: null });
    }
  });
  const page = await device.open();
  await page.poll();
  assert.match(page.field("status").textContent, /connection dropped/);
  await page.poll();
  assert.deepEqual(device.requests.slice(-4), [address, address + "?after=2", address + "?after=2", address]);
  assert.deepEqual(page.field("messages").children.map((article) => article.children[1]!.textContent), ["Restored"]);
  assert.equal(page.field("status").textContent, "");
});

test("a message attachment preview renders original text as plain content", async () => {
  const href = "/remote/api/conversations/" + conversationId + "/attachments/first/file";
  const device = harness((url) => url.pathname === href ? new Response("<script>original()</script>") : Response.json({
    cursor: 1, progressEvents: [], task: null,
    messages: [{ sequence: 1, role: "user", text: "Here is the file", attachments: [{ name: "original.txt", type: "text/plain", href }] }],
  }));
  const page = await device.open();
  const message = page.field("messages").children[0]!;
  const card = message.children[2]!.children[0]!;
  assert.equal(card.children[0]!.textContent, "original.txt");
  await card.children[1]!.children.find((child) => child.textContent === "Preview")!.trigger("click");
  assert.equal(card.children.at(-1)!.children[0]!.textContent, "<script>original()</script>");
  assert.ok(device.requests.includes(href));
});

test("task controls update the selected card and preserve the transcript and draft", async () => {
  let state = "running";
  const device = harness((url, init) => {
    if (url.pathname.endsWith("/control")) {
      assert.equal(url.pathname, "/remote/api/conversations/" + conversationId + "/control");
      const { action, version } = JSON.parse(init.body as string);
      assert.equal(version, state + "-revision");
      state = { pause: "paused", continue: "running", cancel: "cancelled" }[action as string]!;
      return Response.json({ status: state });
    }
    const controls = { running: ["pause", "cancel"], paused: ["continue", "cancel"], cancelled: [] }[state];
    const messages = url.search ? [] : [{ sequence: 1, role: "user", text: "Original request" }];
    return Response.json({ cursor: 1, messages, progressEvents: [], task: { status: state, controls, controlVersion: state + "-revision" } });
  });
  const page = await device.open();
  const task = page.field("task");
  const action = (label: string) => task.children.flatMap((child) => child.children).find((child) => child.textContent === label);
  page.field("prompt").value = "Keep this draft.";
  await action("Pause")!.trigger("click");
  assert.equal(task.children[0]!.textContent, "Paused");
  assert.equal(page.field("send").disabled, true);
  await action("Continue")!.trigger("click");
  assert.equal(task.children[0]!.textContent, "Running");
  assert.equal(page.field("send").disabled, false);
  await action("Cancel task")!.trigger("click");
  assert.equal(task.children[0]!.textContent, "Cancelled");
  assert.equal(action("Cancel task"), undefined);
  assert.equal(page.field("messages").children.length, 1);
  assert.equal(page.field("prompt").value, "Keep this draft.");
});

test("a task control conflict stays with its conversation when the selected chat changes", async () => {
  const rechecking = Promise.withResolvers<void>();
  const stale = Promise.withResolvers<Response>();
  const view = { cursor: 1, messages: [], progressEvents: [], task: { status: "running", controls: ["pause"], controlVersion: "old" } };
  const device = harness((url) => {
    if (url.pathname.endsWith("/control")) return Response.json({ error: "Original task changed." }, { status: 409 });
    if (url.pathname.endsWith("/other")) return Response.json({ ...view, task: null });
    if (url.search) { rechecking.resolve(); return stale.promise; }
    return Response.json(view);
  });
  const page = await device.open();
  const pause = page.field("task").children[1]!.children[0]!;
  const click = pause.trigger("click");
  await rechecking.promise;
  page.field("conversation").value = "other";
  await page.field("conversation").trigger("change");
  await new Promise<void>((resolve) => setImmediate(resolve));
  stale.resolve(Response.json(view));
  await click;
  assert.equal(page.field("status").textContent, "");
  assert.equal(page.field("task").hidden, true);
});

test("child answers preserve typed text during polling and reuse their request after a dropped response", async () => {
  const replies: { childId: number; questionId: string; requestId: string; answer: string }[] = [];
  const question = { childId: 7, questionId: "19", name: "Research", text: "Which month should I use?" };
  let tick = 0;
  let resolved = false;
  const device = harness((url, init) => {
    if (url.pathname.endsWith("/child-answers")) {
      assert.equal(url.pathname, "/remote/api/conversations/" + conversationId + "/child-answers");
      replies.push(JSON.parse(init.body as string));
      if (replies.length === 1) throw new TypeError("Response dropped");
      resolved = true;
      return Response.json(replies[0]);
    }
    return Response.json({ cursor: 1, messages: [], task: {
      status: "running", progress: { steps: [{ title: "Step " + ++tick, status: "running" }] },
      childQuestions: resolved ? [] : [question],
    } });
  });
  const page = await device.open();
  const questions = page.field("child-questions");
  const form = questions.children[0]!;
  assert.equal(form.children[0]!.textContent, question.name);
  assert.equal(form.children[1]!.textContent, question.text);
  const input = form.children[3]!;
  input.value = "October.";
  page.field("prompt").value = "Keep my separate message.";
  await page.poll();
  assert.equal(questions.children[0], form);
  assert.equal(input.value, "October.");
  await form.trigger("submit");
  assert.equal(input.value, "October.");
  assert.match(form.children[5]!.textContent, /retry/i);
  await form.trigger("submit");
  assert.deepEqual(replies, [
    { childId: 7, questionId: "19", requestId: replies[0]!.requestId, answer: "October." },
    replies[0],
  ]);
  assert.match(replies[0]!.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(questions.hidden, true);
  assert.equal(page.field("prompt").value, "Keep my separate message.");
});

test("an in-flight child answer leaves the newly selected conversation alone", async () => {
  const posted = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const view = { cursor: 1, messages: [], task: { status: "running", childQuestions: [
    { childId: 7, questionId: "19", name: "Research", text: "Which month?" },
  ] } };
  const device = harness(url => {
    if (url.pathname.endsWith("/child-answers")) {
      posted.resolve();
      return reply.promise;
    }
    if (url.pathname.endsWith("/other")) return Response.json({ ...view, task: null });
    return Response.json(view);
  });
  const page = await device.open();
  const questions = page.field("child-questions");
  const form = questions.children[0]!;
  form.children[3]!.value = "October.";
  const submission = form.trigger("submit");
  await posted.promise;
  page.field("conversation").value = "other";
  await page.field("conversation").trigger("change");
  await new Promise<void>(resolve => setImmediate(resolve));
  reply.resolve(Response.json({ error: "The question is closed." }, { status: 409 }));
  await submission;
  assert.equal(questions.hidden, true);
  assert.equal(questions.children.length, 0);
  assert.equal(page.field("status").textContent, "");
});

test("reload restores the pending text and retries the original message only on demand", async () => {
  const device = harness();
  const original = await device.open();
  await original.send();
  assert.equal(original.action("Retry send"), undefined);
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

test("pending content survives a new tab after authentication and stays within its pairing", async () => {
  const device = harness();
  await (await device.open()).send();
  for (const token of ["other", "phone/other-account", "phone/account/new-credential"]) {
    device.session.set("kada-device-token", token);
    const other = await device.open();
    assert.equal(other.field("uncertain").hidden, true);
    assert.equal(other.field("send").disabled, false);
    assert.ok(!other.receiptText().includes(draft));
  }
  assert.ok([...device.local].every(([key, value]) => !key.includes("new-credential") && !value.includes("new-credential")));
  device.session.clear();
  assert.equal((await device.open()).field("uncertain").hidden, true);
  device.session.set("kada-device-token", "phone");
  assert.ok((await device.open()).receiptText().includes(draft));
  assert.equal(device.messages.length, 1);
});

test("ordinary drafts retain their exact text by conversation across switching and reopening", async () => {
  const device = harness();
  const page = await device.open();
  const exact = "  北京\n第二行  ";
  await page.type(exact);
  page.field("files").value = "private-file.txt";
  page.field("conversation").value = "other";
  await page.field("conversation").trigger("change");
  assert.equal(page.field("prompt").value, "");
  assert.equal(page.field("files").value, "");
  await page.type("Other draft");
  const reopened = await device.open();
  assert.equal(reopened.field("prompt").value, "Other draft");
  reopened.field("conversation").value = conversationId;
  await reopened.field("conversation").trigger("change");
  assert.equal(reopened.field("prompt").value, exact);
  assert.equal(reopened.field("files").value, "");
  await reopened.type("");
  assert.equal((await device.open()).field("prompt").value, "");
  assert.equal(device.messages.length, 0);
});

test("two tabs send one draft once even if the first response disappears", async () => {
  const device = harness();
  device.failNext("response");
  const first = await device.open();
  await first.type(draft);
  const second = await device.open();
  assert.equal(second.field("prompt").value, draft);
  await Promise.all([first, second].map((page) => page.field("composer").trigger("submit")));
  assert.equal(device.messages.length, 1);
  assert.equal(device.messages[0]!.text, draft);
  const reopened = await device.open();
  assert.equal(reopened.field("prompt").value, "");
  assert.equal(reopened.field("uncertain").hidden, true);
  assert.ok(device.requests.includes(receiptUrl + device.messages[0]!.messageId));
});

test("a stale tab cannot overwrite or clear a newer draft", async () => {
  const device = harness();
  const first = await device.open();
  await first.type("Original");
  const stale = await device.open();
  await first.type("Saved in the first tab");
  await stale.type("Keep these local edits");
  assert.match(stale.field("status").textContent, /changed in another tab/);
  assert.equal(stale.field("prompt").value, "Keep these local edits");
  await stale.type("");
  assert.equal((await device.open()).field("prompt").value, "Saved in the first tab");
});

test("rapid input writes, including a clear, save the latest text", async () => {
  const device = harness();
  const page = await device.open();
  const writes = ["北", "北京", "", "  北京\n到达  "].map((text) => page.type(text));
  await Promise.all(writes);
  assert.equal((await device.open()).field("prompt").value, "  北京\n到达  ");
  assert.equal(page.field("status").textContent, "");
});

test("a temporary draft write failure keeps input and saves the next edit", async () => {
  const device = harness();
  const page = await device.open();
  device.failDraftWrite();
  await page.type("Keep this text");
  assert.equal(page.field("prompt").value, "Keep this text");
  assert.match(page.field("status").textContent, /storage is full or unavailable/);
  await page.type("Keep this text and finish it");
  assert.equal((await device.open()).field("prompt").value, "Keep this text and finish it");
  assert.equal(page.field("status").textContent, "");
});

test("a stale retry cannot submit the discarded message after a newer message is pending", async () => {
  const device = harness();
  await (await device.open()).send();
  const stale = await device.open();
  const retry = stale.action("Retry send")!;
  const other = await device.open();
  await other.action("Discard pending message")!.trigger("click");
  await other.type("New pending message");
  device.failNext("request");
  await other.field("composer").trigger("submit");
  assert.equal(device.messages.length, 2);
  await retry.trigger("click");
  assert.equal(device.messages.length, 2);
  assert.ok(stale.receiptText().includes("New pending message"));
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

test("a late pairing response cannot restore drafts under the wrong bearer", async () => {
  const slowSession = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const device = harness(undefined, async (token) => {
    if (token !== "slow") return;
    requested.resolve();
    await slowSession.promise;
  });
  const original = await device.open();
  await original.type("Original device draft");
  device.session.clear();
  const page = await device.open();
  page.field("token").value = "slow";
  const first = page.field("pair-form").trigger("submit");
  await requested.promise;
  page.field("token").value = "phone";
  await page.field("pair-form").trigger("submit");
  assert.equal(page.field("prompt").value, "Original device draft");
  slowSession.resolve();
  await first;
  assert.equal(page.field("connection").textContent, "phone");
  assert.equal(page.field("prompt").value, "Original device draft");
  assert.equal(device.session.get("kada-device-token"), "phone");
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

test("an existing tab migrates its old pending payload and a re-pair cannot adopt it again", async () => {
  const device = harness();
  const key = "kada:pending:account:phone";
  device.session.set(key, JSON.stringify([[conversationId, { messageId: "old-message", text: draft, attachmentIds: [] }]]));
  assert.ok((await device.open()).receiptText().includes(draft));
  assert.equal(device.session.has(key), false);
  device.session.set(key, JSON.stringify([[conversationId, { messageId: "old-message", text: draft, attachmentIds: [] }]]));
  const freshTab = await device.open();
  freshTab.field("token").value = "phone/account/new-credential";
  await freshTab.field("pair-form").trigger("submit");
  assert.equal((await device.open()).field("uncertain").hidden, true);
  assert.equal(device.messages.length, 0);
});
