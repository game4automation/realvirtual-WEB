// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-variant-index — the cheap answer to "is this field overridden / varied elsewhere?"
 * (plan-2013, Concept D, open point "cost of the icon states"). Pure, Node-testable, lazy.
 *
 * Concept D puts an icon on EVERY scalar inspector row, and each row has to decide its
 * state while it renders. The variants block lives centrally
 * (`scenes[0].extras.realvirtual.Variants`), so without an index every row would walk every
 * override of every variant. This index is built once per document and pulled forward
 * incrementally: `sync()` re-walks only the variants whose `revision` changed (an override
 * write, an undo/redo, a base edit that committed, a delete) and drops variants that are
 * gone. A rename does not bump the revision and therefore costs nothing here.
 *
 * It owns no values of its own beyond the overrides it mirrors: `infoOf()` is a single Map
 * lookup, so an inspector render is O(rows), never O(rows × overrides). It never triggers a
 * full inspector refresh either — `version` changes only when the mirrored data changed.
 */

import { overrideKey, type FieldKey, type VariantsBlock, type VariantValue } from './rv-variant-model';

/**
 * The three icon states of Concept D:
 *  - `overridden` — the variant IN THE SCENE sets this field (filled icon, row marked)
 *  - `elsewhere`  — the scene inherits Base here, but another variant differs (half icon)
 *  - `none`       — no variant touches this field (pale, empty icon)
 */
export type VariantFieldState = 'none' | 'overridden' | 'elsewhere';

/** What one inspector row needs to know about one field. */
export interface VariantFieldInfo {
  readonly state: VariantFieldState;
  /** Ids of every variant that overrides this field, in block order. */
  readonly variants: readonly string[];
  /** The value the variant in the scene sets here (only for `overridden`). */
  readonly value?: VariantValue;
}

const NONE: VariantFieldInfo = Object.freeze({ state: 'none', variants: Object.freeze([]) as readonly string[] });

/** The empty answer — exported so a caller without an index can still render a row. */
export function noVariantFieldInfo(): VariantFieldInfo { return NONE; }

interface Mirrored { readonly revision: number; readonly keys: readonly string[] }

/** `FieldKey → variants`, maintained incrementally. */
export class VariantFieldIndex {
  /** field key → variant id → value (insertion order follows the block). */
  private readonly _byField = new Map<string, Map<string, VariantValue>>();
  private readonly _mirrored = new Map<string, Mirrored>();
  private _active: string | null = null;
  private _version = 0;

  /** Bumped only when the mirrored data or the variant in the scene changed. */
  get version(): number { return this._version; }
  /** The variant whose overrides read as `overridden`. */
  get activeVariant(): string | null { return this._active; }
  /** How many distinct fields any variant varies. */
  get variedFieldCount(): number { return this._byField.size; }

  /** Drops everything (a document went). */
  clear(): void {
    if (this._byField.size === 0 && this._mirrored.size === 0 && this._active === null) return;
    this._byField.clear();
    this._mirrored.clear();
    this._active = null;
    this._version++;
  }

  /**
   * Pulls the index forward to `block`, with `active` the variant in the scene. Only
   * variants whose revision changed (and variants that appeared or vanished) are re-walked.
   */
  sync(block: VariantsBlock | null, active: string | null): void {
    let changed = false;
    const seen = new Set<string>();
    for (const v of block?.variants ?? []) {
      seen.add(v.id);
      const mirrored = this._mirrored.get(v.id);
      if (mirrored && mirrored.revision === v.revision) continue;
      if (mirrored) this._drop(v.id, mirrored.keys);
      const keys: string[] = [];
      for (const o of v.overrides) {
        const key = overrideKey(o);
        keys.push(key);
        let row = this._byField.get(key);
        if (!row) { row = new Map(); this._byField.set(key, row); }
        row.set(v.id, o.value);
      }
      this._mirrored.set(v.id, { revision: v.revision, keys });
      changed = true;
    }
    for (const [id, mirrored] of [...this._mirrored]) {
      if (seen.has(id)) continue;
      this._drop(id, mirrored.keys);
      this._mirrored.delete(id);
      changed = true;
    }
    if (this._active !== active) { this._active = active; changed = true; }
    if (changed) this._version++;
  }

  /** One field's state — a single Map lookup. */
  infoOf(key: FieldKey | string): VariantFieldInfo {
    const row = this._byField.get(typeof key === 'string' ? key : overrideKey(key));
    if (!row || row.size === 0) return NONE;
    const variants = [...row.keys()];
    if (this._active !== null && row.has(this._active)) {
      return { state: 'overridden', variants, value: row.get(this._active) };
    }
    return { state: 'elsewhere', variants };
  }

  /** The value `variantId` sets for `key`, or undefined when it inherits Base. */
  valueOf(key: FieldKey | string, variantId: string): VariantValue | undefined {
    return this._byField.get(typeof key === 'string' ? key : overrideKey(key))?.get(variantId);
  }

  /** Every field any variant varies (compare table, orphan scan) — block order. */
  variedFields(): readonly string[] { return [...this._byField.keys()]; }

  private _drop(variantId: string, keys: readonly string[]): void {
    for (const key of keys) {
      const row = this._byField.get(key);
      if (!row) continue;
      row.delete(variantId);
      if (row.size === 0) this._byField.delete(key);
    }
  }
}
