import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { atomicJson, readJson } from "./util.js";

export type GithubRoutineEvent = {
  source: "github";
  type: "issues.opened";
  eventId: string;
  data: { repository: string; number: number };
};

type SyncOptions = {
  dataDir: string;
  routineId: string;
  repository: string;
  deliver: (event: GithubRoutineEvent) => Promise<unknown>;
  fetch?: typeof fetch;
};

type FeedEvent = {
  id: string;
  type?: string;
  repo?: { name?: string };
  payload?: { action?: string; issue?: { number?: number } };
};

type Checkpoint = { eventId: string | null };
const validId = /^[A-Za-z0-9_-]{1,120}$/;

async function readPage(fetchPage: typeof fetch, repository: string, page: number) {
  const response = await fetchPage(`https://api.github.com/repos/${repository}/events?per_page=100&page=${page}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Kada" },
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
    let { rows, more } = await readPage(fetchPage, repository, 1);
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
      ({ rows, more } = await readPage(fetchPage, repository, page + 1));
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
