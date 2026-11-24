import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Harness } from "@earendil-works/pi-durable";
import { LocalRoutines } from "../../src/routines.js";

const [, , dataDir, start, due, phase] = process.argv;
let now = Number(start);
const at = Number(due);
const control = phase === "pause" || phase === "cancel" || phase === "update";
const sleeping = Promise.withResolvers<void>();
const routines = new LocalRoutines({
  dataDir,
  now: () => now,
  setTimer(callback, delay) {
    if (now + delay !== at) return () => {};
    if (phase === "sleeping" || control) {
      if (control) sleeping.resolve();
      else process.stdout.write("sleeping\n");
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
  schedule: control ? { kind: "daily", time: "00:01", timeZone: "UTC" } : { kind: "once", at: new Date(at).toISOString() },
  missedPolicy: phase === "claimed" ? "skip" : "run_once",
});
if (control) {
  await sleeping.promise;
  const { harness } = await (routines as unknown as { open(): Promise<{ harness: Harness }> }).open();
  harness.abortTask = async () => {
    process.stdout.write(`${phase}\n`);
    return new Promise(() => {});
  };
  if (phase === "pause") await routines.pause("restart");
  else if (phase === "cancel") await routines.cancel("restart");
  else await routines.update("restart", {
    action: "notify", objective: "Edited reminder", schedule: { kind: "once", at: new Date(at + 60_000).toISOString() },
  });
}
process.stdout.write("opened\n");
