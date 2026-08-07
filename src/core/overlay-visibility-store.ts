// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * overlay-visibility-store.ts — central registry for 3D-overlay category
 * visibility in the WebViewer.
 *
 * The viewer draws many independent overlays over/inside the 3D scene:
 * tooltips, gizmos, status/alarm badges, signal chips, highlights and markers.
 * This store is the single source of truth for which overlay CATEGORIES the
 * user has switched off, plus which categories currently have live producers
 * ("present"). The "Overlays" section of the Display panel reads it; producers
 * across three mechanisms react to it:
 *   1. GizmoOverlayManager (tags each handle with a category)
 *   2. own-geometry plugins (drive-axis, highlight, outline, source-marker, …)
 *   3. React DOM overlays (tooltip layer, status panels, signal chips)
 *
 * Design (plan-250):
 * - VANILLA module (NO react import) so engine code (rv-gizmo-manager) can
 *   import it without pulling react into the engine chunk. The react binding
 *   lives separately in `src/hooks/use-overlay-visible.ts`. This mirrors the
 *   `rv-error-store.ts` layering convention.
 * - Two state axes: `hidden` (user prefs, persisted to localStorage) and
 *   `present` (runtime refcount, NOT persisted). BOTH must trigger a rerender,
 *   so the snapshot carries a `version` counter that bumps on every mutation —
 *   otherwise a pure present-change would leave the `state` reference unchanged
 *   and `useSyncExternalStore` would skip the update.
 * - `getOverlaySnapshot()` returns a STABLE reference until the next mutation
 *   (never a freshly-built object per call), so useSyncExternalStore does not
 *   loop. Unknown persisted category ids default to visible (forward-compat).
 */

/** The overlay categories, in panel display order. */
export type OverlayCategory =
  | 'tooltips'    // 3D tooltip system (Drive/MU/Pipe/Tank/Sensor)
  | 'gizmos'      // drive-axis (rotation ring), drive-gizmo tint, IK path
  | 'status'      // error/safety-door badges, sensor states, status panels
  | 'signals'     // 3D signal dots + DOM signal chips
  | 'highlights'  // hover/selection highlight, outline
  | 'markers'     // source markers, snap markers
  | 'connections'; // typed-connection cables (plan-259 link-line gizmos)

export interface OverlayCategoryMeta {
  id: OverlayCategory;
  label: string;
}

/** Fixed catalog — order = display order in the panel. */
export const OVERLAY_CATEGORIES: readonly OverlayCategoryMeta[] = [
  { id: 'tooltips', label: 'Tooltips' },
  { id: 'gizmos', label: 'Gizmos' },
  { id: 'status', label: 'Status & Alarms' },
  { id: 'signals', label: 'Signal chips' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'markers', label: 'Markers' },
  { id: 'connections', label: 'Connections' },
];

const VALID_IDS = new Set<OverlayCategory>(OVERLAY_CATEGORIES.map((c) => c.id));

export interface OverlayVisibilityState {
  /** Categories the user has hidden. Persisted. Unknown/new categories are
   *  absent → default visible (forward-compatible). */
  hidden: ReadonlySet<OverlayCategory>;
  /** Present categories (refcount > 0), in catalog order. NOT persisted. */
  present: readonly OverlayCategoryMeta[];
  /** Bumped on EVERY mutation so getSnapshot yields a new reference whenever
   *  anything changed (hidden OR present). */
  version: number;
}

const STORAGE_KEY = 'rv-overlay-visibility';

// ─── Internal mutable state ────────────────────────────────────────────

/**
 * Parse a persisted store blob into the set of hidden category ids. Pure &
 * exported for tests (the module-level singleton makes the load path otherwise
 * hard to exercise). Unknown/new ids are dropped so a newer catalog never
 * breaks an older saved set (forward-compat: unknown = default visible).
 */
export function parseStoredHidden(raw: string | null): OverlayCategory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { hidden?: unknown };
    if (!Array.isArray(parsed.hidden)) return [];
    return parsed.hidden.filter((id): id is OverlayCategory =>
      typeof id === 'string' && VALID_IDS.has(id as OverlayCategory));
  } catch {
    return [];
  }
}

const hidden = new Set<OverlayCategory>(loadHidden());
/** category → number of live producers. */
const refcount = new Map<OverlayCategory, number>();
let version = 0;
let snapshot: OverlayVisibilityState = buildSnapshot();
const listeners = new Set<() => void>();

function loadHidden(): OverlayCategory[] {
  try {
    return parseStoredHidden(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ hidden: [...hidden] }));
  } catch {
    /* ignore quota / unavailable */
  }
}

function buildSnapshot(): OverlayVisibilityState {
  return {
    hidden: new Set(hidden),
    present: OVERLAY_CATEGORIES.filter((c) => (refcount.get(c.id) ?? 0) > 0),
    version,
  };
}

/** Rebuild the cached snapshot exactly once per mutation and notify. */
function commit(): void {
  version++;
  snapshot = buildSnapshot();
  for (const cb of listeners) cb();
}

// ─── Non-React reads (engine / plugins) ────────────────────────────────

/** True when the category is currently visible (not user-hidden). */
export function isOverlayVisible(cat: OverlayCategory): boolean {
  return !hidden.has(cat);
}

/** The set of user-hidden categories (stable ref until the next change). */
export function getHiddenOverlays(): ReadonlySet<OverlayCategory> {
  return snapshot.hidden;
}

// ─── Mutation (UI) ─────────────────────────────────────────────────────

/** Show/hide a category (persisted). No-op when already in the wanted state. */
export function setOverlayVisible(cat: OverlayCategory, visible: boolean): void {
  const isHidden = hidden.has(cat);
  if (visible && !isHidden) return;
  if (!visible && isHidden) return;
  if (visible) hidden.delete(cat);
  else hidden.add(cat);
  persist();
  commit();
}

/** Show every category (clears the hidden set). No-op when nothing is hidden. */
export function showAllOverlays(): void {
  if (hidden.size === 0) return;
  hidden.clear();
  persist();
  commit();
}

// ─── Presence refcount (producers) ─────────────────────────────────────

/** A producer of `cat` appeared in the scene (++refcount). */
export function registerOverlayProducer(cat: OverlayCategory): void {
  const prev = refcount.get(cat) ?? 0;
  refcount.set(cat, prev + 1);
  if (prev === 0) commit(); // presence changed 0 → 1
}

/** A producer of `cat` left the scene (--refcount, clamped at 0). */
export function unregisterOverlayProducer(cat: OverlayCategory): void {
  const prev = refcount.get(cat) ?? 0;
  if (prev <= 0) return;
  const next = prev - 1;
  refcount.set(cat, next);
  if (next === 0) commit(); // presence changed 1 → 0
}

/** Reset all producer refcounts to 0 (safety net; tests). Does NOT touch the
 *  persisted `hidden` set (user preference survives). */
export function resetOverlayProducers(): void {
  if (refcount.size === 0) return;
  refcount.clear();
  commit();
}

// ─── Snapshot + subscription (framework-neutral) ───────────────────────

/** Current snapshot — stable reference until the next mutation. Safe as the
 *  `getSnapshot` for useSyncExternalStore. */
export function getOverlaySnapshot(): OverlayVisibilityState {
  return snapshot;
}

/** Subscribe to any change. Returns an unsubscribe function. Used by both the
 *  engine (GizmoOverlayManager, plugins) and the React hook. */
export function subscribeOverlayVisibility(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
