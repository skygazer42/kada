export const remotePage = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kada</title>
  <link rel="manifest" href="/remote/manifest.webmanifest">
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; color: #221c30; background: #f8f6fc; --line: #ded8e9; --muted: #65596f; --accent: #593ba3; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, textarea, select, input { font: inherit; }
    button, select, input, textarea { border: 1px solid var(--line); border-radius: 10px; }
    button { min-height: 44px; padding: .55rem .85rem; background: #fff; color: inherit; cursor: pointer; }
    button:disabled { opacity: .55; cursor: wait; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 650; }
    :focus-visible { outline: 3px solid #8865ce; outline-offset: 2px; }
    [hidden] { display: none !important; }
    main { width: min(100% - 2rem, 46rem); margin: auto; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 0; gap: 1rem; }
    h1 { font-size: 1.45rem; margin: 0; }
    h2 { margin: 0 0 .55rem; font-size: 1.1rem; }
    h3 { margin: 0 0 .3rem; font-size: 1rem; }
    p { margin: 0; }
    section, article { margin-bottom: .75rem; }
    .panel { border: 1px solid var(--line); padding: 1rem; background: #fff; border-radius: 14px; }
    .controls { display: flex; align-items: end; gap: .5rem; margin-bottom: .75rem; }
    .child-actions { flex-wrap: wrap; }
    #conversation-field { flex: 1; min-width: 0; }
    label { display: block; font-size: .92rem; font-weight: 650; }
    select, input:not([type=file]), textarea { display: block; margin-top: .3rem; width: 100%; min-height: 44px; padding: .66rem .75rem; background: #fff; color: inherit; }
    #status, #connection { color: var(--muted); font-size: .9rem; }
    #status { min-height: 1.4rem; margin: .25rem 0 .5rem; overflow-wrap: anywhere; }
    #connection { text-align: right; overflow-wrap: anywhere; }
    #pair { max-width: 31rem; margin: 4vh auto 0; }
    #pair button { margin-top: .7rem; }
    #signout { padding-inline: .7rem; }
    #messages { display: grid; gap: .6rem; }
    .message { margin: 0; padding: .75rem 1rem; border-radius: 12px; overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.5; }
    .message-user { background: #ede6fb; margin-left: min(8vw, 3rem); }
    .message-assistant { background: #fff; box-shadow: inset 0 0 0 1px var(--line); margin-right: min(8vw, 3rem); }
    .speaker { color: var(--muted); font-size: .78rem; font-weight: 700; }
    .message-attachments { display: grid; gap: .5rem; margin: .65rem 0 0; padding: 0; list-style: none; }
    .message-attachments li { padding: .6rem; background: #fff; border: 1px solid var(--line); border-radius: 10px; }
    .attachment-actions { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .35rem; }
    .attachment-preview img { display: block; max-width: 100%; max-height: 60vh; margin-top: .4rem; }
    .attachment-preview pre { max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    .task { background: #e9f7f0; border-color: #cce6d7; overflow-wrap: anywhere; }
    .task p + p, .task button, .task h3 { margin-top: .55rem; }
    .task ol, .task ul { margin: .3rem 0 0; padding-left: 1.4rem; }
    .task li { margin-top: .3rem; }
    .task li button { text-align: left; max-width: 100%; overflow-wrap: anywhere; }
    #child-questions form + form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
    #child-questions label { margin-top: .55rem; }
    #pending-tasks { display: grid; gap: .4rem; list-style: none; margin: 0; padding: 0; }
    #pending-tasks button { width: 100%; text-align: left; overflow-wrap: anywhere; }
    .receipt { margin-top: .5rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem; }
    .receipt .pending-message { flex-basis: 100%; overflow-wrap: anywhere; white-space: pre-wrap; }
    #composer { margin-bottom: 1.5rem; }
    textarea { min-height: 6rem; line-height: 1.4; resize: vertical; }
    .compose-actions { display: flex; align-items: center; gap: .5rem; margin-top: .7rem; flex-wrap: wrap; }
    #file-label { display: flex; align-items: center; min-height: 44px; border: 1px solid var(--line); border-radius: 10px; padding: .7rem .8rem; cursor: pointer; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    #file-label:focus-within { outline: 3px solid #8865ce; outline-offset: 2px; }
    #file-names { flex: 1; min-width: 5rem; color: var(--muted); font-size: .87rem; overflow-wrap: anywhere; }
    @media (max-width: 420px) {
      main { width: calc(100% - 1rem); }
      .panel { padding: .8rem; }
      select, input:not([type=file]), textarea { font-size: 1rem; }
    }
  </style>
  <script src="/remote/app.js" defer></script>
</head>
<body>
  <main>
    <header><h1>Kada</h1><p id="connection" hidden></p><button type="button" id="signout" hidden>Sign out</button></header>
    <p id="status" role="status" aria-live="polite"></p>
    <section class="panel" id="pair" hidden>
      <h2>Pair this device</h2>
      <form id="pair-form">
        <label for="token">Device pairing token</label>
        <input id="token" type="password" required autocomplete="off" spellcheck="false" autocapitalize="off">
        <button class="primary">Connect</button>
      </form>
    </section>
    <div id="assistant" hidden>
      <div class="controls">
        <label id="conversation-field" for="conversation">Conversation<select id="conversation"></select></label>
        <button type="button" id="refresh-conversations" aria-label="Refresh conversations">Refresh</button>
        <button type="button" id="new">New chat</button>
      </div>
      <button type="button" id="task-notifications" hidden>Enable task notifications</button>
      <section id="pending-work" class="panel" hidden aria-labelledby="pending-heading">
        <h2 id="pending-heading">Pending work</h2>
        <ul id="pending-tasks"></ul>
      </section>
      <section id="task" class="panel task" hidden aria-label="Task progress"></section>
      <section id="child-questions" class="panel task" hidden aria-label="Child task questions"></section>
      <details id="task-history" class="panel task" hidden>
        <summary>Task history</summary>
        <ol id="task-events"></ol>
      </details>
      <section id="messages" role="log" aria-label="Conversation messages"></section>
      <section id="uncertain" class="panel receipt" hidden aria-label="Message receipt"></section>
      <form id="composer" class="panel">
        <label for="prompt">Message</label>
        <textarea id="prompt" placeholder="What would you like Kada to do?" maxlength="12000"></textarea>
        <div class="compose-actions">
          <label id="file-label" for="files">Attach files<input class="visually-hidden" id="files" type="file" multiple aria-describedby="file-names"></label>
          <span id="file-names">Up to 4 files, 5 MB each</span>
          <button class="primary" id="send">Send</button>
        </div>
      </form>
    </div>
  </main>
</body>
</html>`;

export const remoteScript = String.raw`
"use strict";

const field = (id) => document.getElementById(id);
const pair = field("pair");
const assistant = field("assistant");
const signout = field("signout");
const notifications = field("task-notifications");
const status = field("status");
const conversations = field("conversation");
const pendingWork = field("pending-work");
const pendingTasks = field("pending-tasks");
const task = field("task");
const childQuestions = field("child-questions");
const taskHistory = field("task-history");
const taskEvents = field("task-events");
const messages = field("messages");
const uncertain = field("uncertain");
const prompt = field("prompt");
const fileInput = field("files");
const send = field("send");

let token = sessionStorage.getItem("kada-device-token") || "";
let identity = null;
let connectionAttempt = 0;
let conversationId = "";
let pending;
let editor = { draft: undefined, saving: Promise.resolve() };
let busy = false;
let canSend = true;
let refreshVersion = 0;
let listVersion = 0;
let historyCursor = null;
let shownTask = "";
const childAnswerForms = new Map();
const pendingChildActions = new Map();
let disconnected = false;
let pushSettings;

function bookKey() { return "kada:composer:" + identity.pairingId; }
function selectionKey() { return "kada:conversation:" + identity.pairingId; }

function composerRecords(key = bookKey()) {
  return new Map(JSON.parse(localStorage.getItem(key) || "[]"));
}

async function changeComposer(change, key = bookKey()) {
  if (!navigator.locks) throw new RequestError(409, "This browser cannot safely save or send drafts. Use a browser that supports Web Locks.");
  return navigator.locks.request(key, () => {
    const records = composerRecords(key);
    const result = change(records);
    try {
      if (records.size) localStorage.setItem(key, JSON.stringify([...records]));
      else localStorage.removeItem(key);
    } catch {
      throw new RequestError(409, "Browser storage is full or unavailable. Keep this page open and copy your draft before leaving.");
    }
    return result;
  });
}

function restoreComposer() {
  const record = composerRecords().get(conversationId);
  pending = record?.state === "pending" ? record : undefined;
  editor = { draft: record?.state === "draft" ? record : undefined, saving: Promise.resolve() };
  prompt.value = editor.draft?.text ?? "";
  fileInput.value = "";
  selectFiles();
}

async function migratePending(value, candidate) {
  if (sessionStorage.getItem("kada-device-token") !== value || sessionStorage.getItem("kada-composer-pairing")) return;
  const key = ["kada", "pending", candidate.accountId, candidate.deviceId].join(":");
  const legacy = JSON.parse(localStorage.getItem(key) || "[]");
  const saved = JSON.parse(sessionStorage.getItem(key) || "[]");
  if (!legacy.length && !saved.length) return;
  await changeComposer((records) => {
    for (const [id, message] of [...saved, ...legacy.map(([id, messageId]) => [id, { messageId }])]) {
      if (!records.has(id)) records.set(id, { ...message, state: "pending" });
    }
  }, "kada:composer:" + candidate.pairingId);
  sessionStorage.removeItem(key);
  localStorage.removeItem(key);
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(path, init = {}, bearer = token) {
  const response = await fetch("/remote/api" + path, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: { Authorization: "Bearer " + bearer, ...init.headers },
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({}));
    throw new RequestError(response.status, failure.error || "The request failed.");
  }
  return response;
}

async function get(path) { return (await request(path)).json(); }

async function post(path, value) {
  return (await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  })).json();
}

function report(error) {
  disconnected = !(error instanceof RequestError);
  status.textContent = error instanceof RequestError ? error.message : "The connection dropped. Reconnect to check your conversation.";
}

async function refreshPushSettings(device) {
  if (!navigator.serviceWorker || typeof PushManager === "undefined" || typeof Notification === "undefined") return;
  try {
    const settings = await get("/push");
    if (identity !== device) return;
    pushSettings = settings;
    notifications.hidden = !settings.publicKey;
    notifications.textContent = settings.subscribed ? "Disable task notifications" : "Enable task notifications";
  } catch {
    if (identity === device) notifications.hidden = true;
  }
}

function element(tag, text, container) {
  const node = document.createElement(tag);
  node.textContent = text;
  container.append(node);
  return node;
}

function action(text, container, run) {
  const button = element("button", text, container);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await run(); }
    catch (error) { report(error); }
    finally { button.disabled = false; }
  });
  return button;
}

function conversationPath(id = conversationId) { return "/conversations/" + encodeURIComponent(id); }

function addLocalConversation(id, record) {
  const title = record?.state === "draft" ? "Unsent conversation" : record ? "Pending conversation" : "New conversation";
  const option = element("option", title, conversations);
  option.value = id;
  if (!record) option.dataset.emptyConversation = "true";
}

function choose(id) {
  conversationId = id || crypto.randomUUID();
  localStorage.setItem(selectionKey(), conversationId);
  const empty = conversations.querySelector("[data-empty-conversation]");
  if (empty && empty.value !== conversationId) {
    const record = composerRecords().get(empty.value);
    empty.remove();
    if (record) addLocalConversation(empty.value, record);
  }
  conversations.value = conversationId;
  if (!conversations.value) {
    addLocalConversation(conversationId, composerRecords().get(conversationId));
    conversations.value = conversationId;
  }
  resetConversationView();
  restoreComposer();
  refresh().catch(report);
  updateComposer();
}

function resetConversationView() {
  refreshVersion++;
  canSend = true;
  historyCursor = null;
  shownTask = "";
  messages.replaceChildren();
  taskEvents.replaceChildren();
  taskHistory.hidden = true;
  taskHistory.open = false;
  task.replaceChildren();
  task.hidden = true;
  childQuestions.replaceChildren();
  childQuestions.hidden = true;
  uncertain.hidden = true;
  uncertain.replaceChildren();
}

async function refreshList() {
  const version = ++listVersion;
  const rows = await get("/conversations");
  if (version !== listVersion || !identity) return;
  conversations.replaceChildren();
  pendingTasks.replaceChildren();
  for (const row of rows) {
    const state = row.task && taskStatusLabel(row.task.status);
    const reason = row.task?.question ?? row.task?.reason;
    const option = element("option", [state, row.title, reason].filter(Boolean).join(" · "), conversations);
    option.value = row.conversationId;
    if (row.task?.group === "pending") {
      const item = element("li", "", pendingTasks);
      action([row.title, state].filter(Boolean).join(" · "), item, () => {
        if (conversationId !== row.conversationId) choose(row.conversationId);
      });
    }
  }
  pendingWork.hidden = !pendingTasks.children.length;
  for (const [id, record] of composerRecords()) {
    if (rows.some((row) => row.conversationId === id)) continue;
    addLocalConversation(id, record);
  }
  const hash = location.hash;
  const link = /^#conversation=([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?:&pairing=([a-f0-9]{64}))?$/.exec(hash);
  const linked = link && (!link[2] || link[2] === identity.pairingId) && rows.find(row => row.conversationId === link[1]);
  if (hash.startsWith("#conversation=")) {
    history.replaceState(history.state, "", location.pathname + location.search);
    if (!linked) status.textContent = "This conversation is unavailable on this device.";
  }
  const selected = linked?.conversationId || conversationId || rows[0]?.conversationId;
  if (!selected) return choose("");
  if (selected !== conversationId) return choose(selected);
  conversations.value = selected;
  if (!conversations.value) {
    addLocalConversation(selected);
    conversations.value = selected;
  }
}

function updateComposer() {
  send.disabled = !canSend || busy || Boolean(pending);
  fileInput.disabled = send.disabled;
  prompt.readOnly = send.disabled;
}

function displayReceipt(receipt, checked = false) {
  const id = conversationId;
  const message = pending;
  const canRetry = Boolean(checked && receipt.state === "unknown" && message?.attachmentIds);
  const key = id + "/" + message?.messageId + "/" + receipt.state + "/" + canRetry;
  if (!uncertain.hidden && uncertain.dataset.receipt === key) return;
  uncertain.dataset.receipt = key;
  uncertain.hidden = false;
  uncertain.replaceChildren();
  const copy = {
    unknown: "Delivery is uncertain.",
    interrupted: "The original message was interrupted.",
    accepted: "The message was received and is starting.",
  }[receipt.state] || "The message reached the original conversation.";
  element("span", copy, uncertain);
  if (message?.text) element("p", message.text, uncertain).classList.add("pending-message");
  const attachments = message?.attachmentIds?.length;
  if (attachments) element("span", attachments + (attachments === 1 ? " attachment" : " attachments"), uncertain);
  if (receipt.state === "unknown" || receipt.state === "accepted") {
    action("Check delivery", uncertain, async () => { await checkReceipt(); });
  }
  if (canRetry) {
    action("Retry send", uncertain, async () => {
      if (busy || !canSend || conversationId !== id || pending !== message) return;
      await whileSending(async () => {
        if ((await checkReceipt())?.state === "unknown" && pending?.messageId === message.messageId &&
          composerRecords().get(id)?.messageId === message.messageId) await sendPending(id, message);
      });
    }).classList.add("primary");
  }
  if (receipt.state === "unknown" || receipt.state === "interrupted") {
    action(message?.attachmentIds ? "Discard pending message" : "Dismiss", uncertain, async () => {
      if (busy || conversationId !== id || pending !== message) return;
      await settlePending(message);
    });
  }
}

async function settlePending(message, restore = false) {
  const id = conversationId;
  const device = identity;
  const restored = restore && message.text ? { state: "draft", messageId: crypto.randomUUID(), text: message.text } : undefined;
  const changed = await changeComposer((records) => {
    const current = records.get(id);
    if (current?.state !== "pending" || current.messageId !== message.messageId) return false;
    if (restored) records.set(id, restored);
    else records.delete(id);
    return true;
  });
  if (device !== identity || id !== conversationId || pending !== message) return;
  if (changed && restored) {
    editor.draft = restored;
    prompt.value = restored.text;
  }
  pending = undefined;
  uncertain.hidden = true;
  updateComposer();
}

async function checkReceipt() {
  const id = conversationId;
  const device = identity;
  const record = composerRecords().get(id);
  if (record?.state === "pending" && pending?.messageId !== record.messageId) {
    pending = record;
    if (editor.draft?.messageId === record.messageId && prompt.value === record.text) { editor.draft = undefined; prompt.value = ""; }
    updateComposer();
  } else if (record?.state !== "pending" && pending) {
    pending = undefined;
    updateComposer();
  }
  const message = pending;
  if (!message) {
    uncertain.hidden = true;
    return;
  }
  const receipt = await get(conversationPath(id) + "?messageId=" + encodeURIComponent(message.messageId));
  if (device !== identity || id !== conversationId || pending !== message) return;
  if (receipt.state === "submitted") {
    await settlePending(message);
    if (device !== identity || id !== conversationId) return;
    await refreshList();
    return;
  }
  displayReceipt(receipt, true);
  return receipt;
}

async function download(artifact, container) {
  const href = artifact.href.replace(/^\/remote\/api/, "");
  const response = await request(href);
  if (artifact.kind === "directory") {
    const directory = await response.json();
    const list = document.createElement("ul");
    for (const file of directory.files) {
      const row = element("li", "", list);
      action(file.path, row, () => download({ ...file, name: file.path.split(/[\\/]/).at(-1) }, row));
    }
    if (!directory.files.length) element("li", "Empty directory", list);
    container.querySelector("ul")?.remove();
    container.append(list);
    return;
  }
  const hrefBlob = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = hrefBlob;
  link.download = artifact.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(hrefBlob), 1000);
}

function presentAttachments(attachments, article) {
  const list = element("ul", "", article);
  list.className = "message-attachments";
  for (const attachment of attachments) {
    const card = element("li", "", list);
    element("p", attachment.name, card);
    const controls = element("div", "", card);
    controls.className = "attachment-actions";
    const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.type);
    const text = attachment.type.startsWith("text/") || attachment.type === "application/json";
    if (image || text) {
      const preview = element("div", "", card);
      preview.className = "attachment-preview";
      const button = action("Preview", controls, async () => {
        if (preview.children.length) {
          preview.replaceChildren();
          button.textContent = "Preview";
          button.setAttribute("aria-expanded", "false");
          return;
        }
        const response = await request(attachment.href.replace(/^\/remote\/api/, ""));
        const blob = await response.blob();
        if (image) {
          const picture = element("img", "", preview);
          const href = URL.createObjectURL(new Blob([blob], { type: attachment.type }));
          picture.alt = attachment.name;
          picture.addEventListener("load", () => URL.revokeObjectURL(href), { once: true });
          picture.addEventListener("error", () => {
            URL.revokeObjectURL(href);
            preview.replaceChildren();
            element("p", "The image preview could not be opened.", preview);
          }, { once: true });
          picture.src = href;
        } else {
          const limit = 64 * 1024;
          element("pre", await blob.slice(0, limit).text(), preview);
          if (blob.size > limit) element("p", "Preview shows the first 64 KiB. Download to open the full file.", preview);
        }
        button.textContent = "Hide preview";
        button.setAttribute("aria-expanded", "true");
      });
      button.setAttribute("aria-expanded", "false");
    }
    action("Download", controls, () => download(attachment, card));
  }
}

function taskStatusLabel(status) {
  const labels = {
    pending: "Pending", running: "Running", working: "Working", clarifying: "Clarifying", awaiting_confirmation: "Ready for confirmation",
    submitted: "Submitted", verifying: "Verifying", completed: "Completed",
    waiting_user: "Waiting for you", blocked: "Blocked", needs_attention: "Needs attention",
    failed: "Failed", paused: "Paused", cancelled: "Cancelled", budget_limited: "Budget limit reached", answered: "Answered",
  };
  return labels[status] || String(status || "Task").replace(/_/g, " ");
}

function childAnswerForm(id, question) {
  const device = identity;
  const { childId, questionId, name, text } = question;
  const form = document.createElement("form");
  element("h3", name, form);
  const questionText = element("p", text, form);
  questionText.id = "child-question-" + childId + "-" + questionId;
  const label = element("label", "Answer", form);
  const input = element("textarea", "", form);
  input.id = questionText.id + "-answer";
  input.maxLength = 4000;
  input.required = true;
  input.setAttribute("aria-describedby", questionText.id);
  label.htmlFor = input.id;
  const submit = element("button", "Send answer", form);
  submit.type = "submit";
  const feedback = element("p", "", form);
  feedback.setAttribute("role", "status");
  let pending;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (device !== identity || id !== conversationId || submit.disabled || form.parentNode !== childQuestions) return;
    const answer = input.value.trim();
    if (!answer) {
      feedback.textContent = "Enter your answer.";
      return;
    }
    pending ??= { childId, questionId, requestId: crypto.randomUUID(), answer };
    submit.disabled = true;
    input.readOnly = true;
    feedback.textContent = "";
    try { await post(conversationPath(id) + "/child-answers", pending); }
    catch (error) {
      if (device !== identity) return;
      if (error instanceof RequestError && error.status < 500) {
        feedback.textContent = error.message;
        input.readOnly = false;
        pending = undefined;
        submit.textContent = "Send answer";
      } else {
        feedback.textContent = "Could not confirm delivery. Retry to check your answer.";
        submit.textContent = "Retry answer";
      }
      submit.disabled = false;
      return;
    }
    feedback.textContent = "Answer received.";
    if (device !== identity || id !== conversationId) return;
    try {
      await refresh();
      if (device === identity && id === conversationId) await refreshList();
    } catch (error) {
      if (device === identity && id === conversationId) report(error);
    }
  });
  return form;
}

