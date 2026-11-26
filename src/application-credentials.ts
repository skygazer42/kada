import { createHmac, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isIP } from 'node:net';
import lockfile from 'proper-lockfile';
import ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type CredentialAuth = { type: 'bearer' } | { type: 'header'; name: string } | { type: 'basic'; username: string };
export type CredentialDestination = { name: string; origin: string; auth: CredentialAuth };
export type ApplicationCredential = CredentialDestination & { revision: number; updatedAt: number };
type StoredCredential = ApplicationCredential & { project: string; value?: string; deleted?: true };
type Saved = { schema: 1; salt: string; items: StoredCredential[]; operations: { requestId: string; digest: string; result: ApplicationCredential }[] };
export type CredentialSave = CredentialDestination & { project: string; value: string; expectedRevision: number; requestId: string };
export type CredentialRequest = { name: string; revision: number; url: string; method: string; body?: string; headers?: Record<string, string> };
export type CredentialNetwork = { lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>; request?: typeof httpsRequest };
export class CredentialError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function publicCredentialAddress(address: string): boolean {
  if (!isIP(address) || !ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed instanceof ipaddr.IPv6) return parsed.match(ipaddr.IPv6.parse('2000::'), 3) &&
    !parsed.match(ipaddr.IPv6.parse('2001::'), 23) && !parsed.match(ipaddr.IPv6.parse('3fff::'), 20);
  return !parsed.match(ipaddr.IPv4.parse('192.88.99.0'), 24) && !parsed.match(ipaddr.IPv4.parse('198.18.0.0'), 15);
}

export function credentialDestination(input: unknown): CredentialDestination {
  const invalid = () => { throw new CredentialError(400, 'Provide a credential name, HTTPS origin and supported authentication method.'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'origin', 'auth'].includes(key))) return invalid();
  const { name, origin, auth } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(name) || typeof origin !== 'string' || origin.length > 2048 ||
    !auth || typeof auth !== 'object' || Array.isArray(auth)) return invalid();
  let url: URL;
  try { url = new URL(origin); } catch { return invalid(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|localhost\.localdomain)$/i.test(host) ||
    isIP(host) && !publicCredentialAddress(host)) return invalid();
  const setting = auth as Record<string, unknown>;
  let normalized: CredentialAuth;
  if (setting.type === 'bearer' && Object.keys(setting).length === 1) normalized = { type: 'bearer' };
  else if (setting.type === 'header' && Object.keys(setting).every(key => ['type', 'name'].includes(key)) && typeof setting.name === 'string' &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/.test(setting.name) &&
    !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|accept-encoding|proxy-.*|sec-.*|.*forwarded.*)$/i.test(setting.name)) normalized = { type: 'header', name: setting.name.toLowerCase() };
  else if (setting.type === 'basic' && Object.keys(setting).every(key => ['type', 'username'].includes(key)) && typeof setting.username === 'string' &&
    /^[\x20-\x39\x3b-\x7e]{1,200}$/.test(setting.username)) normalized = { type: 'basic', username: setting.username };
  else return invalid();
  return { name, origin: url.origin, auth: normalized };
}

const metadata = ({ name, origin, auth, revision, updatedAt }: ApplicationCredential): ApplicationCredential => ({ name, origin, auth, revision, updatedAt });
const projectKey = (project: string) => { if (typeof project !== 'string' || !isAbsolute(project)) throw new CredentialError(400, 'Provide the original credential project.'); };
const validRevision = (revision: number, zero = false) => { if (!Number.isSafeInteger(revision) || revision < (zero ? 0 : 1)) throw new CredentialError(400, 'Provide the displayed credential revision.'); };
const validValue = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e][\x20-\x7e]{0,16383}$/.test(value) && !value.endsWith(' ');
const blockedHeader = /^(authorization|host|connection|content-length|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|proxy-.*|sec-.*|.*forwarded.*)$/i;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void;
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      abort = () => reject(new CredentialError(502, 'Authenticated request was cancelled or timed out.'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }), work]);
  } finally { signal.removeEventListener('abort', abort!); }
}

function echoed(text: string, secrets: string[]) {
  const forms = new Set(secrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]));
  const candidates = [text];
  try { candidates.push(JSON.stringify(JSON.parse(text))); } catch { /* A non-JSON response is still checked as text. */ }
  let decoded = text;
  for (let round = 0; round < 3; round++) {
    const next = decoded.replace(/(?:%[a-f0-9]{2})+/gi, part => { try { return decodeURIComponent(part); } catch { return part; } });
    if (next === decoded) break;
    candidates.push(next); decoded = next;
  }
  return candidates.some(candidate => [...forms].some(secret => secret && candidate.toLowerCase().includes(secret.toLowerCase())));
}

