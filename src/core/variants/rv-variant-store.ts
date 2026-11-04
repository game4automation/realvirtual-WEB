// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-variant-store — the owner of a document's variants (plan-2013 §2.1, §2.5, §2.6). Lazy.
 *
 * Owns ids, names, revisions, sparse overrides, the variant IN THE SCENE, the base-value
 * cache, the undo/redo stacks and the experiment lock. It never writes component data
 * itself: every change that concerns the scene goes through the injected `apply` (the
 * parameter apply service) with the FULL target state of the variant in the scene, and the
 * store commits only AFTER the apply succeeded (Gate R2 #3) — a failed or refused apply
 * leaves the store exactly as it was.
 *
 * Edits of a variant that is not in the scene only change the store.
 */

import type { ApplyOptions, ApplyResult, BaseValue, FieldKey, FieldOp } from '../params/rv-param-apply';
import { currentRunLease, type RunLease } from '../hmi/rv-run-lease';
import {
  checkVariantName,
  emptyVariantsBlock,
  newVariantId,
  MAX_VARIANT_NAME,
  overrideKey,
  serializeVariantsBlock,
  targetOps,
  type Variant,
  type VariantOverride,
  type VariantsBlock,
  type VariantValue,
  normalizeDescription,
} from './rv-variant-model';

/** Outcome of a store operation. */
export type VariantResult = { ok: true; id?: string } | { ok: false; error: string; detail?: string };

/** What the store needs from outside. */
export interface VariantStoreDeps {
  /** The apply service, bound to its origin. */
  apply(ops: readonly FieldOp[], options?: ApplyOptions): Promise<ApplyResult>;
  /** Current value of a field in the scene; null = node missing. */
  readBase(k: FieldKey): BaseValue | null;
  /** Coexistence with the old planning paths (Gate R2 #5): a reason refuses `activate`. */
  coexistenceBlocker?(): string | null;
  /** Told after the variant in the scene changed (the runtime sets the eager flag). */
  onSceneChanged?(active: string | null): void;
  /** A new undoable variant edit committed successfully. */
  onCommit?(): void;
  /** Address-free admission (set only admissible fields). */
  check?(component: string, field: string, value: VariantValue | null): { ok: true } | { ok: false; detail: string };
  /** Max undo entries (default 100). */
  undoLimit?: number;
}

interface UndoChange { readonly key: FieldKey; readonly prev: VariantValue | undefined; readonly next: VariantValue | undefined }
interface UndoEntry { readonly variantId: string; readonly changes: readonly UndoChange[] }

/** One pending edit of a batch: a value, or `undefined` = back to Base. */
interface Edit { key: FieldKey; next: VariantValue | undefined }

export class VariantStore {
  private _block: VariantsBlock = emptyVariantsBlock();
  private _saved: string = JSON.stringify(serializeVariantsBlock(emptyVariantsBlock()));
  /** The variant whose values are in the scene (null = Base). */
  private _scene: string | null = null;
  private readonly _base = new Map<string, BaseValue>();
  private _undo: UndoEntry[] = [];
  private _redo: UndoEntry[] = [];
  private _locked: string | null = null;
  private _unresolved = new Set<string>();
  private _batch: { variantId: string; edits: Edit[] } | null = null;
  private readonly _listeners = new Set<() => void>();
  private _version = 0;
  /** Async mutations run one after another (an edit never interleaves with an activation). */
  private _chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: VariantStoreDeps) {}

  // ─── Reading ──────────────────────────────────────────────────────────────

  get block(): VariantsBlock { return this._block; }
  get version(): number { return this._version; }
  /** Variant in the scene (null = Base). */
  get sceneVariant(): string | null { return this._scene; }
  get locked(): string | null { return this._locked; }
  /** Unsaved changes against the file. */
  get dirty(): boolean { return JSON.stringify(serializeVariantsBlock(this._block)) !== this._saved; }
  get canUndo(): boolean { return this._undo.length > 0; }
  get canRedo(): boolean { return this._redo.length > 0; }
  variant(id: string): Variant | undefined { return this._block.variants.find((v) => v.id === id); }
  /** Cached base value of a field (undefined = none cached). */
  baseOf(k: FieldKey): BaseValue | undefined { return this._base.get(overrideKey(k)); }
  /** Fields of the scene variant whose node is missing in this configuration. */
  isUnresolved(k: FieldKey): boolean { return this._unresolved.has(overrideKey(k)); }

  subscribe(fn: () => void): () => void { this._listeners.add(fn); return () => { this._listeners.delete(fn); }; }

  // ─── Document ─────────────────────────────────────────────────────────────

  /** A loaded document: its block as saved. Nothing is applied here (the runtime decides). */
  load(block: VariantsBlock | null): void {
    this._block = block ?? emptyVariantsBlock();
    this._saved = JSON.stringify(serializeVariantsBlock(this._block));
    this._scene = null;
    this._base.clear();
    this._undo = [];
    this._redo = [];
    this._unresolved.clear();
    this._publish();
  }

  /** The serialised block as a save would write it now. */
  snapshot(): Record<string, unknown> | null { return serializeVariantsBlock(this._block); }

  /** The file now carries `saved` (the snapshot that was written; default: the current block). */
  markSaved(saved: Record<string, unknown> | null = serializeVariantsBlock(this._block)): void {
    this._saved = JSON.stringify(saved);
    this._publish();
  }

  // ─── Lock ─────────────────────────────────────────────────────────────────

  /** An experiment batch freezes the store (`experiment-running`). */
  lock(reason = 'experiment-running'): void { this._locked = reason; this._publish(); }
  unlock(): void { this._locked = null; this._publish(); }

  // ─── Variants ─────────────────────────────────────────────────────────────

  create(name: string, opts: { from?: string } = {}): VariantResult {
    if (this._locked) return { ok: false, error: this._locked };
    const bad = checkVariantName(name);
    if (bad) return { ok: false, error: 'invalid-name', detail: bad };
    if (this._block.variants.some((v) => v.name === name.trim())) return { ok: false, error: 'name-taken', detail: `'${name.trim()}' exists` };
    const src = opts.from ? this.variant(opts.from) : undefined;
    if (opts.from && !src) return { ok: false, error: 'unknown-variant' };
    const v: Variant = { id: newVariantId(), name: name.trim(), revision: 0, overrides: src ? src.overrides.map((o) => ({ ...o })) : [] };
    this._setBlock({ ...this._block, variants: [...this._block.variants, v] });
    return { ok: true, id: v.id };
  }

  /** Ensures a migration identity exists; override order and display names do not affect identity. */
  createWithId(id: string, name: string, overrides: readonly VariantOverride[] = [], revision = 0): VariantResult {
    const existing = this.variant(id);
    // An identical copy changes nothing, so it is no conflict — also while a batch or a snapshot
    // holds the lock (the recovery copy of a shipped variant equals the variant itself).
    if (existing && existing.overrides.length === overrides.length && existing.overrides.every((o) =>
      overrides.some((other) => overrideKey(o) === overrideKey(other) && o.value === other.value))) return { ok: true, id };
    if (this._locked) return { ok: false, error: 'locked' };
    const invalid = (): VariantResult | null => {
      const keys = new Set<string>();
      for (const o of overrides) {
        if (keys.has(overrideKey(o))) return { ok: false, error: 'conflict' };
        keys.add(overrideKey(o));
        const verdict = this.deps.check?.(o.component, o.field, o.value);
        if (verdict && !verdict.ok) return { ok: false, error: 'invalid', detail: verdict.detail };
      }
      return null;
    };
    if (existing) {
      const same = existing.overrides.length === overrides.length && existing.overrides.every((o) =>
        overrides.some((other) => overrideKey(o) === overrideKey(other) && o.value === other.value));
      if (same) return { ok: true, id };
      // A strictly newer recovery copy (an edit that was never saved into the document) wins over
      // the reloaded authored variant — but never while that variant is in the scene.
      if (revision <= existing.revision || this._scene === id) return { ok: false, error: 'conflict' };
      const bad = invalid();
      if (bad) return bad;
      for (const o of overrides) this._cacheBase(o, false);
      this._replace(id, (v) => ({ ...v, revision, overrides: overrides.map((o) => ({ ...o })) }));
      return { ok: true, id };
    }
    if (!id) return { ok: false, error: 'invalid-id' };
    const bad = checkVariantName(name);
    if (bad) return { ok: false, error: 'invalid-name', detail: bad };
    const badOverride = invalid();
    if (badOverride) return badOverride;
    const stem = name.trim();
    let unique = stem;
    for (let n = 1; this._block.variants.some((v) => v.name === unique); n++) {
      const suffix = n === 1 ? ' (migrated)' : ` (migrated ${n})`;
      unique = stem.slice(0, MAX_VARIANT_NAME - suffix.length) + suffix;
    }
    for (const o of overrides) this._cacheBase(o, false);
    this._setBlock({ ...this._block, variants: [...this._block.variants,
      { id, name: unique, revision, overrides: overrides.map((o) => ({ ...o })) }] });
    return { ok: true, id };
  }

  rename(id: string, name: string): VariantResult {
    if (this._locked) return { ok: false, error: this._locked };
    const bad = checkVariantName(name);
    if (bad) return { ok: false, error: 'invalid-name', detail: bad };
    if (!this.variant(id)) return { ok: false, error: 'unknown-variant' };
    if (this._block.variants.some((v) => v.id !== id && v.name === name.trim())) return { ok: false, error: 'name-taken' };
    this._replace(id, (v) => ({ ...v, name: name.trim() }));   // no revision bump
    return { ok: true, id };
  }

  /**
   * Sets the description of a variant, or of Base with `id === null`. Text for people only: no
   * revision bump, so results recorded for the variant stay current. Empty text removes it.
   */
  describe(id: string | null, text: string): VariantResult {
    if (this._locked) return { ok: false, error: this._locked };
    return this._setDescription(id, text);
  }

  /**
   * Restores a description kept by the experiment recovery copy (unsaved document). Text only:
   * no revision bump and no undo entry, so — unlike {@link describe} — it is allowed while a batch
   * holds the lock. Returns true when the description changed.
   */
  restoreDescription(id: string | null, text: string): boolean {
    const current = id === null ? this._block.baseDescription : this.variant(id)?.description;
    if (id !== null && !this.variant(id)) return false;
    if ((current ?? '') === (normalizeDescription(text) ?? '')) return false;
    return this._setDescription(id, text).ok;
  }

  private _setDescription(id: string | null, text: string): VariantResult {
    const description = normalizeDescription(text);
    if (id === null) {
      const { baseDescription: _old, ...rest } = this._block;
      this._setBlock(description ? { ...rest, baseDescription: description } : rest);
      return { ok: true };
    }
    if (!this.variant(id)) return { ok: false, error: 'unknown-variant' };
    this._replace(id, (v) => {
      const { description: _old, ...rest } = v;
      return description ? { ...rest, description } : rest;
    });
    return { ok: true, id };
  }

  duplicate(id: string, name: string): VariantResult { return this.create(name, { from: id }); }

  /** Deletes a variant; the variant in the scene goes back to Base first. */
  remove(id: string): Promise<VariantResult> { return this._serial(() => this._remove(id)); }

  private async _remove(id: string): Promise<VariantResult> {
    if (this._locked) return { ok: false, error: this._locked };
    if (!this.variant(id)) return { ok: false, error: 'unknown-variant' };
    if (this._scene === id) {
      const r = await this._activate(null);
      if (!r.ok) return r;
    }
    this._undo = this._undo.filter((e) => e.variantId !== id);
    this._redo = this._redo.filter((e) => e.variantId !== id);
    this._setBlock({
      ...this._block,
      active: this._block.active === id ? null : this._block.active,
      variants: this._block.variants.filter((v) => v.id !== id),
    });
    return { ok: true };
  }

  // ─── Activation ───────────────────────────────────────────────────────────

  /** Puts `id` (null = Base) into the scene: one apply, one reset. */
  activate(id: string | null): Promise<VariantResult> { return this._serial(() => this._activate(id)); }

  /** Batch/restore activation authenticated by the current lease object. No undo entry. */
  activateAsHolder(id: string | null, holder: RunLease | null = null): Promise<VariantResult> {
    return this._serial(() => this._activate(id, holder));
  }

  private async _activate(id: string | null, holder?: RunLease | null): Promise<VariantResult> {
    const authorized = holder != null && holder === currentRunLease();
    if (this._locked && !authorized) return { ok: false, error: holder === undefined ? this._locked : 'locked' };
    if (holder != null && !authorized) return { ok: false, error: 'locked' };
    if (id === this._scene) return { ok: true, id: id ?? undefined };
    const to = id ? this.variant(id) : null;
    if (id && !to) return { ok: false, error: 'unknown-variant' };
    if (id !== null) {
      const blocker = this.deps.coexistenceBlocker?.() ?? null;
      if (blocker) return { ok: false, error: blocker };
    }
    const from = this._scene ? this.variant(this._scene) ?? null : null;
    // From Base: the scene IS the base — refill the cache for every resolvable key of every variant.
    if (this._scene === null) {
      this._base.clear();
      for (const v of this._block.variants) for (const o of v.overrides) this._cacheBase(o, true);
    }
    const ops = targetOps(from, to ?? null, (k) => this._base.get(k));
    const r = authorized
      ? await this.deps.apply(ops, { origin: 'experiment', holder: holder.holder })
      : await this.deps.apply(ops);
    if (!r.ok) return { ok: false, error: r.error ?? 'apply-failed', detail: r.detail };
    this._absorb(r);
    this._scene = id;
    this._undo = [];
    this._redo = [];
    this._setBlock({ ...this._block, active: id });
    this.deps.onSceneChanged?.(id);
    return { ok: true, id: id ?? undefined };
  }

  // ─── Values ───────────────────────────────────────────────────────────────

  /** Sets a value of a variant; in the scene → applied first, committed on success. */
  set(id: string, key: FieldKey, value: VariantValue): Promise<VariantResult> {
    return this._edit(id, [{ key: { address: key.address, component: key.component, field: key.field }, next: value }]);
  }

  /** Removes a variant's override (back to Base for this field). */
  unset(id: string, key: FieldKey): Promise<VariantResult> {
    return this._edit(id, [{ key: { address: key.address, component: key.component, field: key.field }, next: undefined }]);
  }

  /**
   * Bundles several edits of ONE variant into one apply and one undo step (an MCP
   * `component.setFields` with three fields). Edits inside `fn` are collected, not applied.
   */
  async batch(id: string, fn: () => void | Promise<void>): Promise<VariantResult> {
    if (this._batch) { await fn(); return { ok: true }; }
    this._batch = { variantId: id, edits: [] };
    let edits: Edit[];
    try { await fn(); } finally { edits = this._batch?.edits ?? []; this._batch = null; }
    if (edits.length === 0) return { ok: true };
    return this._serial(() => this._editNow(id, edits));
  }

  undo(): Promise<VariantResult> { return this._serial(() => this._step(this._undo, this._redo, 'prev')); }
  redo(): Promise<VariantResult> { return this._serial(() => this._step(this._redo, this._undo, 'next')); }

  // ─── Internals ────────────────────────────────────────────────────────────

  private _serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => undefined);
    return run;
  }

  private _edit(id: string, edits: Edit[]): Promise<VariantResult> {
    // Collected into a running batch synchronously; everything else waits its turn.
    if (this._batch && this._batch.variantId === id && !this._locked) {
      for (const e of edits) {
        const verdict = this.deps.check?.(e.key.component, e.key.field, e.next ?? null);
        if (verdict && !verdict.ok) return Promise.resolve({ ok: false, error: 'invalid', detail: verdict.detail });
      }
      this._batch.edits.push(...edits);
      return Promise.resolve({ ok: true });
    }
    return this._serial(() => this._editNow(id, edits));
  }

  private async _editNow(id: string, edits: Edit[]): Promise<VariantResult> {
    if (this._locked) return { ok: false, error: this._locked };
    const v = this.variant(id);
    if (!v) return { ok: false, error: 'unknown-variant' };
    for (const e of edits) {
      const verdict = this.deps.check?.(e.key.component, e.key.field, e.next ?? null);
      if (verdict && !verdict.ok) return { ok: false, error: 'invalid', detail: verdict.detail };
    }
    const changes: UndoChange[] = edits.map((e) => ({ key: e.key, prev: this._valueOf(v, e.key), next: e.next }));
    const r = await this._commit(v, changes, 'next');
    if (!r.ok) return r;
    this._undo.push({ variantId: id, changes });
    if (this._undo.length > (this.deps.undoLimit ?? 100)) this._undo.shift();
    this._redo = [];
    this.deps.onCommit?.();
    return r;
  }

  private async _step(from: UndoEntry[], to: UndoEntry[], side: 'prev' | 'next'): Promise<VariantResult> {
    if (this._locked) return { ok: false, error: this._locked };
    const entry = from[from.length - 1];
    if (!entry) return { ok: false, error: 'nothing-to-undo' };
    const v = this.variant(entry.variantId);
    if (!v) { from.pop(); return { ok: false, error: 'unknown-variant' }; }
    const r = await this._commit(v, entry.changes, side);
    if (!r.ok) return r;
    from.pop();
    to.push(entry);
    return r;
  }

  /** Applies (when in the scene) the variant with `changes`, then commits them. */
  private async _commit(v: Variant, changes: readonly UndoChange[], side: 'prev' | 'next'): Promise<VariantResult> {
    let overrides = v.overrides.slice();
    for (const c of changes) {
      const value = c[side];
      const k = overrideKey(c.key);
      // Before a field enters a variant for the first time, its base is remembered.
      if (value !== undefined) this._cacheBase(c.key, false);
      const i = overrides.findIndex((o) => overrideKey(o) === k);
      if (value === undefined) { if (i >= 0) overrides.splice(i, 1); continue; }
      const next: VariantOverride = { ...c.key, value };
      if (i >= 0) overrides[i] = next; else overrides.push(next);
    }
    overrides = overrides.filter(Boolean);
    const changed = { ...v, revision: v.revision + 1, overrides };
    if (this._scene === v.id) {
      // Full target state (Gate R2 #2): every override of the variant, plus restores of
      // fields the edit took out of it.
      const ops = targetOps(v, changed, (k) => this._base.get(k));
      const r = await this.deps.apply(ops);
      if (!r.ok) return { ok: false, error: r.error ?? 'apply-failed', detail: r.detail };
      this._absorb(r);
    }
    this._replace(v.id, () => changed);
    return { ok: true, id: v.id };
  }

  private _valueOf(v: Variant, k: FieldKey): VariantValue | undefined {
    const key = overrideKey(k);
    return v.overrides.find((o) => overrideKey(o) === key)?.value;
  }

  /**
   * Caches the base of a field if none is cached and the scene shows its base now — i.e.
   * no variant in the scene overrides it. `fromBase` = the scene is known to be Base.
   */
  private _cacheBase(k: FieldKey, fromBase: boolean): void {
    const key = overrideKey(k);
    if (this._base.has(key)) return;
    if (!fromBase && this._scene) {
      const sv = this.variant(this._scene);
      if (sv?.overrides.some((o) => overrideKey(o) === key)) return;
    }
    const b = this.deps.readBase(k);
    if (b) this._base.set(key, b);
  }

  private _absorb(r: ApplyResult): void {
    for (const c of r.captured) {
      const k = overrideKey(c.key);
      if (!this._base.has(k)) this._base.set(k, c.base);
    }
    this._unresolved = new Set(r.unresolved.map(overrideKey));
  }

  private _replace(id: string, fn: (v: Variant) => Variant): void {
    this._setBlock({ ...this._block, variants: this._block.variants.map((v) => (v.id === id ? fn(v) : v)) });
  }

  private _setBlock(b: VariantsBlock): void {
    this._block = b;
    this._publish();
  }

  private _publish(): void {
    this._version++;
    for (const fn of [...this._listeners]) fn();
  }
}
