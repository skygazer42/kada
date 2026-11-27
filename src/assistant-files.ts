import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { Workspace, type FileSnapshot } from './workspace.js';

export type AssistantFile = FileSnapshot & { sourcePath: string };
const maxBytes = 5 * 1024 * 1024;
const matches = (a: FileSnapshot, b: FileSnapshot) => a.bytes === b.bytes && a.sha256 === b.sha256;

export async function publishAssistantBytes(workspace: Workspace, path: string, bytes: Buffer): Promise<FileSnapshot> {
  const target = await workspace.path(path);
  const expected = { path: target, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await workspace.path(target);
  const temporary = await workspace.path(target + '.' + randomUUID() + '.tmp'), staging = await open(temporary, 'wx', 0o600);
  try {
    try { await staging.writeFile(bytes); await staging.sync(); } finally { await staging.close(); }
    await workspace.path(target);
    try { await link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!matches(await workspace.inspect(target), expected)) throw new Error('A different assistant input already exists; it was not overwritten.');
    }
  } finally { await rm(temporary, { force: true }); }
  if (!matches(await workspace.inspect(target), expected)) throw new Error('The fixed assistant input changed during publication.');
  return expected;
}

export async function prepareAssistantFiles(workspace: Workspace, id: string, paths: string[],
  direction: 'inputs' | 'outputs' = 'inputs', destination = workspace): Promise<AssistantFile[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id) || paths.length > 5) throw new Error('Provide an original work ID and up to five input files.');
  const files: AssistantFile[] = [];
  for (const input of paths) {
    const sourcePath = await workspace.path(input), stat = await lstat(sourcePath);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Assistant inputs require regular files of at most 5 MiB.');
    if (files.some(file => file.sourcePath === sourcePath)) throw new Error('Duplicate assistant input path.');
    const source = await workspace.inspect(sourcePath);
    files.push({ ...source, sourcePath, path: await destination.path(join('agents', 'assistant-work', id, direction, files.length + '-' + basename(sourcePath))) });
  }
  return files;
}

export async function copyAssistantFiles(workspace: Workspace, files: AssistantFile[], destination = workspace): Promise<void> {
  for (const file of files) {
    const target = await destination.path(file.path);
    let saved: FileSnapshot | undefined;
    try { saved = await destination.inspect(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved) {
      if (!matches(saved, file)) throw new Error('The fixed assistant input changed; the saved copy was not overwritten.');
      continue;
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maxBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid assistant file snapshot.');
    const source = await workspace.path(file.sourcePath), opened = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await opened.stat();
      if (!stat.isFile() || stat.size !== file.bytes) throw new Error('The original assistant input changed before copying.');
      const buffer = Buffer.alloc(file.bytes + 1); let size = 0;
      while (size < buffer.length) {
        const part = await opened.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      bytes = buffer.subarray(0, size);
      if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256 || !matches(await workspace.inspect(source), file)) {
        throw new Error('The original assistant input changed while copying.');
      }
    } finally { await opened.close(); }
    await publishAssistantBytes(destination, target, bytes);
  }
}
