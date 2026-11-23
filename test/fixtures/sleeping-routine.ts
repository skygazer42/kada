import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalRoutines } from "../../src/routines.js";

const [, , dataDir, start, due, phase] = process.argv;
let now = Number(start);
const at = Number(due);
const routines = new LocalRoutines({
  dataDir,
  now: () => now,
  setTimer(callback, delay) {
    if (now + delay !== at) return () => {};
    if (phase === "sleeping") {
      process.stdout.write("sleeping\n");
      return () => {};
    }
    const timer = setImmediate(() => {
      now = at;
      callback();
    });
    return () => clearImmediate(timer);
  },
  execute: async ({ id, taskId }) => {
    if (phase !== "claimed") throw new Error("This fixture should be killed while sleeping.");
    await writeFile(join(dataDir, "task-" + taskId + ".json"), JSON.stringify({ id, taskId }), { flag: "wx" });
    process.stdout.write("claimed\n");
    return new Promise(() => {});
  },
});
// Keep the fixture alive after the test observes the native wait or the submitted child task.
setInterval(() => {}, 60_000);
await routines.create({
  id: "restart",
  action: phase === "claimed" ? "task" : "notify",
  objective: "Reminder after restart",
  schedule: { kind: "once", at: new Date(at).toISOString() },
  missedPolicy: phase === "claimed" ? "skip" : "run_once",
});
process.stdout.write("opened\n");
