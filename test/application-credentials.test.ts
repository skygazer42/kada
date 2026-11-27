import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import type { request as HttpsRequest } from 'node:https';
import { ApplicationCredentials, credentialDestination, publicCredentialAddress } from '../src/application-credentials.js';

async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'kada-credentials-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return { directory, store: new ApplicationCredentials(directory), file: join(directory, 'application-credentials', 'items.json') };
}
const value = 'synthetic-credential-value-42';

test('Windows encrypts stored credentials on mutation and can reopen them under the same user', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  const destination = { name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' as const } };
  await f.store.list(project);
  const legacy = { ...destination, project, value, revision: 1, updatedAt: 42 };
  const original = JSON.stringify({ schema: 1, salt: 'aa'.repeat(32), items: [legacy], operations: [] });
  await writeFile(f.file, original);
  assert.deepEqual(await f.store.list(project), [{ ...destination, revision: 1, updatedAt: 42 }]);
  assert.equal(await readFile(f.file, 'utf8'), original);

  const rotation = { ...destination, project, value: 'replacement-synthetic-value', expectedRevision: 1, requestId: 'legacy-rotation' };
  const stored = await f.store.save(rotation);
  const protectedBytes = await readFile(f.file, 'utf8');
  assert.doesNotMatch(protectedBytes, /synthetic-credential-value-42|replacement-synthetic-value|legacy-rotation/);
  const envelope = JSON.parse(protectedBytes);
  assert.equal(envelope.schema, 2);
  assert.equal(envelope.protection, 'windows-dpapi');
  const reopened = new ApplicationCredentials(f.directory);
  assert.deepEqual(await reopened.list(project), [stored]);
  assert.deepEqual(await reopened.save(rotation), stored);
  assert.equal(await readFile(f.file, 'utf8'), protectedBytes);
  const tag = Buffer.from(envelope.tag, 'base64');
  tag[0] = tag[0]! ^ 1;
  const damaged = JSON.stringify({ ...envelope, tag: tag.toString('base64') });
  await writeFile(f.file, damaged);
  await assert.rejects(reopened.list(project), /Stored application credentials/);
  await assert.rejects(reopened.save({ ...rotation, expectedRevision: 2, requestId: 'after-damage' }), /Stored application credentials/);
  assert.equal(await readFile(f.file, 'utf8'), damaged);
});

test('application credentials retain project, revision and original save receipts without returning values', async t => {
  const f = await fixture(t), project = join(f.directory, 'project'), other = join(f.directory, 'other');
  const input = { project, name: 'reports', origin: 'https://api.example/', auth: { type: 'bearer' as const }, value, expectedRevision: 0, requestId: 'save-original' };
  const [first, duplicate] = await Promise.all([f.store.save(input), f.store.save(input)]);
  assert.deepEqual(duplicate, first); assert.equal(first.revision, 1); assert.equal(first.origin, 'https://api.example');
  assert.deepEqual(await f.store.list(project), [first]); assert.deepEqual(await f.store.list(other), []);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-credential|fingerprint|requestId|value/);
  const updated = await f.store.save({ ...input, value: 'replacement-synthetic-value', expectedRevision: 1, requestId: 'rotate' });
  assert.equal(updated.revision, 2);
  assert.deepEqual(await new ApplicationCredentials(f.directory).save(input), first);
  await assert.rejects(f.store.save({ ...input, value: 'different-value' }), { status: 409 });
  await assert.rejects(f.store.save({ ...input, requestId: 'stale' }), { status: 409 });
  await f.store.remove(project, first.name, 2);
  assert.deepEqual(await f.store.list(project), []);
  assert.deepEqual(await f.store.save(input), first, 'old save replay cannot resurrect deleted values');
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /replacement-synthetic-value|synthetic-credential-value-42/);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.directory, 'application-credentials'))).mode & 0o777, 0o700);
  }
});

