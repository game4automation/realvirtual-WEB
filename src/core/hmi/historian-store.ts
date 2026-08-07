// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** State and authenticated CONNECT REST access for historian trend data. */

import { createStore } from './create-store';
import { connectRestJson } from './connect-rest';
import { getConnectSnapshot } from './connect-store';
import { lsLoad, lsSave } from './ls-store-utils';

export const HISTORIAN_STORAGE_KEY = 'historian';
export const HISTORIAN_TIMEOUT_MS = 30_000;

export type HistorianTimeRange = '1h' | '6h' | '24h' | '7d' | 'custom';

export interface HistorianSeries {
  signal: string;
  ts: number[];
  values: number[];
}

export interface HistorianSignal {
  name: string;
  active: boolean;
}

export interface HistorianStatus {
  enabled: boolean;
  connected: boolean;
  bucket: string | null;
  lastWriteUtc: string | null;
  droppedPoints: number;
  authError: boolean;
  disabledReason: string | null;
}

export interface HistorianSnapshot {
  url: string;
  /** Whether the floating trend panel is open — shared so any surface (toolbar
   *  button, ConnectPanel REC dot) can open the panel with a signal preselected. */
  panelOpen: boolean;
  /** Rolling live refresh of relative ranges (persisted — off stays off). */
  follow: boolean;
  /** Chart layout: shared axis (overlay) or one lane per signal (stacked). */
  layout: 'overlay' | 'stacked';
  selectedSignals: string[];
  timeRange: HistorianTimeRange;
  signals: HistorianSignal[];
  results: Map<string, HistorianSeries>;
  /** Expand-only per-signal value bounds for the stacked-lane normalization.
   *  Session-scoped (not persisted): keeps lanes visually stable across
   *  live-follow refreshes instead of re-normalizing to each window's min/max. */
  laneBounds: Record<string, { min: number; max: number }>;
  status: HistorianStatus | null;
  loading: boolean;
  /** QUERY errors only (shown as the panel alert). Status-heartbeat failures
   *  live in `status` — they must never flash the query alert every poll. */
  error: string | null;
  lastFrom: string | null;
  lastTo: string | null;
}

/** Persisted view state — reopening the panel restores the last chart (signals +
 *  relative range) and auto-loads it. Custom ranges are one-offs and not persisted. */
interface HistorianSettings {
  url: string;
  selectedSignals?: string[];
  timeRange?: HistorianTimeRange;
  follow?: boolean;
  layout?: 'overlay' | 'stacked';
  panelOpen?: boolean;
}

const DISCONNECTED_STATUS: HistorianStatus = {
  enabled: false,
  connected: false,
  bucket: null,
  lastWriteUtc: null,
  droppedPoints: 0,
  authError: false,
  disabledReason: 'CONNECT is not connected.',
};

function defaultHistorianUrl(): string {
  return `${getConnectSnapshot().serverUrl.replace(/\/$/, '')}/history`;
}

function loadHistorianSettings(): HistorianSettings {
  return lsLoad<HistorianSettings>(HISTORIAN_STORAGE_KEY, { url: defaultHistorianUrl() });
}

function loadHistorianUrl(): string {
  return loadHistorianSettings().url;
}

/** Persist the current view (url + selection + relative range) as one settings blob. */
function persistView(): void {
  const current = _store.getSnapshot();
  lsSave<HistorianSettings>(HISTORIAN_STORAGE_KEY, {
    url: current.url,
    selectedSignals: current.selectedSignals,
    timeRange: current.timeRange === 'custom' ? undefined : current.timeRange,
    follow: current.follow,
    layout: current.layout,
    panelOpen: current.panelOpen,
  });
}

function hasStoredHistorianUrl(): boolean {
  try { return localStorage.getItem(HISTORIAN_STORAGE_KEY) !== null; } catch { return false; }
}

function initialSnapshot(): HistorianSnapshot {
  const settings = loadHistorianSettings();
  return {
    url: settings.url,
    // The panel survives a reload: an operator's trend view comes back exactly
    // as they left it (window open, last signals, live follow).
    panelOpen: settings.panelOpen === true,
    follow: settings.follow !== false,
    layout: settings.layout === 'stacked' ? 'stacked' : 'overlay',
    selectedSignals: Array.isArray(settings.selectedSignals) ? settings.selectedSignals.filter((s) => typeof s === 'string') : [],
    timeRange: settings.timeRange && settings.timeRange !== 'custom' ? settings.timeRange : '1h',
    signals: [],
    results: new Map(),
    laneBounds: {},
    status: null,
    loading: false,
    error: null,
    lastFrom: null,
    lastTo: null,
  };
}

const _store = createStore<HistorianSnapshot>(initialSnapshot());

