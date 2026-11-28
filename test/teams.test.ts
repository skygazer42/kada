import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { App } from "@microsoft/teams.apps";
import { createClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { serve } from "../src/server.js";
import { runTeams } from "../src/teams.js";
import { scriptedFixture, until } from "./helpers.js";

const clientId = "d00a0001-0000-4000-8000-000000000001";
const tenantId = "d00a0002-0000-4000-8000-000000000002";
const userId = "d00a0003-0000-4000-8000-000000000003";
const stranger = "d00a0004-0000-4000-8000-000000000004";
const conversation = "a:kada-private-chat";
const settings = { clientId, tenantId, userId, clientSecretEnv: "KADA_TEST_TEAMS_SECRET", pairingTokenEnv: "KADA_TEST_TEAMS_PAIR" };
const downloadUrl = "https://fixtures.sharepoint.com/personal/input.txt";
const uploadUrl = "https://fixtures.sharepoint.com/upload/approved-report";
const contentUrl = "https://fixtures.sharepoint.com/personal/report.txt";
const serviceUrl = "https://smba.trafficmanager.net/teams/";

test("Teams private activities preserve the original brief and question, and release verified bytes after consent", { timeout: 60_000 }, async t => {
  let phase = "brief";
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(context => {
    if (phase === "brief") return tool("task_prepare", {
      outcome: "Prepare the Teams report.", deliverables: ["report.txt"], criteria: [{ text: "Inspect report.txt", method: "inspect" }],
      assumptions: [], inputs: [], scope: ["This conversation"], questions: [],
    });
    if (phase === "question") return tool("ask_user", { question: "Which report format?", options: ["CSV", "Text"] });
    assert(context.messages.some(message => message.role === "user" && message.content === "CSV"));
    if (phase === "write") {
      phase = "submit";
      return tool("write", { path: "report.txt", content: "Verified Teams report.\r\n" });
    }
    return tool("task_submit", { summary: "Teams report finished.", artifacts: ["report.txt"],
      criteria: [{ id: 1, status: "passed", evidence: "Inspected report.txt." }] });
  });
  await fixture.runtime.close();
  let clean = () => fixture.close();
  t.after(() => clean());
  const portProbe = createSocket();
  await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const file = join(fixture.directory, "teams-config.json");
  const configure = async (teams?: unknown) => {
    await writeFile(file, JSON.stringify({ ...fixture.settings, port, remoteOrigin: "https://desktop.example.test", teams }));
    return loadConfig(file);
  };
  assert.equal((await configure()).teams, undefined);
  await assert.rejects(configure({ ...settings, tenantId: "common" }), /teams/i);
  await assert.rejects(configure({ ...settings, clientSecret: "unexpected" }), /teams/i);
  const config = await configure(settings);
  assert.deepEqual(config.teams, settings);
  const open = () => serve(config, { models: fixture.models });
  let daemon = await open();
  let stopConnector = async () => {};
  clean = async () => {
    try { await stopConnector(); }
    finally { await daemon.close(); await fixture.close(); }
  };
  const client = createClient(config);
  const { token } = await client.request<{ token: string }>("/v1/remote/devices", "POST", { accountId: "private", deviceId: "teams" });
  for (const [name, value] of [[settings.clientSecretEnv, "syntheticTeamsAppSecret"], [settings.pairingTokenEnv, token]] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const source = Buffer.from("team,amount\r\npreview,10\r\n");
  const uploads: Buffer[] = [];
  const posts: { id: string; body: any }[] = [];
  let platformError: unknown;
  let downloads = 0;
  const platform = createServer(async (req, res) => {
    try {
      if (req.url === "/source") {
        assert.equal(req.headers.authorization, undefined);
        downloads++;
        res.writeHead(200, { "Content-Type": "text/plain" }).end(source);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url === "/upload") {
        assert.equal(req.method, "PUT");
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers["content-range"], "bytes 0-" + (bytes.length - 1) + "/" + bytes.length);
        uploads.push(bytes);
        res.writeHead(201).end("{}");
        return;
      }
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer syntheticConnectorAccess");
      assert.equal(req.url, "/teams/v3/conversations/" + encodeURIComponent(conversation) + "/activities");
      const id = "sent-" + (posts.length + 1);
      posts.push({ id, body: JSON.parse(bytes.toString()) });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id }));
    } catch (error) { platformError = error; res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  const local = "http://127.0.0.1:" + (platform.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { platform.close(resolve); platform.closeAllConnections(); }));
  const fetchTeams: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === downloadUrl) return fetch(local + "/source", init);
    if (url.href === uploadUrl) return fetch(local + "/upload", init);
    assert.equal(url.origin, "https://smba.trafficmanager.net");
    return fetch(local + url.pathname, init);
  };
  let onActivity: ((activity: ReturnType<typeof activity>) => Promise<{ status: number }>) | undefined;
  const initialize = App.prototype.initialize;
  let envelope = 0;
  t.mock.method(App.prototype, "initialize", async function(this: App) {
    assert(this.socketMode);
    Object.assign(this.tokenProvider, { async getAppToken() { return { toString: () => "syntheticConnectorAccess" }; } });
    Object.assign(this.socketMode, {
      createConnection(_url: string, handlers: {
        onReady(frame: { connectionId: string }): void;
        onActivity(envelope: unknown): Promise<{ status: number }>;
      }) {
        return {
          async start() {
            handlers.onReady({ connectionId: "test-teams-socket" });
            onActivity = activity => handlers.onActivity({
              protocolVersion: 1, envelopeId: "activity-" + (++envelope),
              type: activity.type === "invoke" ? "invoke" : "message", ackRequired: activity.type !== "invoke", payload: activity,
            });
          },
          async stop() {},
        };
      },
    });
    await initialize.call(this);
  });
  let controller: AbortController;
  let done: Promise<void>;
  let connectorError: unknown;
  const start = () => {
    onActivity = undefined;
    controller = new AbortController();
    done = runTeams(config, controller.signal, { fetchTeams, log: () => {} });
    void done.catch(error => { connectorError = error; });
  };
  const stop = async () => { controller?.abort(); await done; };
  stopConnector = stop;
  const wait = <T>(read: () => T, ready: (value: T) => boolean) =>
    until(async () => { if (connectorError) throw connectorError; if (platformError) throw platformError; return read(); }, ready);
  const activity = (id: string, patch: Record<string, unknown> = {}) => ({
    id, type: "message", channelId: "msteams", serviceUrl,
    from: { id: "29:local-test", aadObjectId: userId },
    recipient: { id: "28:" + clientId },
    conversation: { id: conversation, conversationType: "personal", tenantId },
    ...patch,
  });
  const stateFile = join(config.dataDir, "teams", tenantId + "-" + clientId + ".json");
  const statusFile = async () => JSON.parse(await readFile(stateFile, "utf8"));
  start();
  await wait(() => Boolean(onActivity), Boolean);
  await onActivity!(activity("outsider", { text: "Wrong sender", from: { id: "29:other", aadObjectId: stranger } }));
  await onActivity!(activity("outside", { text: "Wrong service", serviceUrl: "https://outside.invalid/teams" }));
  const input = activity("in-1", { text: "Prepare the Teams report with the file.",
    attachments: [{ contentType: "application/vnd.microsoft.teams.file.download.info", name: "input.txt",
      content: { downloadUrl, fileType: "txt" } }] });
  assert.equal((await onActivity!(input)).status, 200);
  const stored = await statusFile();
  assert(Object.keys(stored.inbox).length || Object.keys(stored.handled).length);
  await onActivity!(input);
  const card = (post: { body: any }) => post.body.attachments?.[0];
  const findCard = async (type: string, match: string) => (await wait(() => posts.find(post =>
    card(post)?.contentType === type && JSON.stringify(card(post)?.content).includes(match)) ?? null, Boolean))!;
  const adaptive = "application/vnd.microsoft.card.adaptive";
  const brief = await findCard(adaptive, "Prepare the Teams report.");
  const task = (await client.request<{ id: string }[]>("/v1/tasks"))[0];
  assert(task);
  const workspace = (await daemon.runtime.status(task.id)).workspace;
  const attachments = join(workspace, "attachments");
  assert.deepEqual(await readFile(join(attachments, (await readdir(attachments))[0]!, "input.txt")), source);
  assert.equal(downloads, 1);
  phase = "question";
  const confirm = card(brief).content.actions[0].data;
  await onActivity!(activity("reject-confirm", { value: confirm, from: { id: "29:other", aadObjectId: stranger } }));
  assert.equal((await daemon.runtime.status(task.id)).status, "awaiting_confirmation");
  await onActivity!(activity("confirm", { value: confirm }));
  const question = await findCard(adaptive, "Which report format?");
  await until(async () => Object.values((await statusFile()).outbox).some((post: any) => post.messageId === question.id), Boolean);
  await stop();
  await daemon.close();
  daemon = await open();
  assert.equal((await daemon.runtime.status(task.id)).status, "waiting_user");
  phase = "write";
  start();
  await wait(() => Boolean(onActivity), Boolean);
  await onActivity!(activity("answer", { value: { ...card(question).content.actions[0].data, answer: "CSV" } }));
  const offer = await findCard("application/vnd.microsoft.teams.card.file.consent", "report.txt");
  assert.equal(uploads.length, 0);
  const firstKey = card(offer).content.acceptContext.sendId;
  const consent = (id: string, context: object, action = "accept") => activity(id, { type: "invoke", name: "fileConsent/invoke", value: {
    type: "fileUpload", action, context,
    uploadInfo: { uploadUrl, contentUrl, uniqueId: "test-file-id", name: "report.txt", fileType: "txt" },
  } });
  await onActivity!(consent("decline", card(offer).content.declineContext, "decline"));
  await until(async () => (await statusFile()).offers[firstKey]?.status, value => value === "declined");
  await onActivity!(consent("late-consent", card(offer).content.acceptContext));
  await onActivity!(activity("first-reoffer", { text: "!delivery" }));
  const offers = () => posts.filter(post => card(post)?.contentType === "application/vnd.microsoft.teams.card.file.consent");
  const second = (await wait(() => offers()[1] ?? null, Boolean))!;
  assert.equal(uploads.length, 0);
  const reportPath = join(workspace, "report.txt");
  await writeFile(reportPath, "Unverified content.");
  await onActivity!(consent("changed-consent", card(second).content.acceptContext));
  await wait(() => posts.some(post => post.body.text?.includes("could not be uploaded")), Boolean);
  assert.equal(uploads.length, 0);
  await writeFile(reportPath, "Verified Teams report.\r\n");
  await onActivity!(activity("second-reoffer", { text: "!delivery" }));
  const third = (await wait(() => offers()[2] ?? null, Boolean))!;
  const accept = consent("accept-file", card(third).content.acceptContext);
  await until(async () => (await statusFile()).outbox[card(third).content.acceptContext.sendId]?.messageId, id => id === third.id);
  await stop();
  start();
  await wait(() => Boolean(onActivity), Boolean);
  assert.equal((await onActivity!(accept)).status, 200);
  const delivery = await findCard("application/vnd.microsoft.teams.card.file.info", "test-file-id");
  assert.equal(card(delivery).contentUrl, contentUrl);
  await onActivity!(accept);
  await stop();
  assert.deepEqual(uploads, [Buffer.from("Verified Teams report.\r\n")]);
  const final = await daemon.runtime.status(task.id);
  assert.equal(final.status, "completed");
  assert.equal(final.messages.filter(row => row.role === "user" && row.content === "CSV").length, 1);
  assert.equal((await client.request<{ id: string }[]>("/v1/tasks")).length, 1);
  assert.equal(platformError, undefined);
});
