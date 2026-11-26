import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

const token = /\b(?:sk-[a-z0-9_-]{16,}|(?:gh[pousr]|github_pat|xox[baprs])[_-][a-z0-9_-]{12,}|AIza[a-z0-9_-]{16,})\b/i;
const credential = /(?:api[ _-]?key|access[ _-]?key|secret|token|password|authorization|credential|密钥|密码)["'`]?\s*[=:：]|\bbearer\s+\S+|https?:\/\/[^\s/@]+:[^\s/@]+@/i;

export function redactCredentials(text: string): string {
  let privateKey = false;
  return text.split(/\r?\n/).map(line => {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true;
    if (privateKey) { if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false; return "[凭据内容已省略]"; }
    return token.test(line) || credential.test(line) ? "[凭据内容已省略]" : line;
  }).join("\n");
}

/** A shared executor for resources such as one desktop, including across tasks. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    this.tail = result.catch(() => {});
    return result;
  }
}

export async function mapConcurrent<T, R>(items: T[], concurrency: number, action: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await action(items[index]!, index);
    }
  }));
  return results;
}
