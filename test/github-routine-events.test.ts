import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncGithubRoutineEvents, watchGithubIssues, type GithubRoutineEvent } from "../src/github-routine-events.js";
import type { LocalRoutines, Routine } from "../src/routines.js";

const issue = (id: string, number: number, action = "opened") => ({
  id, type: "IssuesEvent", repo: { name: "Team/Repo" }, payload: { action, issue: { number } },
});
const page = (rows: object[], more = false) => Response.json(rows, { headers: more ? {
  Link: '<https://api.github.com/repos/team/repo/events?per_page=100&page=2>; rel="next"',
} : {} });

test("a public feed starts from its latest event and resumes oldest first after an unacknowledged delivery", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-github-feed-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let pages = [page([issue("10", 1)])];
  const attempts: string[] = [];
  let loseReply = true;
  const options = {
    dataDir, routineId: "triage", repository: "Team/Repo",
    fetch: (async (url, options) => {
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/team\/repo\/events\?per_page=100&page=[12]$/);
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      assert.equal(options?.redirect, "error");
      return pages.shift()!;
    }) as typeof fetch,
    deliver: async (event: GithubRoutineEvent) => {
      assert.deepEqual(event, { source: "github", type: "issues.opened", eventId: event.eventId,
        data: { repository: "team/repo", number: event.eventId === "11" ? 2 : 4 } });
      attempts.push(event.eventId);
      if (event.eventId === "13" && loseReply) throw new Error("receipt lost");
    },
  };
  assert.equal((await syncGithubRoutineEvents(options)).baseline, true);
  assert.deepEqual(attempts, []);
  const updates = () => [page([issue("13", 4), issue("12", 3, "closed")], true), page([issue("11", 2), issue("10", 1)])];
  pages = updates();
  await assert.rejects(syncGithubRoutineEvents(options), /receipt lost/);
  loseReply = false;
  pages = updates();
  assert.equal((await syncGithubRoutineEvents(options)).delivered, 1);
  assert.deepEqual(attempts, ["11", "13", "13"]);
  pages = [page([issue("20", 5)])];
  await assert.rejects(syncGithubRoutineEvents(options), /no longer in/);
  pages = [new Response(null, { status: 429, headers: { "Retry-After": "60" } })];
  await assert.rejects(syncGithubRoutineEvents(options), /429/);
  pages = [page([issue("13", 4)])];
  assert.equal((await syncGithubRoutineEvents(options)).delivered, 0);
});

test("the GitHub feed uses the configured credential on its fixed origin", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-github-auth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const tokenEnv = "KADA_TEST_GITHUB_FEED_CREDENTIAL", previous = process.env[tokenEnv];
  delete process.env[tokenEnv];
  t.after(() => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
  const calls: (string | null)[] = [];
  const options = {
    dataDir, routineId: "auth-feed", repository: "team/repo", tokenEnv,
    fetch: (async (url, init) => {
      assert.equal(new URL(String(url)).origin, "https://api.github.com");
      assert.equal(init?.redirect, "error");
      calls.push(new Headers(init?.headers).get("authorization"));
      return page([issue("30", 3)]);
    }) as typeof fetch,
    deliver: async () => assert.fail("An unchanged baseline never delivers."),
  };
  await assert.rejects(syncGithubRoutineEvents(options), /KADA_TEST_GITHUB_FEED_CREDENTIAL/);
  assert.deepEqual(calls, []);
  process.env[tokenEnv] = "fixture-token";
  assert.equal((await syncGithubRoutineEvents(options)).baseline, true);
  process.env[tokenEnv] = "replacement-token";
  assert.equal((await syncGithubRoutineEvents(options)).delivered, 0);
  assert.deepEqual(calls, ["Bearer fixture-token", "Bearer replacement-token"]);
});

test("the watcher stops pagination when a page uses the last GitHub request", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "kada-github-limit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const baseline = { dataDir, routineId: "triage", repository: "team/repo",
    fetch: async () => page([issue("10", 1)]), deliver: async () => assert.fail("The cursor must stay at the baseline") };
  await syncGithubRoutineEvents(baseline);
  const rule = { id: "triage", revision: 1, status: "scheduled",
    event: { source: "github", type: "issues.opened", equals: { repository: "team/repo" } } } as const;
  const routines: Pick<LocalRoutines, "list" | "receiveEvent"> = {
    list: async () => [rule as Routine],
    receiveEvent: async () => assert.fail("A partial feed must not deliver an event"),
  };
  const urls: string[] = [];
  const controller = new AbortController();
  const tokenEnv = "KADA_TEST_GITHUB_WATCH_CREDENTIAL", previous = process.env[tokenEnv];
  process.env[tokenEnv] = "watch-fixture-token";
  t.after(() => { if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; });
  const mock = t.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer watch-fixture-token");
    if (urls.length > 1) {
      controller.abort();
      return page([issue("10", 1)]);
    }
    const response = page([issue("11", 2)], true);
    response.headers.set("X-RateLimit-Remaining", "0");
    return response;
  });
  const logged = t.mock.method(console, "error", () => controller.abort());
  await watchGithubIssues(dataDir, ["triage"], routines, controller.signal, tokenEnv);
  assert.equal(urls.length, 1);
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /GitHub request limit/);
  mock.mock.restore();
  assert.equal((await syncGithubRoutineEvents(baseline)).delivered, 0);
});
