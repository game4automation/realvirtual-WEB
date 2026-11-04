// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-stat-colors.ts -- single source of truth for the DES utilization-state
 * stack (order + colors), shared by the stats chart and the in-scene badges so
 * the two never drift apart.
 *
 * Stacking order (Working first). Colors: Working green, Charging violet,
 * Transport cyan, Slowed orange, Setup BLUE, Blocked YELLOW, Stopped red, Empty
 * grey, Failure dark red. Slowed / Stopped are vehicle states (plan-558),
 * Charging a vehicle service state (plan-612, `AgvTask.serviceState`).
 */

export interface DesStateStackEntry {
  /** Key on DESComponent.getStatistics() (e.g. 'workingPercent'). */
  key: 'workingPercent' | 'chargingPercent' | 'transportPercent' | 'slowedPercent' | 'setupPercent'
    | 'blockedPercent' | 'stoppedPercent' | 'emptyPercent' | 'failurePercent';
  /** Legend label. */
  label: string;
  /** Segment color. */
  color: string;
}

/** Color of the `Charging` state (plan-612) — the one place it is spelled out. */
export const DES_CHARGING_COLOR = '#d500f9';

// Strong, saturated colors (shared 1:1 by the chart and the in-scene badges).
export const DES_STATE_STACK: ReadonlyArray<DesStateStackEntry> = [
  { key: 'workingPercent', label: 'Working', color: '#00c853' }, // vivid green
  { key: 'chargingPercent', label: 'Charging', color: DES_CHARGING_COLOR }, // violet — vehicles charging (plan-612)
  { key: 'transportPercent', label: 'Transport', color: '#00b8d4' }, // cyan — vehicles driving between stops
  { key: 'slowedPercent', label: 'Slowed', color: '#ff9100' },   // orange — vehicles slowed by traffic (plan-558)
  { key: 'setupPercent', label: 'Setup', color: '#2979ff' },     // vivid blue
  { key: 'blockedPercent', label: 'Blocked', color: '#ffab00' }, // vivid amber/yellow
  { key: 'stoppedPercent', label: 'Stopped', color: '#ff1744' }, // red — vehicles stopped by traffic (plan-558)
  { key: 'emptyPercent', label: 'Empty', color: '#90a4ae' },     // neutral grey (idle)
  { key: 'failurePercent', label: 'Failure', color: '#f44336' }, // strong red
];

/** Tooltip/state color of a state name: the stack, then the registered states (plan-644). */
export function desStateColor(name: string): string | undefined {
  return DES_STATE_STACK.find((s) => s.label === name)?.color
    ?? _registered.find((s) => s.name === name)?.color;
}

// ── DES-HMI extension point (plan-644 D8) ─────────────────────────────────
//
// A project adds a DES state (badge bar, tooltip, chart) or a KPI row (badge,
// tooltip; `registerDesKpiRowProvider` in des-stats-gizmos.ts) WITHOUT editing
// these shared files. Both registries share ONE version counter: React views
// re-render through `useSyncExternalStore(subscribeDesHmiExtensions,
// desHmiExtensionsVersion)`, the imperative canvas badges subscribe as plain
// listeners and refresh.

/** A registered DES state: `name` is what `DESComponent.setState()` books. */
export interface DesStateSpec {
  readonly name: string;
  readonly color: string;
  /** Legend / tooltip label. Default: `name`. */
  readonly label?: string;
}

const _registered: DesStateSpec[] = [];
let _extVersion = 0;
const _extListeners = new Set<() => void>();
let _namesCache: { version: number; names: readonly string[] } | null = null;
const _warned = new Set<string>();

/** Current version of the DES-HMI extension registries (raised on every change). */
export function desHmiExtensionsVersion(): number {
  return _extVersion;
}

/** Subscribe to registry changes (states and KPI rows). Returns the unsubscribe. */
export function subscribeDesHmiExtensions(cb: () => void): () => void {
  _extListeners.add(cb);
  return () => { _extListeners.delete(cb); };
}

/** @internal Raise the shared version and notify (also used by the KPI-row registry). */
export function notifyDesHmiExtensionsChanged(): void {
  _extVersion++;
  for (const cb of [..._extListeners]) {
    try { cb(); } catch (e) { console.error('[des-hmi] extension listener failed:', e); }
  }
}

/** @internal One DEV warning per duplicate key (registries are first-wins). */
export function warnDesHmiDuplicate(kind: string, key: string): void {
  if (!import.meta.env.DEV) return;
  const k = `${kind}:${key}`;
  if (_warned.has(k)) return;
  _warned.add(k);
  console.warn(`[des-hmi] ${kind} '${key}' is already registered — the first registration wins.`);
}

/**
 * Register an extra DES state (plan-644 D8). It appears after the stack in
 * `desStateNames()`, in the badge bar, the tooltip and the chart, in `color`.
 * A name that is already known (stack or registered) keeps its FIRST owner: a
 * DEV warning, and the returned function is a no-op. Returns the unregister.
 */
export function registerDesState(spec: DesStateSpec): () => void {
  const known = DES_STATE_STACK.some((s) => s.label === spec.name) || _registered.some((s) => s.name === spec.name);
  if (known) {
    warnDesHmiDuplicate('DES state', spec.name);
    return () => {};
  }
  const entry: DesStateSpec = { ...spec };
  _registered.push(entry);
  notifyDesHmiExtensionsChanged();
  return () => {
    const i = _registered.indexOf(entry);
    if (i < 0) return;
    _registered.splice(i, 1);
    notifyDesHmiExtensionsChanged();
  };
}

/** The registered (non-stack) states, in registration order. */
export function registeredDesStates(): readonly DesStateSpec[] {
  return _registered;
}

/** Every DES state name: the stack (in stack order), then the registered states.
 *  Stable reference until the registry changes. */
export function desStateNames(): readonly string[] {
  if (!_namesCache || _namesCache.version !== _extVersion) {
    _namesCache = {
      version: _extVersion,
      names: Object.freeze([...DES_STATE_STACK.map((s) => s.label), ..._registered.map((s) => s.name)]),
    };
  }
  return _namesCache.names;
}

/** Legend / tooltip label of a state name (registered `label`, else the name). */
export function desStateLabel(name: string): string {
  return _registered.find((s) => s.name === name)?.label ?? name;
}

/** What `desStatePercent` needs of a component (a `DESComponent`, or a structural HMI source entry). */
export interface DesStatePercentSource {
  getStatePercent?(state: string): number;
  getStatistics(): { states?: Record<string, { percent: number }> };
}

/**
 * Share (0…100 %) of `state` for `comp`. A `DESComponent` answers through its
 * allocation-free `getStatePercent` (the `getStatistics()` formula); a
 * structural source without it (e.g. a project's fake HMI source) through its
 * `getStatistics().states`. Unknown or never booked → 0, never `undefined`.
 */
export function desStatePercent(comp: DesStatePercentSource, state: string): number {
  const v = typeof comp.getStatePercent === 'function'
    ? comp.getStatePercent(state)
    : comp.getStatistics().states?.[state]?.percent;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * `node.userData[DES_SOC_USERDATA_KEY]` — the state of charge (0..100 %) of a
 * battery vehicle, written by the project that models the battery (plan-612
 * PalletYard). The DES tooltip shows a `SOC` row only when it is a number.
 */
export const DES_SOC_USERDATA_KEY = '_rvStateOfCharge';

/** State of charge (%) the project wrote on the component's node, else null (tooltip + in-scene badge). */
export function socOf(node: { userData?: Record<string, unknown> } | null | undefined): number | null {
  const v = node?.userData?.[DES_SOC_USERDATA_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
