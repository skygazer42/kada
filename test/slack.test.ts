import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { serve } from "../src/server.js";
import { runSlack } from "../src/slack.js";
import { scriptedFixture, until } from "./helpers.js";

const userId = "U012TESTUSER";
const channel = "D012TESTCHAT";
const team = "T012TESTTEAM";
const bot = "U012TESTBOT";
const botId = "B012TESTBOT";
const settings = { userId, appTokenEnv: "KADA_TEST_SLACK_APP", botTokenEnv: "KADA_TEST_SLACK_BOT", pairingTokenEnv: "KADA_TEST_SLACK_PAIR" };

// This fixture implements only the server text frames and masked client ACKs used by Socket Mode.
function sendFrame(socket: Duplex, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const prefix = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >>> 8, bytes.length & 255]);
  socket.write(Buffer.concat([prefix, bytes]));
}

test("Slack durably ACKs Socket Mode and resumes the original task through DM history and verified files", { timeout: 60_000 }, async t => {
  let phase = "brief";
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(context => {
    if (phase === "brief") return tool("task_prepare", {
      outcome: "Prepare the Slack report.", deliverables: ["report.txt"], criteria: [{ text: "Inspect report.txt", method: "inspect" }],
      assumptions: [], inputs: [], scope: ["This conversation"], questions: [],
    });
    if (phase === "question") return tool("ask_user", { question: "Which report format?", options: ["CSV", "Text"] });
    assert(context.messages.some(message => message.role === "user" && message.content === "CSV"));
    if (phase === "write") {
      phase = "submit";
      return tool("write", { path: "report.txt", content: "Verified Slack report.\r\n" });
    }
    return tool("task_submit", { summary: "Slack report finished.", artifacts: ["report.txt"],
      criteria: [{ id: 1, status: "passed", evidence: "Inspected report.txt." }] });
  });
  await fixture.runtime.close();
  let clean = () => fixture.close();
  t.after(() => clean());
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const configFile = join(fixture.directory, "slack-config.json");
  const load = async (slack?: unknown) => {
    await writeFile(configFile, JSON.stringify({ ...fixture.settings, port, remoteOrigin: "https://desktop.example.test", slack }));
    return loadConfig(configFile);
  };
  assert.equal((await load()).slack, undefined);
  await assert.rejects(load({ ...settings, userId: "C012TESTROOM" }), /slack/i);
  await assert.rejects(load({ ...settings, token: "unexpected" }), /slack/i);
  const config = await load(settings);
  assert.deepEqual(config.slack, settings);
  const stateFile = join(config.dataDir, "slack", team + "-" + botId + ".json");
  const open = () => serve(config, { models: fixture.models });
  let daemon = await open();
  let stopConnector = async () => {};
  clean = async () => {
    try { await stopConnector(); }
    finally { await daemon.close(); await fixture.close(); }
  };
  const client = createClient(config);
  const { token } = await client.request<{ token: string }>("/v1/remote/devices", "POST", { accountId: "personal", deviceId: "slack" });
  const appToken = "xapp-" + "syntheticSlackApp";
  const botToken = "xoxb-" + "syntheticSlackBot";
  for (const [name, value] of [[settings.appTokenEnv, appToken], [settings.botTokenEnv, botToken], [settings.pairingTokenEnv, token]] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  let clock = 0n;
  const stamp = () => {
    const time = BigInt(Date.now()) * 1000n;
    clock = time > clock ? time : clock + 1n;
    return String(clock).slice(0, -6) + "." + String(clock).slice(-6);
  };
  type Message = { type: "message"; channel: string; user: string; ts: string; text: string; thread_ts?: string;
    files?: unknown[]; metadata?: { event_type: string; event_payload: { send_id: string } } };
  const message = (text: string, author = userId, reply?: string): Message => ({
    type: "message", channel, user: author, ts: stamp(), text, ...(reply ? { thread_ts: reply } : {}),
  });
  const acknowledgements: string[] = [];
  const connections: Duplex[] = [];
  const history: Message[] = [];
  const reads: string[] = [];
  const historyBounds: string[] = [];
  const originalDocument = Buffer.from("item,quantity\r\npaper,2\r\n");
  const uploaded: Buffer[] = [];
  const completions: string[] = [];
  let docReads = 0;
  const loseResponses = new Set(["Prepare the Slack report.", "Which report format?"]);
  let timePages = false;
  let platformError: unknown;
  const platform = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://127.0.0.1");
      const answer = (value: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...value }));
      if (url.pathname === "/private-file") {
        assert.equal(req.headers.authorization, "Bearer " + botToken);
        assert(acknowledgements.includes("new-task"));
        docReads++;
        res.writeHead(200, { "Content-Type": "text/csv" }).end(originalDocument);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (url.pathname === "/upload") {
        assert.equal(req.headers.authorization, undefined);
        uploaded.push(body);
        res.writeHead(200).end("OK");
        return;
      }
      if (url.pathname === "/api/apps.connections.open") {
        assert.equal(req.headers.authorization, "Bearer " + appToken);
        answer({ url: "wss://wss-primary.slack.com/link/?ticket=synthetic" });
        return;
      }
      assert.equal(req.headers.authorization, "Bearer " + botToken);
      const isJson = req.headers["content-type"]?.startsWith("application/json");
      if (["/api/conversations.replies", "/api/files.info", "/api/files.getUploadURLExternal"].includes(url.pathname)) {
        assert.match(req.headers["content-type"] ?? "", /^application\/x-www-form-urlencoded/);
      }
      const data = body.length
        ? isJson ? JSON.parse(body.toString()) : Object.fromEntries(new URLSearchParams(body.toString()))
        : Object.fromEntries(url.searchParams);
      switch (url.pathname) {
        case "/api/auth.test": answer({ team_id: team, user_id: bot, bot_id: botId }); break;
        case "/api/conversations.open":
          assert.equal(data.users, userId);
          answer({ channel: { id: channel, is_im: true, user: userId } });
          break;
        case "/api/conversations.history":
        case "/api/conversations.replies": {
          assert.equal(data.channel, channel);
          reads.push(data.ts ?? "root");
          if (!data.ts) historyBounds.push(data.latest);
          const rows = history.filter(item => (data.ts ? item.thread_ts === data.ts : !item.thread_ts) &&
            (!data.oldest || item.ts > data.oldest) && (!data.latest || item.ts < data.latest)).toReversed();
          const page = timePages && !data.ts ? rows.slice(0, 1) : rows;
          answer({ messages: page, has_more: page.length < rows.length });
          break;
        }
        case "/api/chat.postMessage": {
          assert.equal(data.channel, channel);
          assert.equal(data.mrkdwn, false);
          assert.match(data.metadata?.event_payload?.send_id, /^[0-9a-f]{64}$/);
          const row = { ...message(data.text, bot), metadata: data.metadata };
          history.push(row);
          const lose = [...loseResponses].find(text => row.text.includes(text));
          if (lose) {
            loseResponses.delete(lose);
            res.destroy();
          } else answer({ channel, ts: row.ts, message: row });
          break;
        }
        case "/api/files.info":
          assert.equal(data.file, "F012TESTINPUT");
          answer({ file: { id: "F012TESTINPUT", name: "input.csv", mimetype: "text/csv",
            size: originalDocument.length, url_private_download: "https://files.slack.com/files-pri/T012TESTTEAM/input.csv" } });
          break;
        case "/api/files.getUploadURLExternal":
          assert.equal(data.filename, "report.txt");
          answer({ file_id: "F012TESTREPORT", upload_url: "https://files.slack.com/upload/v1/synthetic" });
          break;
        case "/api/files.completeUploadExternal":
          assert.equal(data.channel_id, channel);
          assert.equal(data.files[0].id, "F012TESTREPORT");
          completions.push(data.files[0].id);
          answer({ files: [{ id: "F012TESTREPORT" }] });
          break;
        default: assert.fail("Unexpected Web API method " + url.pathname);
      }
    } catch (error) { platformError = error; res.writeHead(500).end(); }
  });
  platform.on("upgrade", (req, ws) => {
    assert.equal(req.url, "/socket");
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    ws.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    connections.push(ws);
    let buffer = Buffer.alloc(0);
    ws.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const length = buffer[1]! & 127;
        if (buffer.length < length + 6) break;
        if ((buffer[0]! & 15) === 8) { ws.end(Buffer.from([0x88, 0])); return; }
        const mask = buffer.subarray(2, 6);
        const text = buffer.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]!);
        acknowledgements.push(JSON.parse(text.toString()).envelope_id);
        buffer = buffer.subarray(6 + length);
      }
    });
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  const fakePort = (platform.address() as { port: number }).port;
  const fake = "http://127.0.0.1:" + fakePort;
  t.after(() => new Promise<void>(resolve => {
    for (const ws of connections) ws.destroy();
    platform.close(resolve);
    platform.closeAllConnections();
  }));
  const fetchSlack: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://files.slack.com") {
      return fetch(fake + (url.pathname.startsWith("/upload/") ? "/upload" : "/private-file"), init);
    }
    assert.equal(url.origin, "https://slack.com");
    return fetch(fake + url.pathname + url.search, init);
  };
  const openSocket = (url: string) => {
    assert.equal(new URL(url).hostname, "wss-primary.slack.com");
    return new WebSocket("ws://127.0.0.1:" + fakePort + "/socket");
  };
  let controller: AbortController;
  let done: Promise<void>;
  let error: unknown;
  const start = () => {
    controller = new AbortController();
    done = runSlack(config, controller.signal, { fetchSlack, openSocket, log: () => {} });
    void done.catch(reason => { error = reason; });
  };
  const stop = async () => { controller?.abort(); await done; };
  stopConnector = stop;
  const wait = <T>(value: () => T, predicate: (value: T) => boolean) =>
    until(async () => { if (error) throw error; if (platformError) throw platformError; return value(); }, predicate);
  const seen = async (part: string) => (await wait(() => history.find(row => row.user === bot && row.text.includes(part)) ?? null, Boolean))!;
  const emit = (id: string, event: Message, workspace = team) => sendFrame(connections.at(-1)!, {
    type: "events_api", envelope_id: id, payload: { team_id: workspace, event_id: "Ev_" + id, token: "synthetic-legacy-verification", event },
  });
  start();
  await wait(() => connections.length, size => size === 1);
  emit("foreign", message("Outside workspace"), "T999OTHER");
  const incoming = { ...message("Create the Slack report."), files: [{
    id: "F012TESTINPUT",
  }] };
  history.push(incoming);
  emit("new-task", incoming);
  await wait(() => acknowledgements.includes("new-task"), Boolean);
  const persisted = await readFile(stateFile, "utf8");
  const intake = JSON.parse(persisted);
  assert(intake.inbox[incoming.ts] || intake.handled[incoming.ts]);
  assert(!persisted.includes("synthetic-legacy-verification"));
  emit("duplicate-task", incoming);
  const brief = await seen("Prepare the Slack report.");
  assert.match(brief.text, /!confirm/);
  assert.equal(docReads, 1);
  const tasks = () => client.request<{ id: string }[]>("/v1/tasks");
  const initial = await tasks();
  assert.equal(initial.length, 1);
  const id = initial[0]!.id;
  const workspace = (await daemon.runtime.status(id)).workspace;
  const attachments = join(workspace, "attachments");
  assert.deepEqual(await readFile(join(attachments, (await readdir(attachments))[0]!, "input.csv")), originalDocument);
  const later = message("A newer Bot message without a receipt.", bot);
  history.push(later);
  timePages = true;
  sendFrame(connections.at(-1)!, { type: "disconnect", reason: "link_disabled" });
  await wait(() => connections.length, size => size >= 2);
  await until(async () => {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const outbox = state.outbox[brief.metadata!.event_payload.send_id];
    return outbox?.messageId ?? null;
  }, value => value === brief.ts);
  assert(historyBounds.includes(later.ts));
  phase = "question";
  const confirmation = message("!confirm", userId, brief.ts);
  history.push(confirmation);
  emit("confirm", confirmation);
  const question = await seen("Which report format?");
  await stop();
  const stoppedState = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(stoppedState.outbox[question.metadata!.event_payload.send_id].messageId, undefined);
  await daemon.close();
  daemon = await open();
  assert.equal((await daemon.runtime.status(id)).status, "waiting_user");
  phase = "write";
  history.push(message("CSV", userId, question.ts));
  start();
  await wait(() => completions.length, count => count === 1);
  assert(reads.includes(question.ts));
  assert.deepEqual(uploaded, [Buffer.from("Verified Slack report.\r\n")]);
  const final = await daemon.runtime.status(id);
  assert.equal(final.status, "completed");
  assert.equal(final.messages.filter(row => row.role === "user" && row.content === "CSV").length, 1);
  assert.equal((await tasks()).length, 1);
  assert.equal(history.filter(row => row.user === bot && row.text.includes("Prepare the Slack report.")).length, 1);
  assert.equal(platformError, undefined);
});
