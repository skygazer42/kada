import { join } from 'node:path';
import { explicitInstant } from './routine-schedule.js';
import { normalizeMcpPrecheck, projectRoot, type McpPrecheck, type McpTools } from './mcp-tools.js';
import { atomicJson, errorText, readJson, redactCredentials, SerialQueue } from './util.js';
import { localCalendarDay } from './work-items.js';

type CalendarSource = { id: string; revision: string; account: string; calendarId: string; timeZone: string };
type CalendarEvent = { id: string; title: string; day: string; start: string; end: string; allDay: boolean };

export class CalendarError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseSource(input: unknown): CalendarSource {
  const value = record(input);
  if (!value || Object.keys(value).some(key => !['id', 'revision', 'account', 'calendarId', 'timeZone'].includes(key))) {
    throw new CalendarError(400, 'Provide a Calendar MCP connection, account, calendar and time zone.');
  }
  const { id, revision } = normalizeMcpPrecheck({ id: value.id, revision: value.revision, tool: 'list-events', arguments: {} });
  const { account, calendarId, timeZone } = value;
  if (typeof account !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(account) || typeof calendarId !== 'string' || !calendarId.trim() ||
      calendarId.length > 512 || /^[\s]*\[/.test(calendarId) || /[\u0000-\u001f\u007f]/.test(calendarId)) {
    throw new CalendarError(400, 'Choose one calendar and its explicit Google Calendar MCP account nickname.');
  }
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 128 || /^[+-]/.test(timeZone)) {
    throw new CalendarError(400, 'Provide a valid IANA time zone.');
  }
  try {
    return { id, revision, account, calendarId: calendarId.trim(), timeZone: new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone };
  } catch {
    throw new CalendarError(400, 'Provide a valid IANA time zone.');
  }
}

function monthBounds(month: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) || month === '9999-12') throw new CalendarError(400, 'Provide a valid calendar month as YYYY-MM.');
  const from = month + '-01', next = new Date(from + 'T00:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: next.toISOString().slice(0, 10) };
}

function dateOnly(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

function projectEvent(value: unknown, timeZone: string, from: string, to: string): CalendarEvent | undefined {
  const event = record(value);
  const start = record(event?.start), end = record(event?.end);
  if (!event || typeof event.id !== 'string' || !event.id || !start || !end) throw new Error('Invalid calendar event.');
  const id = event.id, title = typeof event.summary === 'string' && event.summary.trim() ? redactCredentials(event.summary.slice(0, 500)) : '未命名日程';
  if (dateOnly(start.date) && dateOnly(end.date)) {
    if (start.date >= end.date) throw new Error('Invalid all-day event.');
    if (start.date >= to || end.date <= from) return;
    return { id, title, start: start.date, end: end.date, day: start.date < from ? from : start.date, allDay: true };
  }
  if (typeof start.dateTime !== 'string' || typeof end.dateTime !== 'string') throw new Error('Invalid calendar event time.');
  const startAt = explicitInstant(start.dateTime, 'Calendar start'), endAt = explicitInstant(end.dateTime, 'Calendar end');
  if (startAt > endAt) throw new Error('Invalid calendar event time.');
  const day = localCalendarDay(startAt, timeZone);
  const lastDay = localCalendarDay(Math.max(startAt, endAt - 1), timeZone);
  if (day >= to || lastDay < from) return;
  return { id, title, day: day < from ? from : day, start: new Date(startAt).toISOString(), end: new Date(endAt).toISOString(), allDay: false };
}

export class ProjectCalendars {
  private readonly path: string;
  private changes = new SerialQueue();
  constructor(directory: string, private readonly mcp: McpTools) {
    this.path = join(directory, 'project-calendars.json');
  }
  private read(): Promise<Record<string, CalendarSource>> {
    return readJson<Record<string, CalendarSource>>(this.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
  }
  private async checkPermission(project: string, check: McpPrecheck) {
    try { await this.mcp.validatePrecheck(project, check); }
    catch (error) { throw new CalendarError(409, errorText(error)); }
  }
  async source(workspace: string) {
    const project = await projectRoot(workspace);
    return { project, source: (await this.read())[project] ?? null };
  }
  async setSource(workspace: string, input: unknown) {
    const project = await projectRoot(workspace), source = parseSource(input);
    return this.changes.run(async () => {
      await this.checkPermission(project, { id: source.id, revision: source.revision, tool: 'list-events', arguments: {} });
      const values = await this.read();
      values[project] = source;
      await atomicJson(this.path, values);
      return { project, source };
    });
  }
  async clearSource(workspace: string) {
    const project = await projectRoot(workspace);
    return this.changes.run(async () => {
      const values = await this.read();
      if (values[project]) {
        delete values[project];
        await atomicJson(this.path, values);
      }
      return { project, source: null };
    });
  }
  async month(workspace: string, month: string, expectedProject?: string) {
    const { from, to } = monthBounds(month);
    const { project, source } = await this.source(workspace);
    if (expectedProject !== undefined && project !== expectedProject) throw new CalendarError(409, 'The original calendar project changed.');
    if (!source) return { configured: false, timeZone: null, events: [] };
    const { id, revision, account, calendarId, timeZone } = source;
    const check = { id, revision, tool: 'list-events', arguments: {
      account, calendarId, timeZone, timeMin: from + 'T00:00:00', timeMax: to + 'T00:00:00',
      fields: ['id', 'summary', 'start', 'end', 'status'],
    } };
    const ensureSource = async () => {
      const current = (await this.read())[project];
      if (JSON.stringify(current) !== JSON.stringify(source)) throw new CalendarError(409, 'The project calendar source changed.');
    };
    await this.checkPermission(project, check);
    const result = await this.mcp.runReadOnly(project, check, AbortSignal.timeout(15_000), ensureSource).catch(async () => {
      await this.checkPermission(project, check);
      await ensureSource();
      throw new CalendarError(502, 'Could not read the configured Google Calendar.');
    });
    await this.checkPermission(project, check);
    await ensureSource();
    try {
      if (result.isError) throw new Error('Provider error.');
      const text = result.content.length === 1 && result.content[0]?.type === 'text' ? result.content[0].text : undefined;
      if (!text || Buffer.byteLength(text) > 1_000_000) throw new Error('Unexpected calendar response.');
      const payload = record(JSON.parse(text));
      if (!Array.isArray(payload?.events) || Array.isArray(payload.partialFailures) && payload.partialFailures.length) throw new Error('Unexpected calendar response.');
      const events = payload.events.filter(value => {
        const event = record(value);
        return event && event.accountId === account && event.status !== 'cancelled';
      }).flatMap(value => {
        const event = projectEvent(value, timeZone, from, to);
        return event ? [event] : [];
      });
      events.sort((a, b) => a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
      return { configured: true, timeZone, events };
    } catch {
      throw new CalendarError(502, 'The provider did not return a supported Google Calendar event list.');
    }
  }
}
