import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema, type OAuthClientInformationMixed, type OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

type Material = { redirectUrl: string; serverUrl: string; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; discovery?: OAuthDiscoveryState; verifier?: string };
type Pending = Material & { state: string; expiresAt: number; exchanging?: true };
type Saved = { binding: string; generation: string; active?: Material; pending?: Pending };
type Scope = { pending: string } | { generation: string };
export type McpAuthSession = { provider: OAuthClientProvider; credentials: string[]; authorizationUrl?: string; state?: string; expiresAt?: number };
export type McpRegisteredClient = { clientId: string; issuer: string; clientSecretEnv?: string; scope?: string };
export type McpOAuthSetting = boolean | McpRegisteredClient;

export class McpAuthError extends Error {
  constructor(readonly status: 400 | 409 | 502, message: string) { super(message); }
}

export function loopback(url: URL): boolean { return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); }

export function oauthUrl(value: string | URL, allowLoopback: boolean): URL {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback && loopback(url))) || url.username || url.password || url.hash) {
    throw new McpAuthError(400, 'OAuth requires HTTPS or an explicitly configured loopback server.');
  }
  return url;
}

export function normalizeOAuth(input: unknown, serverUrl: URL): true | McpRegisteredClient | undefined {
  if (input === undefined || input === false) return;
  if (input === true) return true;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['clientId', 'issuer', 'clientSecretEnv', 'scope'].includes(key))) {
    throw new McpAuthError(400, 'Use oauth: true or a registered client ID, issuer and optional environment reference.');
  }
  const { clientId, issuer, clientSecretEnv, scope } = input as Record<string, unknown>;
  if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 1024 || /[\x00-\x1f\x7f]/.test(clientId) ||
    typeof issuer !== 'string' || !issuer || issuer.length > 2048 ||
    clientSecretEnv !== undefined && (typeof clientSecretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(clientSecretEnv)) ||
    scope !== undefined && (typeof scope !== 'string' || !scope.trim() || scope.length > 2048 || /[^\x20-\x7e]/.test(scope))) {
    throw new McpAuthError(400, 'Provide a registered client ID, issuer and valid secret environment name or scope.');
  }
  const url = oauthUrl(issuer, loopback(serverUrl));
  if (url.search) throw new McpAuthError(400, 'The OAuth issuer must not contain a query.');
  return { clientId, issuer: url.href, ...(clientSecretEnv ? { clientSecretEnv } : {}), ...(scope ? { scope: scope.trim() } : {}) };
}

function registeredClient(config?: McpOAuthSetting): OAuthClientInformationMixed | undefined {
  if (!config || typeof config === 'boolean') return;
  const secret = config.clientSecretEnv === undefined ? undefined : process.env[config.clientSecretEnv];
  if (config.clientSecretEnv && !secret) throw new McpAuthError(400, 'A configured MCP OAuth client secret environment variable is missing.');
  return { client_id: config.clientId, issuer: config.issuer, ...(secret ? { client_secret: secret } : {}) };
}

