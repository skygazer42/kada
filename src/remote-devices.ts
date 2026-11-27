import { join } from 'node:path';
import { createRemoteCredential, type RemoteDevice } from './remote.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type SharedApproval = { taskId: string; approvalId: string; digest: string };
type RoomAccountRole = 'viewer' | 'participant';
type RoomAccountGrant = { roomId: string; accountId: string; role: RoomAccountRole; files: boolean };
const pairingId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const isRoomAccountRole = (value: unknown): value is RoomAccountRole => value === 'viewer' || value === 'participant';

/** Pairing and approval sharing are available only behind the owner's daemon authentication. */
export class RemoteDevices {
  private changes = new SerialQueue();
  private path:string;
  private roomAccountsPath: string;
  constructor(dataDir:string) {
    this.path = join(dataDir,'remote','devices.json');
    this.roomAccountsPath = join(dataDir,'remote','room-accounts.json');
  }
  async credentials():Promise<RemoteDevice[]> {
    try { return await readJson<RemoteDevice[]>(this.path); }
    catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async list() { return (await this.credentials()).map(({accountId,deviceId}) => ({accountId,deviceId})); }
  async setSharedApproval(accountId: string, deviceId: string, approval: SharedApproval, shared: boolean) {
    this.validate(accountId, deviceId);
    return this.changes.run(async () => {
      const devices = await this.credentials();
      const device = devices.find(item => item.accountId === accountId && item.deviceId === deviceId);
      if (!device) throw Object.assign(new Error('Device pairing not found.'), { status: 404 });
      const grants = device.sharedApprovals ?? [];
      const matches = (item: SharedApproval) => item.taskId === approval.taskId &&
        item.approvalId === approval.approvalId && item.digest === approval.digest;
      if (grants.some(matches) === shared) return { shared };
      device.sharedApprovals = shared ? [...grants, approval] : grants.filter(item => !matches(item));
      await atomicJson(this.path, devices);
      return { shared };
    });
  }

  async setSharedThread(accountId: string, deviceId: string, taskId: string, shared: boolean, access: 'view' | 'replies' | 'controls' | 'files') {
    this.validate(accountId, deviceId);
    return this.changes.run(async () => {
      const devices = await this.credentials();
      const device = devices.find(item => item.accountId === accountId && item.deviceId === deviceId);
      if (!device) throw Object.assign(new Error('Device pairing not found.'), { status: 404 });
      const threads = device.sharedThreads ?? [];
      const grant = threads.find(item => item.taskId === taskId);
      if (access !== 'view') {
        if (shared && !grant) throw Object.assign(new Error('Share this thread for viewing before granting interaction access.'), { status: 409 });
        if (!grant || Boolean(grant[access]) === shared) return { shared };
        if (shared) grant[access] = true;
        else delete grant[access];
      } else {
        if (Boolean(grant) === shared) return { shared };
        device.sharedThreads = shared ? [...threads, { taskId }] : threads.filter(item => item !== grant);
      }
      await atomicJson(this.path, devices);
      return { shared };
    });
  }

  private async readRoomAccounts(): Promise<RoomAccountGrant[]> {
    const grants = await readJson<RoomAccountGrant[]>(this.roomAccountsPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    if (!Array.isArray(grants) || grants.some(grant => !grant || typeof grant.accountId !== 'string' || !pairingId.test(grant.accountId) ||
        typeof grant.roomId !== 'string' || !/^[a-f0-9-]{36}$/.test(grant.roomId) || !isRoomAccountRole(grant.role) || typeof grant.files !== 'boolean')) {
      throw new Error('Invalid saved room account access.');
    }
    return grants;
  }

  roomAccounts(roomId: string) {
    return this.changes.run(async () => (await this.readRoomAccounts()).filter(grant => grant.roomId === roomId));
  }

  setRoomAccount(roomId: string, accountId: string, input: Record<string, unknown> | null) {
    if (!pairingId.test(accountId)) throw Object.assign(new Error('Provide a valid paired account ID.'), { status: 400 });
    if (input && (!isRoomAccountRole(input.role) || input.files !== undefined && typeof input.files !== 'boolean' ||
        Object.keys(input).some(key => key !== 'role' && key !== 'files'))) {
      throw Object.assign(new Error('Choose the viewer or participant role and an optional boolean files permission.'), { status: 400 });
    }
    return this.changes.run(async () => {
      const grants = (await this.readRoomAccounts()).filter(grant => grant.roomId !== roomId || grant.accountId !== accountId);
      if (!input) {
        await atomicJson(this.roomAccountsPath, grants);
        return { revoked: true };
      }
      const grant = { roomId, accountId, role: input.role as RoomAccountRole, files: input.files === true };
      await atomicJson(this.roomAccountsPath, [...grants, grant]);
      return grant;
    });
  }

  async setSharedWorkItem(accountId: string, deviceId: string, id: string, shared: boolean, access: 'view' | 'replies' | 'controls' | 'edits' = 'view') {
    this.validate(accountId, deviceId);
    return this.changes.run(async () => {
      const devices = await this.credentials();
      const device = devices.find(item => item.accountId === accountId && item.deviceId === deviceId);
      if (!device) throw Object.assign(new Error('Device pairing not found.'), { status: 404 });
      if (access !== 'view' && shared && !device.sharedWorkItems?.includes(id)) {
        throw Object.assign(new Error('Share this work item for viewing before granting interaction access.'), { status: 409 });
      }
      const field = ({ view: 'sharedWorkItems', replies: 'sharedWorkItemReplies', controls: 'sharedWorkItemControls',
        edits: 'sharedWorkItemEdits' } as const)[access];
      const items = device[field] ?? [];
      if (items.includes(id) === shared) return { shared };
      device[field] = shared ? [...items, id] : items.filter(item => item !== id);
      if (access === 'view' && !shared) {
        device.sharedWorkItemReplies = device.sharedWorkItemReplies?.filter(item => item !== id);
        device.sharedWorkItemControls = device.sharedWorkItemControls?.filter(item => item !== id);
        device.sharedWorkItemEdits = device.sharedWorkItemEdits?.filter(item => item !== id);
      }
      await atomicJson(this.path, devices);
      return { shared };
    });
  }

  async withPairedDevice<T>(tokenHash: string, action: (device: RemoteDevice) => Promise<T>, scope?: 'shared-rooms') {
    return this.changes.run(async () => {
      const device = (await this.credentials()).find(item => item.tokenHash === tokenHash);
      if (!device) return;
      if (scope !== 'shared-rooms') return action(device);
      const grants = new Map(device.sharedThreads?.map(grant => [grant.taskId, grant]));
      for (const account of await this.readRoomAccounts()) {
        if (account.accountId !== device.accountId) continue;
        const grant = { ...grants.get(account.roomId), taskId: account.roomId };
        if (account.role === 'participant') grant.replies = true;
        if (account.files) grant.files = true;
        grants.set(account.roomId, grant);
      }
      return action({ ...device, sharedThreads: [...grants.values()] });
    });
  }

  private validate(accountId:unknown,deviceId:unknown):asserts accountId is string {
    if (![accountId,deviceId].every(id => typeof id === 'string' && pairingId.test(id))) throw new Error('Use 1–80 letters, numbers, underscores or hyphens for account and device IDs.');
  }
  async pair(accountId:string,deviceId:string) {
    this.validate(accountId,deviceId);
    return this.changes.run(async () => {
      const devices = await this.credentials();
      if (devices.some(device => device.accountId === accountId && device.deviceId === deviceId)) throw new Error('Device already paired. Revoke it before pairing again.');
      const {token,tokenHash} = createRemoteCredential();
      await atomicJson(this.path,[...devices,{accountId,deviceId,tokenHash}]);
      return {accountId,deviceId,token};
    });
  }
  async revoke(accountId:string,deviceId:string) {
    this.validate(accountId,deviceId);
    return this.changes.run(async () => {
      await atomicJson(this.path,(await this.credentials()).filter(device => device.accountId !== accountId || device.deviceId !== deviceId));
      return {ok:true};
    });
  }
}
