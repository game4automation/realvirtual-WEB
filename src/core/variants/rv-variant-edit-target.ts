// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-variant-edit-target — the edit target while a variant is in the scene (plan-2013
 * §2.6). Installed with `setActiveEditTarget()` on activation, removed on the return to
 * Base. Lazy.
 *
 * A field edit from the inspector or MCP becomes a variant edit: `setFieldAsync` →
 * `store.set` → the apply transaction with the full target state (one reset) → commit
 * only on success; a refusal rejects. `trySetField` is the synchronous pre-check (admission
 * + lock): a field that cannot vary is refused ("Shared field — edit in Base") instead of
 * silently changing Base under a variant. `addComponent` / `removeComponent` /
 * `setNodeVisible` are deliberately absent — the inspector hides those offers.
 */

import type { Object3D } from 'three';
import type { EditTarget } from '../hmi/rv-edit-target';
import type { RvHistoryChange } from '../ops/rv-document';
import type { FieldKey, VariantValue } from './rv-variant-model';
import type { VariantStore } from './rv-variant-store';

/** What the target needs to turn a registry path into an address. */
export interface VariantTargetHost {
  readonly registry?: {
    getNode(path: string): Object3D | null;
    getAddressForNode?(node: Object3D): string | null;
  } | null;
}

/** Address-free admission (the apply service's `checkValue`). */
export type VariantFieldCheck = (component: string, field: string, value: VariantValue | null) => { ok: true } | { ok: false; detail: string };

export interface VariantHistoryHost {
  readonly document: {
    onHistoryChange(cb: (change: RvHistoryChange) => void): () => void;
    markCoalesceFloor(): () => void;
  };
  undo(): Promise<void>;
  redo(): Promise<void>;
}

export interface VariantEditTarget extends EditTarget {
  recordVariantCommit(): void;
  dispose(): void;
}

function isVariantValue(v: unknown): v is VariantValue {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string';
}

/** Builds the variant edit target for the variant `variantId` currently in the scene. */
export function createVariantEditTarget(opts: {
  store: VariantStore;
  variantId: string;
  host: VariantTargetHost;
  check: VariantFieldCheck;
  historyHost?: VariantHistoryHost | null;
  message?(text: string, id: string): void;
}): VariantEditTarget {
  const { store, variantId, host, check } = opts;
  const history: ('variant' | 'scene')[] = [];
  const redoJournal: ('variant' | 'scene')[] = [];
  let ownStep = false;
  let stepChanged = false;
  let layoutMessageShown = false;
  let releaseFloor = opts.historyHost?.document.markCoalesceFloor() ?? null;

  const resetFloor = (): void => {
    releaseFloor = opts.historyHost?.document.markCoalesceFloor() ?? null;
  };
  const clear = (): void => { history.length = 0; redoJournal.length = 0; };
  const append = (kind: 'variant' | 'scene'): void => {
    history.push(kind);
    if (history.length > 100) history.shift();
    redoJournal.length = 0;
  };
  const onHistoryChange = (change: RvHistoryChange): void => {
    if (change.kind === 'record') {
      append('scene');
      if (!layoutMessageShown) {
        layoutMessageShown = true;
        opts.message?.('Layout change applied to Base (all variants)', 'variant-layout-base');
      }
    } else if (change.kind === 'coalesce') {
      if (history[history.length - 1] !== 'scene') {
        clear();
        opts.message?.('Undo history reset after an unmatched layout change', 'variant-history-reset');
      }
    } else if (change.kind === 'undo' || change.kind === 'redo') {
      if (ownStep) stepChanged = true;
      else clear();
    } else {
      clear();
    }
  };
  const unsubscribe = opts.historyHost?.document.onHistoryChange(onHistoryChange) ?? null;

  const keyOf = (nodePath: string, component: string, field: string): FieldKey | null => {
    const node = host.registry?.getNode(nodePath) ?? null;
    const address = node ? host.registry?.getAddressForNode?.(node) ?? null : null;
    return address ? { address, component, field } : null;
  };

  const verdict = (nodePath: string, component: string, field: string, value: unknown): { ok: true; key: FieldKey } | { ok: false; reason: string; code?: 'shared-field' } => {
    if (store.locked) return { ok: false, reason: 'Locked — experiment running' };
    if (value !== null && !isVariantValue(value)) return { ok: false, code: 'shared-field', reason: 'Shared field — edit in Base' };
    const v = check(component, field, value === null ? null : value);
    if (!v.ok) return { ok: false, code: 'shared-field', reason: `Shared field — edit in Base (${v.detail})` };
    const key = keyOf(nodePath, component, field);
    if (!key) return { ok: false, reason: `no address for '${nodePath}'` };
    return { ok: true, key };
  };

  const setFieldAsync = async (nodePath: string, component: string, field: string, value: unknown): Promise<void> => {
    const v = verdict(nodePath, component, field, value);
    if (!v.ok) throw new Error(v.reason);
    const r = await store.set(variantId, v.key, value as VariantValue);
    if (!r.ok) throw new Error(r.detail ? `${r.error}: ${r.detail}` : r.error);
  };

  const target: VariantEditTarget = {
    available: true,
    persistsTo: 'variant',
    documentKey: store,
    trySetField(nodePath, component, field, value) {
      const v = verdict(nodePath, component, field, value);
      return v.ok ? { ok: true } : v;
    },
    setField(nodePath, component, field, value) {
      return setFieldAsync(nodePath, component, field, value);
    },
    setFieldAsync,
    unsetField(nodePath, component, field) {
      const key = keyOf(nodePath, component, field);
      if (key) void store.unset(variantId, key);
    },
    async withTransaction(_label, fn) {
      const r = await store.batch(variantId, fn);
      if (!r.ok) throw new Error(r.detail ? `${r.error}: ${r.detail}` : r.error);
    },
    async undo() {
      const kind = history[history.length - 1];
      if (!kind) {
        opts.message?.('Switch to Base to undo earlier base changes', 'variant-history-empty');
        return false;
      }
      let ok = false;
      if (kind === 'variant') ok = (await store.undo()).ok;
      else if (opts.historyHost) {
        ownStep = true;
        stepChanged = false;
        try { await opts.historyHost.undo(); ok = stepChanged; } catch { ok = false; }
        finally { ownStep = false; }
      }
      if (ok) { history.pop(); redoJournal.push(kind); }
      resetFloor();
      return ok;
    },
    async redo() {
      const kind = redoJournal[redoJournal.length - 1];
      if (!kind) return false;
      let ok = false;
      if (kind === 'variant') ok = (await store.redo()).ok;
      else if (opts.historyHost) {
        ownStep = true;
        stepChanged = false;
        try { await opts.historyHost.redo(); ok = stepChanged; } catch { ok = false; }
        finally { ownStep = false; }
      }
      if (ok) { redoJournal.pop(); history.push(kind); }
      resetFloor();
      return ok;
    },
    recordVariantCommit() { append('variant'); resetFloor(); },
    dispose() { unsubscribe?.(); releaseFloor?.(); clear(); },
  };
  return target;
}
