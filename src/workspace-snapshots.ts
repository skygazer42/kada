import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { defineDoc } from '@earendil-works/pi-durable';
import { atomicJson, readJson, SerialQueue } from './util.js';
import { Workspace } from './workspace.js';

const storageName = '.kada-workspace-snapshots';
const stagingName = '.kada-restore-staging';
const excluded = new Set([storageName, stagingName, '.git', '.hg', '.svn', 'node_modules', '.venv', '.harness', '.ssh', '.gnupg',
  '.npmrc', 'mcp-oauth', 'application-credentials', 'auth.json', 'token', 'harness.config.json', 'credentials.json']);
const maxFiles = 5000, maxBytes = 200 * 1024 * 1024;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const shaPattern = /^[a-f0-9]{64}$/;

type FileVersion = { path: string; bytes: number; sha256: string; mode: number };
type Snapshot = { id: string; label: string; createdAt: number; entries: FileVersion[]; automatic?: true };
type SnapshotScope = { workspace: Workspace; store: Workspace; dataDir?: string };
type RestoreReport = { snapshotId: string; undoSnapshotId: string | null; restored: number; removed: number };
type RestoreReceipt = { undoSnapshotId: string | null; result?: RestoreReport };

export class WorkspaceSnapshotError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const TurnWorkspaceSnapshot = defineDoc<{ input?: number }>({
  scope: 'session', kind: 'local.workspace_snapshot_turn', version: 1, initial: () => ({}), checkpointWhen: () => true,
});

export function containsWorkspacePath(root: string, path: string): boolean {
  const distance = relative(root, path);
  return distance !== '..' && !distance.startsWith('..' + sep) && !isAbsolute(distance);
}

function same(a: FileVersion | undefined, b: FileVersion | undefined) {
  return a === undefined ? b === undefined : b !== undefined && a.bytes === b.bytes && a.sha256 === b.sha256 && a.mode === b.mode;
}

function excludedName(value: string) {
  const name = value.toLowerCase();
  return excluded.has(name) || name === '.env' || name.startsWith('.env.') || /\.(?:pem|key|p12|pfx)$/.test(name);
}

function diff(from: FileVersion[], to: FileVersion[]) {
  const before = new Map(from.map(file => [file.path, file])), after = new Map(to.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const previous = before.get(path), next = after.get(path);
    if (same(previous, next)) return [];
    return [{ path, action: next ? previous ? 'replace' as const : 'restore' as const : 'remove' as const, previous, next }];
  });
}

