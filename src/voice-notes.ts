import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineDoc, type EntryId } from '@earendil-works/pi-durable';
import { siliconFlowBaseUrl } from './models.js';
import type { FileSnapshot, Workspace } from './workspace.js';

export class VoiceNoteError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 502 | 503, message: string) { super(message); }
}

type Receipt = { id: string; file: FileSnapshot; text: string };
export type VoiceTranscriber = (audio: Uint8Array) => Promise<string>;
export type VoiceSynthesizer = (text: string) => Promise<Uint8Array>;
export const voiceClipLimit = 5 * 1024 * 1024;
const speechLimit = 16 * 1024 * 1024;

export const VoiceNotes = defineDoc<{ requests: Record<string, { file: FileSnapshot; receipt?: Receipt }>;
  speech: Record<string, { answerEntryId: EntryId; file?: FileSnapshot }> }>({
  scope: 'session', kind: 'local.voice_notes', version: 1, initial: () => ({ requests: {}, speech: {} }), checkpointWhen: () => true,
});

export function voiceNoteKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new VoiceNoteError(400, 'Provide a voice note request ID.');
  return 'voice:' + value;
}

export async function readVoiceClip(workspace: Workspace, path: unknown) {
  if (typeof path !== 'string' || !/\.wav$/i.test(path) || path.includes('\0')) throw new VoiceNoteError(400, 'Choose a WAV file in this conversation’s workspace.');
  const { file, data } = await workspace.readBinarySnapshot(path, voiceClipLimit);
  validateVoiceClip(data);
  return { file, data };
}

export function validateVoiceClip(data: Buffer) {
  if (!isWave(data)) {
    throw new VoiceNoteError(400, 'The source must be a valid RIFF WAV recording.');
  }
}

function isWave(data: Buffer) {
  return data.length >= 44 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
}

export function transcriptionText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 32000 || value.includes('\0')) {
    throw new VoiceNoteError(502, 'The voice provider did not return usable text.');
  }
  return value.trim();
}

function siliconFlowVoiceRequest(path: 'transcriptions' | 'speech') {
  const credential = process.env.SILICONFLOW_API_KEY?.trim();
  if (!credential) throw new VoiceNoteError(503, 'Set SILICONFLOW_API_KEY in the daemon environment for voice requests.');
  return async (body: FormData | string) => {
    let response: Response;
    try {
      response = await fetch(siliconFlowBaseUrl + '/audio/' + path, {
        method: 'POST', headers: { Authorization: 'Bearer ' + credential, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) }, body,
        redirect: 'error', signal: AbortSignal.timeout(25_000),
      });
    } catch { throw new VoiceNoteError(502, 'The SiliconFlow voice request could not be completed.'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new VoiceNoteError(502, `SiliconFlow rejected the voice request (HTTP ${response.status}).`);
    }
    return response;
  };
}

export function siliconFlowVoiceTranscriber(): VoiceTranscriber {
  const request = siliconFlowVoiceRequest('transcriptions');
  return async audio => {
    const form = new FormData();
    form.append('model', 'FunAudioLLM/SenseVoiceSmall');
    form.append('file', new Blob([Uint8Array.from(audio)], { type: 'audio/wav' }), 'recording.wav');
    const response = await request(form);
    const value = await response.json().catch(() => undefined) as { text?: unknown } | undefined;
    return transcriptionText(value?.text);
  };
}

export function siliconFlowVoiceSynthesizer(): VoiceSynthesizer {
  const request = siliconFlowVoiceRequest('speech'), model = 'FunAudioLLM/CosyVoice2-0.5B';
  return async text => {
    const response = await request(JSON.stringify({ model, voice: model + ':anna', input: text, response_format: 'wav', stream: false }));
    const reader = response.body?.getReader();
    if (!reader) throw new VoiceNoteError(502, 'SiliconFlow returned no speech audio.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) return Buffer.concat(chunks, bytes);
        bytes += part.value.length;
        if (bytes > speechLimit) {
          await reader.cancel();
          throw new VoiceNoteError(502, 'SiliconFlow returned more than 16 MiB of speech audio.');
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  };
}

export async function saveVoiceReply(directory: string, id: string, audio: Uint8Array): Promise<FileSnapshot> {
  const data = Buffer.from(audio);
  if (data.length > speechLimit || !isWave(data)) throw new VoiceNoteError(502, 'The provider did not return a supported WAV file.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, id + '.wav'), temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600, flush: true });
    await link(temporary, path);
  }
  finally { await rm(temporary, { force: true }); }
  return { path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

export async function verifyVoiceReply(workspace: Workspace, file: FileSnapshot) {
  try {
    const { file: current, data } = await workspace.readBinarySnapshot(file.path, speechLimit);
    if (current.sha256 === file.sha256 && current.bytes === file.bytes && isWave(data)) return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new VoiceNoteError(409, 'The saved audio changed or is missing. Use a new request to render it again.');
}
