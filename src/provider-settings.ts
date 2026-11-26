import { join } from 'node:path';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { ModelRef } from './config.js';
import { memoryProject } from './memory-sources.js';
import { modelCostKnown, validateModel } from './models.js';
import { atomicJson, readJson, redactCredentials, SerialQueue } from './util.js';

export type ModelCheckError = 'unknown_model' | 'missing_credentials' | 'auth' | 'rate_limit' | 'timeout' | 'unreachable' | 'provider_error';
type ProbeResult = { status: 'available' } | { status: 'unavailable'; code: ModelCheckError };
export type ModelCheck = { checkedAt: string; code?: ModelCheckError; message?: string } & ProbeResult;
export type ModelProbe = (model: Model<Api>, signal: AbortSignal) => Promise<ProbeResult>;
export type ModelProposalDecision = 'apply' | 'decline';
export type ModelProposal = { id: string; sourceTaskId: string; previous: ModelRef | null; model: ModelRef; reason: string;
  state: 'pending' | 'applied' | 'declined'; createdAt: string; settledAt?: string };
type StoredProposal = ModelProposal & { project: string; baseline: string };
type SavedSettings = { model?: ModelRef; projectModels?: Record<string, ModelRef>; checks: Record<string, ModelCheck>; proposals?: StoredProposal[] };

export class ModelProposalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const messages: Record<ModelCheckError, string> = {
  unknown_model: 'Unknown model. Check the installed Pi model catalog.',
  missing_credentials: 'No provider credentials are configured. Sign in through Pi or set the provider environment variable.',
  auth: 'The provider rejected or could not validate its credentials. Check Pi sign-in or the provider environment variable.',
  rate_limit: 'The provider is rate limited or has insufficient quota. Check the provider account and retry.',
  timeout: 'The model check timed out. Retry when the provider is reachable.',
  unreachable: 'Could not reach the provider. Check the connection and retry.',
  provider_error: 'The provider could not complete the model check. Check model availability and retry.',
};

function errorCode(error: unknown): ModelCheckError {
  // Provider error bodies may include request values, so classify them without exposing them.
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/^(Provider is not configured|No API key for provider):/i.test(text)) return 'missing_credentials';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|credentials?|api[ _-]?key|sign.in|authenticat/i.test(text)) return 'auth';
  if (/\b(429|402)\b|rate.limit|quota|billing/i.test(text)) return 'rate_limit';
  if (/\b404\b|model.{0,30}(not found|does not exist|unavailable)|unknown model/i.test(text)) return 'unknown_model';
  if (/timed?\s*out|timeout/i.test(text)) return 'timeout';
  if (/\b(EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENOTFOUND)\b|network|fetch failed|connection|unreachable/i.test(text)) return 'unreachable';
  return 'provider_error';
}

function probeModel(models: Models): ModelProbe {
  return async (model, signal) => {
    const message = await models.complete(model, {
      messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
    }, { signal, maxTokens: 16 });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return { status: 'unavailable', code: errorCode(message.errorMessage) };
    }
    return { status: 'available' };
  };
}

const modelKey = (ref: ModelRef) => JSON.stringify([ref.provider, ref.modelId]);

function projectSelection(settings: SavedSettings, project: string, fallback?: ModelRef) {
  return settings.projectModels?.[project] ?? settings.model ?? fallback ?? null;
}

function selectionBaseline(settings: SavedSettings, project: string, fallback?: ModelRef) {
  const current = projectSelection(settings, project, fallback);
  return JSON.stringify([Boolean(settings.projectModels?.[project]), current ? modelKey(current) : null]);
}

function proposalView({ project: _project, baseline: _baseline, ...view }: StoredProposal): ModelProposal { return view; }

function findProposal(settings: SavedSettings, project: string, sourceTaskId: string, id: string): StoredProposal | undefined {
  return settings.proposals?.find(item => item.project === project && item.sourceTaskId === sourceTaskId && item.id === id);
}