async function versionAt(workspace: Workspace, path: string): Promise<FileVersion | undefined> {
  const fullPath = await workspace.path(path);
  let stat;
  try { stat = await lstat(fullPath); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  if (!stat.isFile()) throw new WorkspaceSnapshotError(409, `A snapshot path must resolve to a regular file: ${path}`);
  if (stat.size > maxBytes) throw new WorkspaceSnapshotError(413, 'The workspace exceeds the snapshot byte limit.');
  const file = await workspace.inspect(fullPath);
  const current = await lstat(await workspace.path(path));
  if (current.ino !== stat.ino || current.dev !== stat.dev || current.mode !== stat.mode || file.bytes !== stat.size) {
    throw new WorkspaceSnapshotError(409, `The workspace changed while reading ${path}.`);
  }
  return { path, bytes: file.bytes, sha256: file.sha256, mode: current.mode & 0o777 };
}

async function scan(scope: SnapshotScope): Promise<FileVersion[]> {
  const { workspace, dataDir } = scope;
  const entries: FileVersion[] = [];
  let bytes = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(await workspace.path(directory), { withFileTypes: true })) {
      if (excludedName(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (path === dataDir) continue;
      if (entry.isDirectory()) await walk(path);
      if (!entry.isFile()) continue;
      const key = relative(workspace.root, path).split(sep).join('/');
      if (entries.length >= maxFiles) throw new WorkspaceSnapshotError(413, 'The workspace exceeds the snapshot file limit.');
      const version = await versionAt(workspace, key);
      if (!version) throw new WorkspaceSnapshotError(409, `The workspace changed while reading ${key}.`);
      bytes += version.bytes;
      if (bytes > maxBytes) throw new WorkspaceSnapshotError(413, 'The workspace exceeds the snapshot byte limit.');
      entries.push(version);
    }
  }
  await walk(workspace.root);
  return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function summary(snapshot: Snapshot) {
  return { id: snapshot.id, label: snapshot.label, createdAt: snapshot.createdAt, automatic: snapshot.automatic === true,
    files: snapshot.entries.length, bytes: snapshot.entries.reduce((sum, file) => sum + file.bytes, 0) };
}

async function exactBytes(workspace: Workspace, location: string, version: FileVersion) {
  const reader = await open(await workspace.path(location), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await reader.stat();
    if (!stat.isFile() || stat.size !== version.bytes) throw new WorkspaceSnapshotError(409, `Snapshot bytes changed for ${version.path}.`);
    const buffer = Buffer.alloc(version.bytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await reader.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    if (offset !== version.bytes || createHash('sha256').update(bytes).digest('hex') !== version.sha256) {
      throw new WorkspaceSnapshotError(409, `Snapshot bytes changed for ${version.path}.`);
    }
    return bytes;
  } finally { await reader.close(); }
}

async function writeAtomic(workspace: Workspace, path: string, bytes: Buffer, mode: number, before?: () => Promise<void>, stagedPath?: string) {
  const target = await workspace.path(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = await workspace.path(stagedPath ?? target + '.' + randomUUID() + '.tmp');
  if (stagedPath) {
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    // A retry can replace its own staging file after a process interruption.
    try { await unlink(await workspace.path(stagedPath)); } catch (error) { if (!missing(error)) throw error; }
  }
  await workspace.path(temporary);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(bytes); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    await before?.();
    await rename(temporary, await workspace.path(path));
  } finally { try { await unlink(temporary); } catch (error) { if (!missing(error)) throw error; } }
}

export class WorkspaceSnapshots {
  private changes = new SerialQueue();
  constructor(private dataDir: string) {}

  private async scope(path: string): Promise<SnapshotScope> {
    const [workspace, app] = await Promise.all([Workspace.open(path, { create: false }), Workspace.open(this.dataDir)]);
    if (workspace.root === app.root) throw new WorkspaceSnapshotError(409, 'Choose a workspace separate from the Kada data directory.');
    const dataDir = containsWorkspacePath(workspace.root, app.root) ? app.root : undefined;
    const anchor = dataDir ? await Workspace.open(dirname(workspace.root), { create: false }) : app;
    const directory = await anchor.path(join(storageName, dataDir ? hash([dataDir, workspace.root]) : hash(workspace.root)));
    if (containsWorkspacePath(workspace.root, directory)) throw new WorkspaceSnapshotError(409, 'Snapshot storage requires a location outside the workspace.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { workspace, store: await Workspace.open(await anchor.path(directory), { create: false }), dataDir };
  }

  private async load(scope: SnapshotScope, id: string): Promise<Snapshot> {
    if (!uuidPattern.test(id)) throw new WorkspaceSnapshotError(400, 'Provide a snapshot ID.');
    const snapshot = await readJson<Snapshot>(await scope.store.path(`${id}.json`));
    if (snapshot?.id !== id || !Array.isArray(snapshot.entries) || snapshot.entries.length > maxFiles) throw new WorkspaceSnapshotError(409, 'The snapshot manifest was damaged.');
    let total = 0;
    const seen = new Set<string>();
    for (const file of snapshot.entries) {
      const parts = typeof file?.path === 'string' ? file.path.split('/') : [];
      if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part) || excludedName(part)) ||
        scope.dataDir !== undefined && containsWorkspacePath(scope.dataDir, join(scope.workspace.root, ...parts)) ||
        seen.has(file.path) || !shaPattern.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
        throw new WorkspaceSnapshotError(409, 'The snapshot manifest contains an invalid file.');
      }
      seen.add(file.path);
      total += file.bytes;
      if (total > maxBytes) throw new WorkspaceSnapshotError(409, 'The snapshot manifest exceeds its original limits.');
    }
    return snapshot;
  }

  private async save(scope: SnapshotScope, entries: FileVersion[], label: string, id: string = randomUUID(), automatic?: true): Promise<Snapshot> {
    for (const version of entries) {
      const destination = 'blobs/' + version.sha256;
      const target = await versionAt(scope.store, destination);
      if (target) {
        if (target.sha256 !== version.sha256 || target.bytes !== version.bytes) throw new WorkspaceSnapshotError(409, 'A stored snapshot blob was damaged.');
      } else {
        await writeAtomic(scope.store, destination, await exactBytes(scope.workspace, version.path, version), 0o600);
      }
    }
    if (hash(await scan(scope)) !== hash(entries)) throw new WorkspaceSnapshotError(409, 'The workspace changed during the snapshot.');
    const snapshot = { id, label, createdAt: Date.now(), entries, ...(automatic ? { automatic } : {}) };
    await atomicJson(await scope.store.path(snapshot.id + '.json'), snapshot);
    return snapshot;
  }

  async create(workspace: string, label: string) {
    if (typeof label !== 'string' || !label.trim() || label.length > 120) throw new WorkspaceSnapshotError(400, 'Provide a snapshot label of 1 to 120 characters.');
    return this.changes.run(async () => {
      const scope = await this.scope(workspace);
      return summary(await this.save(scope, await scan(scope), label.trim()));
    });
  }

  async captureTurn(workspace: string, taskId: string, input: number) {
    const digest = hash(['local/workspace-undo', taskId, input]);
    const id = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
    return this.changes.run(async () => {
      const scope = await this.scope(workspace);
      try { return summary(await this.load(scope, id)); } catch (error) { if (!missing(error)) throw error; }
      const saved = await this.save(scope, await scan(scope), `Before task ${taskId} · turn ${input}`, id, true);
      await this.pruneAutomatic(scope);
      return summary(saved);
    });
  }

  private async stored(scope: SnapshotScope) {
    const names = (await readdir(scope.store.root)).filter(name => name.endsWith('.json') && uuidPattern.test(name.slice(0, -5)));
    return (await Promise.all(names.map(name => this.load(scope, name.slice(0, -5)))))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  private async pruneAutomatic(scope: SnapshotScope) {
    const snapshots = await this.stored(scope);
    const older = snapshots.filter(snapshot => snapshot.automatic).slice(10);
    if (!older.length) return;
    const receipts = await readdir(await scope.store.path('restores')).catch(error => { if (missing(error)) return []; throw error; });
    const retainedTargets = new Set(receipts.map(name => name.slice(0, 36)));
    const obsolete = new Set(older.filter(snapshot => !retainedTargets.has(snapshot.id)).map(snapshot => snapshot.id));
    if (!obsolete.size) return;
    for (const id of obsolete) await unlink(await scope.store.path(`${id}.json`));
    const used = new Set(snapshots.filter(snapshot => !obsolete.has(snapshot.id)).flatMap(snapshot => snapshot.entries.map(file => file.sha256)));
    const blobs = await readdir(await scope.store.path('blobs')).catch(error => { if (missing(error)) return []; throw error; });
    for (const name of blobs) if (shaPattern.test(name) && !used.has(name)) await unlink(await scope.store.path('blobs/' + name));
  }

  async list(workspace: string) {
    return this.changes.run(async () => (await this.stored(await this.scope(workspace))).map(summary));
  }

  async preview(workspace: string, snapshotId: string) {
    return this.changes.run(async () => {
      const scope = await this.scope(workspace), target = await this.load(scope, snapshotId), current = await scan(scope);
      const version = randomUUID().replaceAll('-', '') + hash([scope.workspace.root, target, current]);
      return { snapshot: summary(target), version, changes: diff(current, target.entries) };
    });
  }

  private async applyFile(scope: SnapshotScope, change: ReturnType<typeof diff>[number], version: string) {
    const check = async () => {
      if (!same(await versionAt(scope.workspace, change.path), change.previous)) {
        throw new WorkspaceSnapshotError(409, `The workspace changed at ${change.path}.`);
      }
    };
    if (change.next) {
      const bytes = await exactBytes(scope.store, 'blobs/' + change.next.sha256, change.next);
      const staged = join(stagingName, hash([version, change.path]) + '.tmp');
      await writeAtomic(scope.workspace, change.path, bytes, change.next.mode, check, staged);
    } else {
      await check();
      await unlink(await scope.workspace.path(change.path));
    }
  }

  async restore(workspace: string, snapshotId: string, version: string, beforeRestore?: () => Promise<void>): Promise<RestoreReport> {
    if (typeof version !== 'string' || !/^[a-f0-9]{96}$/.test(version)) throw new WorkspaceSnapshotError(400, 'Provide the displayed preview version.');
    return this.changes.run(async () => {
      const scope = await this.scope(workspace), target = await this.load(scope, snapshotId);
      const receiptPath = await scope.store.path(`restores/${snapshotId}-${version}.json`);
      let receipt: RestoreReceipt | undefined;
      try { receipt = await readJson<RestoreReceipt>(receiptPath); } catch (error) { if (!missing(error)) throw error; }
      if (receipt?.result) return receipt.result;
      await beforeRestore?.();
      const current = await scan(scope);
      const previous = receipt?.undoSnapshotId ? (await this.load(scope, receipt.undoSnapshotId)).entries : current;
      if (version.slice(32) !== hash([scope.workspace.root, target, previous])) {
        throw new WorkspaceSnapshotError(409, 'The workspace changed. Preview the restore again.');
      }
      const changes = diff(previous, target.entries);
      const required = new Map(changes.map(change => [change.path, change]));
      const observed = new Map(current.map(file => [file.path, file]));
      for (const change of diff(previous, current)) {
        if (!required.has(change.path) || !same(change.next, required.get(change.path)!.next)) {
          throw new WorkspaceSnapshotError(409, 'The workspace changed after the restore began. Preview again or use the saved undo snapshot.');
        }
      }
      for (const change of changes) {
        await versionAt(scope.workspace, change.path);
        if (!change.next) continue;
        const blob = await versionAt(scope.store, 'blobs/' + change.next.sha256);
        if (!blob || blob.sha256 !== change.next.sha256 || blob.bytes !== change.next.bytes) throw new WorkspaceSnapshotError(409, 'A stored snapshot blob was damaged.');
      }
      if (!changes.length) {
        const result = { snapshotId, undoSnapshotId: null, restored: 0, removed: 0 };
        await atomicJson(receiptPath, { undoSnapshotId: null, result });
        return result;
      }
      if (!receipt) {
        const undo = await this.save(scope, current, 'Before restore ' + snapshotId);
        receipt = { undoSnapshotId: undo.id };
        await atomicJson(receiptPath, receipt);
      }
      try {
        for (const change of changes.toSorted((a, b) => Number(Boolean(a.next)) - Number(Boolean(b.next)))) {
          if (same(observed.get(change.path), change.next)) continue;
          await this.applyFile(scope, change, version);
        }
        if (diff(await scan(scope), target.entries).length) throw new WorkspaceSnapshotError(409, 'The workspace changed during restore.');
        try { await rmdir(await scope.workspace.path(stagingName)); }
        catch (error) { if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
      } catch (error) {
        throw new WorkspaceSnapshotError(409, `${error instanceof Error ? error.message : String(error)} Undo snapshot ${receipt.undoSnapshotId}.`);
      }
      const result = { snapshotId, undoSnapshotId: receipt.undoSnapshotId, restored: changes.filter(change => change.next).length,
        removed: changes.filter(change => !change.next).length };
      await atomicJson(receiptPath, { ...receipt, result });
      return result;
    });
  }
}
