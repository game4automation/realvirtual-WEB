// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Eager flags shared by variants, experiments and the old planning paths (plan-2013 §2.6,
 * §2.8, §2.10). Kept tiny (startup path, 9.3 budget). `isVariantInScene()`: the old write
 * paths refuse with `variant-active`. The run lease: one batch holder per viewer
 * (Phase 4a). The save provider: the lazy variants runtime lends the document save its
 * block, so the normal save writes it too.
 */

let inScene = false;

export function isVariantInScene(): boolean { return inScene; }
export function setVariantInScene(value: boolean): void { inScene = value; }

export interface RunLease { readonly holder: string; readonly documentLoadId: string; release(): void }

let lease: RunLease | null = null;
const leaseListeners = new Set<() => void>();

/** Observe acquisition and release synchronously, including short-lived leases. */
export function subscribeRunLease(listener: () => void): () => void {
  leaseListeners.add(listener);
  return () => { leaseListeners.delete(listener); };
}

/** Takes the lease; `null` when another holder has it. */
export function acquireRunLease(documentLoadId: string, holder: string): RunLease | null {
  if (lease) return null;
  const mine: RunLease = { holder, documentLoadId, release() {
    if (lease !== mine) return;
    lease = null;
    for (const listener of leaseListeners) listener();
  } };
  lease = mine;
  for (const listener of leaseListeners) listener();
  return mine;
}

export function currentRunLease(): RunLease | null { return lease; }

/** The `Variants` block to bake; `null` removes it. */
export type SavePayload = Record<string, unknown> | null;

/** `payload()` may answer `undefined` = leave the file's block untouched (e.g. a block it could not read). */
export interface SaveProvider { payload(): SavePayload | undefined; dirty(): boolean; markSaved(payload: SavePayload): void }

let provider: SaveProvider | null = null;

/** Set by the runtime while it is bound to the open document, cleared on unbind. */
export function setVariantsSaveProvider(p: SaveProvider | null): void { provider = p; }
/** The current block while a runtime is bound — also right after a save; `undefined` = leave the file's block untouched. */
export function getVariantsSavePayload(): SavePayload | undefined { return provider?.payload(); }
export function isVariantsDirty(): boolean { return provider?.dirty() ?? false; }
/** Only what was written becomes clean — edits made during the save stay dirty. */
export function markVariantsSaved(payload: SavePayload | undefined): void { if (payload !== undefined) provider?.markSaved(payload); }

/** Frozen by the run lifecycle; the lazy runtime supplies only plain data. */
export interface SceneVariantProvenance {
  variantId: string;
  revision: number;
  name?: string;
  overrides: readonly import('../variants/rv-variant-model').VariantOverride[];
}
let sceneProvenance: (() => SceneVariantProvenance | null) | null = null;
export function setSceneVariantProvenanceProvider(fn: (() => SceneVariantProvenance | null) | null): void { sceneProvenance = fn; }
export function getSceneVariantProvenance(): SceneVariantProvenance | null { return sceneProvenance?.() ?? null; }

/** Base restoration data supplied by the lazy runtime while its document is bound. */
export interface SceneBaseProvider {
  readonly version: number;
  sceneOverrideKeys(): Set<string>;
  baseValueOf(key: string): import('../params/rv-param-field').BaseValue | undefined;
}
let sceneBase: SceneBaseProvider | null = null;
export function setSceneBaseProvider(value: SceneBaseProvider | null): void { sceneBase = value; }
export function getSceneBaseProvider(): SceneBaseProvider | null { return sceneBase; }

/** Migration access exists only while the lazy variants runtime is document-bound. */
export interface MigrationContext {
  store: import('../variants/rv-variant-store').VariantStore;
  baseValueOf: (key: import('../params/rv-param-field').FieldKey) => import('../variants/rv-variant-model').VariantValue | undefined;
  resolveAddress: (path: string) => readonly string[];
}
export type ColumnMigrationContext = MigrationContext;
let columnMigration: ColumnMigrationContext | null = null;
export function setColumnMigrationContext(value: ColumnMigrationContext | null): void { columnMigration = value; }
export function getColumnMigrationContext(): ColumnMigrationContext | null { return columnMigration; }
/** External mutations are blocked while an experiment owns the viewer. */
export function runLeaseBlocker(): { reason: 'experiment-running' } | null {
  return lease ? { reason: 'experiment-running' } : null;
}
