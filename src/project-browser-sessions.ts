import { randomBytes } from 'node:crypto';

const ticketLifetime = 2 * 60_000;
const sessionLifetime = 8 * 60 * 60_000;
type Grant = { project: string; expiresAt: number; kind: 'ticket' | 'session' };

export function createProjectBrowserSessions() {
  const grants = new Map<string, Grant>();
  function issue(project: string, kind: Grant['kind'], lifetime: number) {
    const now = Date.now();
    for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
    const key = randomBytes(32).toString('base64url');
    grants.set(key, { project, kind, expiresAt: now + lifetime });
    return key;
  }
  function find(key: unknown, kind: Grant['kind']) {
    const grant = typeof key === 'string' ? grants.get(key) : undefined;
    return grant?.kind === kind && grant.expiresAt > Date.now() ? grant : undefined;
  }
  return {
    ticket: (project: string) => issue(project, 'ticket', ticketLifetime),
    exchange(ticket: unknown) {
      const grant = find(ticket, 'ticket');
      if (!grant || typeof ticket !== 'string') return;
      grants.delete(ticket);
      return issue(grant.project, 'session', sessionLifetime);
    },
    project: (authorization?: string) => find(authorization?.replace(/^Bearer /, ''), 'session')?.project,
  };
}