function presentChildQuestions(questions, id) {
  const forms = childAnswerForms.get(id) ?? new Map();
  const current = new Set(questions.map(({ childId, questionId }) => childId + ":" + questionId));
  for (const [key, form] of forms) {
    if (!current.has(key)) {
      form.remove();
      forms.delete(key);
    }
  }
  for (const question of questions) {
    const key = question.childId + ":" + question.questionId;
    const form = forms.get(key) ?? childAnswerForm(id, question);
    forms.set(key, form);
    if (form.parentNode !== childQuestions) childQuestions.append(form);
  }
  if (forms.size) childAnswerForms.set(id, forms);
  else childAnswerForms.delete(id);
  childQuestions.hidden = !forms.size;
}

function presentChildActions(view, id) {
  const stops = view.stoppableChildren ?? [];
  const tools = view.interruptibleChildTools ?? [];
  if (!stops.length && !tools.length) return;
  const device = identity;
  const controls = element("div", "", task);
  controls.className = "controls child-actions";
  const current = () => device === identity && id === conversationId;
  function add(label, route, payload, confirmation) {
    const key = device.pairingId + ":" + id + ":" + route + ":" + payload.childId + ":" + (payload.toolTaskId ?? "");
    const button = action(label, controls, async () => {
      if (!current() || controls.parentNode !== task || pendingChildActions.has(key)) return;
      if (confirmation && !confirm(confirmation)) return;
      const pending = { button };
      pendingChildActions.set(key, pending);
      try {
        const receipt = await post(conversationPath(id) + route, payload);
        if (current()) await refresh();
        if (device === identity) await refreshList();
        if (current() && route === "/child-interrupt") {
          status.textContent = receipt.pending ? "The tool is still stopping. Check its status shortly." : "Tool interrupted.";
        }
      } catch (error) {
        if (!current()) return;
        if (route === "/child-interrupt" && error instanceof RequestError && error.status === 409) {
          try { await refresh(); }
          catch (refreshError) {
            if (current()) report(refreshError);
            return;
          }
        }
        if (current()) report(error);
      } finally {
        pendingChildActions.delete(key);
        pending.button.disabled = false;
      }
    });
    const pending = pendingChildActions.get(key);
    if (pending) {
      pending.button = button;
      button.disabled = true;
    }
  }
  for (const { childId, name } of stops) add("Stop " + name, "/child-stop", { childId }, "Stop " + name + "?");
  for (const { childId, childName, toolTaskId, toolName } of tools) {
    add("Interrupt " + toolName + " in " + childName, "/child-interrupt", { childId, toolTaskId });
  }
}