test('independent credential stores serialize conflicting edits and preserve other project values', async t => {
  const f = await fixture(t), project = join(f.directory, 'project'), other = join(f.directory, 'other');
  const original = { project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' as const }, value, expectedRevision: 0, requestId: 'first' };
  await f.store.save(original);
  const second = new ApplicationCredentials(f.directory);
  const results = await Promise.allSettled([
    f.store.save({ ...original, expectedRevision: 1, requestId: 'left', value: 'left-synthetic-value' }),
    second.save({ ...original, expectedRevision: 1, requestId: 'right', value: 'right-synthetic-value' }),
    second.save({ ...original, project: other, requestId: 'other' }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 2);
  assert.equal((results.find(row => row.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  assert.equal((await f.store.list(project))[0].revision, 2); assert.equal((await f.store.list(other))[0].revision, 1);
  await assert.rejects(f.store.remove(project, 'reports', 1), { status: 409 });
});

test('credential destination and secret validation reject unsafe or ambiguous metadata without exposing input values', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  assert.deepEqual(credentialDestination({ name: 'reports', origin: 'https://API.EXAMPLE:443/', auth: { type: 'header', name: 'X-API-Key' } }),
    { name: 'reports', origin: 'https://api.example', auth: { type: 'header', name: 'x-api-key' } });
  const userinfo = new URL('https://api.example'); userinfo.username = 'fixture-user'; userinfo.password = 'fixture-password';
  for (const origin of ['http://api.example', userinfo.href, 'https://api.example/path', 'https://api.example?key=abc', 'https://api.example/#part', 'https://localhost', 'https://127.1', 'https://[::1]']) {
    assert.throws(() => credentialDestination({ name: 'reports', origin, auth: { type: 'bearer' } }));
  }
  for (const name of ['Host', 'Cookie', 'Origin', 'Proxy-Authorization', 'Content-Length', 'Connection', 'Forwarded', 'Sec-Fetch-Site', 'Accept-Encoding']) {
    assert.throws(() => credentialDestination({ name: 'reports', origin: 'https://api.example', auth: { type: 'header', name } }));
  }
  const input = { project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' as const }, value, expectedRevision: 0, requestId: 'save' };
  for (const fields of [{ value: '' }, { value: value + '\r\nInjected' }, { value: value + '\0' }, { requestId: '../bad' }, { project: 'relative' }, { expectedRevision: -1 }]) {
    await assert.rejects(f.store.save({ ...input, ...fields }), error => { assert.doesNotMatch(String(error), /synthetic-credential/); return true; });
  }
  await f.store.save(input);
  await writeFile(f.file, '{"schema":1,"items":"broken"}');
  await assert.rejects(f.store.list(project), /Stored application credentials/);
  await assert.rejects(f.store.save({ ...input, requestId: 'after-corruption' }), /Stored application credentials/);
});

test('credential egress classifies public addresses and rejects private, mapped, metadata and special networks', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicCredentialAddress(address), true, address);
  for (const address of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'not-an-address']) assert.equal(publicCredentialAddress(address), false, address);
});

test('authenticated requests bind the origin and revision, pin DNS, reject redirects and withhold encoded credential echoes', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  const received: { auth?: string; path: string; method?: string }[] = [];
  const server = createServer((req, res) => {
    received.push({ auth: req.headers.authorization, path: req.url!, method: req.method });
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://other.example/leak' }).end(); return; }
    if (req.url === '/echo') { res.setHeader('x-secret', value); res.end(JSON.stringify({ echo: encodeURIComponent(value), nested: Buffer.from(value).toString('base64') })); return; }
    if (req.url === '/large') { res.end('x'.repeat(1_000_001)); return; }
    if (req.url === '/long') { res.end('x'.repeat(21_000)); return; }
    res.setHeader('x-next-page', '2'); res.setHeader('set-cookie', value); res.end('Received');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const port = (server.address() as { port: number }).port;
  let resolutions = 0, pinned = false;
  const store = new ApplicationCredentials(f.directory, { lookup: async host => { assert.equal(host, 'api.example'); resolutions++; return [{ address: '8.8.8.8', family: 4 }]; },
    request: ((options: any, callback: any) => {
      assert.equal(options.hostname, 'api.example'); assert.equal(options.servername, 'api.example');
      options.lookup('api.example', { all: true }, (_error: unknown, records: unknown) => { assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]); pinned = true; });
      return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, callback);
    }) as typeof HttpsRequest });
  await store.save({ project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value, expectedRevision: 0, requestId: 'save' });
  const request = { name: 'reports', revision: 1, url: 'https://api.example/read', method: 'GET' as const };
  const result = await store.request(project, request);
  assert.equal(result.status, 200); assert.equal(result.body, 'Received'); assert.deepEqual(result.headers, { 'x-next-page': '2' });
  assert.equal(pinned, true); assert.equal(resolutions, 1); assert.equal(received[0].auth, 'Bearer ' + value);
  const echo = await store.request(project, { ...request, url: 'https://api.example/echo' });
  assert.equal(echo.withheld, true); assert.doesNotMatch(JSON.stringify(echo), /synthetic-credential|c3ludGhldGlj/);
  await assert.rejects(store.request(project, { ...request, url: 'https://api.example/redirect' }), /redirect/i);
  await assert.rejects(store.request(project, { ...request, url: 'https://api.example/large' }), /limit/i);
  const long = await store.request(project, { ...request, url: 'https://api.example/long' }); assert.equal(long.body.length, 20_000); assert.equal(long.truncated, true);
  const before = received.length;
  for (const fields of [{ url: 'https://other.example/read' }, { revision: 2 }, { url: 'http://api.example/read' }, { headers: { Authorization: 'override' } }, { url: 'https://api.example/#fragment' }, { method: 'CONNECT' }]) await assert.rejects(store.request(project, { ...request, ...fields }));
  await assert.rejects(store.request(join(f.directory, 'other'), request));
  await store.remove(project, 'reports', 1); await assert.rejects(store.request(project, request));
  assert.equal(received.length, before, 'rejected destinations and revoked revisions never dispatch');
});

test('private DNS answers and cancellation during resolution never dispatch or reveal credentials', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  await f.store.save({ project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value, expectedRevision: 0, requestId: 'save' });
  const noRequest = (() => assert.fail('A refused DNS target must not dispatch')) as typeof HttpsRequest;
  const input = { name: 'reports', revision: 1, url: 'https://api.example/read', method: 'GET' as const };
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], []]) {
    const store = new ApplicationCredentials(f.directory, { lookup: async () => addresses, request: noRequest });
    await assert.rejects(store.request(project, input));
  }
  const resolve = Promise.withResolvers<{ address: string; family: number }[]>(), started = Promise.withResolvers<void>(), controller = new AbortController();
  const store = new ApplicationCredentials(f.directory, { lookup: () => { started.resolve(); return resolve.promise; }, request: noRequest });
  const pending = store.request(project, input, controller.signal); await started.promise; controller.abort();
  await assert.rejects(pending); resolve.resolve([{ address: '8.8.8.8', family: 4 }]);
});

