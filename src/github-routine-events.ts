import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { LocalRoutines, Routine } from "./routines.js";
import { atomicJson, errorText, readJson } from "./util.js";

export type GithubIssue = { repository: string; number: number };
export type GithubPullRequest = GithubIssue & { headSha: string; baseSha: string; draft: boolean; merged: boolean };
export const githubPullRequestEvents = new Set(['opened', 'reopened', 'synchronize', 'closed', 'ready_for_review'].map(action => 'pull_request.' + action));

export function githubPullRequestTarget(data: Record<string, unknown>): GithubPullRequest | undefined {
  const issue = githubIssueTarget(data.repository, data.number);
  const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
  if (!issue || !sha(data.headSha) || !sha(data.baseSha) || typeof data.draft !== 'boolean' || typeof data.merged !== 'boolean') return;
  return { ...issue, headSha: data.headSha.toLowerCase(), baseSha: data.baseSha.toLowerCase(), draft: data.draft, merged: data.merged };
}

export function githubIssueTarget(repository: unknown, number: unknown): GithubIssue | undefined {
  if (typeof repository !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    repository.endsWith("/.") || repository.endsWith("/..") || typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) return;
  return { repository: repository.toLowerCase(), number };
}

export type GithubRoutineEvent = {
  source: "github";
  type: "issues.opened";
  eventId: string;
  data: { repository: string; number: number };
};

export function githubIssueRepository(rule?: Routine) {
  const event = rule?.event;
  const repository = event?.equals.repository;
  if (rule?.status === "scheduled" && event?.source === "github" && event.type === "issues.opened" &&
      typeof repository === "string" && repository === repository.toLowerCase()) return repository;
}

type SyncOptions = {
  dataDir: string;
  routineId: string;
  repository: string;
  deliver: (event: GithubRoutineEvent) => Promise<unknown>;
  fetch?: typeof fetch;
  tokenEnv?: string;
};

type FeedEvent = {
  id: string;
  type?: string;
  repo?: { name?: string };
  payload?: { action?: string; issue?: { number?: number } };
};

type Checkpoint = { eventId: string | null };
const validId = /^[A-Za-z0-9_-]{1,120}$/;

