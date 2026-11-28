import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Models } from '@earendil-works/pi-ai';
import { AssistantError, assistantProject, type Assistants } from './assistants.js';
import { createLocalBrowserSessions } from './local-browser-sessions.js';
import { projectAssistantsPage } from './project-assistants-page.js';
import type { SkillCatalogEntry } from './skills.js';

const prefix = '/project-assistants';

export function createProjectAssistantsAccess(assistants: Assistants, models: Models, origin: string,
  readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>,
  skills: (workspace: string) => Promise<SkillCatalogEntry[]>) {
  const host = new URL(origin).host, sessions = createLocalBrowserSessions();
  async function link(workspace: unknown) {
    return { url: origin + prefix + '?open#' + sessions.ticket(await assistantProject(workspace)) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local project assistants address.' });
    if (path === prefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(projectAssistantsPage.replace('__ASSISTANTS_NONCE__', nonce));
      return true;
    }
    if (path === prefix + '/session' && req.method === 'POST') {
      const token = sessions.exchange((await readBody(req)).ticket);
      return token ? send(200, { token }) : send(401, { error: 'Open project assistants again from Kada.' });
    }
    const project = sessions.scope(req.headers.authorization);
    if (!project) return send(401, { error: 'Open project assistants again from Kada.' });
    if (path === prefix + '/state' && req.method === 'GET') return send(200, { project, windows: process.platform === 'win32', roles: await assistants.list(project, project),
      models: models.getModels().map(model => ({ provider: model.provider, modelId: model.id, name: model.name })), skills: await skills(project) });
    const id = /^\/project-assistants\/roles\/([a-f0-9-]{36})$/.exec(path)?.[1];
    if (id && req.method === 'GET') {
      if (await assistantProject(project) !== project) throw new AssistantError(409, 'The original assistant project changed.');
      const role = await assistants.get(id);
      if (role.project !== project) throw new AssistantError(404, 'Assistant not found in this project.');
      return send(200, role);
    }
    const create = path === prefix + '/roles' && req.method === 'POST';
    if (create || id && req.method === 'PATCH') {
      const { requestId, ...value } = await readBody(req);
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId) || Object.hasOwn(value, 'workspace')) {
        throw new AssistantError(400, 'Provide the original request ID and assistant settings.');
      }
      const scope = { requestId: 'browser-' + requestId, workspace: project, project };
      if (create) return send(201, await assistants.create({ ...value, workspace: project }, scope));
      return send(200, await assistants.update(id!, value, scope));
    }
    return send(404, { error: 'Project assistant action not found.' });
  }
  return { link, handle };
}
