// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor ↔ SignalStore sync for PLC signal nodes (plan-589 spike).
 *
 * The loader registers PLC signals once (`registerSignal`). Editor mutations
 * (add/remove component, delete/restore, rename, reparent, field edits and all
 * their undo/redo branches) used to leave the store untouched — characterised
 * in `tests/spike-589-signal-ist.node.test.ts`. This module closes that gap.
 *
 * Identity: the NODE OBJECT, not its path. `registerSignal` records a snapshot
 * `{type, name, path}` per node (`trackedSignalOf`). After a mutation the
 * executor calls {@link syncSignalSubtree} on the subtree it touched; for each
 * node the DESIRED state is derived from what is true NOW:
 *
 *   - the node is live  ⇔ the NodeRegistry has a path for it (a trashed subtree
 *     is unregistered by `_detachToTrash`, a restored one re-registered);
 *   - it carries a `PLC*` extras record;
 *   - its runtime name is `resolveSignalName(node, extras)` — the ONE naming
 *     rule the loader uses too, so the scope is applied exactly once.
 *
 * and diffed against the snapshot. The snapshot holds the OLD path, which is
 * what makes rename / delete work without a pre-mutation hook: the old path can
 * no longer be computed from the node, but it was recorded at registration.
 *
 * Ownership on removal is the store's job (`SignalStore.unregisterPath`): a
 * released path removes the NAME only when neither another model path nor an
 * interface owns it.
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { SignalCatalogChange, SignalStore } from './rv-signal-store';
import {
  SIGNAL_TYPES, registerSignal, resolveSignalName, setTrackedSignal, trackedSignalOf,
  type TrackedSignal,
} from './rv-signal-construction';

/** The part of the viewer the sync needs. */
export interface SignalSyncHost {
  readonly signalStore: SignalStore | null | undefined;
  readonly registry: NodeRegistry | null | undefined;
}

let _enabled = true;

/** Kill switch — `false` restores the pre-spike executor behaviour (characterisation tests). */
export function setSignalEditorSyncEnabled(on: boolean): void { _enabled = on; }
export function isSignalEditorSyncEnabled(): boolean { return _enabled; }

// ─── Waves: one catalog event per op ────────────────────────────────────────

const _waves = new WeakMap<SignalStore, { depth: number; change: SignalCatalogChange }>();

function emptyChange(): SignalCatalogChange {
  return { registered: [], released: [], removed: [], metaChanged: [], renamed: [] };
}

/** Open a wave; nested waves are folded into the outermost one. */
export function beginSignalSyncWave(store: SignalStore | null | undefined): void {
  if (!store) return;
  const w = _waves.get(store);
  if (w) w.depth++;
  else _waves.set(store, { depth: 1, change: emptyChange() });
}

/** Close a wave; the outermost close emits ONE `onCatalogChanged` when anything changed. */
export function endSignalSyncWave(store: SignalStore | null | undefined): void {
  if (!store) return;
  const w = _waves.get(store);
  if (!w) return;
  if (--w.depth > 0) return;
  _waves.delete(store);
  emit(store, w.change);
}

function emit(store: SignalStore, change: SignalCatalogChange): void {
  if (change.registered.length + change.released.length
    + change.removed.length + change.metaChanged.length + (change.renamed?.length ?? 0) === 0) return;
  store.notifyCatalogChanged(change);
}

// ─── The sync ───────────────────────────────────────────────────────────────

/** First PLC extras record on a node (the loader registers every one; one per node in practice). */
function plcExtrasOf(node: Object3D): { type: string; data: Record<string, unknown> } | null {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const type of SIGNAL_TYPES) {
    const data = rv[type];
    if (data && typeof data === 'object') return { type, data: data as Record<string, unknown> };
  }
  return null;
}

/**
 * Bring the store registrations of every PLC signal node in `root`'s subtree in
 * line with the scene as it is NOW. Idempotent; safe on subtrees without
 * signals (cost: one traverse, one WeakMap lookup per node).
 *
 * Call it AFTER the mutation, with the node object the executor already holds
 * (a trashed root is fine — it is not live, so its signals are released).
 *
 * @returns the change of this call (also folded into an open wave).
 */
