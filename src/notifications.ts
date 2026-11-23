import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TaskStatus } from './client.js';
import type { RoutineOccurrence } from './routines.js';
import { atomicJson, readJson, SerialQueue } from './util.js';

export type Notification = {id:string; taskId?:string; routineId?:string; revision:number; event:string; at:number; detail:string; readAt:number|null; changeGroup?:string; resultHash?:string};
type Inbox = {read:Record<string,number>; reminders:Notification[]};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const visible = new Set(['completed','failed','waiting_user','blocked','needs_attention','clarifying','awaiting_confirmation','budget_limited']);

export function taskNotifications(status: TaskStatus): Notification[] {
  return (status.goal?.events ?? []).filter(event => visible.has(event.type)).map(event => ({
    id:hash([status.id,event.at,event.type,event.detail,event.revision ?? 1]),taskId:status.id,revision:event.revision ?? 1,
    event:event.type,at:event.at,detail:event.detail,readAt:null,
    ...(status.routineOccurrenceId ? {routineId:status.routineOccurrenceId.split('/')[0]} : {}),
    ...(status.routineNotifyOnChange && event.type === 'completed' && event.resultHash ? {changeGroup:status.routineOccurrenceId!.split('/').slice(0,2).join('/'),resultHash:event.resultHash} : {}),
  }));
}

/** Only read marks and due reminder receipts are custom state; task events stay in Pi. */
export class NotificationStore {
  private changes = new SerialQueue();
  private path: string;
  constructor(dataDir:string) { this.path = join(dataDir,'notifications.json'); }
  private async load(): Promise<Inbox> {
    try { return await readJson<Inbox>(this.path); }
    catch(error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {read:{},reminders:[]}; throw error; }
  }
  async list(derived:Notification[]) {
    const stored = await this.load();
    const previous = new Map<string,string>();
    const changed = derived.toSorted((a,b) => a.at-b.at).filter(event => {
      if (!event.changeGroup || !event.resultHash) return true;
      const last = previous.get(event.changeGroup);
      previous.set(event.changeGroup,event.resultHash);
      return last !== event.resultHash;
    });
    const events = new Map([...stored.reminders,...changed].map(event => [event.id,event]));
    return [...events.values()].map(event => ({...event,readAt:stored.read[event.id] ?? null})).sort((a,b) => b.at-a.at || a.id.localeCompare(b.id));
  }
  async mark(ids:string[],derived:Notification[]) {
    return this.changes.run(async () => {
      const stored = await this.load(), events = await this.list(derived);
      for (const id of ids) {
        if (!events.some(event => event.id === id)) throw new Error('Notification not found.');
        stored.read[id] ??= Date.now();
      }
      await atomicJson(this.path,stored);
      return {ok:true};
    });
  }
  async notify(occurrence:RoutineOccurrence) {
    return this.changes.run(async () => {
      const stored = await this.load(), id = hash(['routine',occurrence.id]);
      if (!stored.reminders.some(event => event.id === id)) {
        stored.reminders.push({id,routineId:occurrence.routineId,revision:occurrence.revision,event:'reminder',at:Date.parse(occurrence.scheduledAt),detail:occurrence.objective,readAt:null});
        await atomicJson(this.path,stored);
      }
    });
  }
}
