// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path-field-renderer.tsx — Custom inspector renderer for IKPath.Path.
 *
 * Shows the path's waypoints as a reusable ReorderableList: click a row to
 * select that IKTarget (which also triggers the 3D path visualizer), and reorder
 * with the up/down buttons. Reordering updates the runtime path order
 * immediately; persisting it to the GLB is a follow-up (plan-215 Phase 4).
 *
 * Self-registers with the fieldRendererRegistry on import.
 */

import { useState, useEffect, useSyncExternalStore } from 'react';
import { ReorderableList, type ReorderableListItem } from './ReorderableList';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import type { ComponentRef } from '../engine/rv-node-registry';
import type { RVIKPath } from '../engine/rv-ik-path';

function lastSeg(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function isRef(v: unknown): v is ComponentRef {
  return !!v && typeof v === 'object'
    && (v as Record<string, unknown>).type === 'ComponentReference'
    && typeof (v as Record<string, unknown>).path === 'string';
}

function IKPathTargetsRenderer({ value, fieldName, nodePath, viewer }: FieldRendererProps) {
  const initial = Array.isArray(value) ? (value as unknown[]).filter(isRef) : [];
  const [order, setOrder] = useState<ComponentRef[]>(initial);

  // Re-sync when the underlying field changes (e.g. model reload).
  useEffect(() => {
    setOrder(Array.isArray(value) ? (value as unknown[]).filter(isRef) : []);
  }, [value]);

  // React to selection changes so the matching row highlights.
  const selection = useSyncExternalStore(
    viewer ? viewer.selectionManager.subscribe : noopSubscribe,
    viewer ? viewer.selectionManager.getSnapshot : emptySnapshot,
  );
  const primaryPath = selection.primaryPath;

  const registry = viewer?.registry ?? null;

  // Resolve each ref to its current node path (survives Three.js dedup renames),
  // so selection highlight + click selection use the registered path.
  const resolved = order.map((ref) => {
    const node = registry?.getNode(ref.path) ?? null;
    const cur = node ? (registry?.getPathForNode(node) ?? ref.path) : ref.path;
    return { ref, curPath: cur };
  });

  const items: ReorderableListItem[] = resolved.map((r) => ({ id: r.curPath, label: lastSeg(r.curPath) }));

  const handleSelect = (i: number) => {
    const cur = resolved[i]?.curPath;
    if (cur && viewer) viewer.selectionManager.select(cur);
  };

  const handleReorder = (from: number, to: number) => {
    const next = [...order];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setOrder(next);
    registry?.getByPath<RVIKPath>('IKPath', nodePath)?.reorderTargets(from, to);
    // Persist the new order to the GLB (rewrite IKPath.Path as a setField op).
    persistFieldOp(nodePath, 'IKPath', 'Path', next, order);
  };

  const handleRemove = (i: number) => {
    const next = [...order];
    next.splice(i, 1);
    setOrder(next);
    registry?.getByPath<RVIKPath>('IKPath', nodePath)?.removeTarget(i);
    // Persist the shortened path to the GLB.
    persistFieldOp(nodePath, 'IKPath', 'Path', next, order);
  };

  return (
    <ReorderableList
      title={fieldName}
      items={items}
      onReorder={handleReorder}
      onSelect={handleSelect}
      onRemove={(i) => handleRemove(i)}
      selectedId={primaryPath}
      emptyText="No targets"
    />
  );
}

// Stable no-op store fns for when viewer is null (keeps hook order stable).
const noopSubscribe = () => () => {};
const EMPTY = Object.freeze({ selectedPaths: Object.freeze([]) as ReadonlyArray<string>, primaryPath: null });
const emptySnapshot = () => EMPTY;

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'IKPath',
  fieldName: 'Path',
  component: IKPathTargetsRenderer,
});
