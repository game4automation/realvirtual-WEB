// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-locomotion-policy-field-renderers.tsx — the two inspector editors
 * `LocomotionPolicy` needs (plan-673 Phase 2b).
 *
 * ## `Axes` — an ORDERED reference list
 *
 * `Axes[i]` is the drive of the i-th policy actuator, so the ORDER is the
 * contract and reordering is the one thing an author must be able to do. The
 * generic array editor renders a `componentRefArray` as a flat `[ ]` with no
 * add, no remove and no reorder, which makes the field unauthorable in the
 * browser. Modelled on the `RibbonPath.Rollers` renderer, including the part
 * that matters most: every mutation goes through `persistFieldOp`, so it lands
 * in the SceneStore op log outside the editor and in the AssetDocument inside,
 * undoably, and survives a save.
 *
 * A reference is WRITTEN asset-relative and in AUTHORED names, so the same file
 * works as a document and as a placement and the reference survives save and
 * reload.
 *
 * ## `Decimation` — the derived rate, shown and not entered
 *
 * The policy rate is `1 / (region.TimestepS * Decimation)`. A `RateHz` field
 * would be a third number an author can set against the other two, so there is
 * none; instead the rate is displayed next to the input it derives from, read
 * live from the enclosing `WebMuJoCoRegion`. No region → no timestep → no rate
 * to state, and the renderer says so instead of inventing one.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { ReorderableList, type ReorderableListItem } from './ReorderableList';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import type { ComponentRef } from '../engine/rv-node-registry';
import { isComponentReference, storedReferenceLabel, storedReferenceValue } from '../engine/rv-node-path-rewrite.mjs';
import { assetRelativePath } from '../engine/rv-reference-resolver';
import { authoredAssetRelativePath } from './rv-reference-field';
import { EMPTY_SNAPSHOT } from '../engine/rv-selection-manager';
import { enclosingMuJoCoRegion } from '../engine/rv-mujoco-region';
import { NumberEditor } from './rv-field-editors';
import { InspectorRow } from './rv-inspector-row';
import { FS, INK_LOW } from './shared-sx';

/** The wire `componentType` a drive reference carries. */
const DRIVE_TYPE = 'realvirtual.Drive';