function presentTask(view, id) {
  canSend = view?.status !== "paused" && view?.status !== "cancelled";
  updateComposer();
  task.replaceChildren();
  task.hidden = !view;
  if (!view) return;
  element("h2", taskStatusLabel(view.status), task);
  if (view.question) element("p", view.question, task);
  if (view.reason && view.reason !== view.question) element("p", view.reason, task);
  if (view.progress?.steps?.length) {
    const steps = element("ol", "", task);
    for (const step of view.progress.steps) {
      const state = step.status === "done" ? "Done" : step.status === "running" ? "In progress" : "Pending";
      element("li", step.title + " · " + state, steps);
    }
  }
  if (view.progress?.tools?.length) {
    element("p", "Running " + [...new Set(view.progress.tools.map((tool) => tool.name))].join(", "), task);
  }
  if (view.status === "awaiting_confirmation" && view.brief && view.briefDigest) {
    const brief = view.brief;
    if (brief.outcome) element("p", brief.outcome, task);
    const sections = [
      ["Deliverables", brief.deliverables], ["Inputs", brief.inputs], ["Scope", brief.scope],
      ["Assumptions", brief.assumptions], ["Questions", brief.questions],
      ["Acceptance criteria", brief.criteria?.map((criterion) => typeof criterion === "string" ? criterion : criterion.text)],
    ];
    for (const [label, values] of sections) {
      if (!values?.length) continue;
      element("h3", label, task);
      const list = element("ul", "", task);
      for (const item of values) element("li", item, list);
    }
    if (brief.budget) {
      const limits = [];
      if (typeof brief.budget.maxDurationMs === "number") limits.push(Math.ceil(brief.budget.maxDurationMs / 60000) + " min");
      if (typeof brief.budget.maxEstimatedCostUsd === "number") limits.push("$" + brief.budget.maxEstimatedCostUsd);
      if (limits.length) element("p", "Budget · " + limits.join(" · "), task);
      if (typeof view.budget?.totalTokens === 'number') element('p','Tokens used so far: '+view.budget.totalTokens,task);
      if (view.budget?.priceKnown === false) element('p','Model pricing is unavailable. The monetary cap cannot be measured; token and time limits apply.',task);
    }
    action("Confirm this brief", task, async () => {
      await post(conversationPath(id) + "/confirm", { revision: view.brief.revision, digest: view.briefDigest });
      await refresh();
    }).classList.add("primary");
  }
  if (view.controls?.length) {
    const controls = element("div", "", task);
    controls.className = "controls";
    const labels = { pause: "Pause", continue: "Continue", cancel: "Cancel task" };
    let updating = false;
    for (const control of view.controls) {
      action(labels[control], controls, async () => {
        if (updating || id !== conversationId || control === "cancel" && !confirm("Cancel this task?")) return;
        updating = true;
        const device = identity;
        try {
          await post(conversationPath(id) + "/control", { action: control, version: view.controlVersion });
          if (device === identity && id === conversationId) await refresh();
          if (device === identity) await refreshList();
        } catch (error) {
          if (device !== identity || id !== conversationId) return;
          if (error instanceof RequestError && error.status === 409) await refresh();
          if (device === identity && id === conversationId) report(error);
        } finally { updating = false; }
      });
    }
  }
  presentChildActions(view, id);
  if (view.delivery) {
    if (view.delivery.summary) element("p", view.delivery.summary, task);
    if (view.delivery.verification) element("p", view.delivery.verification, task);
    if (view.delivery.artifacts.length) {
      const artifacts = element("ul", "", task);
      for (const artifact of view.delivery.artifacts) {
        const row = element("li", "", artifacts);
        action((artifact.kind === "directory" ? "Open " : "Download ") + artifact.name, row, () => download(artifact, row));
      }
    }
  }
}