export function syncSignalSubtree(host: SignalSyncHost, root: Object3D): SignalCatalogChange {
  const change = emptyChange();
  const store = host.signalStore;
  const registry = host.registry;
  if (!_enabled || !store || !registry) return change;

  root.traverse((node) => {
    let tracked = trackedSignalOf(store, node);
    const path = registry.getPathForNode(node);
    const ext = path !== null ? plcExtrasOf(node) : null;

    if (ext && path !== null) {
      const name = resolveSignalName(node, ext.data, tracked?.override).runtime;
      // plan-590 Rename-/Sync-Vertrag (a): an announced rename of THIS name is
      // a move, not "register new, release old" — value, force pin, listeners
      // and writers stay. The store rename is idempotent, so a coordinator that
      // already moved the name makes this a pure snapshot update. The rest of
      // the branch then sees an unchanged name (only the path may still differ).
      // The store emits the rename itself (`renamed` + registered/removed), so
      // nothing is added to this wave for it.
      if (tracked && tracked.name !== name && tracked.type === ext.type
        && store.pendingRenameOf(tracked.name) === name && renameForSync(store, tracked.name, name)) {
        if (tracked.path === path) {
          // Refresh registry entry, metadata and the snapshot under the new name;
          // `register()` keeps the moved value (the name already exists).
          registerSignal(node, ext.type, ext.data, path, store, registry, tracked.override);
          return;
        }
        tracked = { ...tracked, name };
      }
      if (tracked && tracked.type === ext.type && tracked.name === name && tracked.path === path) {
        // Same identity — only the DESCRIPTIVE fields can have changed. They do
        // not move the catalog, but they do move the reconcile report, so they
        // get their own `metaChanged` entry instead of silence (plan-589).
        if (syncSignalMeta(store, node, name, ext.data, tracked)) change.metaChanged.push(name);
        return;
      }
      // Register the NEW identity first, release the old one after: a pure
      // path move (rename / reparent of an ancestor) then never drops the name,
      // so its value, force pin and subscribers survive the move.
      registerSignal(node, ext.type, ext.data, path, store, registry, tracked?.override);
      store.indexPathSuffixes(path);
      change.registered.push(name);
      if (tracked) release(store, registry, tracked, path, name, change);
      return;
    }

    if (tracked) {
      release(store, registry, tracked, null, null, change);
      setTrackedSignal(store, node, null);
    }
  });

  const w = _waves.get(store);
  if (w) {
    w.change.registered.push(...change.registered);
    w.change.released.push(...change.released);
    w.change.removed.push(...change.removed);
    w.change.metaChanged.push(...change.metaChanged);
    w.change.renamed!.push(...change.renamed!);
  } else {
    emit(store, change);
  }
  return change;
}

/**
 * Bring `SignalMeta` and the node snapshot in line with the extras of an
 * UNCHANGED registration. An absent field is cleared rather than written as
 * `''` (`clearSignalMetaField` — `setSignalMeta` merges and cannot delete).
 *
 * @returns true when something actually changed (→ one `metaChanged` entry).
 */
function syncSignalMeta(
  store: SignalStore, node: Object3D, name: string,
  data: Record<string, unknown>, tracked: TrackedSignal,
): boolean {
  const read = (key: string): string | undefined => {
    const raw = data[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  };
  const comment = read('Comment');
  const originDataType = read('OriginDataType');
  if (comment === tracked.comment && originDataType === tracked.originDataType) return false;

  if (comment !== undefined) store.setSignalMeta(name, { comment });
  else store.clearSignalMetaField(name, 'comment');
  if (originDataType !== undefined) store.setSignalMeta(name, { originDataType });
  else store.clearSignalMetaField(name, 'originDataType');

  const next: TrackedSignal = { type: tracked.type, name: tracked.name, path: tracked.path };
  if (tracked.override !== undefined) next.override = tracked.override;
  if (comment !== undefined) next.comment = comment;
  if (originDataType !== undefined) next.originDataType = originDataType;
  setTrackedSignal(store, node, next);
  return true;
}

/**
 * The rename half of the plan-590 sync contract. True when the name now lives
 * under `to` (moved here, or already moved by the coordinator). A collision is
 * NOT swallowed into a half state: it is reported and the caller falls back to
 * the ordinary register/release, exactly the behaviour without a rename.
 */
function renameForSync(store: SignalStore, from: string, to: string): boolean {
  try {
    store.renameSignal(from, to);
  } catch (e) {
    console.warn('[signal-editor-sync] announced rename could not be applied:', e);
    return false;
  }
  return store.get(from) === undefined && store.ownerPathCount(from) === 0;
}

function release(
  store: SignalStore, registry: NodeRegistry, old: { type: string; name: string; path: string },
  newPath: string | null, newName: string | null, change: SignalCatalogChange,
): void {
  // The NodeRegistry PLC entry of the old path (the subtree unregister already
  // dropped it for a delete; a rename re-keyed it to the new path, where the
  // fresh registerSignal overwrote it — so only a still-present OLD key goes).
  if (old.path !== newPath && registry.getByPath(old.type, old.path) !== null) {
    registry.unregisterComponent(old.type, old.path);
  }
  if (old.path === newPath && old.name === newName) return;
  // Same path, other name: `register()` already moved the path's ownership.
  if (old.path === newPath) {
    if (store.get(old.name) === undefined) change.removed.push(old.name);
    else change.released.push(old.name);
    return;
  }
  const outcome = store.unregisterPath(old.path, old.name);
  if (outcome === 'name') change.removed.push(old.name);
  else if (outcome === 'path') change.released.push(old.name);
}
