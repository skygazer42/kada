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
type ApprovalFixture = (init: RequestInit, url: string) => Response | Promise<Response>;
type WorkItemsFixture = (url: string, bearer: string, init: RequestInit) => Response | Promise<Response>;
const draft = "Keep this exact draft after reconnect\nwith the attachment.";
const conversationId = "draft-conversation";
const receiptUrl = "/remote/api/conversations/" + conversationId + "?messageId=";

function harness(history?: (url: URL, init: RequestInit) => Response | Promise<Response>, sessionWait?: (token: string) => Promise<void>, list = () => Response.json([]), approvals?: { request: ApprovalFixture; confirm?: () => boolean }, workItems?: WorkItemsFixture) {
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
        confirm: approvals?.confirm ?? (() => true),
        setInterval(callback: () => Promise<void>) { poll = callback; },
        async fetch(url: string, init: RequestInit) {
          requests.push(url);
          const deviceToken = (init.headers as Record<string, string>).Authorization.slice("Bearer ".length);
          if (url === "/remote/api/push" && push) return push.request(init);
          if (url.startsWith("/remote/api/action-approvals") && approvals) return approvals.request(init, url);
          if (url.startsWith("/remote/api/work-items") && workItems) return workItems(url, deviceToken, init);
          if (url === "/remote/api/session") {
            await sessionWait?.(deviceToken);
            const [deviceId, accountId = "account"] = deviceToken.split("/");
            const pairingId = createHash("sha256").update("fixture:" + deviceToken).digest("hex");
            return Response.json({
              channel: "web", accountId, deviceId, pairingId,
              ...(approvals ? { actionApprovals: true } : {}), ...(workItems ? { workItems: true } : {}),
            });
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
  assert.ok(!device.requests.includes("/remote/api/action-approvals"));
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

test("a paired phone confirms the displayed action before allowing it and can only deny an expired action", async () => {
  const action = {
    taskId: "local-task", approvalId: "7", tool: "append", connection: "fixture",
    argumentsPreview: '{"text":"<b>shared</b>"}', digest: "a".repeat(64), status: "pending", expiresAt: Date.now() + 60_000,
  };
  const expired = { ...action, approvalId: "8", digest: "b".repeat(64), status: "expired", expiresAt: Date.now() - 60_000 };
  let rows = [action, expired];
  let confirmed = false;
  const decisions: unknown[] = [];
  const device = harness(undefined, undefined, undefined, {
    confirm: () => confirmed,
    request(init, url) {
      if (init.method !== "POST") return Response.json(rows);
      const id = url.split("/").pop();
      const decision = JSON.parse(init.body as string);
      decisions.push({ url, ...decision });
      rows = rows.filter(row => row.approvalId !== id);
      return Response.json({ id, decision: decision.decision });
    },
  });
  const page = await device.open();
  const list = page.field("approval-list");
  const controls = (row: Element) => row.children.at(-1)!.children;
  assert.equal(page.field("action-approvals").hidden, false);
  assert.ok(list.children[0]!.children.some(child => child.textContent === action.argumentsPreview));
  assert.deepEqual(controls(list.children[1]!).map(button => button.textContent), ["Deny"]);
  const allow = controls(list.children[0]!).find(button => button.textContent === "Allow once")!;
  await allow.trigger("click");
  assert.deepEqual(decisions, []);
  confirmed = true;
  await allow.trigger("click");
  await controls(list.children[0]!)[0]!.trigger("click");
  assert.deepEqual(decisions, [
    { url: "/remote/api/action-approvals/local-task/7", decision: "allow", digest: action.digest },
    { url: "/remote/api/action-approvals/local-task/8", decision: "deny", digest: expired.digest },
  ]);
  assert.equal(page.field("action-approvals").hidden, true);
});

test("late approval lists and decisions cannot change a replacement pairing", async () => {
  const action = {
    taskId: "local-task", approvalId: "7", tool: "append", connection: "fixture",
    argumentsPreview: '{}', digest: "a".repeat(64), status: "pending", expiresAt: Date.now() + 60_000,
  };
  const staleList = Promise.withResolvers<Response>();
  const staleDecision = Promise.withResolvers<Response>();
  let deferList = false;
  const device = harness(undefined, undefined, undefined, {
    request(init) {
      if ((init.headers as Record<string, string>).Authorization !== "Bearer phone") return Response.json([]);
      if (init.method === "POST") return staleDecision.promise;
      return deferList ? staleList.promise : Response.json([action]);
    },
  });
  const page = await device.open();
  const list = page.field("approval-list");
  const oldAllow = list.children[0]?.children.at(-1)?.children.find(button => button.textContent === "Allow once");
  assert.ok(oldAllow);
  const deciding = oldAllow.trigger("click");
  deferList = true;
  const refreshing = page.field("refresh-conversations").trigger("click");
  page.field("token").value = "replacement/account";
  await page.field("pair-form").trigger("submit");
  staleList.resolve(Response.json([action]));
  staleDecision.resolve(Response.json({ error: "Old pairing response." }, { status: 409 }));
  await Promise.all([deciding, refreshing]);
  assert.equal(page.field("connection").textContent, "replacement");
  assert.equal(page.field("action-approvals").hidden, true);
  assert.deepEqual(list.children, []);
  assert.equal(page.field("status").textContent, "");
});

const workItemsUrl = "/remote/api/work-items";
const workItemRow = { id: "release-notes", title: "Release notes", revision: 2, updatedAt: 10 };

function visibleText(node: Element): string {
  return [node.textContent, ...node.children.map(visibleText)].join(" ");
}

test("shared work items display their revision and run status without changing conversations", async () => {
  let shared = true;
  const page = await harness(undefined, undefined, undefined, undefined, (url) => {
    if (url === workItemsUrl) return Response.json(shared ? [workItemRow] : []);
    return Response.json({ ...workItemRow, objective: "Prepare the next release", runs: [
      { id: "current", revision: 2, status: "waiting_user", question: "Which version?" },
      { id: "previous", revision: 1, status: "completed", summary: "Notes drafted." },
    ] });
  }).open();
  await page.type("Keep this draft");
  assert.equal(page.field("shared-work-items").hidden, false);
  const item = page.field("work-item-list").children[0]!.children[0]!;
  assert.match(item.textContent, /Release notes.*Revision 2/);
  await item.trigger("click");
  const detail = page.field("work-item-detail");
  assert.match(visibleText(detail), /Prepare the next release.*Waiting for you.*Which version\?.*Completed.*Notes drafted\./);
  assert.equal(page.field("prompt").value, "Keep this draft");
  shared = false;
  await page.field("refresh-conversations").trigger("click");
  assert.equal(page.field("shared-work-items").hidden, true);
  assert.deepEqual(detail.children, []);
});

test("a late work item detail cannot restore revoked data after a list refresh", async () => {
  const delayed = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  let shared = true;
  const page = await harness(undefined, undefined, undefined, undefined, (url) => {
    if (url === workItemsUrl) return Response.json(shared ? [workItemRow] : []);
    requested.resolve();
    return delayed.promise;
  }).open();
  const opening = page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  await requested.promise;
  shared = false;
  await page.field("refresh-conversations").trigger("click");
  delayed.resolve(Response.json({ ...workItemRow, objective: "Revoked objective", runs: [] }));
  await opening;
  assert.equal(page.field("shared-work-items").hidden, true);
  assert.deepEqual(page.field("work-item-detail").children, []);
});

test("opening a shared run shows its original goal and steps without switching chats", async () => {
  const itemPath = workItemsUrl + "/" + workItemRow.id;
  const device = harness(undefined, undefined, undefined, undefined, (url) => {
    if (url === workItemsUrl) return Response.json([workItemRow]);
    if (url === itemPath) return Response.json({ ...workItemRow, objective: "Current work-item goal", runs: [
      { id: "previous", revision: 1, status: "running", question: "Which date?" },
    ] });
    assert.equal(url, itemPath + "/runs/previous");
    return Response.json({ id: "previous", revision: 1, status: "running", objective: "Original run goal",
      steps: [{ id: "draft", title: "Draft the notes", status: "done" }],
      childQuestions: [{ name: "Reviewer", text: "Which date?" }],
    });
  });
  const page = await device.open();
  const selectedConversation = page.field("conversations").value;
  const conversationRequests = device.requests.filter(url => url.startsWith("/remote/api/conversations/"));
  await page.type("Keep this chat draft");
  await page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  const detail = page.field("work-item-detail");
  const run = detail.children[2]!.children[0]!.children[0]!;
  await run.trigger("click");
  assert.match(visibleText(detail), /Current work-item goal.*Original run goal.*Draft the notes.*Done.*Reviewer.*Which date\?/);
  assert.equal(page.field("conversations").value, selectedConversation);
  assert.deepEqual(device.requests.filter(url => url.startsWith("/remote/api/conversations/")), conversationRequests);
  assert.equal(page.field("prompt").value, "Keep this chat draft");
});

test("a late shared run response cannot restore a revoked work item", async () => {
  const delayed = Promise.withResolvers<Response>();
  const requested = Promise.withResolvers<void>();
  let shared = true;
  const page = await harness(undefined, undefined, undefined, undefined, (url) => {
    if (url === workItemsUrl) return Response.json(shared ? [workItemRow] : []);
    if (url.endsWith("/runs/current")) {
      requested.resolve();
      return delayed.promise;
    }
    return Response.json({ ...workItemRow, objective: "Work-item goal", runs: [
      { id: "current", revision: 2, status: "waiting_user" },
    ] });
  }).open();
  await page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  const detail = page.field("work-item-detail");
  const opening = detail.children[2]!.children[0]!.children[0]!.trigger("click");
  await Promise.race([requested.promise, opening]);
  shared = false;
  await page.field("refresh-conversations").trigger("click");
  delayed.resolve(Response.json({ objective: "Revoked run goal", steps: [], childQuestions: [] }));
  await opening;
  assert.equal(page.field("shared-work-items").hidden, true);
  assert.deepEqual(detail.children, []);
});

test("shared run answers preserve the original request on retry and leave chat drafts intact", async () => {
  const itemPath = workItemsUrl + "/" + workItemRow.id;
  const runPath = itemPath + "/runs/original";
  const version = "a".repeat(64);
  const answers: object[] = [];
  let answered = false;
  const device = harness(undefined, undefined, undefined, undefined, (url, _bearer, init) => {
    if (url === workItemsUrl) return Response.json([workItemRow]);
    if (url === itemPath) return Response.json({ ...workItemRow, objective: "Updated work item", runs: [
      { id: "original", revision: 1, status: answered ? "running" : "waiting_user", question: answered ? null : "Which date?" },
    ] });
    if (url === runPath) return Response.json({ id: "original", revision: 1, objective: "Original goal",
      status: answered ? "running" : "waiting_user", question: answered ? null : "Which date?",
      steps: [], childQuestions: [], answerVersion: answered ? null : version,
    });
    assert.equal(url, runPath + "/answers");
    assert.equal(init.method, "POST");
    answers.push(JSON.parse(init.body as string));
    if (answers.length === 1) throw new TypeError("Answer response lost");
    answered = true;
    return Response.json({ requestId: (answers[1] as { requestId: string }).requestId });
  });
  const page = await device.open();
  await page.type("Keep my chat draft");
  await page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  const detail = page.field("work-item-detail");
  await detail.children[2]!.children[0]!.children[0]!.trigger("click");
  const form = detail.children[2]!.children[0]!.children.at(-1)!.children.at(-1)!;
  const input = form.children[1]!;
  assert.ok(input, "The shared question needs an answer input.");
  input.value = "Use November 25.";
  await page.field("refresh-conversations").trigger("click");
  const restored = detail.children[2]!.children[0]!.children.at(-1)!.children.at(-1)!;
  assert.equal(restored, form);
  assert.equal(input.value, "Use November 25.");
  await form.trigger("submit");
  assert.match(visibleText(form), /Retry answer/);
  assert.equal(input.value, "Use November 25.");
  await form.trigger("submit");
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[0], { requestId: (answers[0] as { requestId: string }).requestId,
    answer: "Use November 25.", version });
  assert.equal(page.field("prompt").value, "Keep my chat draft");
  assert.match(visibleText(detail), /Running/);
});

test("shared child answers keep their draft through run controls and retry the same worker without changing chats", async () => {
  const itemPath = workItemsUrl + "/" + workItemRow.id, runPath = itemPath + "/runs/original";
  let state = "running", answered = false;
  const replies: object[] = [], controls: object[] = [];
  let allowCancel = false;
  const device = harness(undefined, undefined, undefined, { request: () => Response.json([]), confirm: () => allowCancel }, (url, _bearer, init) => {
    if (url === workItemsUrl) return Response.json([workItemRow]);
    if (url === itemPath) return Response.json({ ...workItemRow, objective: "Work-item goal", runs: [{ id: "original", revision: 1, status: state }] });
    if (url === runPath) return Response.json({ id: "original", revision: 1, status: state, objective: "Original run goal", steps: [],
      childQuestions: state === "running" && !answered ? [{ name: "Currency worker", text: "Which currency?", childId: 2, questionId: "7" }] : [],
      controls: state === "running" ? ["pause", "cancel"] : state === "paused" ? ["continue", "cancel"] : [],
      controlVersion: (state === "paused" ? "b" : "a").repeat(64),
    });
    const body = JSON.parse(init.body as string);
    if (url === runPath + "/control") {
      controls.push(body);
      state = body.action === "pause" ? "paused" : body.action === "continue" ? "running" : "cancelled";
      return Response.json({ updated: true });
    }
    assert.equal(url, runPath + "/child-answers");
    replies.push(body);
    if (replies.length === 1) throw new TypeError("Child answer response lost");
    answered = true;
    return Response.json({ childId: 2, questionId: "7", requestId: body.requestId });
  });
  const page = await device.open();
  await page.type("Keep my chat draft");
  await page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  const detail = page.field("work-item-detail");
  await detail.children[2]!.children[0]!.children[0]!.trigger("click");
  const panel = () => detail.children[2]!.children[0]!.children.at(-1)!;
  const button = (label: string) => panel().children.flatMap(row => row.children).find(node => node.textContent === label);
  const form = panel().children.at(-1)!;
  assert.equal(form.children[0]?.textContent, "Answer Currency worker");
  assert.ok(form.children[1], "A shared child question needs an answer input.");
  const input = form.children[1]!;
  input.value = "Use USD.";
  assert.ok(button("Pause"), "A separately authorized run needs a pause action.");
  await button("Pause")!.trigger("click");
  assert.deepEqual(controls[0], { action: "pause", version: "a".repeat(64) });
  await button("Continue")!.trigger("click");
  assert.deepEqual(controls[1], { action: "continue", version: "b".repeat(64) });
  assert.equal(panel().children.at(-1), form);
  assert.equal(input.value, "Use USD.");
  await form.trigger("submit");
  assert.match(visibleText(form), /Retry answer/);
  await page.field("refresh-conversations").trigger("click");
  assert.equal(panel().children.at(-1), form);
  await form.trigger("submit");
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[1], replies[0]);
  assert.deepEqual(replies[0], { childId: 2, questionId: "7", requestId: (replies[0] as { requestId: string }).requestId, answer: "Use USD." });
  assert.equal(page.field("prompt").value, "Keep my chat draft");
  await button("Cancel task")!.trigger("click");
  assert.equal(controls.length, 2);
  allowCancel = true;
  await button("Cancel task")!.trigger("click");
  assert.match(visibleText(detail), /Cancelled/);
  assert.equal(page.field("prompt").value, "Keep my chat draft");
});

test("refreshing a shared run during control delivery unlocks its latest controls after the response", async () => {
  const itemPath = workItemsUrl + "/" + workItemRow.id, runPath = itemPath + "/runs/original";
  const requested = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  let paused = false;
  const page = await harness(undefined, undefined, undefined, undefined, (url) => {
    if (url === workItemsUrl) return Response.json([workItemRow]);
    if (url === itemPath) return Response.json({ ...workItemRow, objective: "Work-item goal", runs: [{ id: "original", revision: 1, status: paused ? "paused" : "running" }] });
    if (url === runPath) return Response.json({ id: "original", revision: 1, status: paused ? "paused" : "running", objective: "Original run goal", steps: [], childQuestions: [],
      controls: paused ? ["continue", "cancel"] : ["pause", "cancel"], controlVersion: "a".repeat(64),
    });
    assert.equal(url, runPath + "/control");
    requested.resolve();
    return response.promise;
  }).open();
  await page.field("work-item-list").children[0]!.children[0]!.trigger("click");
  const detail = page.field("work-item-detail");
  await detail.children[2]!.children[0]!.children[0]!.trigger("click");
  const buttons = () => detail.children[2]!.children[0]!.children.at(-1)!.children.flatMap(row => row.children);
  const stopping = buttons().find(button => button.textContent === "Pause")!.trigger("click");
  await requested.promise;
  await page.field("refresh-conversations").trigger("click");
  assert.equal(buttons().find(button => button.textContent === "Pause")?.disabled, true);
  paused = true;
  response.resolve(Response.json({ updated: true }));
  await stopping;
  assert.equal(buttons().find(button => button.textContent === "Continue")?.disabled, false);
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

test("a phone stop targets the selected child and keeps its sibling and draft visible", async () => {
  const research = { childId: 7, name: "Research" };
  const review = { childId: 8, name: "Review" };
  const requests: unknown[] = [];
  const posted = Promise.withResolvers<void>();
  const stop = Promise.withResolvers<Response>();
  let tick = 0;
  let stopped = false;
  const device = harness((url, init) => {
    if (url.pathname.endsWith("/child-stop")) {
      assert.equal(url.pathname, "/remote/api/conversations/" + conversationId + "/child-stop");
      assert.equal(init.method, "POST");
      requests.push(JSON.parse(init.body as string));
      posted.resolve();
      return stop.promise;
    }
    return Response.json({ cursor: 1, messages: [], task: {
      status: "running", progress: { steps: [{ title: "Step " + ++tick, status: "running" }] },
      stoppableChildren: stopped ? [review] : [research, review],
    } });
  });
  const page = await device.open();
  const button = (name: string) => page.field("task").children.flatMap(row => row.children)
    .find(child => child.textContent === "Stop " + name);
  assert.ok(button(research.name));
  page.field("prompt").value = "Keep my separate message.";
  const click = button(research.name)!.trigger("click");
  await posted.promise;
  await page.poll();
  assert.equal(button(research.name)?.disabled, true);
  assert.equal(button(review.name)?.disabled, false);
  stopped = true;
  stop.resolve(Response.json({ result: "stopped" }));
  await click;
  assert.deepEqual(requests, [{ childId: 7 }]);
  assert.equal(button(research.name), undefined);
  assert.ok(button(review.name));
  assert.equal(page.field("prompt").value, "Keep my separate message.");
});

test("a pending child tool interruption stays bound to the displayed call as polling reveals its replacement", async () => {
  const first = { childId: 7, childName: "Research", toolTaskId: 19, toolName: "read" };
  const replacement = { ...first, toolTaskId: 20 };
  const posted = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<Response>();
  const requests: unknown[] = [];
  let call = first;
  const device = harness((url, init) => {
    if (url.pathname.endsWith("/child-interrupt")) {
      assert.equal(url.pathname, "/remote/api/conversations/" + conversationId + "/child-interrupt");
      assert.equal(init.method, "POST");
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 2) return Response.json({ childId: 7, interrupted: 0, pending: 1 });
      posted.resolve();
      return interrupted.promise;
    }
    return Response.json({ cursor: 1, messages: [], task: {
      status: "running", interruptibleChildTools: [call], stoppableChildren: [{ childId: 7, name: "Research" }],
    } });
  });
  const page = await device.open();
  const button = (label: string) => page.field("task").children.flatMap(row => row.children)
    .find(child => child.textContent === label);
  const firstButton = button("Interrupt read in Research");
  assert.ok(firstButton);
  const click = firstButton.trigger("click");
  await posted.promise;
  assert.equal(firstButton.disabled, true);
  call = replacement;
  await page.poll();
  const replacementButton = button("Interrupt read in Research");
  assert.ok(replacementButton && replacementButton !== firstButton);
  assert.equal(replacementButton.disabled, false);
  interrupted.resolve(Response.json({ error: "This tool call is no longer running." }, { status: 409 }));
  await click;
  await firstButton.trigger("click");
  assert.deepEqual(requests, [{ childId: 7, toolTaskId: 19 }]);
  assert.equal(button("Interrupt read in Research"), replacementButton);
  assert.ok(button("Stop Research"));
  assert.match(page.field("status").textContent, /no longer running/);
  await replacementButton.trigger("click");
  assert.deepEqual(requests, [{ childId: 7, toolTaskId: 19 }, { childId: 7, toolTaskId: 20 }]);
  assert.match(page.field("status").textContent, /still stopping/);
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
