import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoveryTestTimeoutMs, startRecoveryWorker } from "./helpers.js";

test("SIGKILL during a precheck records the interruption and leaves the partial effect alone", { timeout: recoveryTestTimeoutMs }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kada-routine-precheck-")));
  const fixture = new URL("./fixtures/routine-precheck-worker.ts", import.meta.url);
  const marker = join(directory, "workspace", "check-attempts.txt");
  let worker = startRecoveryWorker(fixture, "create", directory);
  try {
    await worker.ready();
    assert.ok(existsSync(marker), "The fixed command must run before a model task is created");
    assert.equal(await worker.stop(), "SIGKILL");
    assert.equal(await readFile(marker, "utf8"), "started\n");

    worker = startRecoveryWorker(fixture, "recover", directory);
    assert.deepEqual(await worker.complete(), {
      type: "completed", history: [["claimed", null], ["failed", "interrupted"]], tasks: [], modelCalls: 0,
    });
    assert.equal(await readFile(marker, "utf8"), "started\n");
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
