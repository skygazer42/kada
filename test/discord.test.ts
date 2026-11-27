import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { runDiscord } from "../src/discord.js";
import { serve } from "../src/server.js";
import { scriptedFixture, until } from "./helpers.js";

const userId = "925474099300071111";
const botId = "925474099300071112";
const channelId = "925474099300071113";
const settings = { userId, botTokenEnv: "KADA_TEST_DISCORD_BOT", pairingTokenEnv: "KADA_TEST_DISCORD_PAIR" };

test("Discord preserves the original private task across REST backfill, confirmation and daemon restart", { timeout: 65_000 }, async t => {
  let phase = "brief";
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(context => {
    if (phase === "brief") return tool("task_prepare", {
      outcome: "Prepare the Discord report.", deliverables: ["report.txt"], criteria: [{ text: "Inspect report.txt", method: "inspect" }],
      assumptions: [], inputs: [], scope: ["This conversation"], questions: [],
    });
    if (phase === "question") return tool("ask_user", { question: "Which report format?", options: ["CSV", "Text"] });
    assert(context.messages.some(message => message.role === "user" && message.content === "CSV"));
    if (phase === "write") {
      phase = "submit";
      return tool("write", { path: "report.txt", content: "Verified Discord report.\r\n" });
    }
    return tool("task_submit", { summary: "The Discord report is ready.", artifacts: ["report.txt"],
      criteria: [{ id: 1, status: "passed", evidence: "Inspected report.txt." }] });
  });
  await fixture.runtime.close();
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const path = join(fixture.directory, "config.json");
  const load = async (discord: unknown) => {
    await writeFile(path, JSON.stringify({ ...fixture.settings, port, remoteOrigin: "https://desktop.example.test", discord }));
    return loadConfig(path);
  };
  let cleanup = () => fixture.close();
  t.after(() => cleanup());
  assert.equal((await load(undefined)).discord, undefined);
  await assert.rejects(load({ ...settings, userId: 925474099300071111 }), /discord/i);
  await assert.rejects(load({ ...settings, token: "unexpected" }), /discord/i);
  const config = await load(settings);
  assert.deepEqual(config.discord, settings);
  const open = () => serve(config, { models: fixture.models });
  let daemon = await open();
  let stopConnector = async () => {};
  cleanup = async () => {
    try { await stopConnector(); }
    finally { await daemon.close(); await fixture.close(); }
  };
  const client = createClient(config);
  const { token } = await client.request<{ token: string }>("/v1/remote/devices", "POST", { accountId: "personal", deviceId: "discord" });
  const botToken = "syntheticDiscordFixtureToken";
  for (const [name, value] of [[settings.botTokenEnv, botToken], [settings.pairingTokenEnv, token]] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  let nextId = 925474099300072010n;
  const message = (content: string, author = userId, replyTo?: string, attachments: unknown[] = []) => ({
    id: String(nextId++), channel_id: channelId, author: { id: author }, content, attachments,
    ...(replyTo ? { message_reference: { message_id: replyTo } } : {}),
  });
  const old = message("A message from before pairing.");
  const history = [old];
  const sends: { id: string; content: string; nonce: string; bytes?: Buffer }[] = [];
  const requestedAfter: string[] = [];
  const messagesPath = "/api/v10/channels/" + channelId + "/messages";
  const sourceBytes = Buffer.from("item,quantity\r\npaper,2\r\n");
  let downloads = 0;
  let discardFileResponse = true;
  let rateLimitedNonce: string | undefined;
  let wrongPeer = true;
  let platformError: unknown;
  const fake = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://127.0.0.1");
      const sendJson = (data: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      if (url.pathname === "/source-file") {
        assert.equal(request.headers.authorization, undefined);
        downloads++;
        response.writeHead(200).end(sourceBytes);
        return;
      }
      assert.equal(request.headers.authorization, "Bot " + botToken);
      if (url.pathname === "/api/v10/users/@me") { sendJson({ id: botId, bot: true }); return; }
      if (url.pathname === "/api/v10/users/@me/channels") {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        assert.deepEqual(JSON.parse(Buffer.concat(parts).toString()), { recipient_id: userId });
        sendJson({ id: channelId, type: 1, recipients: [{ id: wrongPeer ? "925474099300071114" : userId }] });
        return;
      }
      assert.equal(url.pathname, messagesPath);
      if (request.method === "GET") {
        const after = url.searchParams.get("after");
        if (after) requestedAfter.push(after);
        const limit = Number(url.searchParams.get("limit"));
        assert([1, 100].includes(limit));
        const selected = after ? history.filter(row => BigInt(row.id) > BigInt(after)).slice(0, limit) : history.slice(-limit);
        sendJson(selected.toReversed());
        return;
      }
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const bytes = Buffer.concat(parts);
      const contentType = request.headers["content-type"];
      let record: { content?: string; nonce: string; enforce_nonce: boolean; allowed_mentions: { parse: string[] } };
      let output: Buffer | undefined;
      if (contentType?.startsWith("multipart/form-data")) {
        const form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType } }).formData();
        record = JSON.parse(String(form.get("payload_json")));
        const file = form.get("files[0]") as File;
        assert.equal(file.name, "report.txt");
        output = Buffer.from(await file.arrayBuffer());
      } else record = JSON.parse(bytes.toString());
      assert.equal(record.enforce_nonce, true);
      assert.match(record.nonce, /^[A-Za-z0-9_-]{25}$/);
      assert.deepEqual(record.allowed_mentions.parse, []);
      if (record.content?.includes("Prepare the Discord report.") && rateLimitedNonce === undefined) {
        rateLimitedNonce = record.nonce;
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0.05" })
          .end(JSON.stringify({ message: "You are being rate limited.", retry_after: 0.05 }));
        return;
      }
      const row = message(record.content ?? "", botId);
      history.push(row);
      sends.push({ id: row.id, content: row.content, nonce: record.nonce, bytes: output });
      if (output && discardFileResponse) {
        discardFileResponse = false;
        response.destroy();
      } else sendJson(row);
    } catch (error) {
      platformError = error;
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { fake.close(resolve); fake.closeAllConnections(); }));
  const local = "http://127.0.0.1:" + (fake.address() as { port: number }).port;
  const fetchDiscord: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://cdn.discordapp.com") {
      assert.equal(url.pathname, "/attachments/" + channelId + "/source.csv");
      return fetch(local + "/source-file", init);
    }
    assert.equal(url.origin, "https://discord.com");
    return fetch(local + url.pathname + url.search, init);
  };
  await assert.rejects(runDiscord(config, AbortSignal.timeout(5000), { fetchDiscord }), /private channel|private DM|authorized user/i);
  wrongPeer = false;
  const logs: string[] = [];
  let controller: AbortController;
  let done: Promise<void>;
  let connectorError: unknown;
  const start = () => {
    controller = new AbortController();
    done = runDiscord(config, controller.signal, { fetchDiscord, log: line => logs.push(line) });
    void done.catch(error => { connectorError = error; });
  };
  const stop = async () => { controller?.abort(); await done; };
  stopConnector = stop;
  const seen = async (part: string) => (await until(async () => {
    if (connectorError) throw connectorError;
    if (platformError) throw platformError;
    return sends.find(post => post.content.includes(part)) ?? null;
  }, Boolean))!;
  const tasks = () => client.request<{ id: string }[]>("/v1/tasks");
  start();
  await until(async () => requestedAfter.includes(old.id), Boolean);
  await stop();
  assert.deepEqual(await tasks(), []);
  for (let index = 0; index < 101; index++) history.push(message("Outside the authorized user.", "925474099300071114"));
  history.push(message("Create the Discord report.", userId, undefined, [
    { filename: "source.csv", size: sourceBytes.length, content_type: "text/csv", url: "https://cdn.discordapp.com/attachments/" + channelId + "/source.csv" },
  ]));
  start();
  const brief = await seen("Prepare the Discord report.");
  assert.equal(brief.nonce, rateLimitedNonce);
  assert.match(brief.content, /Inspect report\.txt/);
  assert.match(brief.content, /!confirm/);
  const rows = await tasks();
  assert.equal(rows.length, 1);
  const id = rows[0]!.id;
  const original = await daemon.runtime.status(id);
  const attachments = join(original.workspace, "attachments");
  assert.deepEqual(await readFile(join(attachments, (await readdir(attachments))[0]!, "source.csv")), sourceBytes);
  assert.equal(downloads, 1);
  history.push(message("!confirm"));
  await seen("Reply to the original task brief");
  assert.equal((await daemon.runtime.status(id)).status, "awaiting_confirmation");
  phase = "question";
  history.push(message("!confirm", userId, brief.id));
  const question = await seen("Which report format?");
  await stop();
  await daemon.close();
  daemon = await open();
  assert.equal((await daemon.runtime.status(id)).status, "waiting_user");
  phase = "write";
  history.push(message("CSV", userId, question.id));
  start();
  const delivered = await until(async () => sends.find(post => post.bytes) ?? null, Boolean);
  assert.deepEqual(delivered?.bytes, Buffer.from("Verified Discord report.\r\n"));
  await stop();
  start();
  history.push(message("!status"));
  await seen("Unconfirmed Discord sends: 1");
  assert.equal(sends.filter(post => post.bytes).length, 1);
  history.push(message("!delivery"));
  const offers = await until(async () => sends.filter(post => post.bytes), rows => rows.length === 2);
  assert.deepEqual(offers[1]?.bytes, delivered?.bytes);
  assert.notEqual(offers[1]?.nonce, delivered?.nonce);
  history.push(message("File URL outside the DM.", userId, undefined, [
    { filename: "source.csv", size: sourceBytes.length, url: "https://cdn.discordapp.com/attachments/999999999999999999/source.csv" },
  ]));
  await seen("Kada could not use this document");
  assert.equal(downloads, 1);
  assert.equal((await daemon.runtime.status(id)).status, "completed");
  assert.equal((await tasks()).length, 1);
  assert(!logs.some(line => line.includes(botToken) || line.includes(token)));
  assert.equal(platformError, undefined);
});
