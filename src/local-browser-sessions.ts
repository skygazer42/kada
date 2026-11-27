import { randomBytes } from 'node:crypto';

const ticketLifetime = 2 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
type Grant = { scope: string; expiresAt: number; kind: 'ticket' | 'session' };

export function createLocalBrowserSessions() {
  const grants = new Map<string, Grant>();
  function issue(scope: string, kind: Grant['kind'], lifetime: number) {
    const now = Date.now();
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
    const key = randomBytes(32).toString('base64url');
    grants.set(key, { scope, kind, expiresAt: now + lifetime });
    return key;
  }
  function find(key: unknown, kind: Grant['kind']) {
    const grant = typeof key === 'string' ? grants.get(key) : undefined;
    return grant?.kind === kind && grant.expiresAt > Date.now() ? grant : undefined;
  }
  return {
    ticket: (scope: string) => issue(scope, 'ticket', ticketLifetime),
    exchange(ticket: unknown) {
      const grant = find(ticket, 'ticket');
      if (!grant || typeof ticket !== 'string') return;
      grants.delete(ticket);
      return issue(grant.scope, 'session', sessionLifetime);
    },
    scope: (authorization?: string) => find(authorization?.replace(/^Bearer /, ''), 'session')?.scope,
  };
}
