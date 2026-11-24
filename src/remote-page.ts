export const remotePage = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kada</title>
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
    .task { background: #e9f7f0; border-color: #cce6d7; overflow-wrap: anywhere; }
    .task p + p, .task button, .task h3 { margin-top: .55rem; }
    .task ol, .task ul { margin: .3rem 0 0; padding-left: 1.4rem; }
    .task li { margin-top: .3rem; }
    .task li button { text-align: left; max-width: 100%; overflow-wrap: anywhere; }
    .receipt { margin-top: .5rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem; }
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
        <button type="button" id="new">New chat</button>
      </div>
      <section id="task" class="panel task" hidden aria-label="Task progress"></section>
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
const status = field("status");
const conversations = field("conversation");
const task = field("task");
const taskHistory = field("task-history");
const taskEvents = field("task-events");
const messages = field("messages");
const uncertain = field("uncertain");
const prompt = field("prompt");
const fileInput = field("files");
const send = field("send");

let token = sessionStorage.getItem("kada-device-token") || "";
let identity = null;
let conversationId = "";
let pending = new Map();
let busy = false;
let refreshVersion = 0;
let shownMessages = [];
let lastProgressSequence = 0;
let shownTask = "";
let disconnected = false;

function scopedKey(name) {
  return ["kada", name, identity.accountId, identity.deviceId].join(":");
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(path, init = {}) {
  const response = await fetch("/remote/api" + path, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: { Authorization: "Bearer " + token, ...init.headers },
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

function choose(id) {
  conversationId = id || crypto.randomUUID();
  localStorage.setItem(scopedKey("conversation"), conversationId);
  conversations.querySelector("[data-draft]")?.remove();
  conversations.value = conversationId;
  if (!conversations.value) {
    const option = element("option", "New conversation", conversations);
    option.dataset.draft = "true";
    option.value = conversationId;
    conversations.value = conversationId;
  }
  shownMessages = [];
  lastProgressSequence = 0;
  shownTask = "";
  messages.replaceChildren();
  taskEvents.replaceChildren();
  taskHistory.hidden = true;
  taskHistory.open = false;
  task.hidden = true;
  refresh().catch(report);
  updateComposer();
}

async function refreshList() {
  const rows = await get("/conversations");
  conversations.replaceChildren();
  for (const row of rows) {
    const option = element("option", row.title, conversations);
    option.value = row.conversationId;
  }
  const selected = conversationId || rows[0]?.conversationId;
  if (!selected) return choose("");
  if (selected !== conversationId) return choose(selected);
  conversations.value = selected;
  if (!conversations.value) {
    const option = element("option", "New conversation", conversations);
    option.dataset.draft = "true";
    option.value = selected;
    conversations.value = selected;
  }
}

function updateComposer() {
  send.disabled = busy || pending.has(conversationId);
  fileInput.disabled = send.disabled;
}

function displayReceipt(receipt) {
  const key = conversationId + "/" + pending.get(conversationId) + "/" + receipt.state;
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
  if (receipt.state === "unknown" || receipt.state === "accepted") {
    action("Check delivery", uncertain, async () => { await checkReceipt(); });
  }
  if (receipt.state === "unknown" || receipt.state === "interrupted") {
    action("Dismiss", uncertain, async () => { setPending(conversationId, null); uncertain.hidden = true; });
  }
}

function setPending(id, messageId) {
  if (messageId) pending.set(id, messageId);
  else pending.delete(id);
  localStorage.setItem(scopedKey("pending"), JSON.stringify([...pending]));
  updateComposer();
}

async function checkReceipt() {
  const id = conversationId;
  const messageId = pending.get(id);
  if (!messageId) {
    uncertain.hidden = true;
    return;
  }
  const receipt = await get(conversationPath(id) + "?messageId=" + encodeURIComponent(messageId));
  if (id !== conversationId || pending.get(id) !== messageId) return;
  if (receipt.state === "submitted") {
    setPending(id, null);
    uncertain.hidden = true;
    await refreshList();
    return;
  }
  displayReceipt(receipt);
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

function presentTask(view, id) {
  task.replaceChildren();
  task.hidden = !view;
  if (!view) return;
  const labels = {
    working: "Working", clarifying: "Clarifying", awaiting_confirmation: "Ready for confirmation",
    submitted: "Submitted", verifying: "Verifying", completed: "Completed",
    waiting_user: "Waiting for you", blocked: "Blocked", needs_attention: "Needs attention",
    failed: "Failed", paused: "Paused", cancelled: "Cancelled",
  };
  element("h2", labels[view.status] || String(view.status || "Task").replace(/_/g, " "), task);
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
  await checkReceipt();
  if (id !== conversationId) return;
  let view;
  try { view = await get(conversationPath(id)); }
  catch (error) {
    if (error instanceof RequestError && error.status === 404) {
      if (disconnected) status.textContent = "";
      disconnected = false;
      return;
    }
    throw error;
  }
  if (id !== conversationId || version !== refreshVersion) return;
  if (disconnected) status.textContent = "";
  disconnected = false;
  const snapshot = view.messages.map((message) => JSON.stringify(message));
  if (shownMessages.some((previous, index) => previous !== snapshot[index])) {
    shownMessages = [];
    messages.replaceChildren();
  }
  for (const message of view.messages.slice(shownMessages.length)) {
    const fromUser = message.role === "user";
    const article = element("article", "", messages);
    article.className = "message " + (fromUser ? "message-user" : "message-assistant");
    element("p", fromUser ? "You" : "Kada", article).classList.add("speaker");
    element("p", message.text, article);
  }
  shownMessages = snapshot;
  for (const event of view.progressEvents || []) {
    if (event.sequence <= lastProgressSequence) continue;
    const row = element("li", event.label + " · ", taskEvents);
    const occurred = new Date(event.timestamp);
    const time = element("time", occurred.toLocaleString(), row);
    time.dateTime = occurred.toISOString();
    lastProgressSequence = event.sequence;
    taskHistory.hidden = false;
  }
  const taskSnapshot = JSON.stringify(view.task);
  if (taskSnapshot !== shownTask) {
    shownTask = taskSnapshot;
    presentTask(view.task, id);
  }
}

async function connect(value) {
  token = value;
  try {
    identity = await get("/session");
  } catch (error) {
    if (error instanceof RequestError && error.status === 401) sessionStorage.removeItem("kada-device-token");
    throw error;
  }
  sessionStorage.setItem("kada-device-token", token);
  pending = new Map(JSON.parse(localStorage.getItem(scopedKey("pending")) || "[]"));
  conversationId = localStorage.getItem(scopedKey("conversation")) || "";
  field("connection").textContent = identity.deviceId;
  field("connection").hidden = false;
  pair.hidden = true;
  assistant.hidden = false;
  signout.hidden = false;
  status.textContent = "";
  await refreshList();
  updateComposer();
  await refresh();
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

signout.addEventListener("click", () => {
  sessionStorage.removeItem("kada-device-token");
  location.reload();
});

conversations.addEventListener("change", () => choose(conversations.value));
field("new").addEventListener("click", () => { choose(""); prompt.focus(); });
fileInput.addEventListener("change", selectFiles);

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
  const path = conversationPath(id);
  busy = true;
  conversations.disabled = true;
  field("new").disabled = true;
  updateComposer();
  status.textContent = selected.length ? "Uploading attachments…" : "Sending…";
  try {
    const attachmentIds = [];
    for (const file of selected) attachmentIds.push(await upload(file, path));
    const messageId = crypto.randomUUID();
    setPending(id, messageId);
    const receipt = await post(path + "/messages", { messageId, text, attachmentIds });
    prompt.value = "";
    fileInput.value = "";
    selectFiles();
    status.textContent = "";
    if (receipt.state === "submitted") setPending(id, null);
    else if (id === conversationId) displayReceipt(receipt);
    await refreshList();
    await refresh();
  } catch (error) {
    if (pending.has(id) && error instanceof RequestError && error.status < 500) setPending(id, null);
    report(error);
    if (pending.has(id)) displayReceipt({ state: "unknown" });
  } finally {
    busy = false;
    conversations.disabled = false;
    field("new").disabled = false;
    updateComposer();
  }
});

let polling = false;
setInterval(async () => {
  if (!identity || polling || document.hidden || busy) return;
  polling = true;
  try { await refresh(); }
  catch (error) {
    if (error instanceof RequestError && error.status === 401) {
      identity = null;
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
