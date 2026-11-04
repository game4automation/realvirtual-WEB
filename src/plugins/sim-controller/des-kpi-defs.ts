// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * User-defined KPIs of the experiment matrix ("+ Add KPI"). A definition names WHAT every run
 * reports, always measured only after the warm-up (statResetTime; the whole run without one):
 *
 * - a PROPERTY of a component (same `{address, component, field}` addressing as "+ Add property",
 *   or a name pattern summed over several components) - the primary form;
 * - a recorded VALUE ROW (`row:<section>/<key>`, e.g. a script's `self.statValue`);
 * - a PREDEFINED component metric (utilization, breakdown share ...) over one component or a name
 *   pattern (`Stapler_*`), read from the run's post-warm-up statistics.
 *
 * Properties and value rows have a kind: a COUNTER reports value at run end - value at warm-up
 * end (optionally per measured hour), a STATE its time-weighted mean, max or end value over the
 * measured window. The run archive records these points per tracked source (`kpiTrack`, see
 * {@link KpiTrack}); runs recorded before a KPI existed have no value and need a rerun.
 * Pure: no React, no viewer. Persisted as `kpiDefs` on the Base manifest next to `kpiRows`.
 */

export type MetricKey = 'utilization' | 'outputPerHour' | 'totalProcessed' | 'failure' | 'blocked'
  | 'empty' | 'working' | 'transport' | 'stopped' | 'slowed' | 'setup';
export type KpiAggregate = 'mean' | 'sum' | 'min' | 'max';
export type KpiBetter = 'higher' | 'lower';

export type KpiKind = 'counter' | 'state';
export type KpiStateStat = 'mean' | 'max' | 'end';
/** How a tracked value becomes the KPI: counter difference (per hour) or state statistic. */
export interface KpiMeasure { kind: KpiKind; perHour?: boolean; stat?: KpiStateStat }

/** A predefined component metric over one component path or a glob over component NAMES (last path segment). */
export interface KpiComponentSource { match: string; metric: MetricKey; aggregate: KpiAggregate }
/**
 * A component property: `address` (plan-769 node address, as "+ Add property") or `match` (a name
 * glob over the last path segment, summed over every matching component of type `component`).
 */
export interface KpiPropertyRef { component: string; field: string; address?: string; match?: string; path?: string }
export interface KpiPropertySource extends KpiMeasure { property: KpiPropertyRef }
/** One recorded value row, id `row:<section>/<rowKey>` (e.g. a script's `self.statValue`). */
export interface KpiSeriesSource extends KpiMeasure { series: string }

export interface KpiDef {
  id: string;
  label: string;
  unit?: string;
  better?: KpiBetter;
  source: KpiComponentSource | KpiPropertySource | KpiSeriesSource;
}

/** Per-run archive of the tracked sources: measured window and the points of every source. */
export interface KpiTrackValue { warm: number | null; end: number; mean: number | null; max: number | null }
export interface KpiTrack {
  t0: number; t1: number; values: Record<string, KpiTrackValue>;
  /** Set when the run's KPI sources could not be tracked: the source provider did not answer in time. */
  incomplete?: 'kpi-sources-timeout';
}

export const METRICS: Record<MetricKey, { label: string; unit: string; better?: KpiBetter }> = {
  utilization: { label: 'Utilization', unit: '%' },
  outputPerHour: { label: 'Output', unit: '/h', better: 'higher' },
  totalProcessed: { label: 'Total output', unit: 'pcs', better: 'higher' },
  failure: { label: 'Breakdown share', unit: '%', better: 'lower' },
  blocked: { label: 'Blocked share', unit: '%', better: 'lower' },
  empty: { label: 'Idle share', unit: '%', better: 'lower' },
  working: { label: 'Working share', unit: '%' },
  transport: { label: 'Driving share', unit: '%' },
  stopped: { label: 'Traffic stop share', unit: '%', better: 'lower' },
  slowed: { label: 'Slowed by traffic', unit: '%', better: 'lower' },
  setup: { label: 'Setup share', unit: '%' },
};
export const AGGREGATES: KpiAggregate[] = ['mean', 'sum', 'min', 'max'];
export const MAX_KPI_DEFS = 32;
const COMPONENT_PREFIX = 'component:';

export const isSeriesSource = (s: KpiDef['source']): s is KpiSeriesSource => typeof (s as KpiSeriesSource).series === 'string';
export const isPropertySource = (s: KpiDef['source']): s is KpiPropertySource => !!(s as KpiPropertySource).property;
export const isTrackedSource = (s: KpiDef['source']): s is KpiPropertySource | KpiSeriesSource => isSeriesSource(s) || isPropertySource(s);

/** Archive key of a tracked source: `prop:<address or *glob>|<component>|<field>`, or the row id. */
export function trackKeyOf(source: KpiPropertySource | KpiSeriesSource): string {
  if (isSeriesSource(source)) return source.series;
  const p = source.property;
  return `prop:${p.address ?? `*${p.match ?? ''}`}|${p.component}|${p.field}`;
}
/** Parse a `prop:` track key back into its reference (null for row ids and malformed keys). */
export function parseTrackKey(key: string): KpiPropertyRef | null {
  if (!key.startsWith('prop:')) return null;
  const [target, component, field] = key.slice(5).split('|');
  if (!target || !component || !field) return null;
  return target.startsWith('*') ? { component, field, match: target.slice(1) } : { component, field, address: target };
}
/** Every source a run must track for these definitions (deduplicated). */
export function trackedSourcesOf(defs: readonly KpiDef[]): string[] {
  return [...new Set(defs.flatMap(d => isTrackedSource(d.source) ? [trackKeyOf(d.source)] : []))];
}

const COUNTER_NAME = /count|sum|total|destroyed|produced|processed|output/i;
/** Proposed kind for a new property / value row: names like *Count, Total*, *Processed -> counter. */
export function suggestKind(...names: Array<string | undefined>): KpiKind {
  return names.some(n => n && COUNTER_NAME.test(n)) ? 'counter' : 'state';
}

/** Defensive parse of a run's `kpiTrack` archive entry. */
export function parseKpiTrack(raw: unknown): KpiTrack | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!fin(r.t0) || !fin(r.t1) || !r.values || typeof r.values !== 'object') return undefined;
  const values: Record<string, KpiTrackValue> = {};
  for (const [key, v] of Object.entries(r.values as Record<string, unknown>)) {
    const e = v as Record<string, unknown> | null;
    if (!e || !fin(e.end)) continue;
    values[key] = { end: e.end, warm: fin(e.warm) ? e.warm : null, mean: fin(e.mean) ? e.mean : null, max: fin(e.max) ? e.max : null };
  }
  return { t0: r.t0, t1: r.t1, values, ...(r.incomplete === 'kpi-sources-timeout' ? { incomplete: 'kpi-sources-timeout' as const } : {}) };
}
/** KPI-map entries of a run's track: `track:<key>/<point>` plus `track:hours` (measured hours). */
export function trackKpis(track: KpiTrack | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!track) return out;
  out['track:hours'] = Math.max(0, track.t1 - track.t0) / 3600;
  for (const [key, v] of Object.entries(track.values)) {
    out[`track:${key}/end`] = v.end;
    if (v.warm !== null) out[`track:${key}/warm`] = v.warm;
    if (v.mean !== null) out[`track:${key}/mean`] = v.mean;
    if (v.max !== null) out[`track:${key}/max`] = v.max;
  }
  return out;
}
export const isMetricKey = (v: unknown): v is MetricKey => typeof v === 'string' && Object.hasOwn(METRICS, v);
/** A pattern (contains `*`) or a bare name can hit several components; a full path hits one. */
export const matchesSeveral = (match: string) => match.includes('*') || !match.includes('/');