async function refresh() {
  if (!identity || !conversationId) return;
  const version = ++refreshVersion;
  const id = conversationId;
  const current = () => version === refreshVersion;
  const path = conversationPath(id);
  let after = historyCursor;
  let view;
  try {
    await checkReceipt();
    if (!current()) return;
    view = await get(after === null ? path : path + "?after=" + after).catch((error) => {
      if (!current() || after === null || !(error instanceof RequestError) || error.status !== 400) throw error;
      after = null;
      return get(path);
    });
  } catch (error) {
    if (!current()) return;
    if (error instanceof RequestError && error.status === 404) {
      if (disconnected) status.textContent = "";
      disconnected = false;
      return;
    }
    throw error;
  }
  if (!current()) return;
  if (disconnected) status.textContent = "";
  disconnected = false;
  if (after === null && historyCursor !== null) {
    messages.replaceChildren();
    taskEvents.replaceChildren();
    taskHistory.hidden = true;
  }
  for (const message of view.messages) {
    const fromUser = message.role === "user";
    const article = element("article", "", messages);
    article.className = "message " + (fromUser ? "message-user" : "message-assistant");
    element("p", fromUser ? "You" : "Kada", article).classList.add("speaker");
    if (message.text) element("p", message.text, article);
    if (message.attachments?.length) presentAttachments(message.attachments, article);
  }
  for (const event of view.progressEvents || []) {
    const row = element("li", event.label + " · ", taskEvents);
    const occurred = new Date(event.timestamp);
    const time = element("time", occurred.toLocaleString(), row);
    time.dateTime = occurred.toISOString();
    taskHistory.hidden = false;
  }
  historyCursor = view.cursor;
  const taskSnapshot = JSON.stringify(view.task);
  if (taskSnapshot !== shownTask) {
    shownTask = taskSnapshot;
    presentTask(view.task, id);
    presentChildQuestions(view.task?.childQuestions ?? [], id);
  }
}

