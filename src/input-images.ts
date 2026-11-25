import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Api, ImageContent, Message, Model, UserMessage } from '@earendil-works/pi-ai';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { AgentDoc, defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable';
import type { ModelRef } from './config.js';

export type InputImage = { path: string; mimeType: string; bytes: number; sha256: string };
let images: ReturnType<typeof createNodePhotonImages> | undefined;

function limitRequestImages(messages: readonly Message[], maxPerRequest: number) {
  let remaining = maxPerRequest;
  let projected: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if ((message.role !== 'user' && message.role !== 'toolResult') || typeof message.content === 'string') continue;
    let omitted = false;
    const content = message.content.filter(block => {
      if (block.type !== 'image') return true;
      if (remaining > 0) { remaining--; return true; }
      omitted = true;
      return false;
    });
    if (!omitted) continue;
    content.push({ type: 'text', text: 'Earlier images omitted to meet this model’s request limit. Refer to their original messages and files.' });
    projected ??= [...messages];
    projected[index] = { ...message, content };
  }
  return projected ? { messages: projected } : undefined;
}

export function inputImageExtension(fallback: ModelRef) {
  return defineExtension({ name: 'local_input_images', hooks: [hook(GenerationTask, {
    beforeRequest: async ({ messages }, api, context) => {
      const ref = (await api.snapshot(AgentDoc, api.conversationId, context))?.model ?? fallback;
      const max = api.models.getModel(ref.provider, ref.modelId)?.inputLimits?.images?.maxPerRequest;
      return max === undefined ? undefined : limitRequestImages(messages, max);
    },
  })] });
}

export async function imageInput(text: string, references: readonly InputImage[] | undefined, model: Model<Api>): Promise<UserMessage['content']> {
  if (!references?.length) return text;
  if (references.length > 4 || references.some(image => !isAbsolute(image.path) || !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) ||
    !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(image.sha256))) {
    throw new Error('Invalid original image references.');
  }
  if (!model.input.includes('image')) return text + '\n\nThe selected model does not support image input. Use the attached workspace files where possible.';
  const resize = model.inputLimits?.images?.resize;
  const limits = { maxWidth: resize?.maxWidth ?? 2000, maxHeight: resize?.maxHeight ?? 2000, maxBytes: resize?.maxBytes ?? 4.5 * 1024 * 1024 };
  const count = Math.min(references.length, model.inputLimits?.images?.maxPerMessage ?? 4, model.inputLimits?.images?.maxPerRequest ?? 4);
  const content: (ImageContent | { type: 'text'; text: string })[] = [{ type: 'text', text }];
  for (const image of references.slice(0, count)) {
    const file = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== image.bytes) throw new Error('Original image is unavailable or changed.');
      bytes = Buffer.alloc(image.bytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const part = await file.read(bytes, length, bytes.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      bytes = bytes.subarray(0, length);
    } finally { await file.close(); }
    if (bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
      throw new Error('Original image is unavailable or changed.');
    }
    const prepared = await (images ??= createNodePhotonImages()).then(processor => processor.prepare(bytes, image.mimeType, limits));
    if (prepared) content.push({ type: 'image', data: prepared.data, mimeType: prepared.mimeType });
    else content.push({ type: 'text', text: 'An attached image could not be decoded for this model. Its workspace file remains available.' });
  }
  if (count < references.length) content.push({ type: 'text', text: 'Additional attached images exceed this model’s image limit. Their workspace files remain available.' });
  return content;
}
