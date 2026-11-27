import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { projectRoot, type McpTools } from './mcp-tools.js';
import { createProjectBrowserSessions } from './project-browser-sessions.js';
import { projectMcpPage } from './project-mcp-page.js';

const prefix = '/project-mcp';

export function createProjectMcpAccess(mcp: McpTools, origin: string, readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host, sessions = createProjectBrowserSessions();
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
    const project = sessions.project(req.headers.authorization);
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
    return send(404, { error: 'Project tools action not found.' });
  }
  return { link, handle };
}