async function connect(value) {
  const attempt = ++connectionAttempt;
  let candidate;
  try {
    candidate = await (await request("/session", {}, value)).json();
    if (attempt !== connectionAttempt) return;
    await migratePending(value, candidate);
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    if (error instanceof RequestError && error.status === 401 && sessionStorage.getItem("kada-device-token") === value) {
      sessionStorage.removeItem("kada-device-token");
    }
    throw error;
  }
  if (attempt !== connectionAttempt) return;
  const sameSession = sessionStorage.getItem("kada-device-token") === value;
  token = value;
  identity = candidate;
  childAnswerForms.clear();
  pushSettings = undefined;
  notifications.hidden = true;
  sessionStorage.setItem("kada-device-token", token);
  sessionStorage.setItem("kada-composer-pairing", identity.pairingId);
  const oldSelection = sameSession && localStorage.getItem(["kada", "conversation", identity.accountId, identity.deviceId].join(":"));
  conversationId = localStorage.getItem(selectionKey()) || oldSelection || composerRecords().keys().next().value || "";
  if (conversationId) localStorage.setItem(selectionKey(), conversationId);
  listVersion++;
  conversations.replaceChildren();
  pendingTasks.replaceChildren();
  pendingWork.hidden = true;
  resetConversationView();
  restoreComposer();
  if (pending) displayReceipt({ state: "unknown" });
  field("connection").textContent = identity.deviceId;
  field("connection").hidden = false;
  pair.hidden = true;
  assistant.hidden = false;
  signout.hidden = false;
  status.textContent = "";
  updateComposer();
  await refreshList();
  await refresh();
  await refreshPushSettings(candidate);
}

