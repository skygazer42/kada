import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { ApplicationCredentials, credentialDestination } from './application-credentials.js';
import { saveQuestion } from './questions.js';
import { GoalDoc } from './goal.js';

const name = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' });
const auth = Type.Union([
  Type.Object({ type: Type.Literal('bearer') }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('header'), name: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('basic'), username: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
]);
const output = (value: unknown) => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export function credentialTools(store: ApplicationCredentials, project: string, preparation: boolean) {
  return defineExtension({ name: 'local_credential_management', tools: [
    defineTool({ name: 'credentials_list', description: 'Read only credential names, HTTPS origins, authentication methods and revisions in this project. Values are never returned. A saved credential is not permission for arbitrary external work.', parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe',
      execute: async () => output(await store.list(project)) }),
    defineTool({ name: 'request_credential', description: 'Ask the user to provide an API credential using a protected owner input, never chat. Specify only its name, HTTPS origin, authentication method, short label and reason. Call alone, then wait. This never starts work or authorizes a future request. Never put a credential value in tool arguments or ask_user.',
      parameters: Type.Object({ name, origin: Type.String({ minLength: 1, maxLength: 2048 }), auth,
        label: Type.String({ minLength: 1, maxLength: 120 }), reason: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }), replay: 'safe', executionMode: 'sequential', callers: ['model'],
      execute: async (args, api, ctx) => {
        const destination = credentialDestination({ name: args.name, origin: args.origin, auth: args.auth });
        if (!args.label.trim() || !args.reason.trim() || (args.label + args.reason).includes('\0')) throw new Error('Provide a short credential label and reason.');
        const expectedRevision = await api.memo<number>('credential-revision', ctx) ?? await api.memo('credential-revision', await store.revision(project, destination.name), ctx);
        return saveQuestion(api, { text: args.label.trim(), options: [], detail: args.reason.trim(), credential: { ...destination, expectedRevision } }, preparation, false, ctx, 'request_credential');
      },
    }),
  ] });
}

export function credentialExecution(store: ApplicationCredentials, project: string, preparation: boolean) {
  return defineExtension({ name: 'local_credential_requests', tools: [defineTool({
    name: 'credential_request', description: 'Make one HTTPS API request with a saved credential name and displayed revision, only within the user-approved execution scope. The backend sends authentication only to its bound origin, rejects redirects and withholds credential echoes. Never place secrets or placeholders in URL/body/headers. An interrupted request is not retried automatically; inspect the actual effect before requesting another call.',
    parameters: Type.Object({ name, revision: Type.Integer({ minimum: 1 }), url: Type.String({ minLength: 1, maxLength: 8192 }),
      method: Type.Union(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map(value => Type.Literal(value))),
      body: Type.Optional(Type.String({ maxLength: 65_536 })), headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 2048 }))) }, { additionalProperties: false }), executionMode: 'sequential', callers: ['model'],
    execute: async (args, api, ctx) => {
      const goal = await api.snapshot(GoalDoc, ctx);
      if (!goal?.initialized || goal.phase !== 'working' || preparation && !goal.confirmation) throw new Error('A confirmed execution goal is required for an authenticated request.');
      return output(await store.request(project, args, ctx.abortSignal));
    },
  })] });
}
