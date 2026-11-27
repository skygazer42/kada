import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalBrowserSessions } from './local-browser-sessions.js';
import type { LocalRuntime } from './runtime.js';
import { workspaceSnapshotPage } from './workspace-snapshot-page.js';

const prefix = '/workspace-snapshots';

export function createWorkspaceSnapshotAccess(runtime: LocalRuntime, origin: string, readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host, sessions = createLocalBrowserSessions();
  async function link(taskId: string) {
    await runtime.workspaceSnapshots(taskId);
    return { url: origin + prefix + '?open#' + sessions.ticket(taskId) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local workspace snapshots address.' });
    if (path === prefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(workspaceSnapshotPage.replace('__SNAPSHOT_NONCE__', nonce));
      return true;
    }
    if (path === prefix + '/session' && req.method === 'POST') {
      const token = sessions.exchange((await readBody(req)).ticket);
      return token ? send(200, { token }) : send(401, { error: 'Open workspace snapshots again from Kada.' });
    }
    const taskId = sessions.scope(req.headers.authorization);
    if (!taskId) return send(401, { error: 'Open workspace snapshots again from Kada.' });
    if (path === prefix + '/state' && req.method === 'GET') {
      const snapshots = await runtime.workspaceSnapshots(taskId);
      return send(200, { workspace: (await runtime.metadata(taskId)).workspace, snapshots });
    }
    if (path === prefix + '/snapshots' && req.method === 'POST') {
      const input = await readBody(req);
      if (Object.keys(input).length !== 1 || typeof input.label !== 'string') return send(400, { error: 'Provide the snapshot label.' });
      return send(201, await runtime.saveWorkspaceSnapshot(taskId, input.label));
    }
    const operation = /^\/workspace-snapshots\/snapshots\/([a-f0-9-]{36})\/(preview|restore)$/.exec(path);
    if (operation) {
      const [, id, action] = operation;
      if (action === 'preview' && req.method === 'GET') return send(200, await runtime.previewWorkspaceRestore(taskId, id!));
      if (action === 'restore' && req.method === 'POST') {
        const input = await readBody(req);
        if (Object.keys(input).length !== 1 || typeof input.version !== 'string') return send(400, { error: 'Provide the displayed preview version.' });
        return send(200, await runtime.restoreWorkspace(taskId, id!, input.version));
      }
    }
    return send(404, { error: 'Workspace snapshot action not found.' });
  }
  return { link, handle };
}
