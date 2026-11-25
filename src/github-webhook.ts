import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { GithubWebhookConfig } from './config.js';
import type { LocalRoutines } from './routines.js';
import { RoutineError } from './routines.js';
import { githubIssueTarget, githubPullRequestEvents, githubPullRequestTarget } from './github-routine-events.js';

const maxBody = 1_048_576;
class WebhookError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length']) > maxBody) {
    request.resume(); throw new WebhookError(413, 'Webhook body exceeds 1 MiB.');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBody) { request.resume(); throw new WebhookError(413, 'Webhook body exceeds 1 MiB.'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export async function githubWebhook(request: IncomingMessage, path: string, grants: readonly GithubWebhookConfig[], routines: Pick<LocalRoutines, 'list' | 'receiveEvent'>) {
  if (!path.startsWith('/hooks/')) return;
  try {
    const match = /^\/hooks\/github\/([A-Za-z0-9_-]{1,120})$/.exec(path);
    const grant = match && grants.find(entry => entry.routineId === match[1]);
    if (!grant) throw new WebhookError(404, 'Webhook not found.');
    if (request.method !== 'POST') throw new WebhookError(405, 'Use POST for this webhook.');
    const secret = process.env[grant.secretEnv];
    if (!secret) throw new WebhookError(503, 'Webhook credentials are unavailable.');
    const signature = request.headers['x-hub-signature-256'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new WebhookError(401, 'Invalid webhook signature.');
    const raw = await rawBody(request);
    const expected = createHmac('sha256', secret).update(raw).digest();
    if (!timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), expected)) throw new WebhookError(401, 'Invalid webhook signature.');
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      throw new WebhookError(415, 'Expected an uncompressed application/json webhook.');
    }
    let payload: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      payload = value as Record<string, unknown>;
    } catch { throw new WebhookError(400, 'Invalid webhook JSON.'); }
    const issueEvent = request.headers['x-github-event'] === 'issues' && payload.action === 'opened';
    const eventType = request.headers['x-github-event'] === 'pull_request' && typeof payload.action === 'string' ? 'pull_request.' + payload.action : undefined;
    if (!issueEvent && (!eventType || !githubPullRequestEvents.has(eventType))) return { status: 200, data: { accepted: false } };
    const repository = (payload.repository as { full_name?: unknown } | undefined)?.full_name;
    const pr = payload.pull_request as { number?: unknown; head?: { sha?: unknown }; base?: { sha?: unknown }; draft?: unknown; merged?: unknown } | undefined;
    const data = issueEvent ? githubIssueTarget(repository, (payload.issue as { number?: unknown } | undefined)?.number) :
      githubPullRequestTarget({ repository, number: pr?.number, headSha: pr?.head?.sha, baseSha: pr?.base?.sha, draft: pr?.draft, merged: pr?.merged });
    if (!data || !issueEvent && payload.number !== undefined && payload.number !== pr?.number) {
      throw new WebhookError(400, 'Provide valid GitHub event identifiers and state.');
    }
    const rule = (await routines.list()).find(rule => rule.id === grant.routineId);
    if (rule?.event?.source !== 'github' || typeof rule.event.equals.repository !== 'string' ||
      rule.event.equals.repository !== rule.event.equals.repository.toLowerCase()) throw new WebhookError(409, 'The webhook rule is unavailable.');
    const type = issueEvent ? 'issues.opened' : eventType!;
    if (rule.event.type !== type) return { status: 200, data: { accepted: false } };
    const result = await routines.receiveEvent(grant.routineId, {
      source: 'github', type, eventId: 'hook-' + createHash('sha256').update(raw).digest('hex'), data,
    }, rule.revision);
    return { status: result.outcome === 'accepted' ? 202 : 200, data: { accepted: result.outcome === 'accepted' } };
  } catch (error) {
    if (error instanceof WebhookError) return { status: error.status, data: { error: error.message } };
    if (error instanceof RoutineError) return { status: error.status, data: { error: 'The webhook rule cannot accept this event in its current state.' } };
    return { status: 503, data: { error: 'Webhook admission could not be confirmed. Retry the original signed delivery.' } };
  }
}
