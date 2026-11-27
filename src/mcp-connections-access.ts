import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLocalBrowserSessions } from './local-browser-sessions.js';
import { runMcpConnectionAction, type McpConnectionAction } from './mcp-connection-actions.js';
import type { McpDefinition, McpTools } from './mcp-tools.js';
import { mcpConnectionsPage } from './mcp-connections-page.js';

const prefix = '/mcp-connections';

export function createMcpConnectionsAccess(mcp: McpTools, origin: string, readBody: (request: IncomingMessage) => Promise<Record<string, unknown>>) {
  const host = new URL(origin).host, sessions = createLocalBrowserSessions();
  const callback = origin + '/v1/settings/mcp/oauth/callback';
  const link = () => ({ url: origin + prefix + '?open#' + sessions.ticket('connections') });
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(body));
      return true;
    };
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Use the local MCP connections address.' });
    if (path === prefix && req.method === 'GET') {
      const nonce = randomBytes(18).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      res.end(mcpConnectionsPage.replace('__MCP_CONNECTIONS_NONCE__', nonce));
      return true;
    }
    if (path === prefix + '/session' && req.method === 'POST') {
      const token = sessions.exchange((await readBody(req)).ticket);
      return token ? send(200, { token }) : send(401, { error: 'Open MCP connections again from Kada.' });
    }
    if (sessions.scope(req.headers.authorization) !== 'connections') return send(401, { error: 'Open MCP connections again from Kada.' });
    if (path === prefix + '/state' && req.method === 'GET') return send(200, { connections: await mcp.list() });
    if (path === prefix + '/connections' && req.method === 'POST') {
      return send(201, await mcp.configure(await readBody(req) as McpDefinition));
    }
    const action = /^\/mcp-connections\/connections\/([^/]+)\/(test|enable|disable|approval|login|logout)$/.exec(path);
    if (action && req.method === 'POST') {
      return send(200, await runMcpConnectionAction(mcp, decodeURIComponent(action[1]!), action[2] as McpConnectionAction,
        () => readBody(req), callback));
    }
    return send(404, { error: 'MCP connection action not found.' });
  }
  return { link, handle };
}