test('custom header and Basic authentication reject overrides and withhold JSON-escaped values before truncation', async t => {
  const f = await fixture(t), project = join(f.directory, 'project'), secret = 'synthetic-"quoted\\value-42';
  let reply = 'OK'; const received: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((req, res) => { received.push(req.headers); res.end(reply); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const port = (server.address() as { port: number }).port;
  const store = new ApplicationCredentials(f.directory, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: ((options: any, callback: any) => httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, callback)) as typeof HttpsRequest });
  for (const auth of [{ type: 'header' as const, name: 'x-api-key' }, { type: 'basic' as const, username: 'reports' }]) {
    const name = auth.type;
    await store.save({ project, name, origin: 'https://api.example', auth, value: secret, expectedRevision: 0, requestId: name });
    const input = { name, revision: 1, url: 'https://api.example/read', method: 'POST', body: '{"report":true}' };
    reply = 'OK'; await store.request(project, input);
    assert.equal(received.at(-1)![auth.type === 'header' ? auth.name : 'authorization'], auth.type === 'header' ? secret : 'Basic ' + Buffer.from('reports:' + secret).toString('base64'));
    const count = received.length;
    await assert.rejects(store.request(project, { ...input, headers: { [auth.type === 'header' ? 'X-API-Key' : 'Authorization']: 'override' } }));
    assert.equal(received.length, count);
    for (reply of [JSON.stringify({ nested: [secret] }), JSON.stringify({ value: secret }).replace(/s/g, '\\u0073'), 'x'.repeat(21_000) + JSON.stringify({ value: secret })]) {
      const result = await store.request(project, input);
      assert.equal(result.withheld, true, 'JSON-escaped secrets must be withheld, including after the preview boundary');
      assert.equal(result.truncated, false); assert.doesNotMatch(result.body, /synthetic|quoted/);
    }
  }
});

