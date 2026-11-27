import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface ModelRef { provider: string; modelId: string }
export interface RemoteComputer { name: string; origin: string }
export type GithubWebhookConfig = { routineId: string; secretEnv: string };
export interface ComputerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  tools: string[];
  observationTools?: string[];
  leaseMs?: number;
}
export const browserProfilePattern = /^[a-z][a-z0-9_-]{0,39}$/;
export interface Config {
  dataDir: string;
  port: number;
  model?: ModelRef;
  subagentModel?: ModelRef;
  maxSubagents: number;
  maxDurationMs: number;
  maxTotalTokens?: number;
  maxEstimatedCostUsd?: number;
  compactAtTokens?: number;
  review?: boolean;
  web?: boolean;
  workspaceSnapshots?: boolean;
  deferOptionalTools?: boolean;
  /** Experimental method learning; snapshotted only for newly created tasks. */
  learning?: boolean;
  /** First-run local Agent/Skill metadata discovery; no plugins are executed by discovery. */
  discovery?: boolean;
  maxReworks?: number;
  maxStalls?: number;
  computer?: ComputerConfig;
  browserProfiles?: Record<string, ComputerConfig>;
  /** Canonical origin of an already configured HTTPS reverse proxy. */
  remoteOrigin?: string;
  remoteComputers?: RemoteComputer[];
  remotePush?: boolean;
  githubIssuePolling?: string[];
  githubIssueTokenEnv?: string;
  githubWebhooks?: GithubWebhookConfig[];
}

export function positiveInt(value: unknown, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

export function modelRef(value: unknown, name: string): ModelRef | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object") throw new Error(`${name} must contain provider and modelId`);
  const m = value as Record<string, unknown>;
  if (typeof m.provider !== "string" || !m.provider.trim() || typeof m.modelId !== "string" || !m.modelId.trim()) {
    throw new Error(`${name} must contain provider and modelId`);
  }
  return { provider: m.provider, modelId: m.modelId };
}

function computerConfig(input: unknown, label: string): ComputerConfig {
  const c = input as ComputerConfig;
  if (!c || typeof c.command !== "string" || !c.command.trim() || !Array.isArray(c.tools) ||
    c.tools.length === 0 || !c.tools.every(t => typeof t === "string" && t.length > 0) ||
    (c.args !== undefined && (!Array.isArray(c.args) || !c.args.every(a => typeof a === "string"))) ||
    (c.env !== undefined && (typeof c.env !== "object" || !c.env || !Object.values(c.env).every(v => typeof v === "string")))) {
    throw new Error(label + " requires a command and an explicit tools allowlist (optional args and env)");
  }
  if (c.observationTools !== undefined && (!Array.isArray(c.observationTools) || !c.observationTools.every(t => typeof t === "string" && c.tools.includes(t)))) {
    throw new Error(label + ".observationTools must be selected from its tools");
  }
  if (c.leaseMs !== undefined) positiveInt(c.leaseMs, label + ".leaseMs", 120_000, 3_600_000);
  return c;
}

