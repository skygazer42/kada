import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { serve } from '../src/server.js';
import { scriptedFixture } from './helpers.js';

async function oauthServer(t: TestContext) {
  let origin = '', currentAccess = '', currentRefresh = '', refreshes = 0, exchanges = 0, echo: false | 'access' | 'client' = false, loseResponse = false;
  const clientSecret = 'synthetic-client-secret-' + randomUUID();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const send = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const body = async () => { const parts: Buffer[] = []; for await (const part of req) parts.push(part); return Buffer.concat(parts).toString(); };
    if (url.pathname.includes('.well-known/oauth-protected-resource')) return send(200, { resource: origin + '/mcp', authorization_servers: [origin + '/oauth'], scopes_supported: ['read'] });
    if (url.pathname.includes('.well-known/oauth-authorization-server') || url.pathname.includes('.well-known/openid-configuration')) {
      return send(200, { issuer: origin + '/oauth', authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['read'] });
    }
    if (url.pathname === '/register') return send(201, { ...JSON.parse(await body()), client_id: 'synthetic-client', client_secret: clientSecret });
    if (url.pathname === '/authorize') {
      const code = randomUUID(), redirect = url.searchParams.get('redirect_uri')!;
      assert.equal(new URL(redirect).hostname, '127.0.0.1');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect });
      const next = new URL(redirect);
      next.searchParams.set('state', url.searchParams.get('state')!);
      next.searchParams.set('code', code);
      res.writeHead(302, { Location: next.href }); res.end(); return;
    }
    if (url.pathname === '/token') {
      const input = new URLSearchParams(await body());
      if (input.get('grant_type') === 'authorization_code') {
        exchanges++;
        const code = input.get('code')!, saved = codes.get(code);
        if (!saved || saved.redirect !== input.get('redirect_uri') || saved.challenge !== createHash('sha256').update(input.get('code_verifier') ?? '').digest('base64url')) {
          return send(400, { error: 'invalid_grant' });
        }
        codes.delete(code);
      } else {
        refreshes++;
        if (input.get('refresh_token') !== currentRefresh) return send(400, { error: 'invalid_grant' });
      }
      currentAccess = 'synthetic-access-' + randomUUID(); currentRefresh = 'synthetic-refresh-' + randomUUID();
      if (loseResponse && input.get('grant_type') === 'authorization_code') { loseResponse = false; req.socket.destroy(); return; }
      return send(200, { access_token: currentAccess, refresh_token: currentRefresh, token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    }
    if (url.pathname === '/mcp') {
      if (!currentAccess || req.headers.authorization !== 'Bearer ' + currentAccess) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
        return send(401, { error: 'authorization_required' });
      }
      if (req.method !== 'POST') return send(405, {});
      const input = JSON.parse(await body());
      if (input.id === undefined) { res.writeHead(202); res.end(); return; }
      const results: Record<string, object> = {
        initialize: { protocolVersion: input.params.protocolVersion, serverInfo: { name: 'oauth-fixture', version: '1' }, capabilities: { tools: {} } },
        'tools/list': { tools: [{ name: 'read', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] },
        'tools/call': { content: [{ type: 'text', text: echo === 'client' ? clientSecret : echo ? currentAccess : 'Connected.' }] },
      };
      return send(200, { jsonrpc: '2.0', id: input.id, result: results[input.method] });
    }
    send(404, {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { origin, expire() { currentAccess = 'expired'; }, echo(kind: 'access' | 'client' = 'access') { echo = kind; }, refreshes: () => refreshes, exchanges: () => exchanges,
    loseResponse() { loseResponse = true; },
    secrets: () => [currentAccess, currentRefresh, clientSecret] };
}

async function app(t: TestContext) {
  const fixture = await scriptedFixture(() => fauxAssistantMessage('No model needed.'));
  const slot = createServer();
  await new Promise<void>(resolve => slot.listen(0, '127.0.0.1', resolve));
  const port = (slot.address() as { port: number }).port;
  await new Promise<void>(resolve => slot.close(() => resolve()));
  const open = () => serve({ ...fixture.settings, port }, { models: fixture.models });
  let server = await open();
  t.after(async () => { await server.close(); await fixture.close(); });
  const origin = 'http://127.0.0.1:' + port, token = (await readFile(join(fixture.directory, 'token'), 'utf8')).trim();
  const request = (path: string, method = 'GET', value?: object) => fetch(origin + path, { method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: value === undefined ? undefined : JSON.stringify(value) });
  return { origin, directory: fixture.directory, request, runtime: () => server.runtime, async restart() { await server.close(); server = await open(); } };
}

test('the owner signs in to an OAuth MCP server through PKCE, resumes across restart, refreshes and logs out without exposing tokens', async t => {
  const authority = await oauthServer(t), f = await app(t);
  assert.equal((await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true })).status, 201);
  assert.equal((await fetch(f.origin + '/v1/settings/mcp/inbox/login', { method: 'POST' })).status, 401);
  const login = await f.request('/v1/settings/mcp/inbox/login', 'POST', {});
  assert.equal(login.status, 200, await login.clone().text());
  const pending = await login.json();
  assert.equal(new URL(pending.authorizationUrl).origin, authority.origin);
  await f.restart();
  const approved = await fetch(pending.authorizationUrl, { redirect: 'manual' });
  const callback = approved.headers.get('location')!;
  const wrong = new URL(callback); wrong.searchParams.set('state', 'inbox.' + 'a'.repeat(43));
  assert.equal((await fetch(wrong)).status, 400);
  assert.equal(authority.exchanges(), 0);
  const finished = await fetch(callback);
  assert.equal(finished.status, 200, await finished.clone().text());
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(authority.exchanges(), 1);
  const [saved] = await (await f.request('/v1/settings/mcp')).json();
  assert.equal(saved.enabled, false);
  assert.equal(saved.oauth.credentialsSaved, true);
  const checked = await (await f.request('/v1/settings/mcp/inbox/test', 'POST', {})).json();
  assert.equal(checked.test.status, 'ok');
  assert.equal((await f.request('/v1/settings/mcp/inbox/enable', 'POST', { revision: checked.revision, tools: ['read'] })).status, 200);
  await f.restart();
  const [pin] = await f.runtime().mcp.pins();
  assert.ok(pin);
  authority.expire();
  const replies = await Promise.all([f.runtime().mcp.executeApproved(pin, 'read', {}), f.runtime().mcp.executeApproved(pin, 'read', {})]);
  assert.deepEqual(replies.map(result => result.output), [[{ type: 'text', text: 'Connected.' }], [{ type: 'text', text: 'Connected.' }]]);
  assert.equal(authority.refreshes(), 1);
  authority.expire(); authority.echo();
  const hidden = await f.runtime().mcp.executeApproved(pin, 'read', {});
  assert.equal(hidden.isError, true);
  const publicText = JSON.stringify([hidden, await (await f.request('/v1/settings/mcp')).json()]);
  for (const secret of authority.secrets()) assert.equal(publicText.includes(secret), false);
  assert.equal((await f.request('/v1/settings/mcp/inbox/logout', 'POST', {})).status, 200);
  await assert.rejects(f.runtime().mcp.executeApproved(pin, 'read', {}), /changed|enabled|allowed/i);
  const [loggedOut] = await (await f.request('/v1/settings/mcp')).json();
  assert.equal(loggedOut.oauth.credentialsSaved, false);
  assert.equal(loggedOut.enabled, false);
  assert.deepEqual(await f.runtime().list(), []);
});

test('OAuth state expires and cannot survive logout or an endpoint edit, even when the old endpoint is restored', async t => {
  const authority = await oauthServer(t), f = await app(t);
  const definition = { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true };
  await f.request('/v1/settings/mcp', 'POST', definition);
  const begin = async () => {
    const response = await f.request('/v1/settings/mcp/inbox/login', 'POST', {});
    assert.equal(response.status, 200, await response.clone().text());
    const pending = await response.json();
    return (await fetch(pending.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  };
  const first = await begin();
  await f.request('/v1/settings/mcp/inbox/logout', 'POST', {});
  assert.equal((await fetch(first)).status, 400);
  const second = await begin();
  await f.request('/v1/settings/mcp', 'POST', { ...definition, url: authority.origin + '/other' });
  await f.request('/v1/settings/mcp', 'POST', definition);
  assert.equal((await fetch(second)).status, 400);
  const third = await begin();
  const now = Date.now(), expired = t.mock.method(Date, 'now', () => now + 11 * 60_000);
  try { assert.equal((await fetch(third)).status, 400); } finally { expired.mock.restore(); }
  assert.equal(authority.exchanges(), 0);
  assert.equal((await f.request('/v1/settings/mcp', 'POST', { ...definition, url: 'http://example.test/mcp' })).status, 400);
  assert.equal((await f.request('/v1/settings/mcp', 'POST', { ...definition, headers: { Authorization: 'EXISTING_MCP_KEY' } })).status, 400);
});

test('a late completed OAuth exchange cannot disable a newer authorized and enabled account', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const authorize = async () => {
    const login = await (await f.request('/v1/settings/mcp/inbox/login', 'POST', {})).json();
    return (await fetch(login.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  };
  const callback = await authorize();
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const manager = f.runtime().mcp, original = manager['connect'].bind(manager);
  let held = false;
  const paused = t.mock.method(manager, 'connect', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    if (args[4]?.code && !held) { held = true; arrived.resolve(); await release.promise; }
    return result;
  });
  const late = fetch(callback);
  try {
    await Promise.race([arrived.promise, late.then(() => { throw new Error('The first exchange did not reach its completion boundary.'); })]);
    await f.request('/v1/settings/mcp/inbox/logout', 'POST', {});
    const newer = await authorize();
    assert.equal((await fetch(newer)).status, 200);
    const tested = await (await f.request('/v1/settings/mcp/inbox/test', 'POST', {})).json();
    assert.equal((await f.request('/v1/settings/mcp/inbox/enable', 'POST', { revision: tested.revision, tools: ['read'] })).status, 200);
    release.resolve();
    assert.equal((await late).status, 400);
    const [current] = await (await f.request('/v1/settings/mcp')).json();
    assert.equal(current.enabled, true);
    assert.equal(current.revision, tested.revision);
    assert.equal(current.oauth.credentialsSaved, true);
  } finally { release.resolve(); await late; paused.mock.restore(); }
});

test('an OAuth callback after an interrupted local completion promotes saved tokens without redeeming the code twice', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const login = await (await f.request('/v1/settings/mcp/inbox/login', 'POST', {})).json();
  const callback = (await fetch(login.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  const failure = t.mock.method(f.runtime().mcp['oauth'], 'complete', async () => { throw new Error('Synthetic interruption before saving the local grant'); });
  assert.equal((await fetch(callback)).status, 400);
  failure.mock.restore();
  await f.restart();
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(authority.exchanges(), 1);
  const [current] = await (await f.request('/v1/settings/mcp')).json();
  assert.equal(current.oauth.credentialsSaved, true);
});

test('an unknown OAuth code exchange is not retried and denied sign-in clears only the pending attempt', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const begin = async () => {
    const login = await (await f.request('/v1/settings/mcp/inbox/login', 'POST', {})).json();
    return (await fetch(login.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  };
  const callback = await begin();
  authority.loseResponse();
  assert.equal((await fetch(callback)).status, 502);
  assert.equal((await fetch(callback)).status, 409);
  assert.equal(authority.exchanges(), 1);
  const denied = new URL(await begin()); denied.searchParams.delete('code'); denied.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(denied)).status, 400);
  const [current] = await (await f.request('/v1/settings/mcp')).json();
  assert.equal(current.oauth.authorizationPending, false);
  assert.equal(current.oauth.credentialsSaved, false);
});

test('a corrupt OAuth credentials file is reported without echoing its content and logout can clear it', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const marker = 'synthetic-private-file-content';
  await writeFile(join(f.directory, 'mcp-oauth', 'inbox.json'), '{"access_token":"' + marker);
  const response = await f.request('/v1/settings/mcp');
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes(marker), false);
  assert.equal((await f.request('/v1/settings/mcp/inbox/logout', 'POST', {})).status, 200);
});

test('a valid OAuth session withholds a reflected saved client secret without needing token refresh', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const login = await (await f.request('/v1/settings/mcp/inbox/login', 'POST', {})).json();
  const callback = (await fetch(login.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  assert.equal((await fetch(callback)).status, 200);
  const tested = await f.runtime().mcp.test('inbox');
  await f.runtime().mcp.enable('inbox', ['read'], tested.revision);
  authority.echo('client');
  const [pin] = await f.runtime().mcp.pins();
  const result = await f.runtime().mcp.executeApproved(pin!, 'read', {});
  assert.equal(result.isError, true);
  assert.equal(authority.refreshes(), 0);
  for (const secret of authority.secrets()) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('closing MCP waits for pending OAuth credential loading and forbids network or dispatch afterwards', async t => {
  const authority = await oauthServer(t), f = await app(t);
  await f.request('/v1/settings/mcp', 'POST', { id: 'inbox', transport: 'http', url: authority.origin + '/mcp', oauth: true });
  const login = await (await f.request('/v1/settings/mcp/inbox/login', 'POST', {})).json();
  const callback = (await fetch(login.authorizationUrl, { redirect: 'manual' })).headers.get('location')!;
  await fetch(callback);
  const manager = f.runtime().mcp, tested = await manager.test('inbox');
  await manager.enable('inbox', ['read'], tested.revision);
  const [pin] = await manager.pins();
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = manager['oauth'].active.bind(manager['oauth']);
  const held = t.mock.method(manager['oauth'], 'active', async (...args: Parameters<typeof original>) => {
    arrived.resolve(); await release.promise; return original(...args);
  });
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const network = t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => { requests++; return originalFetch(...args); });
  const operation = manager.executeApproved(pin!, 'read', {}).then(() => 'dispatched', () => 'cancelled');
  await arrived.promise;
  let closed = false;
  const closing = manager.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'Close must await the full registered operation, including loading credentials.');
    release.resolve();
    await closing;
    assert.equal(await operation, 'cancelled');
    assert.equal(requests, 0);
  } finally { release.resolve(); await Promise.all([operation, closing]); held.mock.restore(); network.mock.restore(); }
});