export class McpOAuth {
  private readonly changes = new SerialQueue();
  constructor(private readonly dataDir: string) {}
  private path(id: string) { return join(this.dataDir, 'mcp-oauth', id + '.json'); }
  private async read(id: string): Promise<Saved | undefined> {
    try { return await readJson<Saved>(this.path(id)); }
    catch (error) {
      if (error instanceof SyntaxError) throw new McpAuthError(400, 'Stored MCP authorization could not be read. Check its local credentials file.');
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private pending(saved: Saved | undefined, binding: string, state: string): Pending {
    const expected = Buffer.from(saved?.pending?.state ?? ''), supplied = Buffer.from(state);
    if (!saved || saved.binding !== binding || !saved.pending || expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied) || Date.now() >= saved.pending.expiresAt) {
      throw new McpAuthError(400, 'This authorization request is invalid or expired. Start sign-in again.');
    }
    return saved.pending;
  }
  async status(id: string, binding: string) {
    const saved = await this.read(id);
    return { credentialsSaved: saved?.binding === binding && Boolean(saved.active?.tokens),
      authorizationPending: saved?.binding === binding && Boolean(saved.pending && saved.pending.expiresAt > Date.now()) };
  }
  async clear(id: string) {
    await this.changes.run(() => atomicJson(this.path(id), { binding: '', generation: randomUUID() }));
  }
  async begin(id: string, binding: string, redirectUrl: string, serverUrl: string, config?: McpOAuthSetting): Promise<McpAuthSession> {
    const redirect = new URL(redirectUrl);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.username || redirect.password || redirect.search || redirect.hash) {
      throw new McpAuthError(400, 'OAuth needs the local daemon callback URL.');
    }
    const state = id + '.' + randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 10 * 60_000;
    const session = this.session(id, binding, { pending: state }, { redirectUrl, serverUrl }, config);
    await this.changes.run(async () => {
      const prior = await this.read(id);
      const saved: Saved = prior?.binding === binding ? prior : { binding, generation: randomUUID() };
      const active = saved.active;
      saved.pending = { state, expiresAt, redirectUrl, serverUrl, ...(active?.redirectUrl === redirectUrl ? { client: active.client } : {}),
        ...(active?.discovery ? { discovery: active.discovery } : {}) };
      await atomicJson(this.path(id), saved);
    });
    session.state = state; session.expiresAt = expiresAt;
    return session;
  }
  async active(id: string, binding: string, config?: McpOAuthSetting): Promise<McpAuthSession> {
    const saved = await this.read(id);
    if (saved?.binding !== binding || !saved.active?.tokens) throw new McpAuthError(400, 'Sign in to this MCP connection from the owner settings first.');
    return this.session(id, binding, { generation: saved.generation }, saved.active, config);
  }
  async claim(id: string, binding: string, state: string, config?: McpOAuthSetting) {
    const claimed = await this.changes.run(async () => {
      const saved = await this.read(id), pending = this.pending(saved, binding, state);
      const session = this.session(id, binding, { pending: state }, pending, config);
      if (pending.tokens) return { needsExchange: false, session };
      if (pending.exchanging) throw new McpAuthError(409, 'This authorization code was already submitted. Start sign-in again if its result is unknown.');
      pending.exchanging = true;
      await atomicJson(this.path(id), saved);
      return { needsExchange: true, session };
    });
    return claimed;
  }
  async complete(id: string, binding: string, state: string) {
    await this.changes.run(async () => {
      const saved = (await this.read(id))!, pending = this.pending(saved, binding, state);
      if (!pending.tokens) throw new McpAuthError(502, 'The MCP service did not save an authorization grant.');
      const { state: _state, expiresAt: _expires, exchanging: _exchanging, verifier: _verifier, ...active } = pending;
      saved.active = active; saved.generation = randomUUID(); delete saved.pending;
      await atomicJson(this.path(id), saved);
    });
  }
  async ready(id: string, binding: string, state: string) {
    const pending = this.pending(await this.read(id), binding, state);
    if (!pending.tokens) throw new McpAuthError(502, 'The MCP service did not save an authorization grant.');
  }
  async cancel(id: string, binding: string, state: string) {
    await this.changes.run(async () => {
      const saved = await this.read(id);
      if (saved?.binding !== binding || saved.pending?.state !== state) return;
      delete saved.pending;
      await atomicJson(this.path(id), saved);
    });
  }
  private session(id: string, binding: string, scope: Scope, initial: Material, config?: McpOAuthSetting): McpAuthSession {
    const registered = registeredClient(config);
    const credentials: string[] = [];
    const material = (saved: Saved | undefined): Material => {
      if ('pending' in scope) return this.pending(saved, binding, scope.pending);
      if (saved?.binding !== binding || saved.generation !== scope.generation || !saved.active) throw new McpAuthError(400, 'This MCP authorization changed. Sign in again.');
      return saved.active;
    };
    const read = async () => material(await this.read(id));
    const write = (change: (value: Material) => void) => this.changes.run(async () => {
      const saved = await this.read(id); change(material(saved)); await atomicJson(this.path(id), saved);
    });
    const remember = (...values: (string | undefined)[]) => { for (const value of values) if (value && !credentials.includes(value)) credentials.push(value); };
    remember(initial.client?.client_secret, initial.tokens?.access_token, initial.tokens?.refresh_token, initial.tokens?.id_token);
    remember(registered?.client_secret);
    const { redirectUrl, serverUrl } = initial;
    const session: McpAuthSession = { credentials, provider: {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return { client_name: 'Kada', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', ...(config && typeof config === 'object' && config.scope ? { scope: config.scope } : {}) }; },
      state: () => { if ('pending' in scope) return scope.pending; throw new McpAuthError(400, 'The MCP connection needs a fresh owner sign-in.'); },
      clientInformation: async () => {
        const saved = await read();
        if (registered) return registered;
        remember(saved.client?.client_secret); return saved.client;
      },
      ...(!registered ? { saveClientInformation: async (client: OAuthClientInformationMixed) => { remember(client.client_secret); await write(value => { value.client = client; }); } } : {}),
      tokens: async () => {
        const tokens = (await read()).tokens;
        if (!tokens) return;
        const parsed = OAuthTokensSchema.safeParse(tokens);
        if (!parsed.success) throw new McpAuthError(400, 'Stored MCP credentials are invalid. Sign in again.');
        remember(parsed.data.access_token, parsed.data.refresh_token, parsed.data.id_token);
        return parsed.data;
      },
      saveTokens: async tokens => { remember(tokens.access_token, tokens.refresh_token, tokens.id_token); await write(value => { value.tokens = tokens; }); },
      saveCodeVerifier: verifier => write(value => { value.verifier = verifier; }),
      codeVerifier: async () => { const value = (await read()).verifier; if (!value) throw new McpAuthError(400, 'This sign-in has no PKCE verifier. Start again.'); return value; },
      discoveryState: async () => (await read()).discovery,
      saveDiscoveryState: discovery => write(value => { value.discovery = discovery; }),
      invalidateCredentials: kind => write(value => {
        if (kind === 'all' || kind === 'client') delete value.client;
        if (kind === 'all' || kind === 'tokens') delete value.tokens;
        if (kind === 'all' || kind === 'verifier') delete value.verifier;
        if (kind === 'all' || kind === 'discovery') delete value.discovery;
      }),
      redirectToAuthorization: async url => {
        await read();
        if (!('pending' in scope)) throw new McpAuthError(400, 'The MCP connection needs a fresh owner sign-in.');
        const valid = oauthUrl(url, loopback(new URL(serverUrl)));
        if (valid.href.length > 8192) throw new McpAuthError(400, 'The MCP authorization URL is too long.');
        session.authorizationUrl = valid.href;
      },
    } };
    return session;
  }
}