/** URL-ish slug for the `def:` id. */
export function slugOf(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'kpi';
}
/** A fresh `def:<slug>` id that collides with none of `taken`. */
export function uniqueDefId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `def:${slugOf(label)}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Validate untrusted defs (manifest, MCP): invalid entries and duplicate ids are dropped, at most 32 kept. */
export function normalizeKpiDefs(raw: unknown): KpiDef[] {
  if (!Array.isArray(raw)) return [];
  const out: KpiDef[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_KPI_DEFS) break;
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^def:[a-z0-9-]+$/.test(r.id) || ids.has(r.id)) continue;
    if (typeof r.label !== 'string' || !r.label.trim()) continue;
    const s = r.source && typeof r.source === 'object' ? r.source as Record<string, unknown> : null;
    let source: KpiDef['source'] | null = null;
    const measure = (): KpiMeasure => {
      const kind: KpiKind = s!.kind === 'counter' ? 'counter' : 'state';
      return kind === 'counter' ? { kind, ...(s!.perHour === true ? { perHour: true } : {}) }
        : { kind, ...(s!.stat === 'max' || s!.stat === 'end' ? { stat: s!.stat } : {}) };
    };
    const p = s?.property && typeof s.property === 'object' ? s.property as Record<string, unknown> : null;
    const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : undefined;
    if (s && typeof s.series === 'string' && s.series.startsWith('row:')) source = { series: s.series, ...measure() };
    else if (p && str(p.component) && str(p.field) && (str(p.address) || str(p.match))) {
      const address = str(p.address), match = address ? undefined : str(p.match), path = str(p.path);
      source = { property: { component: str(p.component)!, field: str(p.field)!, ...(address ? { address } : { match: match! }), ...(path ? { path } : {}) }, ...measure() };
    }
    else if (s && typeof s.match === 'string' && s.match.trim() && isMetricKey(s.metric)) {
      const aggregate = AGGREGATES.includes(s.aggregate as KpiAggregate) ? s.aggregate as KpiAggregate : 'mean';
      source = { match: s.match.trim(), metric: s.metric, aggregate };
    }
    if (!source) continue;
    ids.add(r.id);
    out.push({ id: r.id, label: r.label.trim().slice(0, 80), source,
      ...(typeof r.unit === 'string' && r.unit ? { unit: r.unit.slice(0, 16) } : {}),
      ...(r.better === 'higher' || r.better === 'lower' ? { better: r.better } : {}) });
  }
  return out;
}

function globRegex(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** True when a component path is hit by `match` (full path, or a name glob). */
export function componentMatches(match: string, path: string): boolean {
  if (path === match) return true;
  if (match.includes('/')) return false;
  return globRegex(match).test(lastSegment(path));
}

/** This run's value of the def, from its KPI map; undefined when nothing matches. */
export function evaluateKpiDef(def: KpiDef, kpis: Record<string, number>): number | undefined {
  if (isTrackedSource(def.source)) {
    const key = `track:${trackKeyOf(def.source)}`;
    const at = (point: string) => { const v = kpis[`${key}/${point}`]; return v !== undefined && Number.isFinite(v) ? v : undefined; };
    if (def.source.kind === 'counter') {
      const end = at('end'), warm = at('warm');
      if (end === undefined || warm === undefined) return undefined;
      if (!def.source.perHour) return end - warm;
      const hours = kpis['track:hours'];
      return hours !== undefined && hours > 0 ? (end - warm) / hours : undefined;
    }
    return at(def.source.stat ?? 'mean');
  }
  const { match, metric, aggregate } = def.source;
  const suffix = `/${metric}`;
  const values: number[] = [];
  for (const [key, value] of Object.entries(kpis)) {
    if (!key.startsWith(COMPONENT_PREFIX) || !key.endsWith(suffix) || !Number.isFinite(value)) continue;
    if (componentMatches(match, key.slice(COMPONENT_PREFIX.length, -suffix.length))) values.push(value);
  }
  if (!values.length) return undefined;
  switch (aggregate) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    default: return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

/** Component paths found in run KPI keys (`component:<path>/<metric>`). */
export function componentPathsOf(kpiKeys: Iterable<string>): string[] {
  const paths = new Set<string>();
  for (const key of kpiKeys) {
    if (!key.startsWith(COMPONENT_PREFIX)) continue;
    const rest = key.slice(COMPONENT_PREFIX.length);
    const slash = rest.lastIndexOf('/');
    if (slash > 0) paths.add(rest.slice(0, slash));
  }
  return [...paths].sort();
}

/**
 * What the component picker offers: a pattern `Stem*` wherever two or more names share the text
 * before a trailing `_<digits>` / `<digits>`, then every single component. Without runs the live
 * component names stand in for the paths.
 */
export function componentSuggestions(kpiKeys: Iterable<string>, liveNames: string[] = []) {
  let paths = componentPathsOf(kpiKeys);
  if (!paths.length) paths = [...new Set(liveNames.filter(Boolean))].sort();
  const components = paths.map(path => ({ path, name: lastSegment(path) }));
  const stems = new Map<string, number>();
  for (const { name } of components) {
    const m = /^(.*?)(_?)\d+$/.exec(name);
    if (!m || !m[1]) continue;
    const stem = `${m[1]}${m[2]}`;
    stems.set(stem, (stems.get(stem) ?? 0) + 1);
  }
  const patterns = [...stems].filter(([, n]) => n >= 2).sort(([a], [b]) => a.localeCompare(b))
    .map(([stem, count]) => ({ match: `${stem}*`, count }));
  return { patterns, components };
}

/** Readable label of a recorded row id: a script's `row:scripts/["Owner/Path","Key"]` → `Key · Path`. */
export function rowDisplayLabel(id: string, fallback?: string): string {
  if (id.startsWith('row:scripts/')) {
    try {
      const [owner, key] = JSON.parse(id.slice('row:scripts/'.length)) as [unknown, unknown];
      if (typeof owner === 'string' && typeof key === 'string') return `${key} · ${lastSegment(owner)}`;
    } catch { /* fall through */ }
  }
  return fallback ?? id;
}

/** Recorded value rows split into the editor's "Script values" and "Model values" groups. */
export function seriesSourceOptions(series: Iterable<{ id: string; label: string; unit?: string }>) {
  const seen = new Map<string, { id: string; label: string; unit?: string; group: 'Script values' | 'Model values' }>();
  for (const s of series) {
    if (!s.id.startsWith('row:') || s.id.startsWith('row:system.performance/') || seen.has(s.id)) continue;
    seen.set(s.id, { id: s.id, label: rowDisplayLabel(s.id, s.label), ...(s.unit ? { unit: s.unit } : {}),
      group: s.id.startsWith('row:scripts/') ? 'Script values' : 'Model values' });
  }
  return [...seen.values()].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
}

/** Suggested name: "AGV breakdown share"-style from the match and metric, or the property / value name. */
export function defaultLabel(def: Pick<KpiDef, 'source'>, seriesLabel?: string): string {
  if (isTrackedSource(def.source)) {
    let base: string;
    if (isSeriesSource(def.source)) base = seriesLabel ?? rowDisplayLabel(def.source.series);
    else {
      const p = def.source.property;
      const subject = p.match ? p.match.replace(/_?\*$/, '').replace(/\*/g, '') || 'All' : lastSegment(p.path ?? p.component);
      base = `${subject} ${p.field}`;
    }
    if (def.source.kind === 'counter') return def.source.perHour ? `${base} per hour` : base;
    return def.source.stat && def.source.stat !== 'mean' ? `${base} (${def.source.stat})` : base;
  }
  const metric = METRICS[def.source.metric].label;
  const { match, aggregate } = def.source;
  const subject = match.includes('*') ? match.replace(/_?\*$/, '').replace(/\*/g, '') || 'All' : lastSegment(match);
  const prefix = matchesSeveral(match) && aggregate !== 'mean' ? `${aggregate[0].toUpperCase()}${aggregate.slice(1)} ` : '';
  return `${prefix}${subject} ${metric.charAt(0).toLowerCase()}${metric.slice(1)}`.trim();
}

/** Unit a def shows by default: the metric's; a tracked value keeps its own unit, per hour adds `/h`. */
export function defaultUnit(source: KpiDef['source'], valueUnit?: string): string | undefined {
  if (isTrackedSource(source)) return source.kind === 'counter' && source.perHour ? `${valueUnit ?? ''}/h` : valueUnit;
  return METRICS[source.metric].unit;
}

// Sources the next DES runs of a model track (set by the panel / commands, read by the run lifecycle).
const tracked = new Map<string, readonly string[]>();
export function setTrackedKpiSources(model: string, keys: readonly string[]): void { tracked.set(model, [...keys]); }
/** Undefined when the model's Base manifest has not been read in this session yet. */
export function trackedKpiSources(model: string): readonly string[] | undefined { return tracked.get(model); }

// ─── Property KPI candidates ("+ Add KPI" picker) ──────────────────────────

/** Components that describe the scene (layout, identity, references) and never measure material flow. */
export const KPI_METADATA_COMPONENTS: ReadonlySet<string> = new Set([
  'LayoutObject', 'Path', 'PathBlock', 'Generated', 'AssetReference', 'AssetOverrides', 'NodeId', 'Group',
  'BakeRole', 'SnapPoints', 'WebSensor',
]);

/** Identity / bookkeeping fields (`version`, `id`, `…Id`) are numbers without meaning as a KPI. */
export function isKpiMetadataField(field: string): boolean {
  return /^(version|id)$/i.test(field) || /Id$/.test(field);
}

export interface KpiPropertyCandidate { address: string; path: string; component: string; field: string; value: number | boolean | null; unit?: string }

/**
 * The property options a KPI can be defined on: numeric fields of the material-flow components in
 * the model, plus the runtime counters the DES runner reports (TotalProcessed, numeric `prop` entries).
 * When the runner reports its instances, only fields of those instances (address + component) count;
 * without a running DES model `isFlowType` (the registered material-flow types) decides.
 */
export function kpiPropertyOptions(
  fields: readonly KpiPropertyCandidate[],
  runtime: readonly KpiPropertyCandidate[],
  isFlowType: (component: string) => boolean,
): KpiPropertyCandidate[] {
  const instances = new Set(runtime.map(r => `${r.address}|${r.component}`));
  const isInstance = (p: KpiPropertyCandidate) => instances.size > 0
    ? instances.has(`${p.address}|${p.component}`) : isFlowType(p.component);
  const keep = (p: KpiPropertyCandidate) => !KPI_METADATA_COMPONENTS.has(p.component) && !isKpiMetadataField(p.field);
  const out = fields.filter(p => typeof p.value === 'number' && keep(p) && isInstance(p));
  const seen = new Set(out.map(p => `${p.address}|${p.component}|${p.field}`));
  for (const r of runtime) {
    const key = `${r.address}|${r.component}|${r.field}`;
    if (typeof r.value === 'number' && keep(r) && !seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
