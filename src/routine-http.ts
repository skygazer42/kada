import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { publicCredentialAddress, type CredentialNetwork } from './application-credentials.js';
import { stableJson } from './mcp-tools.js';
import { VERSION } from './version.js';

export type RoutineHttpCheck = { url: string; track?: string[] };
export type RoutineHttpNetwork = CredentialNetwork;
class HttpCheckError extends Error {}
const failure = () => new HttpCheckError('Could not check the HTTPS endpoint.');

export function normalizeRoutineHttp(input: unknown): RoutineHttpCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'track'].includes(key))) {
    throw new HttpCheckError('Provide an HTTPS URL and optional tracked JSON fields.');
  }
  const { url: raw, track } = input as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.length > 2048) throw new HttpCheckError('Provide an HTTPS URL of up to 2048 characters.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpCheckError('Provide a public HTTPS URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.href.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.href.includes('#') || url.port && url.port !== '443' ||
    !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|localhost\.localdomain)$/i.test(host) ||
    isIP(host) && !publicCredentialAddress(host)) throw new HttpCheckError('Use a public HTTPS URL on port 443 without credentials or a fragment.');
  if (track !== undefined && (!Array.isArray(track) || !track.length || track.length > 16 ||
    track.some(field => typeof field !== 'string' || !field.trim() || field.length > 80 || field.includes('\0')) || new Set(track).size !== track.length)) {
    throw new HttpCheckError('Choose one to sixteen distinct tracked JSON fields.');
  }
  return { url: url.href, ...(track === undefined ? {} : { track: [...track as string[]] }) };
}

function fingerprint(text: string, track?: string[]) {
  const digest = (value: string) => ({ sha256: createHash('sha256').update(value).digest('hex') });
  let data: unknown;
  try { data = JSON.parse(text); }
  catch {
    if (track) throw new HttpCheckError('Tracked HTTPS fields require a JSON response.');
    return digest(text);
  }
  const pending = [{ value: data, depth: 0 }], items = new Map<string, string[]>();
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new HttpCheckError('HTTPS JSON requires finite numbers.');
    if (!value || typeof value !== 'object') continue;
    if (depth > 64) throw new HttpCheckError('HTTPS JSON exceeds 64 levels of nesting.');
    if (track && !Array.isArray(value)) {
      const record = value as Record<string, unknown>, id = Object.hasOwn(record, track[0]!) ? record[track[0]!] : undefined;
      if (typeof id === 'string' || typeof id === 'number') {
        const key = JSON.stringify(id), fields = items.get(key) ?? [];
        fields.push(stableJson(track.slice(1).map(field => Object.hasOwn(record, field) ? record[field] : null)));
        items.set(key, fields);
      }
    }
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return digest(stableJson(track ? Object.fromEntries([...items].map(([id, values]) => [id, values.sort()])) : data));
}

async function resolveBeforeAbort(work: Promise<{ address: string; family: number }[]>, signal: AbortSignal) {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new HttpCheckError('HTTPS check was cancelled or timed out.')); });
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function sampleRoutineHttp(input: RoutineHttpCheck, parentSignal?: AbortSignal, network: RoutineHttpNetwork = {}): Promise<{ sha256: string }> {
  const check = normalizeRoutineHttp(input), url = new URL(check.url), hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(parentSignal ? [parentSignal] : [])]);
  let response: IncomingMessage | undefined;
  try {
    if (signal.aborted) throw new HttpCheckError('HTTPS check was cancelled or timed out.');
    const addresses = await resolveBeforeAbort(isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) :
      (network.lookup ?? (host => lookup(host, { all: true, verbatim: true })))(hostname), signal);
    if (!addresses.length || addresses.some(row => !publicCredentialAddress(row.address) || isIP(row.address) !== row.family)) {
      throw new HttpCheckError('The HTTPS destination must resolve only to public addresses.');
    }
    if (signal.aborted) throw new HttpCheckError('HTTPS check was cancelled or timed out.');
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const current = (network.request ?? request)({ protocol: 'https:', hostname, servername: isIP(hostname) ? undefined : hostname,
        port: 443, path: url.pathname + url.search, method: 'GET', headers: { 'accept-encoding': 'identity', 'user-agent': 'Kada/' + VERSION },
        lookup: pinned, agent: false, rejectUnauthorized: true, signal }, resolve);
      current.once('error', () => reject(failure()));
      current.end();
    });
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      throw new HttpCheckError('HTTPS check returned status ' + (response.statusCode ?? 0) + '.');
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') {
      throw new HttpCheckError('HTTPS check response encoding must be identity.');
    }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > 1_000_000) throw new HttpCheckError('HTTPS check response exceeds its 1 MB limit.');
      chunks.push(chunk);
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new HttpCheckError('HTTPS check response requires valid UTF-8.'); }
    return fingerprint(text, check.track);
  } catch (error) {
    if (error instanceof HttpCheckError) throw error;
    throw failure();
  } finally { response?.destroy(); }
}
