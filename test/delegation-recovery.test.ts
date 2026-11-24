import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { recoveryTestTimeoutMs, startRecoveryWorker } from "./helpers.js";

test("SIGKILL during background delegation preserves the child and delivers one parent report", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-delegation-crash-")));
  const fixture = new URL("./fixtures/delegation-worker.ts", import.meta.url);
  let worker = startRecoveryWorker(fixture, "create", directory);
  try {
    const before = await worker.ready();
    const evidence = join(before.childDirectory, "evidence.txt");
    assert.equal(await readFile(evidence, "utf8"), "Durable child evidence.");
    assert.equal(before.childStatus, "running");
    assert.equal(before.workerWrites, 1);
    assert.equal(before.reports, 0);
    assert.equal(before.deliveries, 0);
    assert.equal(await worker.stop(), "SIGKILL");

    const storagePath = join(directory, "tasks", before.taskId, "session.sqlite");
    const childRequest = `delegate:${before.batchId}:${before.childId}`;
    const beforeStorage = await openNodeSqliteStorage(storagePath);
    let childSubmission;
    try {
      childSubmission = await beforeStorage.submissionByRequest(before.childId, childRequest, ctx);
      assert.equal(childSubmission?.status, "placed");
    } finally {
      await beforeStorage.close(ctx);
    }

    worker = startRecoveryWorker(fixture, "recover", directory);
    const after = await worker.complete();
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.childId, before.childId);
    assert.equal(after.batchId, before.batchId);
    assert.equal(after.childStatus, "completed");
    assert.equal(after.workerWrites, 0);
    assert.equal(after.reports, 1);
    assert.equal(after.deliveries, 1);
    assert.equal(after.summary, "Combined the recovered evidence.");
    assert.equal(await readFile(evidence, "utf8"), "Durable child evidence.");

    const afterStorage = await openNodeSqliteStorage(storagePath);
    try {
      const child = await afterStorage.scanSubmissions({ conversationId: before.childId }, 10, undefined, ctx);
      assert.deepEqual(child.items.map(item => [item.id, item.requestId, item.status]), [[childSubmission.id, childRequest, "done"]]);
      const parent = await afterStorage.scanSubmissions({ conversationId: before.parentId }, 10, undefined, ctx);
      assert.deepEqual(parent.items.map(item => [item.requestId, item.status]), [
        ["initial", "done"], [`delegate-report:${before.batchId}`, "done"],
      ]);
    } finally {
      await afterStorage.close(ctx);
    }
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("SIGKILL after a parent asks for input cancels the background child on recovery", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-delegation-crash-")));
  const fixture = new URL("./fixtures/delegation-worker.ts", import.meta.url);
  let worker = startRecoveryWorker(fixture, "create", directory, "waiting");
  try {
    const before = await worker.ready();
    assert.equal(before.goalStatus, "waiting_user");
    assert.equal(before.childStatus, "running");
    assert.equal(await worker.stop(), "SIGKILL");
    worker = startRecoveryWorker(fixture, "recover", directory, "waiting");
    const after = await worker.complete();
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.childId, before.childId);
    assert.equal(after.goalStatus, "waiting_user");
    assert.equal(after.childStatus, "cancelled");
    assert.equal(after.workerRequests, 0);
    assert.equal(after.reports, 0);
    assert.equal(after.deliveries, 0);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("SIGKILL after persisting a goal revision cancels the previous batch before new work starts", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-delegation-crash-")));
  const fixture = new URL("./fixtures/delegation-worker.ts", import.meta.url);
  let worker = startRecoveryWorker(fixture, "create", directory, "revision");
  try {
    const before = await worker.ready();
    assert.equal(before.childStatus, "running");
    assert.equal(await worker.stop(), "SIGKILL");
    worker = startRecoveryWorker(fixture, "recover", directory, "revision");
    const after = await worker.complete();
    assert.equal(after.taskId, before.taskId);
    assert.equal(after.childId, before.childId);
    assert.equal(after.childStatus, "cancelled");
    assert.equal(after.workerRequests, 0);
    assert.equal(after.reports, 0);
    assert.equal(after.revision, 2);
    assert.equal(after.summary, "Delivered the revised goal.");
    assert.equal(after.deliveries, 1);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