// Query sequencing: only the latest STARTED query may write results/errors —
// otherwise a slow, superseded response overwrites fresher data (last-resolved-wins bug).
let _querySeq = 0;
let _activeQueryController: AbortController | null = null;

/** Loop-based bounds — Math.min(...values) overflows the arg limit at ~65k points. */
function valueBounds(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function requestBaseUrl(): string {
  const url = hasStoredHistorianUrl() ? _store.getSnapshot().url : defaultHistorianUrl();
  if (url !== _store.getSnapshot().url) _store.set({ url });
  return url.replace(/\/$/, '');
}

function parseSeries(value: unknown): HistorianSeries[] {
  if (!Array.isArray(value)) throw new Error('Historian returned an invalid query response.');
  return value.flatMap((item): HistorianSeries[] => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { signal?: unknown; ts?: unknown; values?: unknown };
    if (typeof row.signal !== 'string' || !Array.isArray(row.ts) || !Array.isArray(row.values)) return [];
    const count = Math.min(row.ts.length, row.values.length);
    const ts: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const timestamp = Number(row.ts[i]);
      const point = Number(row.values[i]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(point)) continue;
      ts.push(timestamp);
      values.push(point);
    }
    return [{ signal: row.signal, ts, values }];
  });
}

function toIso(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Historian time range is invalid.');
  return date.toISOString();
}

export const historianStore = {
  subscribe: _store.subscribe,
  getSnapshot: _store.getSnapshot,

  setUrl(url: string): void {
    const normalized = url.trim().replace(/\/$/, '') || defaultHistorianUrl();
    _store.set({ url: normalized });
    persistView();
  },

  setSelectedSignals(selectedSignals: string[]): void {
    const selected = [...new Set(selectedSignals)];
    _store.set((prev) => ({
      ...prev,
      selectedSignals: selected,
      // Deselected signals drop their sticky lane bounds — a re-added signal
      // starts a fresh calibration instead of inheriting stale extremes.
      laneBounds: Object.fromEntries(Object.entries(prev.laneBounds).filter(([name]) => selected.includes(name))),
    }));
    persistView();
  },

  setPanelOpen(panelOpen: boolean): void {
    _store.set({ panelOpen });
    persistView();
  },

  /** Open the trend panel, optionally adding a signal to the selection first
   *  (the ConnectPanel REC-dot shortcut: one click from a recorded signal to its history). */
  openPanel(signal?: string): void {
    if (signal && signal.trim().length > 0) {
      const prev = _store.getSnapshot().selectedSignals;
      _store.set({ selectedSignals: [...new Set([...prev, signal.trim()])] });
      persistView();
    }
    _store.set({ panelOpen: true });
    persistView();
  },

  setTimeRange(timeRange: HistorianTimeRange): void {
    _store.set({ timeRange });
    persistView();
  },

  setFollow(follow: boolean): void {
    _store.set({ follow });
    persistView();
  },

  setLayout(layout: 'overlay' | 'stacked'): void {
    _store.set({ layout });
    persistView();
  },

  markConnectUnavailable(): void {
    _store.set({ status: DISCONNECTED_STATUS, signals: [], loading: false });
  },

  async refreshStatus(): Promise<HistorianStatus> {
    if (getConnectSnapshot().state !== 'connected' || getConnectSnapshot().gatewayUnreachable) {
      this.markConnectUnavailable();
      return DISCONNECTED_STATUS;
    }
    try {
      const status = await connectRestJson<HistorianStatus>(`${requestBaseUrl()}/status`);
      _store.set({ status });
      return status;
    } catch (error) {
      // Heartbeat failures speak through the status chip ONLY — writing the
      // query `error` here made the alert bar flash on every 10s poll.
      const message = error instanceof Error ? error.message : String(error);
      const status = { ...DISCONNECTED_STATUS, enabled: true, disabledReason: message };
      _store.set({ status });
      return status;
    }
  },

  async refreshSignals(): Promise<HistorianSignal[]> {
    try {
      const signals = await connectRestJson<HistorianSignal[]>(`${requestBaseUrl()}/signals`);
      const clean = Array.isArray(signals)
        ? signals.filter((signal) => signal && typeof signal.name === 'string')
          .map((signal) => ({ name: signal.name, active: signal.active === true }))
        : [];
      _store.set((prev) => ({
        ...prev,
        signals: clean,
        selectedSignals: prev.selectedSignals.filter((name) => clean.some((signal) => signal.name === name)),
      }));
      persistView();   // the filter above touches a persisted field
      return clean;
    } catch {
      // Discovery failure is a status concern, not a query error.
      return [];
    }
  },

  async queryHistory(
    signals: string[],
    from: Date | number | string,
    to: Date | number | string,
  ): Promise<HistorianSeries[]> {
    const selected = [...new Set(signals.filter(Boolean))];
    const fromIso = toIso(from);
    const toIsoValue = toIso(to);
    // Sequencing: this call supersedes any in-flight query — abort it and make
    // sure ONLY the newest sequence number may write store state afterwards.
    const seq = ++_querySeq;
    _activeQueryController?.abort();
    const controller = new AbortController();
    _activeQueryController = controller;
    const timeout = window.setTimeout(() => controller.abort(), HISTORIAN_TIMEOUT_MS);
    _store.set({ loading: true, error: null, selectedSignals: selected });

    try {
      const params = new URLSearchParams({ from: fromIso, to: toIsoValue });
      for (const signal of selected) params.append('signal', signal);
      const raw = await connectRestJson<unknown>(`${requestBaseUrl()}/query?${params.toString()}`, {
        signal: controller.signal,
      });
      const series = parseSeries(raw);
      if (seq !== _querySeq) return series;   // superseded — a newer query owns the store
      _store.set((prev) => {
        // Sticky lane bounds: expand-only per signal, so stacked lanes stay
        // visually stable across live-follow refreshes (no phantom movement).
        const laneBounds = { ...prev.laneBounds };
        for (const entry of series) {
          const bounds = valueBounds(entry.values);
          if (!bounds) continue;
          const existing = laneBounds[entry.signal];
          laneBounds[entry.signal] = existing
            ? { min: Math.min(existing.min, bounds.min), max: Math.max(existing.max, bounds.max) }
            : bounds;
        }
        return {
          ...prev,
          results: new Map(series.map((entry) => [entry.signal, entry])),
          laneBounds,
          loading: false,
          error: null,
          lastFrom: fromIso,
          lastTo: toIsoValue,
        };
      });
      return series;
    } catch (error) {
      if (seq !== _querySeq) return [];       // aborted by a newer query — stay silent
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
      const message = aborted
        ? 'Historian query timed out after 30 seconds.'
        : error instanceof Error ? error.message : String(error);
      _store.set({ loading: false, error: message, results: new Map() });
      return [];
    } finally {
      window.clearTimeout(timeout);
      if (_activeQueryController === controller) _activeQueryController = null;
    }
  },
};

