// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-edit-target — the write-path seam between the inspector/editors and the
 * active document.
 *
 * Outside the asset editor, field edits flow into the SceneStore op log
 * (hmi / des / planner — the session/layout document). Inside the editor
 * workspace, the SAME inspector UI must write into the AssetDocument instead
 * (the GLB being authored). This module carries that routing decision:
 *
 * - `getActiveEditTarget()` returns the asset adapter while the asset-editor
 *   plugin is active, else the SceneStore adapter (which emits ops IDENTICAL
 *   to the historical direct `getSceneStore().applyOp(...)` calls, or reports
 *   itself unavailable pre-boot so callers keep their legacy fallback).
 *
 * Optional methods (`addComponent?`, `removeComponent?`, `setNodeVisible?`)
 * double as UI capability flags: the inspector shows the corresponding
 * affordance only when the active target defines it.
 *
 * ## What is deliberately NOT on this interface (plan-703 Phase 3)
 *
 * `transformNode`, `renameNode` and `deleteNode` were declared here and
 * implemented by the asset adapter, but **nothing ever called them through the
 * seam** — every editor flow reaches for `AssetDocument` directly
 * (`EditorTransformTool`, `kinematics/transform-actions`, `rv-cadlink-reimport`,
 * the MCP editor tools). They were removed rather than given consumers,
 * because a capability flag nobody reads cannot gate a UI affordance, and
 * carrying it into the unified document would have set three method names in
 * concrete on the strength of an interface that never bore weight. The three
 * op kinds themselves are untouched and keep their executors; what went is the
 * unused routing surface.
 */

import { getSceneStore } from './scene/scene-store-singleton';
import { freshOpId } from '../ops/rv-op-utils';

/**
 * Where an accepted op actually ENDS UP — a different question from whether it
 * was accepted (plan-394 §2.6).
 *
 *   'asset' — the AssetDocument; `web_editor_save` writes it into the asset GLB.
 *   'scene' — the scene op log; the debounced draft autosave bakes it into the
 *             draft body. **Optimistic, not guaranteed:** `_loadIntoWorkspace`
 *             CANCELS the autosave rather than flushing it, so an edit made less
 *             than the debounce interval before a model switch is lost.
 *   'none'  — accepted and persisted nowhere.
 */
export type PersistenceTarget = 'asset' | 'scene' | 'none';

export interface EditTarget {
  /** True when the target can accept ops right now (SceneStore may be absent pre-boot). */
  readonly available: boolean;
  /**
   * Where accepted ops land, when the target knows. `available` alone cannot
   * answer it: a TRANSIENT workspace (an Example model, a shared link) accepts
   * ops, supports undo and reports `available: true`, yet `_afterOpsChanged`
   * returns before every persistence path — the autosave timer is never even
   * scheduled. Anything that reports a durable write to a caller has to consult
   * this, not `available` (see `getActivePersistenceTarget`).
   */
  readonly persistsTo?: PersistenceTarget;
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): void;
  unsetField(nodePath: string, componentType: string, fieldName: string, prev: unknown): void;
  withTransaction(label: string, fn: () => Promise<void>): Promise<void>;
  // Editor-only capabilities — undefined ⇒ the UI hides the affordance.
  addComponent?(nodePath: string, baseType: string, fields: Record<string, unknown>): string;
  removeComponent?(nodePath: string, componentType: string): void;
  setNodeVisible?(nodePath: string, visible: boolean): void;
}

/** SceneStore adapter — reproduces the exact op emission the inspector and
 *  scene-field-ops used before the seam existed. */
const sceneStoreTarget: EditTarget = {
  get available(): boolean {
    return getSceneStore() !== null;
  },
  get persistsTo(): PersistenceTarget {
    const store = getSceneStore();
    if (!store) return 'none';
    return store.isTransient() ? 'none' : 'scene';
  },
  setField(nodePath, componentType, fieldName, value, prev): void {
    const store = getSceneStore();
    if (!store) return;
    void store.applyOp({
      id: freshOpId(), ts: Date.now(), schemaV: 1,
      kind: 'setField', nodePath, componentType, fieldName, value, prev,
    });
  },
  unsetField(nodePath, componentType, fieldName, prev): void {
    const store = getSceneStore();
    if (!store) return;
    void store.applyOp({
      id: freshOpId(), ts: Date.now(), schemaV: 1,
      kind: 'unsetField', nodePath, componentType, fieldName, prev,
    });
  },
  async withTransaction(label, fn): Promise<void> {
    const store = getSceneStore();
    if (!store) { await fn(); return; }
    await store.withTransaction(label, fn);
  },
};

let _override: EditTarget | null = null;
let _version = 0;
const _listeners = new Set<() => void>();

/** Install (or clear) the asset-editor target. Called by the AssetEditorPlugin
 *  on mode activate/deactivate. */
export function setActiveEditTarget(target: EditTarget | null): void {
  _override = target;
  _version++;
  for (const fn of _listeners) fn();
}

/** The currently active edit target (asset document in editor mode, else SceneStore). */
export function getActiveEditTarget(): EditTarget {
  return _override ?? sceneStoreTarget;
}

/**
 * Where a write through the active target would actually be KEPT.
 *
 * The honest answer to "did that stick?", and it needs TWO signals rather than
 * one (plan-394 §2.6): `available` is `true` for a transient workspace exactly
 * as it is for a normal one, so a tool deriving durability from `available`
 * alone reports success for edits that are discarded on reload.
 *
 * An installed override that does not declare `persistsTo` is treated as
 * `'asset'`: the only thing that ever installs one is the asset-editor plugin,
 * whose target wraps an `AssetDocument`.
 */
export function getActivePersistenceTarget(): PersistenceTarget {
  const target = getActiveEditTarget();
  if (!target.available) return 'none';
  return target.persistsTo ?? 'asset';
}

// The asset-editor target installs ASYNCHRONOUSLY after mode activation (the
// plugin awaits the base-model load first), so UI that gates on editor-only
// capabilities needs a change signal — useSyncExternalStore-compatible pair.

/** Subscribe to edit-target install/clear. Returns the unsubscribe. */
export function subscribeEditTarget(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Monotonic version, bumped on every setActiveEditTarget call. */
export function getEditTargetVersion(): number {
  return _version;
}