export async function loadConfig(filename = "harness.config.json"): Promise<Config> {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Configuration must be a JSON object");
  const model = process.env.MODEL_PROVIDER && process.env.MODEL_ID
    ? { provider: process.env.MODEL_PROVIDER, modelId: process.env.MODEL_ID }
    : modelRef(raw.model, "model");
  const computer = raw.computer === undefined ? undefined : computerConfig(raw.computer, 'computer');
  let browserProfiles: Config['browserProfiles'];
  if (raw.browserProfiles !== undefined) {
    if (!raw.browserProfiles || typeof raw.browserProfiles !== 'object' || Array.isArray(raw.browserProfiles)) throw new Error('browserProfiles must be an object.');
    browserProfiles = Object.fromEntries(Object.entries(raw.browserProfiles).map(([name, input]) => {
      if (!browserProfilePattern.test(name)) throw new Error('Use lowercase names for browser profiles.');
      return [name, computerConfig(input, 'browserProfiles.' + name)];
    }));
  }
  if (raw.dataDir !== undefined && typeof raw.dataDir !== "string") throw new Error("dataDir must be a string");
  const githubIssuePolling = raw.githubIssuePolling;
  if (githubIssuePolling !== undefined && (!Array.isArray(githubIssuePolling) ||
      githubIssuePolling.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(id)))) {
    throw new Error("githubIssuePolling must be an array of routine IDs.");
  }
  const githubIssueTokenEnv = raw.githubIssueTokenEnv;
  if (githubIssueTokenEnv !== undefined && (typeof githubIssueTokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(githubIssueTokenEnv))) {
    throw new Error("githubIssueTokenEnv must name an environment variable.");
  }
  const githubWebhooks = raw.githubWebhooks;
  if (githubWebhooks !== undefined && (!Array.isArray(githubWebhooks) || githubWebhooks.length > 64 ||
    githubWebhooks.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).some(key => !['routineId', 'secretEnv'].includes(key)) ||
      typeof entry.routineId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(entry.routineId) ||
      typeof entry.secretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.secretEnv)) ||
    new Set(githubWebhooks.map(entry => entry.routineId)).size !== githubWebhooks.length)) {
    throw new Error('githubWebhooks requires up to 64 unique routine IDs with secretEnv references.');
  }
  if (raw.remoteOrigin !== undefined) {
    if (typeof raw.remoteOrigin !== 'string') throw new Error('remoteOrigin must be an HTTPS origin.');
    const origin = new URL(raw.remoteOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('remoteOrigin must be an HTTPS origin.');
  }
  let remoteComputers: RemoteComputer[] | undefined;
  if (raw.remoteComputers !== undefined) {
    if (!Array.isArray(raw.remoteComputers)) throw new Error("remoteComputers must be an array.");
    remoteComputers = raw.remoteComputers.map(entry => {
      const origin = typeof entry?.origin === "string" ? URL.parse(entry.origin) : null;
      if (typeof entry?.name !== "string" || !entry.name.trim() ||
        origin?.protocol !== "https:" || origin.href !== origin.origin + "/") {
        throw new Error("remoteComputers entries need a name and an HTTPS origin.");
      }
      return { name: entry.name.trim(), origin: origin.origin };
    });
    if (new Set(remoteComputers.map(computer => computer.origin)).size !== remoteComputers.length) {
      throw new Error("remoteComputers must contain unique origins.");
    }
  }
  const maxEstimatedCostUsd = raw.maxEstimatedCostUsd ?? 1;
  if (typeof maxEstimatedCostUsd !== "number" || !Number.isFinite(maxEstimatedCostUsd) || maxEstimatedCostUsd <= 0) throw new Error("maxEstimatedCostUsd must be a positive number");
  return {
    dataDir: resolve(process.env.HARNESS_DATA_DIR ?? raw.dataDir as string ?? ".harness"),
    port: positiveInt(process.env.HARNESS_PORT ? Number(process.env.HARNESS_PORT) : raw.port, "port", 4317, 65535),
    model, subagentModel: modelRef(raw.subagentModel, "subagentModel"),
    maxSubagents: positiveInt(raw.maxSubagents, "maxSubagents", 3, 16),
    maxDurationMs: positiveInt(raw.maxDurationMs, "maxDurationMs", 3_600_000),
    ...(raw.maxTotalTokens === undefined ? {} : { maxTotalTokens: positiveInt(raw.maxTotalTokens, "maxTotalTokens", 500_000) }),
    maxEstimatedCostUsd,
    compactAtTokens: positiveInt(raw.compactAtTokens, "compactAtTokens", 48_000),
    review: optionalBoolean(raw.review, "review", false),
    web: optionalBoolean(raw.web, "web", true),
    ...(optionalBoolean(raw.workspaceSnapshots, 'workspaceSnapshots', false) ? { workspaceSnapshots: true } : {}),
    ...(optionalBoolean(raw.deferOptionalTools, 'deferOptionalTools', false) ? { deferOptionalTools: true } : {}),
    learning: optionalBoolean(raw.learning, "learning", false),
    discovery: optionalBoolean(raw.discovery, "discovery", true),
    ...(optionalBoolean(raw.remotePush, "remotePush", false) ? { remotePush: true } : {}),
    ...(remoteComputers?.length ? { remoteComputers } : {}),
    ...(githubIssuePolling ? { githubIssuePolling: [...new Set(githubIssuePolling)] } : {}),
    ...(githubIssueTokenEnv ? { githubIssueTokenEnv } : {}),
    ...(githubWebhooks ? { githubWebhooks: githubWebhooks.map(({ routineId, secretEnv }) => ({ routineId, secretEnv })) } : {}),
    maxReworks: raw.maxReworks === 0 ? 0 : positiveInt(raw.maxReworks, "maxReworks", 3, 20),
    maxStalls: positiveInt(raw.maxStalls, "maxStalls", 2, 20),
    computer,
    ...(browserProfiles ? { browserProfiles } : {}),
    ...(typeof raw.remoteOrigin === 'string' ? {remoteOrigin:new URL(raw.remoteOrigin).origin} : {}),
  };
}
