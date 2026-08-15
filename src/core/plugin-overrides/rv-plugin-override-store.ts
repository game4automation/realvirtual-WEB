// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Persistence for user plugin overrides (plan-435 Phase 3).
 *
 * Which plugins the user switched OFF in the feature matrix, scoped per
 * project (falling back to the model) so one project's diagnosis does not
 * silently cripple another. Follows the prefix pattern already used by
 * `rv-doc-alias.ts` and `rv-scene-owner.ts`: one prefix constant, a versioned
 * JSON record, every storage access in `try/catch`, enumerable by prefix.
 *
 * SAFETY: only plugins with `core !== true` and outside the protected set are
 * ever written or applied — a persisted override must never be able to make
 * the viewer unusable across a reload. `?resetPlugins=1` is the escape hatch
 * for the case where it happens anyway.
 */

/** localStorage key prefix — also listed in `RV_DYNAMIC_PREFIXES`. */
export const LS_KEY_PLUGIN_OVERRIDES_PREFIX = 'rv-plugin-overrides/';

/** Persisted shape. `v` guards against a future format change. */
interface PluginOverrideRecord {
  v: 1;
  /** Plugin IDs the user switched off. Never contains `core: true` plugins. */
  disabled: string[];
}

/**
 * Plugins that must stay switchable-on no matter what the storage says.
 *
 * The authoritative list lives in the PRIVATE feature-matrix guards, which the
 * public core must not import. That module registers itself here on load; in a
 * public build (no feature matrix, hence no way to toggle anything) the set
 * simply stays empty.
 */
const _protectedIds = new Set<string>();

/** Register plugin IDs that may never be persisted or applied as disabled. */
export function registerProtectedPluginIds(ids: Iterable<string>): void {
  for (const id of ids) _protectedIds.add(id);
}

/** Is this plugin ID protected from user overrides? */
export function isPluginOverrideProtected(id: string): boolean {
  return _protectedIds.has(id);
}

/**
 * Storage scope for the overrides: the active project, else the model, else
 * `null` — and `null` means "do not persist at all" rather than a shared
 * bucket that would leak one model's overrides into every other.
 */
export function overrideScopeKey(
  projectId: string | null,
  modelKey: string | null,
): string | null {
  const scope = projectId ?? modelKey;
  if (scope === null) return null;
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function storageKey(scope: string): string {
  return `${LS_KEY_PLUGIN_OVERRIDES_PREFIX}${scope}`;
}

/**
 * Read the disabled IDs for a scope. Any problem — storage unavailable,
 * malformed JSON, wrong version, wrong shape — yields an empty list rather
 * than a throw: a broken record must not stop the viewer from booting.
 */
export function loadOverrides(scope: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PluginOverrideRecord> | null;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.disabled)) return [];
    return parsed.disabled.filter(
      (id): id is string => typeof id === 'string' && id.length > 0 && !isPluginOverrideProtected(id),
    );
  } catch {
    return [];
  }
}

/**
 * Persist the disabled IDs for a scope. Protected IDs are stripped, and an
 * empty list removes the entry instead of leaving `{"v":1,"disabled":[]}`
 * behind. Callers are responsible for keeping `core: true` plugins out — only
 * the viewer knows the `core` flag.
 */
export function saveOverrides(scope: string, ids: readonly string[]): void {
  const disabled = ids.filter((id) => !isPluginOverrideProtected(id));
  try {
    if (disabled.length === 0) {
      localStorage.removeItem(storageKey(scope));
      return;
    }
    const record: PluginOverrideRecord = { v: 1, disabled };
    localStorage.setItem(storageKey(scope), JSON.stringify(record));
  } catch {
    // Private mode or quota: the session keeps its in-memory overrides.
  }
}

/** Drop the stored overrides for a scope (RESET button, `?resetPlugins=1`). */
export function clearOverrides(scope: string): void {
  try {
    localStorage.removeItem(storageKey(scope));
  } catch {
    // Nothing persisted, nothing to clear.
  }
}

/**
 * The `?resetPlugins=1` escape hatch: wipe EVERY scope's overrides before any
 * of them is read. Deliberately not scope-limited — someone reaching for this
 * has already lost access to the UI that would tell them which scope is at
 * fault.
 */
export function clearAllOverrides(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_KEY_PLUGIN_OVERRIDES_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage unavailable — nothing was persisted either.
  }
}
