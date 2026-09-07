// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-path-rollers-field-renderer.tsx — custom inspector renderer for
 * `RibbonPath.Rollers` (plan-459 F10).
 *
 * Without it the field is unauthorable in the browser: the generic array editor
 * in `rv-field-editors.tsx` renders a `componentRefArray` as a flat `[ ]` and
 * offers no way to add, remove or reorder — and the ORDER of `Rollers` is the
 * running direction of the web, so it is the one thing an author must be able to
 * change (SOL round-1 finding 4).
 *
 * ## Persistence is the point
 *
 * The IKPath renderer this is modelled on reorders the RUNTIME list and, for a
 * long time, did not write anything back. Here every mutation goes through
 * `persistFieldOp` — the same `setField` op the property inspector uses, so it
 * lands in the SceneStore op log outside the editor and in the AssetDocument
 * inside, undoably, and survives a save. `tests/ribbon-rollers-renderer.test.tsx`
 * is the acceptance criterion for that half, not for the visuals.
 *
 * Self-registers with the `fieldRendererRegistry` on import; the import lives in
 * `src/core/hmi/App.tsx` next to the other field renderers.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Button } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { ReorderableList, type ReorderableListItem } from './ReorderableList';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import type { ComponentRef } from '../engine/rv-node-registry';

/** The wire `componentType` the exporter writes for a plain node reference. */
const TRANSFORM_TYPE = 'UnityEngine.Transform';

function lastSeg(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function isRef(v: unknown): v is ComponentRef {
  return !!v && typeof v === 'object'
    && (v as Record<string, unknown>).type === 'ComponentReference'
    && typeof (v as Record<string, unknown>).path === 'string';
}

// Stable no-op store fns for when the viewer is absent (keeps hook order stable).
const noopSubscribe = () => () => {};
const EMPTY = Object.freeze({
  selectedPaths: Object.freeze([]) as ReadonlyArray<string>,
  primaryPath: null,
});
const emptySnapshot = () => EMPTY;

export function RibbonPathRollersRenderer({ value, fieldName, nodePath, viewer }: FieldRendererProps) {
  const initial = Array.isArray(value) ? (value as unknown[]).filter(isRef) : [];
  const [order, setOrder] = useState<ComponentRef[]>(initial);

  // Re-sync when the underlying field changes (model reload, undo).
  useEffect(() => {
    setOrder(Array.isArray(value) ? (value as unknown[]).filter(isRef) : []);
  }, [value]);

  const selection = useSyncExternalStore(
    viewer ? viewer.selectionManager.subscribe : noopSubscribe,
    viewer ? viewer.selectionManager.getSnapshot : emptySnapshot,
  );
  const primaryPath = selection.primaryPath;
  const registry = viewer?.registry ?? null;

  // Resolve each ref to its CURRENT node path, so the selection highlight and
  // the click-to-select survive the loader's dedup renames (doc-node-paths.md).
  const resolved = order.map((ref) => {
    const node = registry?.getNode(ref.path) ?? null;
    const curPath = node ? (registry?.getPathForNode(node) ?? ref.path) : ref.path;
    return { ref, curPath, missing: !node };
  });

  const items: ReorderableListItem[] = resolved.map((r, i) => ({
    id: `${i}:${r.curPath}`,
    label: lastSeg(r.curPath),
    // The end entries are the winders by contract, so saying which end a row is
    // costs nothing and answers the question the list exists to answer.
    sublabel: r.missing
      ? 'missing'
      : (i === 0 ? 'start' : i === resolved.length - 1 ? 'end' : undefined),
  }));

  /** Write `next` to the runtime field AND through the edit target. */
  const commit = (next: ComponentRef[]): void => {
    const prev = order;
    setOrder(next);
    persistFieldOp(nodePath, 'RibbonPath', 'Rollers', next, prev);
  };

  const handleSelect = (i: number): void => {
    const cur = resolved[i]?.curPath;
    if (cur && viewer) viewer.selectionManager.select(cur);
  };

  const handleReorder = (from: number, to: number): void => {
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  };

  const handleRemove = (i: number): void => {
    const next = [...order];
    next.splice(i, 1);
    commit(next);
  };

  const handleAdd = (): void => {
    if (!primaryPath) return;
    if (order.some((ref) => ref.path === primaryPath)) return;
    commit([...order, { type: 'ComponentReference', path: primaryPath, componentType: TRANSFORM_TYPE } as ComponentRef]);
  };

  return (
    <Box>
      <ReorderableList
        title={fieldName}
        items={items}
        onReorder={handleReorder}
        onSelect={handleSelect}
        onRemove={handleRemove}
        selectedId={resolved.findIndex((r) => r.curPath === primaryPath) >= 0
          ? `${resolved.findIndex((r) => r.curPath === primaryPath)}:${primaryPath}`
          : null}
        emptyText="No rollers"
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          disabled={!primaryPath}
          onClick={handleAdd}
          data-testid="web-rollers-add"
          sx={{ fontSize: 11, textTransform: 'none' }}
        >
          Add selected node
        </Button>
      </Box>
    </Box>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'RibbonPath',
  fieldName: 'Rollers',
  component: RibbonPathRollersRenderer,
});
