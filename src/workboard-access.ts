import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { workboardPage } from './workboard-page.js';
import { WorkItemError, type WorkItemRun, type WorkItems } from './work-items.js';

const ticketLifetime = 2 * 60_000, sessionLifetime = 8 * 60 * 60_000;
const boardPrefix = '/workboard';
type Access = { project: string; expiresAt: number; kind: 'ticket' | 'session' };

export function createWorkboardAccess<T extends WorkItemRun>(items: WorkItems<T>, origin: string,
  readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host;
  const keys = new Map<string, Access>();
  function issueKey(project: string, kind: Access['kind'], lifetime: number) {
    const now = Date.now();
    for (const [token, access] of keys) if (access.expiresAt <= now) keys.delete(token);
    const token = randomBytes(32).toString('base64url');
    keys.set(token, { project, kind, expiresAt: now + lifetime });
    return token;
  }
  function findKey(token: unknown, kind: Access['kind']) {
    if (typeof token !== 'string') return undefined;
    const access = keys.get(token);
    return access?.kind === kind && access.expiresAt > Date.now() ? access : undefined;
  }
  async function link(workspace: string) {
    const { project } = await items.board(workspace);
    // A new link must navigate even if the tab already shows the workboard.
    return { url: origin + boardPrefix + '?open#' + issueKey(project, 'ticket', ticketLifetime) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path !== boardPrefix && !path.startsWith(boardPrefix + '/')) return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local workboard address.' });
    if (path === boardPrefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(workboardPage.replace('__BOARD_NONCE__', nonce));
      return true;
    }
    if (path === boardPrefix + '/session' && req.method === 'POST') {
      const { ticket } = await readBody(req);
      const access = findKey(ticket, 'ticket');
      if (!access) return send(401, { error: 'Open the workboard again from Kada.' });
      keys.delete(ticket as string);
      return send(200, { token: issueKey(access.project, 'session', sessionLifetime) });
    }
    const access = findKey(req.headers.authorization?.replace(/^Bearer /, ''), 'session');
    if (!access) return send(401, { error: 'Open the workboard again from Kada.' });
    const { project } = access;
    if (path === boardPrefix + '/board') {
      if (req.method === 'GET') return send(200, await items.board(project, project));
      if (req.method === 'PATCH') return send(200, await items.editBoard(project, await readBody(req), project));
    }
    if (path === boardPrefix + '/items' && req.method === 'POST') {
      const { requestId, ...value } = await readBody(req);
      if (typeof requestId !== 'string') throw new WorkItemError(400, 'Provide a work item request ID.');
      return send(201, await items.create({ ...value, workspace: project }, { project, requestId }));
    }
    const item = /^\/workboard\/items\/([a-f0-9-]{36})$/.exec(path)?.[1];
    if (item && req.method === 'PATCH') {
      const { requestId, ...value } = await readBody(req);
      if (typeof requestId !== 'string') throw new WorkItemError(400, 'Provide a work item request ID.');
      return send(200, await items.update(item, value, { project, requestId }));
    }
    return send(404, { error: 'Workboard action not found.' });
  }
  return { link, handle };
}
