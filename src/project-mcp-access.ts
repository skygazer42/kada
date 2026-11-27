import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectRoot, type McpTools } from './mcp-tools.js';
import { createLocalBrowserSessions } from './local-browser-sessions.js';
import { projectMcpPage } from './project-mcp-page.js';
import type { ProjectCalendars } from './project-calendars.js';
import type { ProjectGmail } from './project-gmail.js';

const prefix = '/project-mcp';

export function createProjectMcpAccess(mcp: McpTools, apps: { gmail: ProjectGmail; calendar: ProjectCalendars },
  origin: string, readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host, sessions = createLocalBrowserSessions();
  async function link(workspace: string) {
    return { url: origin + prefix + '?open#' + sessions.ticket(await projectRoot(workspace)) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local project tools address.' });
    if (path === prefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(projectMcpPage.replace('__MCP_NONCE__', nonce));
      return true;
    }
    if (path === prefix + '/session' && req.method === 'POST') {
      const token = sessions.exchange((await readBody(req)).ticket);
      return token ? send(200, { token }) : send(401, { error: 'Open the project tools again from Kada.' });
    }
    const project = sessions.scope(req.headers.authorization);
    if (!project) return send(401, { error: 'Open the project tools again from Kada.' });
    if (path === prefix + '/state' && req.method === 'GET') {
      const [tools, connections] = await Promise.all([mcp.projectTools(project), mcp.list()]);
      return send(200, { project, tools, connections: connections.filter(connection => connection.enabled && connection.allowedTools.length)
        .map(({ id, allowedTools }) => ({ id, tools: allowedTools })) });
    }
    if (path === prefix + '/tools' && req.method === 'PUT') {
      const input = await readBody(req);
      if (Object.keys(input).some(key => key !== 'tools')) return send(400, { error: 'Provide the project tool selection.' });
      return send(200, { tools: await mcp.setProjectTools(project, input.tools) });
    }
    const source = path === prefix + '/gmail-source' ? apps.gmail : path === prefix + '/calendar-source' ? apps.calendar : undefined;
    if (source || path === prefix + '/bindings') {
      if (await projectRoot(project) !== project) return send(409, { error: 'The original project changed. Reopen the project settings.' });
      if (source && req.method === 'PUT') return send(200, await source.setSource(project, await readBody(req)));
      if (source && req.method === 'DELETE') return send(200, await source.clearSource(project));
      if (!source && req.method === 'GET') {
        const [gmail, calendar, pins] = await Promise.all([apps.gmail.source(project), apps.calendar.source(project), mcp.pins(project)]);
        const candidates = (names: string[]) => pins.filter(pin => names.every(name => pin.tools.includes(name) &&
          !pin.approvalTools?.includes(name) && pin.discovery?.some(tool => tool.name === name && tool.readOnly)))
          .map(({ id, revision }) => ({ id, revision }));
        return send(200, {
          gmail: { source:gmail.source, connections:candidates(['search_gmail_messages','get_gmail_message_content']) },
          calendar: { source:calendar.source, connections:candidates(['list-events']) },
        });
      }
      return send(405, { error: 'Method not allowed.' });
    }
    return send(404, { error: 'Project tools action not found.' });
  }
  return { link, handle };
}