async function projectKey(workspace: string): Promise<string> {
  const project = await memoryProject(workspace);
  if (!project) throw new Error('The model settings workspace must be an existing directory.');
  return project;
}

export class ProviderSettings {
  private readonly path: string;
  private readonly changes = new SerialQueue();
  private readonly decisions = new SerialQueue();
  private readonly probe: ModelProbe;

  constructor(dataDir: string, private readonly models: Models, probe?: ModelProbe) {
    this.path = join(dataDir, 'provider-settings.json');
    this.probe = probe ?? probeModel(models);
  }

  private async read(): Promise<SavedSettings> {
    try {
      return await readJson<SavedSettings>(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { checks: {} };
      throw error;
    }
  }

  async selected(fallback?: ModelRef, workspace?: string): Promise<ModelRef | undefined> {
    const project = await memoryProject(workspace, { allowMissing: true });
    const settings = await this.read();
    return (project === undefined ? undefined : settings.projectModels?.[project]) ?? settings.model ?? fallback;
  }

  assertSelectable(ref: ModelRef): ModelRef {
    const model = validateModel(this.models, ref);
    return { provider: model.provider, modelId: model.modelId };
  }

  async propose(workspace: string, sourceTaskId: string, id: string, ref: ModelRef, reason: string, fallback?: ModelRef): Promise<ModelProposal> {
    if (!/^[1-9]\d{0,19}$/.test(id) || typeof ref?.provider !== 'string' || typeof ref.modelId !== 'string' ||
      typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500 || /[\u0000-\u0008\u000B-\u001F\u007F]/.test(reason)) {
      throw new ModelProposalError(400, 'Provide an original proposal ID, catalog model and a reason of up to 500 characters.');
    }
    const project = await projectKey(workspace);
    const text = redactCredentials(reason.trim());
    return this.changes.run(async () => {
      const settings = await this.read();
      const previous = findProposal(settings, project, sourceTaskId, id);
      if (previous) {
        if (modelKey(previous.model) !== modelKey(ref) || previous.reason !== text) throw new ModelProposalError(409, 'The model proposal already has different content.');
        return proposalView(previous);
      }
      const entry = this.models.getModel(ref.provider, ref.modelId);
      if (!entry) throw new ModelProposalError(400, messages.unknown_model);
      const model = { provider: entry.provider, modelId: entry.id };
      const created: StoredProposal = { id, sourceTaskId, project, baseline: selectionBaseline(settings, project, fallback),
        previous: projectSelection(settings, project, fallback), model, reason: text, state: 'pending', createdAt: new Date().toISOString() };
      settings.proposals = [...(settings.proposals ?? []), created];
      await atomicJson(this.path, settings);
      return proposalView(created);
    });
  }

  async proposals(workspace: string, sourceTaskId: string) {
    const project = await projectKey(workspace);
    return ((await this.read()).proposals ?? []).filter(item => item.project === project && item.sourceTaskId === sourceTaskId).map(proposalView);
  }

  async decideProposal(workspace: string, sourceTaskId: string, id: string, decision: ModelProposalDecision, fallback?: ModelRef) {
    if (decision !== 'apply' && decision !== 'decline') throw new ModelProposalError(400, 'Choose apply or decline.');
    const project = await projectKey(workspace);
    const state = decision === 'apply' ? 'applied' : 'declined';
    const authorized = (settings: SavedSettings) => {
      const proposal = findProposal(settings, project, sourceTaskId, id);
      if (!proposal) throw new ModelProposalError(404, 'Model proposal not found in this conversation.');
      if (proposal.state === state) return proposal;
      if (proposal.state !== 'pending') throw new ModelProposalError(409, 'The model proposal already has a different decision.');
      if (decision === 'apply' && selectionBaseline(settings, project, fallback) !== proposal.baseline) {
        throw new ModelProposalError(409, 'The project default model changed. Ask for a new proposal.');
      }
      return proposal;
    };
    return this.decisions.run(async () => {
      const proposal = authorized(await this.read());
      if (proposal.state === state) return proposalView(proposal);
      if (decision === 'apply') {
        const check = await this.check(proposal.model);
        if (check.status !== 'available') throw new ModelProposalError(409, check.message ?? messages.provider_error);
      }
      return this.changes.run(async () => {
        const settings = await this.read();
        const original = authorized(settings);
        if (decision === 'apply') {
          const check = settings.checks[modelKey(original.model)];
          if (check?.status !== 'available') throw new ModelProposalError(409, check?.message ?? messages.provider_error);
          settings.projectModels = { ...settings.projectModels, [project]: original.model };
        }
        original.state = state;
        original.settledAt = new Date().toISOString();
        await atomicJson(this.path, settings);
        return proposalView(original);
      });
    });
  }

  async select(ref: ModelRef, workspace?: string): Promise<ModelRef> {
    const model = this.assertSelectable(ref);
    const project = workspace === undefined ? undefined : await projectKey(workspace);
    return this.changes.run(async () => {
      const settings = await this.read();
      const check = settings.checks[modelKey(model)];
      if (check?.status === 'unavailable') throw new Error(check.message);
      if (project === undefined) {
        settings.model = model;
      } else {
        if (check?.status !== 'available') throw new Error('Run a successful model connection check before setting a project default.');
        settings.projectModels = { ...settings.projectModels, [project]: model };
      }
      await atomicJson(this.path, settings);
      return model;
    });
  }

  async clear(workspace: string): Promise<void> {
    const project = await projectKey(workspace);
    await this.changes.run(async () => {
      const settings = await this.read();
      if (!settings.projectModels || !Object.hasOwn(settings.projectModels, project)) return;
      delete settings.projectModels[project];
      await atomicJson(this.path, settings);
    });
  }

  async list(defaultModel?: ModelRef, workspace?: string) {
    const project = workspace === undefined ? undefined : await projectKey(workspace);
    const settings = await this.read();
    const selected = (project === undefined ? undefined : settings.projectModels?.[project]) ?? settings.model ?? defaultModel;
    const providers = new Map<string, Array<{ id: string; name: string; selected: boolean; priceKnown: boolean; check?: ModelCheck }>>();
    for (const model of this.models.getModels()) {
      const ref = { provider: model.provider, modelId: model.id };
      let entries = providers.get(model.provider);
      if (!entries) providers.set(model.provider, entries = []);
      entries.push({
        id: model.id,
        name: model.name,
        selected: selected?.provider === model.provider && selected.modelId === model.id,
        priceKnown: modelCostKnown(ref),
        check: settings.checks[modelKey(ref)],
      });
    }
    return Promise.all([...providers].map(async ([id, models]) => {
      const auth = await this.models.checkAuth(id).catch(() => undefined);
      return { id, authentication: { configured: auth !== undefined, source: auth?.type }, models };
    }));
  }

  async check(ref: ModelRef, options: { signal?: AbortSignal } = {}): Promise<ModelCheck> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const checkedAt = new Date().toISOString();
    const model = this.models.getModel(ref.provider, ref.modelId);
    if (!model) return { status: 'unavailable', code: 'unknown_model', checkedAt, message: messages.unknown_model };
    const deadline = AbortSignal.timeout(15_000);
    const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let result: ProbeResult;
    try {
      result = await this.probe(model, probeSignal);
    } catch (error) {
      result = { status: 'unavailable', code: errorCode(error) };
    }
    signal?.throwIfAborted();
    if (deadline.aborted) result = { status: 'unavailable', code: 'timeout' };
    const check: ModelCheck = result.status === 'available'
      ? { status: 'available', checkedAt }
      : { status: 'unavailable', code: result.code, checkedAt, message: messages[result.code] };
    await this.changes.run(async () => {
      const settings = await this.read();
      const key = modelKey(ref);
      if ((settings.checks[key]?.checkedAt ?? '') > checkedAt) return;
      settings.checks[key] = check;
      await atomicJson(this.path, settings);
    });
    return check;
  }
}