test('rotation and deletion during blocked DNS prevent authenticated dispatch', async t => {
  const f = await fixture(t), project = join(f.directory, 'project');
  const original = { project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' as const }, value, expectedRevision: 0, requestId: 'save' };
  await f.store.save(original);
  for (const mutation of ['rotate', 'delete']) {
    const started = Promise.withResolvers<void>(), resolved = Promise.withResolvers<{ address: string; family: number }[]>();
    const store = new ApplicationCredentials(f.directory, { lookup: () => { started.resolve(); return resolved.promise; }, request: (() => assert.fail('Revoked revision must not dispatch')) as typeof HttpsRequest });
    const revision = (await f.store.list(project))[0].revision;
    const pending = store.request(project, { name: 'reports', revision, url: 'https://api.example/read', method: 'GET' });
    await started.promise;
    if (mutation === 'rotate') await f.store.save({ ...original, expectedRevision: revision, requestId: mutation, value: 'rotated-synthetic-value' });
    else await f.store.remove(project, 'reports', revision);
    resolved.resolve([{ address: '8.8.8.8', family: 4 }]);
    await assert.rejects(pending, { status: 409 });
  }
});

test('cancellation at the DNS call handles a late resolver rejection', async t => {
  const f = await fixture(t), project = join(f.directory, 'project'), controller = new AbortController();
  await f.store.save({ project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value, expectedRevision: 0, requestId: 'save' });
  const store = new ApplicationCredentials(f.directory, { lookup: () => { controller.abort(); return Promise.reject(new Error('Synthetic resolver failure')); }, request: (() => assert.fail('Cancelled lookup must not dispatch')) as typeof HttpsRequest });
  await assert.rejects(store.request(project, { name: 'reports', revision: 1, url: 'https://api.example/read', method: 'GET' }, controller.signal));
  await new Promise<void>(done => setImmediate(done));
});

test('cancellation after dispatch closes the actual authenticated connection without retry', { timeout: 10_000 }, async t => {
  const f = await fixture(t), project = join(f.directory, 'project'), started = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  let calls = 0;
  const server = createServer((_req, res) => { calls++; res.on('close', () => closed.resolve()); started.resolve(); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const port = (server.address() as { port: number }).port;
  const store = new ApplicationCredentials(f.directory, { lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: ((options: any, callback: any) => httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined }, callback)) as typeof HttpsRequest });
  await store.save({ project, name: 'reports', origin: 'https://api.example', auth: { type: 'bearer' }, value, expectedRevision: 0, requestId: 'save' });
  const controller = new AbortController(), pending = store.request(project, { name: 'reports', revision: 1, url: 'https://api.example/read', method: 'GET' }, controller.signal);
  await started.promise; controller.abort(new Error(value));
  await assert.rejects(pending, error => { assert.doesNotMatch(String(error), /synthetic-credential/); return true; });
  await closed.promise; assert.equal(calls, 1);
  await assert.rejects(store.request(project, { name: 'reports', revision: 1, url: 'https://api.example/read', method: 'GET' }, controller.signal), error => { assert.doesNotMatch(String(error), /synthetic-credential/); return true; });
});
