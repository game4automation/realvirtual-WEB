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
 * Optional methods (`addComponent?`, `removeComponent?`, `transformNode?`,
 * `renameNode?`, `deleteNode?`) double as UI capability flags: the inspector
 * shows the corresponding affordance only when the active target defines it.
 */

import { getSceneStore } from './scene/scene-store-singleton';
import { freshOpId } from '../ops/rv-op-utils';

/** Node-local TRS used by transformNode (mirrors rv-asset-ops NodeTransform). */
export interface EditTargetTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export interface EditTarget {
  /** True when the target can accept ops right now (SceneStore may be absent pre-boot). */
  readonly available: boolean;
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): void;
  unsetField(nodePath: string, componentType: string, fieldName: string, prev: unknown): void;
  withTransaction(label: string, fn: () => Promise<void>): Promise<void>;
  // Editor-only capabilities — undefined ⇒ the UI hides the affordance.
  addComponent?(nodePath: string, baseType: string, fields: Record<string, unknown>): string;
  removeComponent?(nodePath: string, componentType: string): void;
  transformNode?(nodePath: string, transform: EditTargetTransform, prev: EditTargetTransform): void;
  renameNode?(nodePath: string, name: string, prevName: string): void;
  deleteNode?(nodePath: string): void;
  setNodeVisible?(nodePath: string, visible: boolean): void;
}

/** SceneStore adapter — reproduces the exact op emission the inspector and
 *  scene-field-ops used before the seam existed. */
const sceneStoreTarget: EditTarget = {
  get available(): boolean {
    return getSceneStore() !== null;
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
