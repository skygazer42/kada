import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { LocalRuntime } from "../../src/runtime.js";
import { fakeRoutineClock, until } from "../helpers.js";

const [mode, dataDir] = process.argv.slice(2) as ["create" | "recover", string];
const manual = process.argv[4] === "manual";
const workspace = join(dataDir, "workspace");
const due = Date.UTC(2026, 10, 23, 12);
const clock = fakeRoutineClock(mode === "create" || manual ? due - 60_000 : due + 60_000);
const model = { provider: "precheck-fixture", modelId: "scripted" };
const provider = fauxProvider({ provider: model.provider, models: [{ id: model.modelId }] });
let modelCalls = 0;
provider.setResponses([() => {
  modelCalls++;
  return fauxAssistantMessage("The precheck should not have created a task.");
}]);
const models = createModels();
models.setProvider(provider.provider);
const runtime = new LocalRuntime({ dataDir, port: 4317, model, maxSubagents: 1, maxDurationMs: 60_000, web: false, review: false, discovery: false },
  { models, routineClock: clock });
const routineId = "crash-precheck";
const script = String.raw`
  const fs = require("node:fs");
  const marker = "check-attempts.txt";
  const first = !fs.existsSync(marker);
  fs.appendFileSync(marker, "started\n");
  if (first) {
    const parent = process.ppid;
    const timer = setInterval(() => {
      try { process.kill(parent, 0); }
      catch { clearInterval(timer); }
    }, 50);
    setTimeout(() => clearInterval(timer), 20000).unref();
  }
`;

try {
  if (mode === "create") {
    await mkdir(workspace);
    await runtime.routines.create({ id: routineId, action: "task", workspace, objective: "Handle a changed observation.",
      precheck: { command: [process.execPath, "-e", script] },
      schedule: { kind: "once", at: new Date(due).toISOString() },
      budget: { maxEstimatedCostUsd: 1, maxDurationMs: 60_000 } });
    if (manual) {
      await runtime.routines.runNow(routineId, "crash-manual");
    } else {
      await until(async () => clock.waitingAt(due), Boolean);
      clock.advanceTo(due);
    }
    await until(async () => existsSync(join(workspace, "check-attempts.txt")) || (await runtime.list()).length > 0, Boolean);
    console.log(JSON.stringify({ type: "ready" }));
    await setTimeout(60_000);
  } else {
    await runtime.recover();
    const history = await until(async () => (await runtime.routines.history(routineId)).filter(row => Boolean(row.trigger) === manual), rows => rows.some(row => row.status !== "claimed"));
    console.log(JSON.stringify({ type: "completed", history: history.map(row => [row.status, row.precheck?.status, row.trigger ?? "scheduled"]),
      tasks: (await runtime.list()).map(task => task.id), modelCalls }));
  }
} finally {
  await runtime.close();
}
