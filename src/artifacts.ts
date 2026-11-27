import { spawn } from 'node:child_process';
import { basename, dirname, extname, resolve } from 'node:path';
import type { TaskStatus } from './client.js';
import { Workspace } from './workspace.js';

export class ArtifactError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** Recheck the bytes on every open; a completed task does not keep a mutable file verified. */
export async function artifactTarget(status: TaskStatus, index: number) {
  const goal = status.goal;
  const artifact = goal?.candidate?.artifacts[index];
  if (!Number.isSafeInteger(index) || index < 0 || artifact === undefined) throw new ArtifactError(404, 'Artifact not found.');
  const workspace = await Workspace.open(status.workspace, {create:false});
  const path = await workspace.path(artifact);
  if (status.status !== 'completed' || !goal?.mechanical?.passed || goal.candidate?.revision !== goal.revision) {
    throw new ArtifactError(409, 'This candidate has not been verified for delivery.');
  }
  const file = goal.mechanical.files.find(file => file.path === path);
  const directory = goal.mechanical.directories?.find(file => file.path === path);
  const saved = file ?? directory;
  if (!saved) throw new ArtifactError(409, 'This artifact is outside the verified scope.');
  let current;
  try { current = await workspace.inspectPath(path); }
  catch { throw new ArtifactError(409, 'This artifact is missing or changed after verification.'); }
  if (saved.bytes !== current.bytes || saved.sha256 !== current.sha256 ||
      (directory && (!('kind' in current) || current.entries !== directory.entries))) {
    throw new ArtifactError(409, 'This artifact changed after verification.');
  }
  return {index, path, name:basename(path), kind:directory ? 'directory' as const : 'file' as const, bytes:current.bytes, sha256:current.sha256};
}

export async function artifactList(status: TaskStatus) {
  return Promise.all((status.goal?.candidate?.artifacts ?? []).map(async (path,index) => {
    try { return {...await artifactTarget(status,index), state:'verified' as const}; }
    catch (error) {
      return {index,path:resolve(status.workspace,path),name:basename(path),state:status.status === 'completed' ? 'changed' as const : 'unverified' as const,
        reason:error instanceof Error ? error.message : 'Artifact unavailable.'};
    }
  }));
}

export function openLocalPath(path: string, kind: 'file' | 'directory', reveal = false) {
  // Executable formats are revealed in their folder; opening an artifact never runs its script.
  const document = /\.(txt|md|json|csv|pdf|png|jpe?g|gif|webp|docx|xlsx|pptx|wav)$/i.test(extname(path));
  const folder = reveal || kind === 'directory' || !document;
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? [folder && kind === 'file' ? '/select,' + path : path]
    : process.platform === 'darwin' ? [...(folder && kind === 'file' ? ['-R'] : []),path]
    : [folder && kind === 'file' ? dirname(path) : path];
  return new Promise<void>((resolve,reject) => {
    const child = spawn(command,args,{detached:true,stdio:'ignore'});
    child.once('error',reject);
    child.once('spawn',() => { child.unref(); resolve(); });
  });
}
