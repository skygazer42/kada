import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { demoModels } from "../src/models.js";
import { LocalRuntime, type RuntimeOptions } from "../src/runtime.js";
import { prepareDemo } from "../src/demo.js";
import type { Config } from "../src/config.js";
import { createModels, fauxProvider, getCurrentTools, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";

export function hasTool(context: TranscriptContext, name: string): boolean { return getCurrentTools(context.messages).some(t => t.name === name); }

export function fakeRoutineClock(start: number) {
  let now = start;
  const pending = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delay: number) {
      const timer = { at: now + delay, callback };
      pending.add(timer);
      return () => { pending.delete(timer); };
    },
    advanceTo(at: number) {
      now = at;
      while (true) {
        const due = [...pending].filter(timer => timer.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) return;
        for (const timer of due) if (pending.delete(timer)) timer.callback();
      }
    },
    waitingAt(at: number) {
      return [...pending].some(timer => timer.at === at);
    },
  };
}

export async function demoFixture(delayMs = 0, maxDurationMs = 30_000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-harness-")));
  const workspace = join(directory, "workspace");
  await prepareDemo(workspace);
  const { models, ref } = demoModels(workspace, { delayMs });
  const config: Config = { dataDir: directory, port: 4317, model: ref, maxSubagents: 2, maxDurationMs, review: true, web: false, discovery: false };
  const runtime = new LocalRuntime(config, { models });
  return { directory, workspace, config, runtime, models, async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); } };
}
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(value).slice(0, 4000)}`);
    await setTimeout(25);
  }
}

const recoveryWorkerTimeoutMs = 45_000;
export const recoveryTestTimeoutMs = 2 * recoveryWorkerTimeoutMs + 10_000;

export function startRecoveryWorker(fixture: URL, phase: "create" | "recover", ...args: string[]) {
  const path = fileURLToPath(fixture);
  const child = spawn(process.execPath, ["--import", "tsx", path, phase, ...args], {
    stdio: ["ignore", "pipe", "pipe"], timeout: recoveryWorkerTimeoutMs, killSignal: "SIGKILL",
  });
  const stdout: string[] = [];
  let stderr = "";
  let spawnError: Error | undefined;
  const readyLine = Promise.withResolvers<string | undefined>();
  createInterface({ input: child.stdout }).on("line", line => {
    stdout.push(line);
    if (line.startsWith('{"type":"ready"')) readyLine.resolve(line);
  });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.once("error", error => { spawnError = error; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => {
      readyLine.resolve(undefined);
      resolve({ code, signal });
    });
  });
  const diagnostics = async () => {
    const { code, signal } = await closed;
    return `${phase} worker ${path} exited with ${signal ?? code} (timeout ${recoveryWorkerTimeoutMs}ms)\n${spawnError ?? ""}\nstdout: ${stdout.join("\n")}\nstderr: ${stderr}`;
  };
  return {
    async ready() {
      const line = await readyLine.promise;
      if (line === undefined) assert.fail(`Worker did not become ready. ${await diagnostics()}`);
      return JSON.parse(line);
    },
    async complete() {
      const { code } = await closed;
      if (code !== 0) assert.fail(`Worker did not complete. ${await diagnostics()}`);
      const line = stdout.at(-1);
      if (line === undefined) assert.fail(`Worker did not report a result. ${await diagnostics()}`);
      return JSON.parse(line);
    },
    async stop() {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return (await closed).signal;
    },
  };
}

export async function scriptedFixture(respond: (context: TranscriptContext, signal?: AbortSignal) => AssistantMessage | Promise<AssistantMessage>, config: Partial<Config> = {}, extensions: (workspace: string) => Extension[] | Promise<Extension[]> = () => [], options: Omit<RuntimeOptions, "models" | "extensions"> = {}) {
  const f = await demoFixture();
  const faux = fauxProvider({ provider: "local-test", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 256 }, () => (context, options) => respond(context, options?.signal)));
  const models = createModels(); models.setProvider(faux.provider);
  const settings = { ...f.config, model: { provider: "local-test", modelId: "scripted" }, review: false, ...config };
  const runtime = new LocalRuntime(settings, { ...options, models, extensions: await extensions(f.workspace) });
  return { ...f, runtime, settings, models, async close() { await runtime.close(); await f.close(); } };
}