async function readPage(fetchPage: typeof fetch, repository: string, page: number, token?: string) {
  const response = await fetchPage(`https://api.github.com/repos/${repository}/events?per_page=100&page=${page}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Kada", ...(token ? { Authorization: "Bearer " + token } : {}) },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(`GitHub events returned HTTP ${response.status}.${retryAfter ? " Retry-After: " + retryAfter : ""}`);
  }
  const rows = await response.json() as FeedEvent[];
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row => !row || typeof row.id !== "string" || !validId.test(row.id))) {
    throw new Error("GitHub returned an invalid events page.");
  }
  return { rows, more: /;\s*rel="next"/.test(response.headers.get("Link") ?? "") };
}

export async function syncGithubRoutineEvents(options: SyncOptions) {
  const repository = options.repository.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/.test(repository) ||
    repository.endsWith("/.") || repository.endsWith("/..") || !validId.test(options.routineId)) {
    throw new Error("Provide a routine ID and public GitHub repository as owner/name.");
  }
  const token = options.tokenEnv ? process.env[options.tokenEnv]?.trim() : undefined;
  if (options.tokenEnv && (!token || !/^[\x21-\x7e]+$/.test(token))) {
    throw new Error(`Set a valid GitHub API credential in ${options.tokenEnv} before syncing events.`);
  }
  const directory = join(options.dataDir, "github-routine-events");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(JSON.stringify([options.routineId, repository])).digest("hex");
  const path = join(directory, key + ".json");
  const release = await lockfile.lock(path, { realpath: false });
  try {
    let saved: Checkpoint | undefined;
    try { saved = await readJson<Checkpoint>(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (saved !== undefined && (!saved || saved.eventId !== null &&
      (typeof saved.eventId !== "string" || !validId.test(saved.eventId)))) {
      throw new Error("The GitHub feed checkpoint is invalid.");
    }
    const fetchPage = options.fetch ?? fetch;
    let { rows, more } = await readPage(fetchPage, repository, 1, token);
    if (!saved) {
      await atomicJson(path, { eventId: rows[0]?.id ?? null });
      return { repository, baseline: true, delivered: 0 };
    }

    const pending = new Map<string, FeedEvent>();
    let reachedCheckpoint = false;
    for (let page = 1; ; page++) {
      for (const event of rows) {
        if (event.id === saved.eventId) {
          reachedCheckpoint = true;
          break;
        }
        if (!pending.has(event.id)) pending.set(event.id, event);
      }
      if (reachedCheckpoint || !more || page === 3) break;
      ({ rows, more } = await readPage(fetchPage, repository, page + 1, token));
    }
    if (!reachedCheckpoint && (saved.eventId !== null || more)) {
      throw new Error("The GitHub feed checkpoint is no longer in the available event window.");
    }
    let delivered = 0;
    for (const event of [...pending.values()].reverse()) {
      if (event.type === "IssuesEvent" && event.payload?.action === "opened" &&
        event.repo?.name?.toLowerCase() === repository) {
        const number = event.payload.issue?.number;
        if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
          throw new Error("An opened GitHub issue is missing a valid issue number.");
        }
        await options.deliver({ source: "github", type: "issues.opened", eventId: event.id, data: { repository, number } });
        delivered++;
      }
      await atomicJson(path, { eventId: event.id });
    }
    return { repository, baseline: false, delivered };
  } finally {
    await release();
  }
}

/** Polling only reads GitHub. The routine owns task admission and its budget. */
export async function watchGithubIssues(dataDir: string, routineIds: readonly string[], routines: Pick<LocalRoutines, "list" | "receiveEvent">, signal: AbortSignal, tokenEnv?: string) {
  while (!signal.aborted) {
    let nextPoll = Date.now() + 60_000;
    let rateLimited = false;
    const pollFetch: typeof fetch = async (url, init) => {
      if (rateLimited) throw new Error("GitHub request limit reached before the complete feed could be read.");
      const response = await fetch(url, {
        ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      });
      const now = Date.now();
      const pollSeconds = Number(response.headers.get("X-Poll-Interval"));
      if (Number.isFinite(pollSeconds) && pollSeconds > 0) nextPoll = Math.max(nextPoll, now + pollSeconds * 1_000);
      const retryAfter = response.headers.get("Retry-After");
      if (retryAfter) {
        const retryAt = /^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1_000 : Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) nextPoll = Math.max(nextPoll, retryAt);
      }
      const exhausted = response.headers.get("X-RateLimit-Remaining") === "0";
      if (exhausted) {
        const resetAt = Number(response.headers.get("X-RateLimit-Reset")) * 1_000;
        if (Number.isFinite(resetAt)) nextPoll = Math.max(nextPoll, resetAt);
      }
      rateLimited = exhausted || response.status === 429 || response.status === 403 && retryAfter !== null;
      return response;
    };
    try {
      for (const rule of await routines.list()) {
        if (signal.aborted || rateLimited) break;
        if (!routineIds.includes(rule.id)) continue;
        const repository = githubIssueRepository(rule);
        if (!repository) continue;
        try {
          await syncGithubRoutineEvents({ dataDir, routineId: rule.id, repository, fetch: pollFetch, tokenEnv,
            deliver: event => {
              signal.throwIfAborted();
              return routines.receiveEvent(rule.id, event, rule.revision);
            },
          });
        } catch (error) {
          if (!signal.aborted && (error as NodeJS.ErrnoException).code !== "ELOCKED") {
            console.error(`GitHub sync for ${rule.id} failed. ${errorText(error)}`);
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) console.error("Could not list GitHub issue routines. " + errorText(error));
    }
    if (signal.aborted) return;
    try {
      await sleep(Math.min(2_147_483_647, Math.max(0, nextPoll - Date.now())), undefined, { signal, ref: false });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
