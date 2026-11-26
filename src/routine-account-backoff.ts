import { isRetryableAssistantError, type AssistantMessage } from '@earendil-works/pi-ai';

export type AccountRefusal = 'auth' | 'access' | 'quota' | 'model';

export function modelAccountRefusal(message: AssistantMessage): AccountRefusal | undefined {
  if (message.stopReason !== 'error' || !message.errorMessage || isRetryableAssistantError(message)) return;
  const text = message.errorMessage;
  if (/^(?:No API key for provider|Provider is not configured):/i.test(text) || /^(?:HTTP\s+)?401\b/i.test(text) || /\b(?:invalid_api_key|authentication_error)\b/i.test(text)) return 'auth';
  if (/^(?:HTTP\s+)?403\b/i.test(text) || /\bpermission_denied\b/i.test(text)) return 'access';
  if (/^(?:HTTP\s+)?402\b/i.test(text) || /\b(?:insufficient_quota|insufficient[_ ]credits|credit balance is too low|out of budget)\b/i.test(text)) return 'quota';
  if (/\bmodel_not_found\b/i.test(text) || /^(?:HTTP\s+)?404\b.*\bmodel\b.*\b(?:not found|does not exist)\b/i.test(text)) return 'model';
  return undefined;
}
