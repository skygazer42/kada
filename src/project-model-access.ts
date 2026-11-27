import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { modelRef, type ModelRef } from './config.js';
import type { ProviderSettings } from './provider-settings.js';
import { createProjectBrowserSessions } from './project-browser-sessions.js';
import { projectModelPage } from './project-model-page.js';

const prefix = '/project-model';

export function createProjectModelAccess(providers: ProviderSettings, defaultModel: ModelRef | undefined, origin: string,
  readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host, sessions = createProjectBrowserSessions();
  async function link(workspace: string) {
    const { project } = await providers.projectDefault(workspace, defaultModel);
    return { url: origin + prefix + '?open#' + sessions.ticket(project) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local project model address.' });
    if (path === prefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(projectModelPage.replace('__MODEL_NONCE__', nonce));
      return true;
    }
    if (path === prefix + '/session' && req.method === 'POST') {
      const token = sessions.exchange((await readBody(req)).ticket);
      return token ? send(200, { token }) : send(401, { error: 'Open the model settings again from Kada.' });
    }
    const project = sessions.project(req.headers.authorization);
    if (!project) return send(401, { error: 'Open the model settings again from Kada.' });
    if (path === prefix + '/state' && req.method === 'GET') {
      const preferences = await providers.projectDefault(project, defaultModel);
      return send(200, { ...preferences, providers: await providers.list(defaultModel, project) });
    }
    if (path === prefix + '/model' && req.method === 'DELETE') {
      await providers.clear(project);
      return send(200, await providers.projectDefault(project, defaultModel));
    }
    if ((path === prefix + '/check' || path === prefix + '/model') && req.method === 'POST') {
      const input = await readBody(req);
      if (Object.keys(input).some(key => key !== 'provider' && key !== 'modelId')) {
        return send(400, { error: 'Provide the selected provider and model ID.' });
      }
      const ref = modelRef(input, 'Project model');
      if (!ref) return send(400, { error: 'Choose a provider and model.' });
      if (path.endsWith('/check')) return send(200, await providers.check(ref));
      return send(200, await providers.select(ref, project));
    }
    return send(404, { error: 'Project model action not found.' });
  }
  return { link, handle };
}
