import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryTestTimeoutMs, startRecoveryWorker } from "./helpers.js";

test("SIGKILL during two live subagents recovers without duplicating children", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-crash-")));
  const fixture = new URL("./fixtures/recovery-worker.ts", import.meta.url);
  let worker = startRecoveryWorker(fixture, "create", directory);
  try {
    const before = await worker.ready();
    assert.equal(before.ids.length, 3);
    assert.equal(await worker.stop(), "SIGKILL");
    await writeFile(join(directory, "release"), "resume");
    worker = startRecoveryWorker(fixture, "recover", directory);
    const after = await worker.complete();
    assert.equal(after.type, "completed");
    assert.deepEqual(after.ids, before.ids);
    assert.deepEqual(after.delegations.map((child:{conversationId:string}) => child.conversationId),before.delegations.map((child:{conversationId:string}) => child.conversationId));
    assert.equal(after.delegations.length,2);
    assert(after.delegations.every((child:{parentTaskId:string;status:string;answer?:string;usage:{totalTokens:number}}) => child.parentTaskId === before.taskId && child.status === 'completed' && child.answer && child.usage.totalTokens >= 0));
    const report = await readFile(join(directory, "workspace", "report.md"), "utf8");
    assert.match(report, /Alpha source/);
    assert.match(report, /Beta source/);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