function selectFiles() {
  const selected = [...fileInput.files];
  field("file-names").textContent = selected.length ? selected.map((file) => file.name).join(", ") : "Up to 4 files, 5 MB each";
}

async function upload(file, path) {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const mime = ({
    json: "application/json", csv: "text/csv", md: "text/markdown", tsv: "text/tab-separated-values",
  })[file.name.split(".").at(-1)?.toLowerCase()] || file.type || "application/octet-stream";
  const known = ["application/json", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp",
    "text/plain", "text/csv", "text/markdown", "text/tab-separated-values"];
  const response = await request(path + "/uploads", {
    method: "POST",
    headers: {
      "Content-Type": known.includes(mime) ? mime : "application/octet-stream",
      "X-Kada-Filename": encodeURIComponent(file.name),
      "X-Kada-Sha256": sha,
    },
    body: bytes,
  });
  return (await response.json()).id;
}

field("pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const entered = field("token");
  const value = entered.value.trim();
  entered.value = "";
  try { await connect(value); }
  catch (error) { report(error); entered.focus(); }
});

notifications.addEventListener("click", async () => {
  const device = identity;
  const bearer = token;
  const settings = pushSettings;
  if (!device || !settings?.publicKey || notifications.disabled || signout.disabled) return;
  notifications.disabled = true;
  signout.disabled = true;
  try {
    if (settings.subscribed) {
      await request("/push", { method: "DELETE" }, bearer);
    } else {
      if (await Notification.requestPermission() !== "granted") {
        throw new RequestError(409, "Allow notifications in your browser to enable task updates.");
      }
      const registration = await navigator.serviceWorker.register("/remote/sw.js", { scope: "/remote/" });
      const worker = registration.installing ?? registration.waiting;
      if (!registration.active && worker) await new Promise((resolve, reject) => {
        const changed = () => {
          if (worker.state !== "activated" && worker.state !== "redundant") return;
          worker.removeEventListener("statechange", changed);
          if (worker.state === "activated") resolve();
          else reject(new RequestError(409, "The notification worker could not start."));
        };
        worker.addEventListener("statechange", changed);
        changed();
      });
      if (identity !== device) return;
      const subscription = await registration.pushManager.getSubscription() ??
        await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: settings.publicKey });
      if (identity !== device) return;
      await request("/push", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      }, bearer);
    }
    await refreshPushSettings(device);
  } catch (error) {
    if (identity === device) report(error);
  } finally { notifications.disabled = false; signout.disabled = false; }
});