function lastSeg(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function isRef(v: unknown): v is ComponentRef {
  return isComponentReference(v);
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

export function LocomotionPolicyAxesRenderer({ value, fieldName, componentType, nodePath, viewer }: FieldRendererProps) {
  const initial = Array.isArray(value) ? (value as unknown[]) : [];
  const [order, setOrder] = useState<unknown[]>(initial);

  useEffect(() => {
    setOrder(Array.isArray(value) ? (value as unknown[]) : []);
  }, [value]);

  const selection = useSyncExternalStore(
    viewer ? viewer.selectionManager.subscribe : noopSubscribe,
    viewer ? viewer.selectionManager.getSnapshot : emptySnapshot,
  );
  const primaryPath = selection.primaryPath;
  const registry = viewer?.registry ?? null;
  const ownerNode = registry?.getNode(nodePath) ?? null;

  // Resolve each entry to its CURRENT node path, so the selection highlight and
  // click-to-select survive the loader's dedup renames. A NON-reference entry is
  // kept in place and labelled — never filtered away, which is the explicit
  // counter-test to today's silent `RobotIK.Axis` drop.
  const resolved = order.map((entry) => {
    if (!isRef(entry)) {
      return { curPath: typeof entry === 'string' ? entry : '(not a reference)', missing: true, bad: true };
    }
    const written = entry.path ?? storedReferenceLabel(entry) ?? '';
    const node = !registry ? null
      : typeof entry.path === 'string'
        ? (registry.resolvePath(entry.path, ownerNode) ?? registry.getNode(entry.path))
        : (ownerNode ? registry.storedNode(ownerNode, storedReferenceValue(entry)) : null);
    const curPath = node ? (registry?.getPathForNode(node) ?? written) : written;
    return { curPath, missing: !node, bad: false };
  });

  const items: ReorderableListItem[] = resolved.map((r, i) => ({
    id: `${i}:${r.curPath}`,
    label: lastSeg(r.curPath) || '(empty)',
    // The index IS the actuator index, so naming the failure right on the row is
    // the whole value of the list.
    sublabel: r.bad ? 'not a reference' : r.missing ? 'missing' : undefined,
  }));

  const commit = (next: unknown[]): void => {
    const prev = order;
    setOrder(next);
    persistFieldOp(nodePath, componentType, fieldName, next, prev);
  };

  const handleSelect = (i: number): void => {
    const cur = resolved[i]?.curPath;
    if (cur && !resolved[i].bad && viewer) viewer.selectionManager.select(cur);
  };

  const handleAdd = (): void => {
    if (!primaryPath) return;
    let written = primaryPath;
    if (ownerNode && registry) {
      const scope = registry.enclosingScope(ownerNode);
      const target = registry.getNode(primaryPath);
      written = (target ? authoredAssetRelativePath(target, scope.root) : null)
        ?? assetRelativePath(primaryPath, scope);
    }
    if (order.some((e) => isRef(e) && (e.path === written || e.path === primaryPath))) return;
    commit([...order, { type: 'ComponentReference', path: written, componentType: DRIVE_TYPE } as ComponentRef]);
  };

  const selectedIdx = resolved.findIndex((r) => !r.bad && r.curPath === primaryPath);

  return (
    <Box>
      <ReorderableList
        title={fieldName}
        items={items}
        onReorder={(from, to) => {
          const next = [...order];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          commit(next);
        }}
        onSelect={handleSelect}
        onRemove={(i) => commit(order.filter((_, j) => j !== i))}
        selectedId={selectedIdx >= 0 ? `${selectedIdx}:${primaryPath}` : null}
        emptyText="No axes — the policy drives nothing"
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          disabled={!primaryPath}
          onClick={handleAdd}
          data-testid="policy-axes-add"
          sx={{ fontSize: FS.label, textTransform: 'none' }}
        >
          Add selected drive
        </Button>
      </Box>
    </Box>
  );
}

/** `Decimation` with the derived policy rate as a read-only caption. */
export function LocomotionPolicyDecimationRenderer({ value, fieldName, componentType, nodePath, viewer }: FieldRendererProps) {
  const current = typeof value === 'number' && Number.isFinite(value) ? value : 4;
  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const region = enclosingMuJoCoRegion(node);
  const rateHz = region ? region.policyRateHz(current) : null;

  return (
    <InspectorRow
      label={fieldName}
      labelTitle={`${fieldName} — physics steps per policy step`}
      alignField="stretch"
      trailing={
        <Tooltip title={rateHz === null
          ? 'No enclosing WebMuJoCoRegion, so there is no timestep and no rate'
          : 'Derived: 1 / (region TimestepS × Decimation) — never entered'}
        >
          <Typography
            data-testid="policy-rate-hz"
            sx={{ fontSize: FS.micro, color: INK_LOW, whiteSpace: 'nowrap', ml: 0.5 }}
          >
            {rateHz === null ? 'no region' : `${rateHz.toFixed(rateHz >= 100 ? 0 : 1)} Hz`}
          </Typography>
        </Tooltip>
      }
    >
      <NumberEditor
        value={current}
        onChange={(v) => persistFieldOp(nodePath, componentType, fieldName, Math.max(1, Math.round(v)), value)}
        min={1}
        step={1}
        ariaLabel={fieldName}
      />
    </InspectorRow>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'LocomotionPolicy',
  fieldName: 'Axes',
  component: LocomotionPolicyAxesRenderer,
});
fieldRendererRegistry.register({
  componentType: 'LocomotionPolicy',
  fieldName: 'Decimation',
  component: LocomotionPolicyDecimationRenderer,
});
