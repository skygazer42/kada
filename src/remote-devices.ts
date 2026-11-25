import { join } from 'node:path';
import { createRemoteCredential, type RemoteDevice } from './remote.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type SharedApproval = { taskId: string; approvalId: string; digest: string };

/** Pairing and approval sharing are available only behind the owner's daemon authentication. */
export class RemoteDevices {
  private changes = new SerialQueue();
  private path:string;
  constructor(dataDir:string) { this.path = join(dataDir,'remote','devices.json'); }
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

  async setSharedWorkItem(accountId: string, deviceId: string, id: string, shared: boolean) {
    this.validate(accountId, deviceId);
    return this.changes.run(async () => {
      const devices = await this.credentials();
      const device = devices.find(item => item.accountId === accountId && item.deviceId === deviceId);
      if (!device) throw Object.assign(new Error('Device pairing not found.'), { status: 404 });
      const items = device.sharedWorkItems ?? [];
      if (items.includes(id) === shared) return { shared };
      device.sharedWorkItems = shared ? [...items, id] : items.filter(item => item !== id);
      await atomicJson(this.path, devices);
      return { shared };
    });
  }

  async withPairedDevice<T>(tokenHash: string, action: (device: RemoteDevice) => Promise<T>) {
    return this.changes.run(async () => {
      const device = (await this.credentials()).find(item => item.tokenHash === tokenHash);
      if (!device) return;
      return action(device);
    });
  }

  private validate(accountId:unknown,deviceId:unknown):asserts accountId is string {
    if (![accountId,deviceId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))) throw new Error('Use 1–80 letters, numbers, underscores or hyphens for account and device IDs.');
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
