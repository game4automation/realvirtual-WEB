// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * ls-store-utils.ts — Tiny helpers for the recurring "load/save settings JSON
 * to localStorage" pattern used by 6+ stores in the WebViewer.
 *
 * Each settings store typically wants:
 *   1. Read DEFAULTS
 *   2. Merge JSON from localStorage on top (per-field, ignore corrupted entries)
 *   3. Optionally merge `appConfig.<namespace>` overrides on top
 *   4. Guard `save` with `isSettingsLocked()` so locked deployments cannot
 *      mutate persisted state
 *   5. Silently swallow quota / SecurityError on write
 *
 * `lsLoad` and `lsSave` encapsulate items 1, 2, 4, and 5 while leaving store-
 * specific validation, migration, and the config-override merge as opt-in
 * callbacks so each store keeps its existing defensive behavior.
 *
 * Stores that have fundamentally different shapes (map-keyed entries, scalar
 * booleans, per-key dynamic prefixes, REST-backed pub/sub) should NOT use this
 * helper — they have their own legitimate guards that don't fit here.
 */

import { isSettingsLocked } from '../rv-app-config';

/** Options accepted by {@link lsLoad}. */
export interface LsLoadOptions<T> {
  /**
   * Field-level validator. Receives the per-field merge of `defaults` and the
   * parsed JSON (`{ ...defaults, ...parsed }`) and returns the cleaned partial.
   * Use this when individual fields need type guards beyond the basic
   * "spread parsed on top of defaults" pattern.
   *
   * Example: `search-settings-store` requires `Array.isArray(disabledTypes)`
   * before accepting the field.
   */
  validate?: (merged: T, parsed: Partial<T>) => Partial<T>;

  /**
   * Pre-validation migration hook. Receives the raw `JSON.parse` result and
   * returns a partial that subsequent merging will apply. Use this when older
   * formats (e.g. boolean flags now replaced by string enums) must be coerced.
   *
   * Example: `visual-settings-store.migrateToneMapping()` accepts legacy
   * booleans in addition to the new string enum.
   */
  migrate?: (raw: unknown) => Partial<T>;

  /**
   * Optional appConfig override merged on top of the localStorage layer.
   * Pass the `getAppConfig().<namespace>` slice as `configOverride`; only
   * defined (`!== undefined`) keys win over the localStorage value.
   *
   * This implements the documented 3-layer merge:
   *   DEFAULTS  ->  localStorage  ->  appConfig
   */
  configOverride?: Partial<T> | undefined;
}

/**
 * Load a JSON object from localStorage with defaults, optional migration, and
 * optional appConfig override.
 *
 * Returns a defensive clone (the spread operator) so callers cannot mutate
 * the same object reference between successive `lsLoad` calls.
 *
 * Never throws — corrupted entries fall back to `defaults`.
 */
export function lsLoad<T extends object>(
  key: string,
  defaults: T,
  options?: LsLoadOptions<T>,
): T {
  let parsed: Partial<T> = {};
  try {
    const raw = readLocalStorage(key);
    if (raw) {
      const json = JSON.parse(raw) as unknown;
      if (options?.migrate) {
        parsed = options.migrate(json);
      } else if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Partial<T>;
      }
    }
  } catch {
    parsed = {};
  }

  // Layer 1+2: defaults + parsed (parsed overrides per-key).
  const merged: T = { ...defaults, ...parsed };

  // Optional field-level cleanup.
  const validated = options?.validate ? options.validate(merged, parsed) : null;
  const afterValidate: T = validated ? { ...merged, ...validated } : merged;

  // Layer 3: optional appConfig override.
  const override = options?.configOverride;
  if (override) {
    return applyOverride(afterValidate, override);
  }
  return afterValidate;
}

/**
 * Save a JSON object to localStorage. Respects {@link isSettingsLocked} so
 * locked deployments cannot mutate persisted state. Silently swallows
 * quota / SecurityError on write.
 */
export function lsSave<T>(key: string, value: T): void {
  if (isSettingsLocked()) return;
  try {
    writeLocalStorage(key, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — silently ignore */
  }
}

/**
 * Per-key merge of `override` over `base` — only keys whose override value is
 * `!== undefined` win. Mirrors the `override.x ?? fromStorage.x` pattern the
 * existing stores already use for the appConfig layer.
 */
function applyOverride<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base } as { [K in keyof T]: T[K] };
  for (const k of Object.keys(override) as (keyof T)[]) {
    const v = override[k];
    if (v !== undefined) {
      result[k] = v as T[typeof k];
    }
  }
  return result;
}