signout.addEventListener("click", async () => {
  if (signout.disabled) return;
  const bearer = token;
  signout.disabled = true;
  sessionStorage.removeItem("kada-device-token");
  identity = null;
  childAnswerForms.clear();
  try {
    if (pushSettings?.publicKey) {
      await request("/push", { method: "DELETE", signal: AbortSignal.timeout(3_000) }, bearer);
    }
  } catch {
    // Keep sign-out local even when the daemon cannot receive the unsubscribe.
  } finally { location.reload(); }
});

conversations.addEventListener("change", () => choose(conversations.value));
field("new").addEventListener("click", () => { choose(""); prompt.focus(); });
field("refresh-conversations").addEventListener("click", () => refreshList().catch(report));
let returning = false;
async function refreshOnReturn() {
  if (!identity || document.hidden || returning || busy) return;
  returning = true;
  try { await refreshList(); }
  catch (error) { report(error); }
  finally { returning = false; }
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
window.addEventListener("hashchange", () => {
  if (identity && location.hash.startsWith("#conversation=")) refreshList().catch(report);
});
fileInput.addEventListener("change", selectFiles);

prompt.addEventListener("input", () => {
  if (!identity || !conversationId) return;
  const text = prompt.value;
  const id = conversationId;
  const key = bookKey();
  const selected = editor;
  selected.saving = selected.saving.then(async () => {
    const previous = selected.draft;
    const next = text ? { state: "draft", messageId: previous?.messageId ?? crypto.randomUUID(), text } : undefined;
    await changeComposer((records) => {
      const record = records.get(id);
      if (record?.messageId !== previous?.messageId || record?.text !== previous?.text || record?.state === "pending") {
        throw new RequestError(409, "This draft changed in another tab. Copy your edits and reopen this conversation.");
      }
      if (next) records.set(id, next);
      else records.delete(id);
    }, key);
    selected.draft = next;
    if (selected === editor && selected.error === status.textContent) status.textContent = "";
    selected.error = undefined;
  }).catch((error) => {
    if (selected !== editor) return;
    report(error);
    selected.error = status.textContent;
  });
  return selected.saving;
});

async function whileSending(run) {
  busy = true;
  conversations.disabled = true;
  field("new").disabled = true;
  updateComposer();
  try { await run(); }
  catch (error) { report(error); }
  finally {
    busy = false;
    conversations.disabled = false;
    field("new").disabled = false;
    updateComposer();
  }
}

async function sendPending(id, message) {
  status.textContent = "Sending…";
  let receipt;
  const { messageId, text, attachmentIds } = message;
  try { receipt = await post(conversationPath(id) + "/messages", { messageId, text, attachmentIds }); }
  catch (error) {
    if (error instanceof RequestError && error.status < 500 && error.status !== 401) {
      await settlePending(message, true);
      if (attachmentIds.length) {
        throw new RequestError(error.status, error.message + " Attach the files again to send this message.");
      }
    } else {
      displayReceipt({ state: "unknown" });
    }
    throw error;
  }
  status.textContent = "";
  if (receipt.state === "submitted") {
    await settlePending(message);
  } else {
    displayReceipt(receipt);
  }
  await refreshList();
  await refresh();
}

field("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (send.disabled) return;
  const text = prompt.value;
  const selected = [...fileInput.files];
  if (!text.trim() && !selected.length) return;
  if (selected.length > 4 || selected.some((file) => file.size > 5 * 1024 * 1024)) {
    status.textContent = "Choose up to four files, each 5 MB or smaller.";
    return;
  }
  const id = conversationId;
  await whileSending(async () => {
    await editor.saving;
    const messageId = editor.draft?.messageId;
    const current = composerRecords().get(id);
    if (current?.state === "pending") { await checkReceipt(); return; }
    if (text && (current?.messageId !== messageId || current?.text !== text)) {
      throw new RequestError(409, "This draft changed in another tab. Copy your edits and reopen this conversation.");
    }
    if (selected.length) status.textContent = "Uploading attachments…";
    const attachmentIds = [];
    for (const file of selected) attachmentIds.push(await upload(file, conversationPath(id)));
    const message = { state: "pending", messageId: messageId ?? crypto.randomUUID(), text, attachmentIds };
    const claimed = await changeComposer((records) => {
      const record = records.get(id);
      if (record?.state === "pending" || record?.messageId !== messageId || record?.text !== (text || undefined)) return false;
      records.set(id, message);
      return true;
    });
    if (!claimed) {
      if (composerRecords().get(id)?.state === "pending") await checkReceipt();
      else throw new RequestError(409, "This draft changed in another tab. Copy your edits and reopen this conversation.");
      return;
    }
    pending = message;
    editor.draft = undefined;
    prompt.value = "";
    fileInput.value = "";
    selectFiles();
    await sendPending(id, message);
  });
});

let polling = false;
setInterval(async () => {
  if (!identity || polling || document.hidden || busy) return;
  const device = identity;
  polling = true;
  try { await refresh(); }
  catch (error) {
    if (device !== identity) return;
    if (error instanceof RequestError && error.status === 401) {
      identity = null;
      childAnswerForms.clear();
      sessionStorage.removeItem("kada-device-token");
      assistant.hidden = true;
      pair.hidden = false;
      signout.hidden = true;
      field("connection").hidden = true;
    }
    report(error);
  }
  finally { polling = false; }
}, 1500);

if (token) connect(token).catch((error) => { pair.hidden = false; report(error); });
else pair.hidden = false;
`;
