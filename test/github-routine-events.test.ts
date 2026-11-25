import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncGithubRoutineEvents, type GithubRoutineEvent } from "../src/github-routine-events.js";

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
