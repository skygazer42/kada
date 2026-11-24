import { join } from 'node:path';
import type { Api, Model, Models } from '@earendil-works/pi-ai';
import type { ModelRef } from './config.js';
import { modelCostKnown, validateModel } from './models.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type ModelCheckError = 'unknown_model' | 'missing_credentials' | 'auth' | 'rate_limit' | 'timeout' | 'unreachable' | 'provider_error';
type ProbeResult = { status: 'available' } | { status: 'unavailable'; code: ModelCheckError };
export type ModelCheck = { checkedAt: string; code?: ModelCheckError; message?: string } & ProbeResult;
export type ModelProbe = (model: Model<Api>, signal: AbortSignal) => Promise<ProbeResult>;
type SavedSettings = { model?: ModelRef; checks: Record<string, ModelCheck> };

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

export class ProviderSettings {
  private readonly path: string;
  private readonly changes = new SerialQueue();
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

  async selected(fallback?: ModelRef): Promise<ModelRef | undefined> {
    return (await this.read()).model ?? fallback;
  }

  assertSelectable(ref: ModelRef): ModelRef {
    const model = validateModel(this.models, ref);
    return { provider: model.provider, modelId: model.modelId };
  }

  async select(ref: ModelRef): Promise<ModelRef> {
    const model = this.assertSelectable(ref);
    return this.changes.run(async () => {
      const settings = await this.read();
      const check = settings.checks[modelKey(model)];
      if (check?.status === 'unavailable') throw new Error(check.message);
      await atomicJson(this.path, { ...settings, model });
      return model;
    });
  }

  async list(defaultModel?: ModelRef) {
    const settings = await this.read();
    const selected = settings.model ?? defaultModel;
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
