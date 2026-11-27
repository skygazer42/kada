import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSocket } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { serve } from "../src/server.js";
import { runTelegram } from "../src/telegram.js";
import { hasTool, scriptedFixture, until } from "./helpers.js";

const telegramConfig = { userId: 25001, botTokenEnv: "KADA_TEST_TELEGRAM_BOT", pairingTokenEnv: "KADA_TEST_TELEGRAM_PAIR" };

test("Telegram is opt-in and config stores environment variable names and one private user", async t => {
  const directory = await mkdtemp(join(tmpdir(), "kada-telegram-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "config.json");
  const config = async (telegram?: unknown) => {
    await writeFile(file, JSON.stringify({ telegram }));
    return loadConfig(file);
  };
  assert.equal((await config()).telegram, undefined);
  assert.deepEqual((await config(telegramConfig)).telegram, telegramConfig);
  await assert.rejects(config({ ...telegramConfig, userId: -1 }), /telegram/);
  await assert.rejects(config({ ...telegramConfig, botTokenEnv: "not a variable" }), /telegram/);
  await assert.rejects(config({ ...telegramConfig, token: "unexpected" }), /telegram/);
});

test("Telegram private chat confirms the original brief, resumes its question and delivers verified bytes", { timeout: 45_000 }, async t => {
  let stage = "prepare";
  let childAnswers = 0;
  const tool = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const fixture = await scriptedFixture(context => {
    if (stage === "new-chat") return fauxAssistantMessage("Answer in the new conversation.");
    const users = context.messages.filter(message => message.role === "user");
    if (hasTool(context, "delegation_ask")) {
      if (users.some(message => message.content === "Use blue.")) {
        childAnswers++;
        return fauxAssistantMessage("The child chose blue.");
      }
      return tool("delegation_ask", { question: "Which report color?" });
    }
    if (stage === "prepare") return tool("task_prepare", {
      outcome: "Deliver the Telegram report.", deliverables: ["report.txt"], inputs: [], scope: ["This workspace"],
      assumptions: ["Use the chosen format."], questions: [], criteria: [{ text: "Inspect report.txt", method: "inspect" }],
    });
    if (stage === "question") return tool("ask_user", { question: "Which format?", options: ["CSV", "Text"] });
    assert(users.some(message => message.content === "CSV"));
    if (stage === "delegate") {
      stage = "child";
      return tool("delegate_background", { tasks: [{ name: "Color worker", instructions: "Ask which report color to use." }] });
    }
    if (stage === "child" && !users.some(message => String(message.content).startsWith("Background delegation finished."))) {
      return fauxAssistantMessage("Waiting on the color worker.");
    }
    if (stage === "child") {
      stage = "submit";
      return tool("write", { path: "report.txt", content: "Kada telegram proof\r\n" });
    }
    return tool("task_submit", { summary: "Report delivered.", artifacts: ["report.txt"],
      criteria: [{ id: 1, status: "passed", evidence: "Inspected report.txt." }] });
  });
  await fixture.runtime.close();
  const socket = createSocket();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const config = { ...fixture.settings, port, remoteOrigin: "https://host.example.test", telegram: telegramConfig };
  const open = () => serve(config, { models: fixture.models });
  let daemon = await open();
  let stopConnector = async () => {};
  t.after(async () => {
    try { await stopConnector(); }
    finally { await daemon.close(); await fixture.close(); }
  });
  const client = createClient(config);
  const pairing = await client.request<{ token: string }>("/v1/remote/devices", "POST", { accountId: "private", deviceId: "telegram" });
  const botToken = "60001:" + "syntheticFixtureKey".repeat(2);
  for (const [name, value] of [[telegramConfig.botTokenEnv, botToken], [telegramConfig.pairingTokenEnv, pairing.token]] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const updates: { update_id: number; message?: unknown; callback_query?: unknown }[] = [];
  const posts: { id: number; text: string; buttons?: unknown; document?: Buffer }[] = [];
  const offsets: number[] = [];
  const logs: string[] = [];
  const originalInput = Buffer.from("key,value\r\nTG-1,42\r\n");
  let downloads = 0;
  let repeatFirst = false;
  let dropDocument = true;
  let platformError: unknown;
  const platform = createServer(async (req, res) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const bytes = Buffer.concat(parts);
      const ok = (result: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, result }));
      const method = req.url?.split("/").at(-1);
      if (method === "telegram-file") {
        downloads++;
        res.writeHead(200, { "Content-Type": "text/csv" }).end(originalInput);
        return;
      }
      if (method === "sendDocument") {
        const form = await new Response(bytes as Uint8Array<ArrayBuffer>, {
          headers: { "Content-Type": req.headers["content-type"]! },
        }).formData();
        assert.equal(form.get("chat_id"), String(telegramConfig.userId));
        const file = form.get("document") as File;
        assert.equal(file.name, "report.txt");
        const post = { id: 100 + posts.length, text: "", document: Buffer.from(await file.arrayBuffer()) };
        posts.push(post);
        if (dropDocument) {
          dropDocument = false;
          res.destroy();
        } else ok({ message_id: post.id });
        return;
      }
      const body = JSON.parse(bytes.toString());
      if (method === "getUpdates") {
        offsets.push(body.offset ?? 0);
        await setTimeout(35);
        const rows = updates.filter(row => row.update_id >= (body.offset ?? 0));
        if (repeatFirst && body.offset > 3) { repeatFirst = false; rows.unshift(updates[2]!); }
        ok(rows);
      } else if (method === "getFile") {
        assert.equal(body.file_id, "attached-input-file");
        ok({ file_path: "documents/input.csv", file_size: originalInput.length });
      } else if (method === "sendMessage") {
        assert.equal(Number(body.chat_id), telegramConfig.userId);
        const post = { id: 100 + posts.length, text: body.text, buttons: body.reply_markup?.inline_keyboard };
        posts.push(post);
        ok({ message_id: post.id });
      } else if (method === "answerCallbackQuery") {
        assert.equal(body.callback_query_id, "confirm-6");
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
          ok: false, error_code: 400, description: "Bad Request: query is too old",
        }));
      }
      else assert.fail("Unexpected Bot API method " + method);
    } catch (error) {
      platformError = error;
      res.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  const api = "http://127.0.0.1:" + (platform.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { platform.close(resolve); platform.closeAllConnections(); }));
  const fetchTelegram: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, "https://api.telegram.org");
    if (url.pathname.startsWith("/file/bot")) {
      assert.equal(url.pathname, "/file/bot" + botToken + "/documents/input.csv");
      return fetch(api + "/telegram-file", init);
    }
    assert(url.pathname.startsWith("/bot" + botToken + "/"));
    return fetch(api + "/" + url.pathname.split("/").at(-1), init);
  };
  let controller: AbortController;
  let done: Promise<void>;
  let connectorError: unknown;
  const start = () => {
    controller = new AbortController();
    done = runTelegram(config, controller.signal, { fetchTelegram, log: line => logs.push(line) });
    void done.catch(error => { connectorError = error; });
  };
  const stop = async () => { controller?.abort(); await done; };
  stopConnector = stop;
  const message = (update_id: number, text: string, from = telegramConfig.userId, type = "private", reply?: number) =>
    ({ update_id, message: { message_id: update_id + 10, chat: { id: telegramConfig.userId, type },
      from: { id: from }, text, ...(reply ? { reply_to_message: { message_id: reply } } : {}) } });
  const confirm = (update_id: number, id: number, from = telegramConfig.userId) =>
    ({ update_id, callback_query: { id: "confirm-" + update_id, from: { id: from }, data: "confirm",
      message: { message_id: id, chat: { id: telegramConfig.userId, type: "private" } } } });
  const published = async (text: string) => (await until(async () => {
    if (connectorError) throw connectorError;
    if (platformError) throw platformError;
    return posts.find(post => post.text.includes(text)) ?? null;
  }, Boolean))!;

  const submitted = message(3, "Create the Telegram report.");
  const document = { file_id: "attached-input-file", file_name: "input.csv", mime_type: "text/csv", file_size: originalInput.length };
  updates.push(message(1, "Wrong sender", 91), message(2, "Group message", telegramConfig.userId, "group"),
    { ...submitted, message: { ...submitted.message, text: undefined, caption: submitted.message.text, document } });
  repeatFirst = true;
  start();
  const brief = await published("Deliver the Telegram report.");
  assert.match(brief.text, /Inspect report\.txt/);
  assert(brief.buttons);
  const tasks = () => client.request<{ id: string; status: string }[]>("/v1/tasks");
  const [task] = await tasks();
  assert(task);
  const originalTask = await daemon.runtime.status(task.id);
  const attachmentDir = join(originalTask.workspace, "attachments");
  const [upload] = await readdir(attachmentDir);
  assert(upload);
  assert.deepEqual(await readFile(join(attachmentDir, upload, "input.csv")), originalInput);
  await stop();
  const stateFile = join(config.dataDir, "telegram", "60001.json");
  const firstState = JSON.parse(await readFile(stateFile, "utf8"));
  const firstPollCount = offsets.length;
  await writeFile(stateFile, JSON.stringify({ ...firstState, offset: 3 }));
  start();
  await until(async () => offsets.slice(firstPollCount).includes(4), Boolean);
  assert.equal(downloads, 1);
  updates.push(message(4, "/status"));
  const restoredBrief = (await until(async () => posts.filter(post => post.buttons).at(1) ?? null, Boolean, 5000))!;
  assert.equal(restoredBrief.text, brief.text);
  stage = "question";
  updates.push(confirm(5, restoredBrief.id, 91));
  await until(async () => offsets.includes(6), Boolean);
  assert.equal((await daemon.runtime.status(task.id)).status, "awaiting_confirmation");
  await assert.rejects(runTelegram(config, AbortSignal.timeout(1000), { fetchTelegram }), /Lock file is already being held/i);
  updates.push(confirm(6, restoredBrief.id));
  const question = await published("Which format?");
  assert.match(question.text, /CSV/);
  await stop();
  await daemon.close();
  daemon = await open();
  stage = "delegate";
  updates.push(message(7, "CSV", telegramConfig.userId, "private", question.id));
  start();
  const childQuestion = await published("Which report color?");
  updates.push(message(8, "Use blue.", telegramConfig.userId, "private", childQuestion.id));
  const original = await until(async () => posts.find(post => post.document), Boolean);
  assert.deepEqual(original?.document, Buffer.from("Kada telegram proof\r\n"));
  await stop();
  start();
  updates.push(message(9, "/status"));
  assert.match((await published("Unconfirmed Telegram sends: 1")).text, /1/);
  assert.equal(posts.filter(post => post.document).length, 1);
  updates.push(message(10, "/delivery"));
  await until(async () => posts.filter(post => post.document), rows => rows.length === 2);
  assert.deepEqual(posts.filter(post => post.document)[1]?.document, original?.document);
  await until(async () => offsets.includes(11), Boolean);
  const final = await daemon.runtime.status(task.id);
  assert.equal(final.status, "completed");
  assert.equal(final.messages.filter(item => item.role === "user" && item.content === "CSV").length, 1);
  assert.equal(childAnswers, 1);
  assert.equal((await tasks()).length, 1);
  await stop();
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  await writeFile(stateFile, JSON.stringify({ ...state, lastUpdateAt: Date.now() - 7 * 24 * 60 * 60 * 1000 }));
  updates.length = 0;
  const arriving = message(1, "/new");
  arriving.message.message_id = 1001;
  updates.push(arriving);
  start();
  await published("New Kada conversation.");
  stage = "new-chat";
  const nextMessage = message(2, "A new conversation.");
  nextMessage.message.message_id = 1002;
  updates.push(nextMessage);
  await published("Answer in the new conversation.");
  assert.equal((await tasks()).length, 2);
  const oldDelivery = posts.find(post => post.document && post.id !== original?.id)!;
  const originalStatus = message(3, "/status", telegramConfig.userId, "private", oldDelivery.id);
  originalStatus.message.message_id = 1003;
  updates.push(originalStatus);
  await until(async () => posts.filter(post => post.text.includes("Kada task: completed")).length, count => count === 2);
  const large = message(4, "Oversized document.");
  updates.push({ ...large, message: { ...large.message, message_id: 1004, text: undefined, caption: large.message.text,
    document: { ...document, file_size: 5 * 1024 * 1024 + 1 } } });
  await published("5 MiB attachment limit");
  assert.equal(downloads, 1);
  assert.equal((await tasks()).length, 2);
  assert(!logs.some(line => line.includes(botToken) || line.includes(pairing.token)));
  assert.equal(platformError, undefined);
});