// ── Historian connection settings (CONNECT-side InfluxDb block) ─────────────
//
// The InfluxDB connection lives in CONNECT's config (server-side; the token is
// never exposed — GET /config redacts it to `tokenConfigured`). These helpers do
// the redacted GET → merge → PUT roundtrip for the settings UI. An empty token
// on save keeps the stored one (CONNECT S5 contract).

/** Redacted view of CONNECT's `InfluxDb` config block. */
export interface InfluxDbSettings {
  enabled: boolean;
  url: string;
  org: string;
  project: string;
  tokenConfigured: boolean;
}

function connectConfigUrl(): string {
  return `${getConnectSnapshot().serverUrl.replace(/\/$/, '')}/config`;
}

/** Load the redacted historian connection settings from CONNECT. */
export async function fetchInfluxSettings(): Promise<InfluxDbSettings> {
  const cfg = await connectRestJson<Record<string, unknown>>(connectConfigUrl());
  const influx = (cfg.influxDb ?? {}) as Record<string, unknown>;
  return {
    enabled: influx.enabled === true,
    url: typeof influx.url === 'string' && influx.url ? influx.url : 'http://localhost:8086',
    org: typeof influx.org === 'string' && influx.org ? influx.org : 'realvirtual',
    project: typeof influx.project === 'string' ? influx.project : '',
    tokenConfigured: influx.tokenConfigured === true,
  };
}

/** Persist historian connection settings via CONNECT's config API (merge-PUT). */
export async function saveInfluxSettings(next: {
  enabled: boolean; url: string; org: string; project: string; token: string;
}): Promise<void> {
  const cfg = await connectRestJson<Record<string, unknown>>(connectConfigUrl());
  const influx = (cfg.influxDb ?? {}) as Record<string, unknown>;
  const body = {
    ...cfg,
    influxDb: {
      ...influx,
      enabled: next.enabled,
      url: next.url.trim(),
      org: next.org.trim(),
      // Lowercase per project-name convention (CONNECT validates hard).
      project: next.project.trim().toLowerCase(),
      token: next.token.trim(),
    },
  };
  await connectRestJson(connectConfigUrl(), { method: 'PUT', body: JSON.stringify(body) });
}

/** Reset state and persistence for isolated tests. */
export function __resetHistorianStore(): void {
  try { localStorage.removeItem(HISTORIAN_STORAGE_KEY); } catch { /* ignore */ }
  _store.set(initialSnapshot());
}