export class ApplicationCredentials {
  private readonly directory: string;
  private readonly path: string;
  private readonly queue = new SerialQueue();
  constructor(dataDir: string, private readonly network: CredentialNetwork = {}) { this.directory = join(dataDir, 'application-credentials'); this.path = join(this.directory, 'items.json'); }
  private async exclusive<T>(action: () => Promise<T>) {
    return this.queue.run(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(this.directory, { stale: 30_000, update: 10_000, retries: { retries: 100, minTimeout: 50, maxTimeout: 200 } });
      try { return await action(); } finally { await release(); }
    });
  }
  private async load(): Promise<Saved> {
    let saved: Saved;
    try { saved = await readJson<Saved>(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, salt: randomBytes(32).toString('hex'), items: [], operations: [] };
      throw new CredentialError(400, 'Stored application credentials could not be read.');
    }
    if (saved?.schema !== 1 || !/^[a-f0-9]{64}$/.test(saved.salt) || !Array.isArray(saved.items) || !Array.isArray(saved.operations) || saved.items.some(item =>
      !item || typeof item.project !== 'string' || !isAbsolute(item.project) || typeof item.name !== 'string' || typeof item.origin !== 'string' || !item.auth ||
      !Number.isSafeInteger(item.revision) || item.revision < 1 || !Number.isFinite(item.updatedAt) || (item.deleted !== undefined && item.deleted !== true) || (!item.deleted && !validValue(item.value))) ||
      saved.operations.some(operation => !operation || typeof operation.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(operation.digest) || !operation.result)) {
      throw new CredentialError(400, 'Stored application credentials are invalid.');
    }
    try {
      for (const item of [...saved.items, ...saved.operations.map(operation => operation.result)]) {
        credentialDestination({ name: item.name, origin: item.origin, auth: item.auth });
        validRevision(item.revision);
        if (!Number.isFinite(item.updatedAt)) throw new Error('Invalid stored time.');
      }
      if (new Set(saved.items.map(item => JSON.stringify([item.project, item.name]))).size !== saved.items.length ||
        new Set(saved.operations.map(operation => operation.requestId)).size !== saved.operations.length) throw new Error('Duplicate stored identity.');
    } catch { throw new CredentialError(400, 'Stored application credentials are invalid.'); }
    return saved;
  }
  async list(project: string): Promise<ApplicationCredential[]> {
    projectKey(project);
    return this.exclusive(async () => (await this.load()).items.filter(item => item.project === project && !item.deleted).map(metadata));
  }
  async revision(project: string, name: string): Promise<number> {
    projectKey(project);
    return this.exclusive(async () => (await this.load()).items.find(item => item.project === project && item.name === name)?.revision ?? 0);
  }
  async hasSave(requestId: string): Promise<boolean> {
    return this.exclusive(async () => (await this.load()).operations.some(operation => operation.requestId === requestId));
  }
  async save(input: CredentialSave): Promise<ApplicationCredential> {
    const destination = credentialDestination({ name: input.name, origin: input.origin, auth: input.auth });
    projectKey(input.project); validRevision(input.expectedRevision, true);
    if (!validValue(input.value) ||
      typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(input.requestId)) throw new CredentialError(400, 'Provide a nonblank credential value and valid save request ID.');
    return this.exclusive(async () => {
      const saved = await this.load();
      const digest = createHmac('sha256', saved.salt).update(JSON.stringify([input.project, destination, input.expectedRevision, input.value])).digest('hex');
      const receipt = saved.operations.find(operation => operation.requestId === input.requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new CredentialError(409, 'This credential save request already has different content.');
        return metadata(receipt.result);
      }
      const index = saved.items.findIndex(item => item.project === input.project && item.name === destination.name), previous = saved.items[index];
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new CredentialError(409, 'The credential changed. Read its current revision before replacing it.');
      const next: StoredCredential = { ...destination, project: input.project, value: input.value, revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() };
      if (index < 0) saved.items.push(next); else saved.items[index] = next;
      const result = metadata(next);
      saved.operations.push({ requestId: input.requestId, digest, result });
      await atomicJson(this.path, saved);
      return result;
    });
  }
  async remove(project: string, name: string, revision: number): Promise<void> {
    projectKey(project); validRevision(revision);
    await this.exclusive(async () => {
      const saved = await this.load(), item = saved.items.find(item => item.project === project && item.name === name);
      if (!item) throw new CredentialError(404, 'Credential not found in this project.');
      if (item.revision !== revision) throw new CredentialError(409, 'The credential changed. Read its current revision before deleting it.');
      if (item.deleted) return;
      delete item.value; item.deleted = true; item.revision++; item.updatedAt = Date.now();
      await atomicJson(this.path, saved);
    });
  }
  async request(project: string, input: CredentialRequest, parentSignal?: AbortSignal): Promise<{ status: number; body: string; headers: Record<string, string>; truncated: boolean; withheld: boolean }> {
    projectKey(project); validRevision(input.revision);
    if (Object.keys(input).some(key => !['name', 'revision', 'url', 'method', 'body', 'headers'].includes(key)) ||
      typeof input.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.name) || typeof input.url !== 'string' || input.url.length > 8192 ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method) ||
      input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 65_536 || ['GET', 'HEAD'].includes(input.method))) throw new CredentialError(400, 'Provide a supported HTTP request of up to 64 KiB.');
    const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' };
    if (input.headers !== undefined) {
      if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers) || Object.keys(input.headers).length > 16) throw new CredentialError(400, 'Invalid authenticated request headers.');
      for (const [name, value] of Object.entries(input.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/.test(name) || blockedHeader.test(name) || name.toLowerCase() === 'accept-encoding' ||
          typeof value !== 'string' || !/^[\x20-\x7e]{0,2048}$/.test(value)) throw new CredentialError(400, 'Invalid authenticated request headers.');
        headers[name.toLowerCase()] = value;
      }
    }
    let url: URL;
    try { url = new URL(input.url); } catch { throw new CredentialError(400, 'Invalid authenticated request URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new CredentialError(400, 'Use the credential HTTPS origin without credentials or a fragment.');
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(parentSignal ? [parentSignal] : [])]);
    if (signal.aborted) throw new CredentialError(502, 'Authenticated request was cancelled or timed out.');
    // Read only metadata until the destination is validated; recheck its revision before dispatch.
    const selected = (await this.list(project)).find(item => item.name === input.name);
    if (!selected) throw new CredentialError(404, 'Credential not found in this project.');
    if (selected.revision !== input.revision || url.origin !== selected.origin) throw new CredentialError(409, 'The credential revision or request origin does not match.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable((this.network.lookup ?? (host => lookup(host, { all: true, verbatim: true })))(hostname), signal); }
    catch { throw new CredentialError(502, 'The authenticated request destination could not be resolved.'); }
    if (!addresses.length || addresses.some(row => !publicCredentialAddress(row.address) || isIP(row.address) !== row.family)) throw new CredentialError(400, 'The credential destination must resolve only to public addresses.');
    const pinned: LookupFunction = (_host, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    const started = await this.exclusive(async () => {
      const selected = (await this.load()).items.find(item => item.project === project && item.name === input.name && !item.deleted);
      if (!selected || selected.revision !== input.revision || selected.origin !== url.origin) throw new CredentialError(409, 'The credential changed before request dispatch.');
      if (signal.aborted) throw new CredentialError(502, 'Authenticated request was cancelled or timed out.');
      const value = selected.value!, auth = selected.auth;
      const headerName = auth.type === 'header' ? auth.name : 'authorization';
      if (Object.hasOwn(headers, headerName)) throw new CredentialError(400, 'The credential authentication header cannot be overridden.');
      const headerValue = auth.type === 'bearer' ? 'Bearer ' + value : auth.type === 'basic' ? 'Basic ' + Buffer.from(auth.username + ':' + value).toString('base64') : value;
      headers[headerName] = headerValue;
      const response = new Promise<{ status: number; body: string; headers: Record<string, string>; truncated: boolean; withheld: boolean }>((resolve, reject) => {
        const fail = () => reject(new CredentialError(502, 'Authenticated request failed. Check its destination and credential.'));
        const request = (this.network.request ?? httpsRequest)({ protocol: 'https:', hostname, servername: isIP(hostname) ? undefined : hostname,
          port: url.port || 443, path: url.pathname + url.search, method: input.method, headers, lookup: pinned, agent: false, signal }, response => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy(); reject(new CredentialError(502, 'Authenticated redirects are refused.')); return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); fail(); return; }
          let bytes = 0; const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1_000_000) { reject(new CredentialError(502, 'Authenticated response exceeds its 1 MB limit.')); response.destroy(); return; }
            chunks.push(Buffer.from(chunk));
          });
          response.on('error', fail);
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8'), secrets = [value, headerValue, ...(auth.type === 'basic' ? [auth.username + ':' + value] : [])];
            const withheld = echoed(text, secrets), safeHeaders: Record<string, string> = {};
            for (const name of ['content-range', 'retry-after', 'x-next-page', 'x-page', 'x-per-page', 'x-total', 'x-total-count', 'x-total-pages']) {
              const header = response.headers[name];
              if (typeof header === 'string' && header.length <= 2000 && !echoed(header, secrets)) safeHeaders[name] = header;
            }
            resolve({ status: response.statusCode ?? 0, body: withheld ? 'Response contained a configured credential and was withheld.' : text.slice(0, 20_000),
              headers: safeHeaders, truncated: !withheld && text.length > 20_000, withheld });
          });
        });
        request.on('error', fail);
        request.end(input.body);
      });
      return { response: response.then(result => ({ result }), error => ({ error: error instanceof CredentialError ? error : new CredentialError(502, 'Authenticated request failed. Check its destination and credential.') })) };
    });
    const response = await abortable(started.response, signal);
    if ('error' in response) throw response.error;
    return response.result;
  }
}
