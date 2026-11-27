import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { ArtifactError, artifactTarget } from './artifacts.js';
import type { TaskStatus } from './client.js';
import { Workspace } from './workspace.js';
import { chartPage } from './chart-preview-page.js';

type Chart = { title: string; type: 'bar' | 'line'; labels: string[]; series: { name: string; values: number[] }[] };
const lifetimeMs = 10 * 60_000;

export function parseChart(text: string): Chart {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new ArtifactError(400, 'The chart delivery must use valid JSON.'); }
  const chart = parsed as Partial<Chart> | null;
  const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 160;
  if (!chart || !label(chart.title) || (chart.type !== 'bar' && chart.type !== 'line') ||
    !Array.isArray(chart.labels) || !chart.labels.length || chart.labels.length > 120 || !chart.labels.every(label) ||
    !Array.isArray(chart.series) || !chart.series.length || chart.series.length > 6 ||
    chart.series.some(series => !series || !label(series.name) || !Array.isArray(series.values) ||
      series.values.length !== chart.labels!.length ||
      series.values.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) {
    throw new ArtifactError(400, 'Provide a bar or line chart with a title, labels and matching finite numeric series.');
  }
  return { title: chart.title, type: chart.type, labels: chart.labels, series: chart.series.map(({ name, values }) => ({ name, values })) };
}

const title = Type.String({ minLength: 1, maxLength: 160 });
const series = Type.Object({ name: title, values: Type.Array(Type.Number(), { minItems: 1, maxItems: 120 }) }, { additionalProperties: false });
const chartSpec = Type.Object({ title, type: Type.Union([Type.Literal('bar'), Type.Literal('line')]),
  labels: Type.Array(title, { minItems: 1, maxItems: 120 }), series: Type.Array(series, { minItems: 1, maxItems: 6 }) }, { additionalProperties: false });

export function chartArtifactExtension(workspace: Workspace) {
  return defineExtension({ name: 'local_chart_delivery', tools: [defineTool({
    name: 'save_chart',
    description: 'Save a verified-delivery candidate for a bar or line chart. Use the real data with one number per label per series. After writing, submit the .chart.json file with the original task delivery. Inspect the existing file before retrying an interrupted write.',
    parameters: Type.Object({ path: Type.String({ pattern: '\\.chart\\.json$', maxLength: 4096 }), spec: chartSpec }, { additionalProperties: false }),
    execute: async ({ path, spec }, api, context) => {
      const chart = parseChart(JSON.stringify(spec));
      const cwd = (await api.agent(context)).cwd;
      await workspace.write(path, JSON.stringify(chart, null, 2) + '\n', cwd);
      return { output: [{ type: 'text', text: `Saved ${path} for delivery.` }] };
    },
  })] });
}

export function createChartPreviews(origin: string) {
  const host = new URL(origin).host;
  const snapshots = new Map<string, { expiresAt: number; chart: Chart }>();
  async function issue(status: TaskStatus, index: number) {
    const artifact = await artifactTarget(status, index);
    if (artifact.kind !== 'file' || !artifact.name.toLowerCase().endsWith('.chart.json') || artifact.bytes > 256 * 1024) {
      throw new ArtifactError(400, 'Choose a verified .chart.json file up to 256 KiB.');
    }
    const workspace = await Workspace.open(status.workspace, { create: false });
    const { file, text } = await workspace.readSnapshot(artifact.path);
    if (file.sha256 !== artifact.sha256) throw new ArtifactError(409, 'This artifact changed after verification.');
    const chart = parseChart(text), now = Date.now();
    for (const [token, snapshot] of snapshots) if (snapshot.expiresAt <= now) snapshots.delete(token);
    const token = randomBytes(24).toString('base64url'), expiresAt = now + lifetimeMs;
    snapshots.set(token, { chart, expiresAt });
    return { url: origin + '/chart-preview/' + token, expiresAt };
  }

  function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const match = /^\/chart-preview\/([A-Za-z0-9_-]{32})$/.exec(url.pathname);
    if (!match) return false;
    const token = match[1]!, snapshot = snapshots.get(token);
    if (!snapshot || snapshot.expiresAt <= Date.now() || req.method !== 'GET' || req.headers.host !== host) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('This chart preview is unavailable. Open it again from Kada.');
      return true;
    }
    const nonce = randomBytes(18).toString('base64url');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    });
    res.end(chartPage(nonce, snapshot.chart));
    return true;
  }
  return { issue, handle };
}
