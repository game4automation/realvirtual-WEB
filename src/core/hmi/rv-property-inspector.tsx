// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PropertyInspector — Editable property panel for the selected hierarchy node.
 *
 * Shows component properties grouped by type (Drive, Sensor, TransportSurface, etc.).
 * - CONSUMED fields: editable with appropriate widgets
 * - IGNORED / unknown fields: read-only, grayed out with "Not used" tooltip
 * - Override indicators: blue dot for fields that differ from GLB defaults
 * - Per-field and per-node reset to GLB defaults
 * - LogicStep runtime status section (state, progress, cycle stats)
 *
 * Positioned to the right of the hierarchy panel when a node is selected.
 *
 * Sub-modules:
 * - rv-inspector-helpers.ts  — Pure functions + constants (shared with hierarchy browser)
 * - rv-field-editors.tsx     — Inline editor widgets (Number, Boolean, Enum, etc.)
 * - rv-reference-display.tsx — ComponentReference and ScriptableObject badges
 * - rv-field-row.tsx         — Single field row component
 * - rv-component-section.tsx — Collapsible component section
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSignalTick } from '../../hooks/use-signal-tick';
import { useChangeGatedTick } from '../../hooks/use-change-gated-tick';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { MathUtils } from 'three';
import type { Object3D } from 'three';
import { RV_SYNTHETIC_KEY } from '../engine/rv-bake-chunk';
import { DIVIDER, FS, ICON_SIZE, LINK, OCCUPIED, RV_SCROLL_CLASS, SUCCESS, WARN, WARN_LIGHT } from './shared-sx';
import { InspectorSubheader } from './rv-inspector-blocks';
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  Button,
  Chip,
  LinearProgress,
} from '@mui/material';
import {
  RestartAlt,
  FilterList,
  Lock,
  LockOpen,
  SwapHoriz,
  OpenInNew,
  PushPin,
  Visibility,
  VisibilityOff,
} from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { LayoutPlannerPlugin } from '../../plugins/layout-planner';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import { getOverriddenFields } from '../engine/rv-extras-overlay-store';
import {
  overrideTargetOf,
  revertComponentOverride,
  writeOverride,
} from '../ops/rv-reference-guard';
import { referenceOverriddenFields } from './rv-field-override';
import { USER_PAUSE_REASON } from '../engine/rv-constants';
import { LeftPanel } from './LeftPanel';
import { AasDetailHeaderAction } from '../../plugins/aas-link-plugin';
import { FloatingPanel } from './FloatingPanel';
import { INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH, ACTIVITY_BAR_WIDTH } from './layout-constants';
import {
  isHiddenComponentType,
  componentColor,
  extractComponentTypes,
  type ReverseReference,
} from './rv-inspector-helpers';
import { getPrimaryDisplayValue, applyLiveEdit, getLiveStateFor } from './rv-value-resolver';
import { FMU_TYPE } from '../engine/rv-fmu-constants';
import { navigateToRef } from './rv-reference-display';
import { ComponentSection, runtimeRow } from './rv-component-section';
import { AddComponentSection } from './rv-add-component-section';
import { buildBehaviorVirtualComponent, behaviorDisplayName, collectBehaviorData, type BehaviorViewerSnapshot } from './inspector-behavior-section';
import { BehaviorSignalSlots } from '../../plugins/signal-bind/InlineSignalSlots';
import { ConnectionsSection } from './rv-connections-section';
import { findLayoutRoot } from './layout-root-utils';
import { findPickOwner } from '../engine/rv-pick-owner';
import { isModelRoot } from '../engine/rv-model-root';
import { collectNodeMeshInfo, type NodeMeshEntry } from '../engine/rv-node-mesh-info';
import { buildBakedGeometryVirtualComponent } from './rv-baked-geometry-section';
import { getCapabilities } from '../engine/rv-component-registry';
import { Vector3Editor } from './rv-field-editors';
import { InspectorRow } from './rv-inspector-row';
import { StepState } from '../engine/rv-logic-step';
import type { StepStateInfo } from '../engine/rv-logic-engine';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';
import { PROVENANCE_REFERENCED_TITLE } from './signal-vocabulary';
import { SignalUsageSection } from './rv-signal-usage-list';
import { signalNameForPath } from './use-signal-usages';
import { isSignalComponentTypeKey } from '../engine/rv-node-registry';

// Re-export isHiddenComponentType for backward compatibility
export { isHiddenComponentType } from './rv-inspector-helpers';

// ── Consumed-only filter persistence ────────────────────────────────────

const LS_KEY_CONSUMED_ONLY = 'rv-inspector-consumed-only';
const LS_KEY_DETACHED = 'rv-inspector-detached';

function loadConsumedOnly(): boolean {
  // Default ON: hide non-consumed ("N more fields") diagnostic fields until the
  // user opts into the full dump via the toggle. A stored preference wins.
  try {
    const v = localStorage.getItem(LS_KEY_CONSUMED_ONLY);
    return v === null ? true : v === 'true';
  }
  catch { return true; }
}

function loadDetached(): boolean {
  try { return localStorage.getItem(LS_KEY_DETACHED) === 'true'; }
  catch { return false; }
}

// ── Stable no-ops for read-only virtual ComponentSections ────────────────
// Virtual (ephemeral) sections never edit/reset — pass shared frozen handlers
// so they don't allocate a fresh closure per render.
const EMPTY_OVERRIDES: Set<string> = new Set();
// `referenceOverriddenFields` moved to `rv-field-override.ts` (plan-512): the
// unit auto-scale's write rule has to see exactly the override union the dot shows.

/**
 * Drop the instance override for one field — or, with no field, for the whole
 * component.
 *
 * A no-op when the node is not inside a reference, which is the common case;
 * the caller does not branch, so a Revert always means the same thing.
 */
function revertReferenceOverride(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
  fieldName?: string,
): void {
  if (viewer.modes.activeMode === 'viewer') return;
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const target = overrideTargetOf(node, viewer.currentModelRoot ?? null);
  if (!target) return;
  if (fieldName === undefined) {
    revertComponentOverride(target.referenceNode, target.nodeId, componentType);
  } else {
    writeOverride(target.referenceNode, target.nodeId, componentType, fieldName, undefined);
  }
  viewer.markRenderDirty();
}
const NOOP_FIELD_EDIT = (_fieldName: string, _value: unknown): void => { /* read-only */ };
const NOOP_FIELD_RESET = (_fieldName: string): void => { /* read-only */ };
const NOOP_RESET = (): void => { /* read-only */ };

// ── LogicStep Runtime Section ─────────────────────────────────────────────

interface RuntimeFieldRowProps {
  label: string;
  value: string;
  color?: string;
}

function RuntimeFieldRow({ label, value, color }: RuntimeFieldRowProps) {
  return (
    <InspectorRow label={label} labelTitle={label} labelColor="text.disabled" dense minHeight={22} py={0.15}>
      <Typography sx={{ fontSize: FS.micro, color: color ?? 'text.primary', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </Typography>
    </InspectorRow>
  );
}

/** Pure projection of a snap-point registry entry into the inspector rows.
 *  Returns null when the uuid is not a registered snap. Mock-testable without a
 *  React render (plan-200 §9.5 / §10.5). `partnerOwnerRoot` is the partner's
 *  asset root (for a clickable "Paired with" navigation), null when unpaired. */
export function snapInspectorData(
  reg: { getById(id: string): import('../engine/rv-snap-point-registry').SnapPoint | undefined } | null,
  uuid: string,
): { type: string; axis: string; flow: string; state: string; occupied: boolean; pairedWith: string; partnerOwnerRoot: Object3D | null } | null {
  const snap = reg?.getById(uuid) ?? null;
  if (!snap) return null;
  const partner = snap.pairedSnapId ? reg?.getById(snap.pairedSnapId) ?? null : null;
  return {
    type: snap.typeId,
    axis: snap.dir.axis,
    flow: snap.flow === 'in' ? 'Input' : snap.flow === 'out' ? 'Output' : 'Bidirectional',
    state: snap.occupied ? 'Occupied' : 'Free',
    occupied: snap.occupied,
    pairedWith: partner ? (partner.ownerRoot?.name || partner.scenePath || partner.id) : '—',
    partnerOwnerRoot: partner?.ownerRoot ?? null,
  };
}

/** Accent color for an occupied snap (amber). */
const SNAP_OCCUPIED_COLOR = OCCUPIED;

/** Build the read-only-live virtual component for a selected snap Empty, or null
 *  when the node is not a registered snap. Resolves the snap by Object3D.uuid
 *  through the snap-point registry; the "Paired with" row is clickable and
 *  navigates to the partner's component when the partner root is resolvable. */
function buildSnapVirtualComponent(viewer: RVViewer, uuid: string): { type: string; data: Record<string, unknown> } | null {
  const reg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry() ?? null;
  const d = snapInspectorData(reg, uuid);
  if (!d) return null;

  const data: Record<string, unknown> = {
    Type: runtimeRow(d.type),
    Axis: runtimeRow(d.axis),
    Flow: runtimeRow(d.flow),
    State: runtimeRow(d.state, { color: d.occupied ? SNAP_OCCUPIED_COLOR : undefined }),
  };

  // "Paired with" → clickable navigation to the partner component (when paired
  // and the partner root resolves to a registered path).
  const partnerPath = d.partnerOwnerRoot ? viewer.registry?.getPathForNode(d.partnerOwnerRoot) ?? null : null;
  data['Paired with'] = partnerPath
    ? runtimeRow(d.pairedWith, { onClick: () => navigateToRef(viewer, partnerPath) })
    : runtimeRow(d.pairedWith);

  return { type: 'Snap Point', data };
}

/** Rows of the per-node mesh list before the rest collapses into one "+N" row
 *  (a baked model root owns every static chunk). */
const MESH_ROWS_MAX = 6;

const MESH_KIND_LABELS: Record<NodeMeshEntry['kind'], string> = {
  own: 'Mesh',
  chunk: 'Chunk',
  window: 'Chunk window',
};

/** Pure projection of a node's mesh entries into inspector rows (label → text),
 *  in display order. The own mesh gets the full read-out, chunks and chunk
 *  windows one row each. Testable without a React render. */
export function meshInspectorRows(entries: readonly NodeMeshEntry[]): Array<[string, string]> {
  const n = (v: number): string => v.toLocaleString('en-US');
  const rows: Array<[string, string]> = [];
  const rest = entries.filter((e) => e.kind !== 'own');
  const own = entries.find((e) => e.kind === 'own');
  if (own) {
    rows.push(['Geometry', own.block]);
    rows.push(['Triangles', n(own.triangles)]);
    if (own.vertices !== null) rows.push(['Vertices', n(own.vertices)]);
    if (own.materials.length > 0) rows.push(['Material', own.materials.join(', ')]);
    if (own.attributes.length > 0) rows.push(['Attributes', own.attributes.join(', ')]);
  }
  rest.slice(0, MESH_ROWS_MAX).forEach((e, i) => {
    const parts = [e.name, `${n(e.triangles)} tris`];
    if (e.range) parts.push(`idx ${n(e.range.indexStart)} +${n(e.range.indexCount)}`);
    rows.push([`${MESH_KIND_LABELS[e.kind]} ${i + 1}`, parts.join(' · ')]);
  });
  if (rest.length > MESH_ROWS_MAX) rows.push(['More', `+${rest.length - MESH_ROWS_MAX}`]);
  return rows;
}

function LogicStepRuntimeSection({ info }: { info: StepStateInfo }) {
  const stateColor = STEP_STATE_COLORS[info.state];
  const stateLabel = STEP_STATE_LABELS[info.state];

  return (
    <Box sx={{ borderBottom: `1px solid ${DIVIDER}` }}>
      {/* Section header — the shared InspectorSubheader with the state as accent (plan-510). */}
      <InspectorSubheader
        accent={stateColor}
        dot={<Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: stateColor, flexShrink: 0 }} />}
        trailing={
          <Typography sx={{ fontSize: FS.micro, color: stateColor, fontWeight: 600 }}>
            {stateLabel}
          </Typography>
        }
      >
        Runtime Status
      </InspectorSubheader>

      {/* Runtime fields */}
      <Box sx={{ py: 0.5 }}>
        <RuntimeFieldRow label="State" value={info.state} color={stateColor} />
        {info.reason === 'suppressed-live' && (
          <RuntimeFieldRow label="Control" value="Live-controlled" color={WARN_LIGHT} />
        )}
        <RuntimeFieldRow label="Type" value={info.type} />

        {/* Progress bar — an InspectorRow like its siblings (plan-514: no private
            100 px label column), the bar + percentage in the value column. */}
        <InspectorRow label="Progress" labelTitle="Progress" labelColor="text.disabled" dense minHeight={22} py={0.15}>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, info.progress)}
              sx={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                bgcolor: DIVIDER,
                '& .MuiLinearProgress-bar': { bgcolor: stateColor, borderRadius: 2 },
              }}
            />
            <Typography sx={{ fontSize: FS.micro, color: 'text.secondary', minWidth: 28, textAlign: 'right' }}>
              {info.progress.toFixed(0)}%
            </Typography>
          </Box>
        </InspectorRow>

        {/* SerialContainer-specific fields */}
        {info.type === 'SerialContainer' && (
          <>
            {info.currentIndex !== undefined && info.childCount !== undefined && (
              <RuntimeFieldRow label="Current Step" value={`${info.currentIndex + 1} / ${info.childCount}`} />
            )}
            {info.completedCycles !== undefined && (
              <RuntimeFieldRow label="Completed Cycles" value={info.completedCycles.toString()} />
            )}
            {info.minCycleTime !== undefined && info.minCycleTime > 0 && (
              <RuntimeFieldRow label="Min Cycle Time" value={`${info.minCycleTime.toFixed(3)}s`} />
            )}
            {info.maxCycleTime !== undefined && info.maxCycleTime > 0 && (
              <RuntimeFieldRow label="Max Cycle Time" value={`${info.maxCycleTime.toFixed(3)}s`} />
            )}
            {info.medianCycleTime !== undefined && info.medianCycleTime > 0 && (
              <RuntimeFieldRow label="Median Cycle Time" value={`${info.medianCycleTime.toFixed(3)}s`} />
            )}
          </>
        )}

        {/* ParallelContainer-specific fields */}
        {info.type === 'ParallelContainer' && info.finishedCount !== undefined && info.childCount !== undefined && (
          <RuntimeFieldRow label="Finished" value={`${info.finishedCount} / ${info.childCount}`} />
        )}

        {/* Delay-specific fields */}
        {info.type === 'Delay' && info.elapsed !== undefined && info.duration !== undefined && (
          <RuntimeFieldRow label="Elapsed" value={`${info.elapsed.toFixed(2)}s / ${info.duration.toFixed(2)}s`} />
        )}
      </Box>
    </Box>
  );
}

// ── Layout Transform Section ─────────────────────────────────────────────

/** Below this a transform change cannot alter any rendered figure (the section
 *  prints 4 decimals for millimetres and 2 for degrees), so it must not cost a
 *  React commit. Compared component-wise on numbers — never by object identity,
 *  because three.js mutates `position`/`rotation`/`scale` in place. */
const TRANSFORM_EPSILON = 1e-6;

/**
 * Flat numeric fingerprint of everything {@link LayoutTransformSection} renders
 * from the live node: position (x/y/z), Euler rotation (x/y/z), scale (x/y/z)
 * and the `visible` flag driving the header's eye icon. Missing node → null.
 *
 * Scale is included even though the section has no scale editor today: the
 * fingerprint is the contract "nothing this node shows has changed", and a
 * future scale row must not silently freeze. `visible` is included because the
 * header reads `node.visible` directly and an external hide/show carries no
 * other notification.
 */
function readTransformSignature(node: Object3D | undefined | null): readonly number[] | null {
  if (!node) return null;
  return [
    node.position.x, node.position.y, node.position.z,
    node.rotation.x, node.rotation.y, node.rotation.z,
    node.scale.x, node.scale.y, node.scale.z,
    node.visible ? 1 : 0,
  ];
}

/** Component-wise comparison of two transform fingerprints within {@link TRANSFORM_EPSILON}. */
function transformSignaturesEqual(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > TRANSFORM_EPSILON) return false;
  }
  return true;
}

/**
 * Fingerprint of every value the inspector shows that changes WITHOUT touching
 * the SignalStore (plan-344 Phase 3.1) — the gate for the non-signal live tick.
 *
 * Two sources, and deliberately only these two, because they are exactly what
 * gets rendered:
 *  1. `getLiveState()` of each live component on the selected node. For a Drive
 *     that is `CurrentPosition`/`CurrentSpeed`/`IsRunning`/`IsAtTarget`/targets/
 *     jog flags; for a TransportSurface its `Speed`.
 *  2. When a behavior LayoutObject root is selected, the collected behavior
 *     read-out — the scoped `Flow.*` states plus EVERY drive and sensor in the
 *     subtree (speed + direction / occupied). This is the one surface that shows
 *     CHILD drives, so it is the one that must include them or their read-out
 *     would freeze.
 *
 * Returned as a string so the comparison is a single `===` with no allocation
 * bookkeeping on the caller's side.
 */
function readLiveSignature(
  viewer: RVViewer,
  nodePath: string,
  liveComponentTypes: readonly string[],
  behaviorRootNode: Object3D | null,
): string {
  const parts: string[] = [];
  for (const type of liveComponentTypes) {
    const live = getLiveStateFor(viewer, nodePath, type);
    // The section header's value (Drive position, FMU state) is part of what the
    // inspector DISPLAYS — without it an FMU going running → idle never re-renders
    // the header once its drive stands still.
    const header = getPrimaryDisplayValue(viewer, nodePath, type, {}).text ?? '';
    parts.push(`${type}=${live ? JSON.stringify(live) : ''}|${header}`);
  }
  if (behaviorRootNode) {
    const d = collectBehaviorData(viewer as unknown as BehaviorViewerSnapshot, behaviorRootNode);
    parts.push(`behavior=${JSON.stringify(d)}`);
  }
  return parts.join(';');
}

interface LayoutTransformSectionProps {
  // Re-declared inline so this section is self-contained; viewer + nodePath
  // are required for transform read/write, the rest are inspector-level
  // wiring callbacks.
  viewer: RVViewer;
  nodePath: string;
  /** The object to read, when it has no path to look up by — an unregistered
   *  node the hierarchy selected (plan-754 D2). Always read-only in that case. */
  node?: import('three').Object3D | null;
  locked: boolean;
  /** The lock is a PROPERTY of the node, not a user setting — hide the toggle
   *  entirely (the model root, plan-715). A disabled toggle would invite the
   *  question "how do I unlock it", which has no answer. */
  lockFixed?: boolean;
  onToggleLock?: () => void;
  /** Toggle for the universal Visible flag — rendered next to the lock
   *  icon in the section header. Receives the new desired value. */
  onToggleVisible?: (next: boolean) => void;
  /** Reverse-direction action — rotates the asset 180° around its
   *  connected snap-point's outward axis. Only shown when the asset is
   *  part of at least one paired snap-point chain. */
  onReverseDirection?: () => void;
  /** Whether the asset has any paired snap (= the Reverse button should
   *  be enabled). When false the button is hidden entirely. */
  canReverse?: boolean;
}

function LayoutTransformSection({ viewer, nodePath, node: nodeOverride, locked, lockFixed, onToggleLock, onToggleVisible, onReverseDirection, canReverse }: LayoutTransformSectionProps) {
  const node = nodeOverride ?? viewer.registry?.getNode(nodePath);

  // Poll position/rotation at 200 ms for live updates (e.g. during a
  // TransformControls drag) — but ONLY commit when something the section
  // actually renders has moved (plan-344 Phase 3.1). The previous version bumped
  // state unconditionally, so a completely static scene still re-rendered this
  // section 5×/s forever. `nodePath` as resetKey re-baselines on selection change
  // and clears the old interval.
  const tick = useChangeGatedTick({
    read: () => readTransformSignature(nodeOverride ?? viewer.registry?.getNode(nodePath)),
    equal: transformSignaturesEqual,
    resetKey: nodePath || nodeOverride?.uuid || '',
  });

  const pos = useMemo(() => {
    if (!node) return { x: 0, y: 0, z: 0 };
    return { x: +node.position.x.toFixed(4), y: +node.position.y.toFixed(4), z: +node.position.z.toFixed(4) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, tick]);

  const rot = useMemo(() => {
    if (!node) return { x: 0, y: 0, z: 0 };
    return {
      x: +MathUtils.radToDeg(node.rotation.x).toFixed(2),
      y: +MathUtils.radToDeg(node.rotation.y).toFixed(2),
      z: +MathUtils.radToDeg(node.rotation.z).toFixed(2),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, tick]);

  const emitTransformUpdate = useCallback(() => {
    if (!node) return;
    // Auto-stop the simulation when the user changes a layout object's
    // transform. Uses the user-owned pause reason so Play / Space resumes it.
    viewer.setSimulationPaused?.(USER_PAUSE_REASON, true);
    viewer.markRenderDirty();
    viewer.emit('layout-transform-update', {
      path: nodePath,
      position: [node.position.x, node.position.y, node.position.z] as [number, number, number],
      rotation: [
        MathUtils.radToDeg(node.rotation.x),
        MathUtils.radToDeg(node.rotation.y),
        MathUtils.radToDeg(node.rotation.z),
      ] as [number, number, number],
    });
  }, [node, nodePath, viewer]);

  const handlePositionChange = useCallback((v: { x: number; y: number; z: number }) => {
    if (!node || locked) return;
    node.position.set(v.x, v.y, v.z);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleRotationChange = useCallback((v: { x: number; y: number; z: number }) => {
    if (!node || locked) return;
    node.rotation.set(MathUtils.degToRad(v.x), MathUtils.degToRad(v.y), MathUtils.degToRad(v.z));
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleResetPosition = useCallback(() => {
    if (!node || locked) return;
    node.position.set(0, 0, 0);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  const handleResetRotation = useCallback(() => {
    if (!node || locked) return;
    node.rotation.set(0, 0, 0);
    node.updateMatrixWorld(true);
    emitTransformUpdate();
  }, [node, locked, emitTransformUpdate]);

  if (!node) return null;

  const labelColor = locked ? 'text.disabled' : 'text.secondary';
  const resetBtnSx = { p: 0.15, color: 'text.disabled', flexShrink: 0, '&:hover': { color: WARN } };

  return (
    <Box sx={{ borderBottom: `1px solid ${DIVIDER}` }}>
      <InspectorSubheader
        accent={LINK}
        trailing={<Box sx={{ display: 'flex', alignItems: 'center' }}>
        {/* Reverse direction — rotates the asset 180° around its connected
            snap-point's outward axis. Only visible when the asset is part of
            a snap-chain (`canReverse` true). Sits before the visibility
            toggle so the most-disruptive geometric action is leftmost in the
            cluster of icons. */}
        {onReverseDirection && canReverse && (
          <Tooltip title="Reverse direction (rotate 180° around connection)">
            <IconButton
              size="small"
              onClick={onReverseDirection}
              sx={{ p: 0.25, mr: 0.25, color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
            >
              <SwapHoriz sx={{ fontSize: ICON_SIZE.sm }} />
            </IconButton>
          </Tooltip>
        )}
        {/* Visibility toggle — sits next to the lock icon so both
            object-level flags are reachable from the section header. */}
        {onToggleVisible && (
          <Tooltip title={node.visible ? 'Hide object' : 'Show object'}>
            <IconButton
              size="small"
              onClick={() => onToggleVisible(!node.visible)}
              sx={{ p: 0.25, mr: 0.25, color: node.visible ? 'primary.main' : 'text.disabled', '&:hover': { color: node.visible ? 'primary.light' : 'text.primary' } }}
            >
              {node.visible ? <Visibility sx={{ fontSize: ICON_SIZE.sm }} /> : <VisibilityOff sx={{ fontSize: ICON_SIZE.sm }} />}
            </IconButton>
          </Tooltip>
        )}
        {lockFixed ? (
          <Tooltip title="Model root — always at the asset origin, not editable">
            <Lock sx={{ fontSize: ICON_SIZE.sm, color: 'text.disabled', mx: 0.25 }} />
          </Tooltip>
        ) : (
          <Tooltip title={locked ? 'Unlock object' : 'Lock object'}>
            <IconButton
              size="small"
              onClick={onToggleLock}
              sx={{ p: 0.25, color: locked ? WARN : 'text.secondary', '&:hover': { color: locked ? WARN_LIGHT : 'text.primary' } }}
            >
              {locked ? <Lock sx={{ fontSize: ICON_SIZE.sm }} /> : <LockOpen sx={{ fontSize: ICON_SIZE.sm }} />}
            </IconButton>
          </Tooltip>
        )}
        </Box>}
      >
        Transform
      </InspectorSubheader>
      <Box sx={{ py: 0.5, opacity: locked ? 0.5 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
        <InspectorRow
          fullWidthField
          label="Position"
          labelColor={labelColor}
          py={0.25}
          trailing={
            <Tooltip title="Reset position to 0,0,0">
              <IconButton size="small" onClick={handleResetPosition} sx={resetBtnSx}>
                <RestartAlt sx={{ fontSize: ICON_SIZE.xs }} />
              </IconButton>
            </Tooltip>
          }
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Vector3Editor value={pos} onChange={handlePositionChange} />
          </Box>
        </InspectorRow>
        <InspectorRow
          fullWidthField
          label="Rotation"
          labelColor={labelColor}
          py={0.25}
          trailing={
            <Tooltip title="Reset rotation to 0,0,0">
              <IconButton size="small" onClick={handleResetRotation} sx={resetBtnSx}>
                <RestartAlt sx={{ fontSize: ICON_SIZE.xs }} />
              </IconButton>
            </Tooltip>
          }
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Vector3Editor value={rot} onChange={handleRotationChange} />
          </Box>
        </InspectorRow>
      </Box>
    </Box>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export interface PropertyInspectorProps {
  viewer: RVViewer;
}

/**
 * The path the inspector may WRITE against for a selection, or null.
 *
 * plan-755 F9: a node the bake created (`userData._rvSynthetic` — a partition
 * object) is registered and HAS a path, but it stands in no document and is
 * rebuilt by every bake, so an override written against it would address
 * nothing on the next load. It therefore takes the runtime-selection branch:
 * fields visible, nothing editable, no `writeOverride`.
 */
export function inspectorWritePath(node: Object3D | null | undefined, path: string | null | undefined): string | null {
  if (!node || !path) return null;
  if ((node.userData as Record<string, unknown> | undefined)?.[RV_SYNTHETIC_KEY] === true) return null;
  return path;
}

export function PropertyInspector({ viewer }: PropertyInspectorProps) {
  const { plugin, state } = useEditorPlugin();
  const selectedNode = state.selectedNode;
  const selectedPath = inspectorWritePath(selectedNode, state.selectedNodePath);
  /**
   * The selection is a node the document does not address (plan-754 D2): a
   * chunk mesh, a light, a hover overlay. Everything that WRITES here goes
   * through a path — the overlay, the op log, Add Component — so the inspector
   * shows what such a node IS (transform, geometry) and nothing that pretends
   * it could be edited.
   */
  const isRuntimeSelection = !!selectedNode && !selectedPath;

  // Read the selected node's userData
  const nodeData = useMemo(() => {
    const node = selectedNode;
    if (!node) return null;

    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    // A node without rv_extras (e.g. a snap-point Empty) still gets an inspector
    // card — it shows no real component sections but may carry a read-only "Snap
    // Point" virtual component. Only a missing node returns null; an extras-less
    // node returns empty components.
    if (!rv) return { components: [], layoutObj: undefined, uuid: node.uuid };

    // Collect component types and their data (skip hidden types)
    const components: Array<{ type: string; data: Record<string, unknown> }> = [];
    for (const [key, value] of Object.entries(rv)) {
      if (isHiddenComponentType(key)) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        components.push({ type: key, data: value as Record<string, unknown> });
      }
    }

    // Detect LayoutObject for transform editing
    const layoutObj = rv.LayoutObject as Record<string, unknown> | undefined;

    return { components, layoutObj, uuid: node.uuid };
    // Depend on `state` so the component objects are re-collected from userData
    // after every edit (notify() produces a fresh snapshot). An edit replaces
    // the touched component object with a new identity (applyFieldToScene), so
    // re-collecting here propagates that new reference to ComponentSection,
    // whose field rows are memoised on the `data` reference. Unchanged
    // components keep their identity, so their child memos stay stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, state]);

  // Check if the selected node has a LayoutObject (for transform section)
  // Re-read Locked from live userData on any state change (state is always a new ref after notify())
  const hasLayoutObject = !!nodeData?.layoutObj;
  const layoutLocked = useMemo(() => {
    const rv = selectedNode?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return !!(rv?.LayoutObject?.Locked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, state]);

  /**
   * The selected node is the GLB root (plan-715).
   *
   * It gets the SAME Transform section as a placed LayoutObject, permanently
   * locked: the numbers are worth reading (they are the asset's 0,0,0 promise)
   * and must not be editable, because moving the root would move the whole file
   * relative to its own origin. Only the transform is frozen — components and
   * metadata below stay fully editable, which is the point of making the root
   * addressable in the first place.
   */
  const isRootSelected = useMemo(
    () => isModelRoot(selectedNode, viewer.currentModelRoot),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedNode, viewer, state],
  );

  // Geometry the selected node carries (own mesh, attached chunks, chunk
  // windows) — null for a plain group. The bake revision covers the draw state
  // changing under a standing selection (placement baked / released, the
  // loader bake landing late).
  const bakeRevision = useChangeGatedTick({
    read: () => viewer.bakeRegistry.revision,
    resetKey: selectedNode?.uuid ?? '',
  });
  const meshRows = useMemo(() => {
    const entries = selectedNode ? collectNodeMeshInfo(selectedNode, viewer.bakeRegistry) : [];
    return entries.length > 0 ? meshInspectorRows(entries) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, viewer, state, bakeRevision]);

  // Check if the selected node has a LogicStep component
  const hasLogicStep = nodeData?.components.some(c => c.type.startsWith('LogicStep_')) ?? false;

  // Get logic step runtime info
  const logicEngine = viewer.logicEngine;
  const stepInfo = hasLogicStep && logicEngine && selectedPath
    ? logicEngine.getStepInfo(selectedPath)
    : null;

  // plan-566: a selected SIGNAL node gets the "Used by" cross-reference list.
  const selectedSignalName = useMemo(() => {
    if (!nodeData?.components.some((c) => isSignalComponentTypeKey(c.type))) return null;
    return signalNameForPath(viewer, selectedPath);
  }, [nodeData, viewer, selectedPath]);

  // Find reverse references: who points to this node via ComponentReference?
  // Uses the pre-built index in NodeRegistry (O(1) lookup instead of full scene scan).
  const referencedBy = useMemo<readonly ReverseReference[]>(() => {
    if (!selectedPath || !viewer.registry) return [];
    return viewer.registry.getReferencesTo(selectedPath);
  }, [selectedPath, viewer.registry]);

  // Owning component node for exact-node picks: when a component-less mesh is
  // selected (editor picking resolves to the exact node), surface the nearest
  // ancestor carrying components (e.g. the Drive of an axis sub-mesh) as a
  // clickable breadcrumb chip. Null when the node is its own owner.
  const pickOwner = useMemo(() => {
    if (!selectedNode || !viewer.registry) return null;
    const owner = findPickOwner(selectedNode, viewer.registry);
    return owner && owner.node !== selectedNode ? owner : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, viewer.registry, state]);

  // Behavior States+Hardware gate: the stamped behavior marker is
  // ui.hidden, so it no longer appears in nodeData.components.
  // Detect it by scanning the SELECTED node's RAW userData (filterHidden:false)
  // for a component whose capability ui.filter is 'Behavior'.
  //
  // The gate matches ONLY when the LayoutObject ROOT ITSELF is selected
  // (`findLayoutRoot(node) === node`) — not a snap-point child or any other
  // descendant, which would otherwise spuriously surface the behavior section.
  // Returns the marker type (e.g. `ConveyorBehavior`) used as the virtual
  // component's header name, or null.
  const behaviorRoot = useMemo<{ root: import('three').Object3D; markerType: string } | null>(() => {
    if (!selectedNode) return null;
    // Only when the LayoutObject root itself is the selected node.
    if (findLayoutRoot(selectedNode) !== selectedNode) return null;
    const rootRv = selectedNode.userData?.realvirtual;
    const rawTypes = extractComponentTypes(rootRv, { filterHidden: false });
    const markerType = rawTypes.find(t => getCapabilities(t).ui.filter === 'Behavior');
    return markerType ? { root: selectedNode, markerType } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, state]);

  // Count total overrides for this node
  const totalOverrides = useMemo(() => {
    if (!selectedPath || !state.overlay) return 0;
    const nodeOverrides = state.overlay.nodes[selectedPath];
    if (!nodeOverrides) return 0;
    let count = 0;
    for (const comp of Object.values(nodeOverrides)) {
      count += Object.keys(comp).length;
    }
    return count;
  }, [selectedPath, state.overlay]);

  const handleFieldEdit = useCallback(
    (componentType: string, fieldName: string, value: unknown) => {
      if (!selectedPath || !plugin) return;

      // Splat.Invert* / Crop* persist through the normal overlay path (same
      // as Drive.Speed etc.), but the gaussian-splat library renders splats
      // through its own pipeline and ignores the container's scale, so we
      // also push the new state into the library's splatMesh directly.
      // - Invert{X,Y,Z}     → setSplatScale (mirror via negative scale)
      // - Crop{Min,Max}{XYZ} → setSplatCrop (shader uniforms for AABB clip)
      if (componentType === 'Splat' && viewer.registry) {
        plugin.updateOverlayField(selectedPath, componentType, fieldName, value);
        const node = selectedNode;
        if (node?.userData?._isSplat) {
          const splat = node.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
          const splatPlugin = viewer.getPlugin('gaussian-splat') as unknown as {
            setSplatScale?(container: import('three').Group, scale: readonly [number, number, number]): void;
            setSplatCrop?(container: import('three').Group, box: { min: readonly [number, number, number]; max: readonly [number, number, number] }): void;
          } | undefined;
          if (fieldName === 'InvertX' || fieldName === 'InvertY' || fieldName === 'InvertZ') {
            const sx = splat?.Splat?.InvertX ? -1 : 1;
            const sy = splat?.Splat?.InvertY ? -1 : 1;
            const sz = splat?.Splat?.InvertZ ? -1 : 1;
            splatPlugin?.setSplatScale?.(node as import('three').Group, [sx, sy, sz]);
          } else if (fieldName.startsWith('CropMin') || fieldName.startsWith('CropMax')) {
            const NO_CROP = 1e6;
            const num = (k: string, fallback: number): number => {
              const v = splat?.Splat?.[k];
              return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
            };
            splatPlugin?.setSplatCrop?.(node as import('three').Group, {
              min: [num('CropMinX', -NO_CROP), num('CropMinY', -NO_CROP), num('CropMinZ', -NO_CROP)],
              max: [num('CropMaxX',  NO_CROP), num('CropMaxY',  NO_CROP), num('CropMaxZ',  NO_CROP)],
            });
          }
          viewer.markRenderDirty();
        }
        return;
      }

      // Side-effect for LayoutObject.Visible/Locked: also mutate node.visible
      // so the change is immediately visible in the 3D view. The overlay
      // update below persists the value the regular way.
      if (componentType === 'LayoutObject') {
        const node = selectedNode;
        if (node) {
          if (fieldName === 'Visible') {
            node.visible = !!value;
            // markShadowsDirty (not markRenderDirty): syncs BatchedMesh
            // per-instance visibility and rebuilds the shadow map.
            viewer.markShadowsDirty();
          }
          // Locked needs no side-effect — gizmo / drag logic reads
          // userData.realvirtual.LayoutObject.Locked directly each frame.
        }
      }

      plugin.updateOverlayField(selectedPath, componentType, fieldName, value);

      // Push the edit into the live component instance too, so a field that is
      // part of the component's live state (e.g. Drive.TargetSpeed) takes
      // effect and displays immediately instead of waiting for a scene reload.
      // No-op for non-live / non-owner components.
      applyLiveEdit(viewer, selectedPath, componentType, fieldName, value);
    },
    [plugin, selectedPath, selectedNode, viewer],
  );

  const handleFieldReset = useCallback(
    (componentType: string, fieldName: string) => {
      if (!selectedPath || !plugin) return;
      // Revert the instance override first, then the overlay one. Both, not
      // either: a field can legitimately carry one of each, and a Revert that
      // cleared only the nearer of the two would look like it had failed.
      revertReferenceOverride(viewer, selectedPath, componentType, fieldName);
      plugin.resetField(selectedPath, componentType, fieldName);
    },
    [plugin, selectedPath, viewer],
  );

  const handleComponentReset = useCallback(
    (componentType: string) => {
      if (!selectedPath || !plugin) return;
      revertReferenceOverride(viewer, selectedPath, componentType);
      plugin.resetComponent(selectedPath, componentType);
    },
    [plugin, selectedPath, viewer],
  );

  const handleResetAll = useCallback(() => {
    if (!selectedPath || !plugin) return;
    plugin.resetNode(selectedPath);
  }, [plugin, selectedPath]);

  const handleClose = useCallback(() => {
    if (!plugin) return;
    plugin.clearSelection();
  }, [plugin]);

  // Consumed-only filter: hide non-consumed (grayed-out) fields
  const [consumedOnly, setConsumedOnly] = useState(loadConsumedOnly);
  const toggleConsumedOnly = useCallback(() => {
    setConsumedOnly(prev => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_CONSUMED_ONLY, String(next)); } catch { /* */ }
      return next;
    });
  }, []);

  // Detached (floating) mode
  const [detached, setDetached] = useState(loadDetached);
  const toggleDetached = useCallback(() => {
    setDetached(prev => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_DETACHED, String(next)); } catch { /* */ }
      return next;
    });
  }, []);

  // Shared signal polling for live display in signal reference badges (consolidated via hook)
  const signalStore = viewer.signalStore;
  useSignalTick(signalStore, 200);

  // Drive/TransportSurface runtime values (position, speed) change every
  // physics frame without touching the SignalStore, so the signal tick above
  // won't refresh them. Poll at 200ms only when the selected node has such a
  // component. Sensors write to the SignalStore and refresh via the tick above.
  // Also poll when a behavior root is selected — its virtual component shows
  // child drives' live speed/direction, which change every physics frame.
  //
  // plan-344 Phase 3.1: the poll no longer commits unconditionally. It compares a
  // fingerprint of exactly the values these sections DISPLAY (each live
  // component's `getLiveState()` plus, for a behavior root, the collected
  // subtree drive/sensor read-out) and bumps state only on a real change — so a
  // paused or static scene costs zero inspector re-renders.
  const liveTypes = useMemo(
    () => (nodeData?.components ?? [])
      // Fmu: its header shows the instance state, which changes without any
      // signal or drive movement (plan-510 fix).
      .filter(c => c.type === 'Drive' || c.type === 'TransportSurface'
        || c.type === FMU_TYPE || c.type.startsWith(`${FMU_TYPE}_`))
      .map(c => c.type),
    [nodeData],
  );
  const hasLiveNonSignalComponent = liveTypes.length > 0 || behaviorRoot !== null;
  // Stable primitives as effect deps — `nodeData.components` and `behaviorRoot`
  // get a fresh identity on every editor-state notify, which would otherwise
  // tear down and rebuild the interval on every edit.
  const liveTypesKey = liveTypes.join('|');
  const behaviorRootKey = behaviorRoot ? `${behaviorRoot.root.uuid}:${behaviorRoot.markerType}` : '';
  useChangeGatedTick({
    read: () => readLiveSignature(
      viewer,
      selectedPath ?? '',
      liveTypes,
      behaviorRoot?.root ?? null,
    ),
    enabled: hasLiveNonSignalComponent && !!selectedPath,
    resetKey: `${selectedPath ?? ''}|${liveTypesKey}|${behaviorRootKey}`,
  });

  if (!plugin || !selectedNode || !nodeData) return null;

  const nodeName = selectedPath
    ? selectedPath.split('/').pop() ?? selectedPath
    : selectedNode.name || selectedNode.type;

  // Show runtime section only when step is not Idle (matching C# ShowIf pattern)
  const showRuntimeSection = stepInfo && stepInfo.state !== StepState.Idle;

  // ── Shared toolbar buttons ────────────────────────────────────────────
  const toolbarButtons = (
    <>
      <Tooltip title={consumedOnly ? 'Showing active fields only \u2014 click to show all' : 'Click to show only active fields'}>
        <IconButton size="small" onClick={toggleConsumedOnly} sx={{ color: consumedOnly ? SUCCESS : 'text.secondary', p: 0.25 }}>
          <FilterList sx={{ fontSize: ICON_SIZE.sm }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={detached ? 'Dock to hierarchy panel' : 'Detach as floating window'}>
        <IconButton size="small" onClick={toggleDetached} sx={{ color: 'text.secondary', p: 0.25 }}>
          {detached ? <PushPin sx={{ fontSize: ICON_SIZE.sm }} /> : <OpenInNew sx={{ fontSize: ICON_SIZE.sm }} />}
        </IconButton>
      </Tooltip>
    </>
  );

  // ── Shared footer ─────────────────────────────────────────────────────
  const footerContent = (
    <>
      {/* plan-566: where this signal is used (components, logic steps, PLC,
          operator panel, bindings, CONNECT bridges) — every entry jumps there. */}
      {selectedSignalName && <SignalUsageSection viewer={viewer} name={selectedSignalName} />}
      {/* Reverse references. Shares its title with the signal tooltip's incoming
          block on purpose (plan-353 F4): same relation, same word — the title
          comes from the vocabulary SSOT so they cannot drift apart. */}
      {referencedBy.length > 0 && (
        <Box sx={{ pb: 0.75, borderTop: `1px solid ${DIVIDER}` }}>
          <InspectorSubheader>{PROVENANCE_REFERENCED_TITLE}</InspectorSubheader>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1 }}>
            {referencedBy.map((ref, i) => {
              const sourceName = ref.sourcePath.split('/').pop() ?? ref.sourcePath;
              const color = componentColor(ref.componentType);
              return (
                <Tooltip key={i} title={`${ref.sourcePath} \u2192 ${ref.fieldName}\nClick to navigate`} placement="top">
                  <Chip
                    label={`${sourceName}.${ref.fieldName}`}
                    size="small"
                    onClick={() => navigateToRef(viewer, ref.sourcePath)}
                    sx={{
                      height: 16,
                      fontSize: FS.micro,
                      fontWeight: 500,
                      cursor: 'pointer',
                      bgcolor: color + '18',
                      color: color,
                      border: `1px solid ${color}44`,
                      '& .MuiChip-label': { px: 0.5 },
                      '&:hover': { bgcolor: color + '28' },
                    }}
                  />
                </Tooltip>
              );
            })}
          </Box>
        </Box>
      )}
      {/* Override count + Reset — same compact grey-text footer row as the
          hierarchy window for a unified footer design across all windows. */}
      <Box sx={{ px: 1, py: 0.25, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: FS.micro, color: 'text.disabled', flex: 1 }}>
          {totalOverrides > 0
            ? `${totalOverrides} override${totalOverrides !== 1 ? 's' : ''}`
            : 'No overrides'}
        </Typography>
        {totalOverrides > 0 && (
          <Button
            size="small"
            variant="text"
            startIcon={<RestartAlt sx={{ fontSize: ICON_SIZE.xs }} />}
            onClick={handleResetAll}
            sx={{
              fontSize: FS.micro,
              textTransform: 'none',
              color: WARN,
              py: 0,
              px: 0.5,
              minWidth: 0,
              '&:hover': { bgcolor: `${WARN}1a` },
            }}
          >
            Reset All
          </Button>
        )}
      </Box>
    </>
  );

  // ── Ephemeral read-only "virtual components" ──────────────────────────
  // Built fresh on every render (cheap; a handful of map/registry ops) so they
  // refresh on the inspector's signal/live ticks. They are NOT stamped into
  // userData — they are injected into the section list at render time and
  // rendered through the SAME ComponentSection pipeline (readOnlyLive mode) as
  // a real component. Order: AFTER the real LayoutObject/config sections.
  const virtualComponents: Array<{ type: string; data: Record<string, unknown>; extraContent?: React.ReactNode }> = [];
  // Behavior live state — only when the LayoutObject root ITSELF is selected.
  // Since plan-325 the section also carries the behavior's synthetic signal
  // slots (Conveyor Flow.*, F10) as SignalSlotRow rows: always visible from
  // the descriptor, bindable once the scoped signal is materialised. The
  // section therefore renders even when no live data exists yet.
  if (behaviorRoot) {
    const vc = buildBehaviorVirtualComponent(
      viewer as unknown as BehaviorViewerSnapshot,
      behaviorRoot.root,
      behaviorRoot.markerType,
    ) ?? { type: behaviorDisplayName(behaviorRoot.markerType), data: {} };
    virtualComponents.push({
      ...vc,
      extraContent: (
        <BehaviorSignalSlots
          viewer={viewer}
          root={behaviorRoot.root}
          markerType={behaviorRoot.markerType}
        />
      ),
    });
  }
  // Snap-point data — when a registered snap Empty is selected (resolved by uuid).
  if (nodeData.uuid) {
    const snapVc = buildSnapVirtualComponent(viewer, nodeData.uuid);
    if (snapVc) virtualComponents.push(snapVc);
  }
  // Baked geometry — what a selected chunk mesh IS (boundary, partition,
  // material, size); BEFORE the generic Mesh block (plan-505 F7).
  const bakedVc = buildBakedGeometryVirtualComponent(viewer, selectedNode);
  if (bakedVc) virtualComponents.push(bakedVc);
  // Mesh data — own mesh, attached chunks, chunk windows + subtree totals.
  if (meshRows) {
    const data: Record<string, unknown> = {};
    for (const [label, text] of meshRows) data[label] = runtimeRow(text);
    virtualComponents.push({ type: 'Mesh', data });
  }
  const hasContent = nodeData.components.length > 0 || virtualComponents.length > 0;

  // ── Shared scrollable content ─────────────────────────────────────────
  const scrollContent = (
    <Box
      className={RV_SCROLL_CLASS}
      sx={{
        flex: 1,
        overflow: 'auto',
      }}
    >
      {/* Owner breadcrumb: exact-node editor picks land on plain geometry —
          offer one click to jump to the owning component node (e.g. Drive). */}
      {pickOwner && (
        <Box sx={{ pb: 0.75, borderBottom: `1px solid ${DIVIDER}` }}>
          <InspectorSubheader>Part of</InspectorSubheader>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1 }}>
            {(() => {
              const ownerName = pickOwner.path.split('/').pop() ?? pickOwner.path;
              const primaryType = pickOwner.components[0];
              const color = componentColor(primaryType);
              return (
                <Tooltip title={`${pickOwner.path}\nClick to select`} placement="top">
                  <Chip
                    label={`${primaryType}: ${ownerName}`}
                    size="small"
                    onClick={() => navigateToRef(viewer, pickOwner.path)}
                    sx={{
                      height: 16,
                      fontSize: FS.micro,
                      fontWeight: 500,
                      cursor: 'pointer',
                      bgcolor: color + '18',
                      color: color,
                      border: `1px solid ${color}44`,
                      '& .MuiChip-label': { px: 0.5 },
                      '&:hover': { bgcolor: color + '28' },
                    }}
                  />
                </Tooltip>
              );
            })()}
          </Box>
        </Box>
      )}

      {/* LogicStep Runtime Status (above component sections, hidden when Idle) */}
      {showRuntimeSection && <LogicStepRuntimeSection info={stepInfo} />}

      {/* Layout Object Transform (position + rotation editing).
          Lock + Visibility toggles live inside its header. */}
      {hasLayoutObject && selectedPath && (
        <LayoutTransformSection
          viewer={viewer}
          nodePath={selectedPath}
          locked={layoutLocked}
          onToggleLock={() => handleFieldEdit('LayoutObject', 'Locked', !layoutLocked)}
          onToggleVisible={(next) => handleFieldEdit('LayoutObject', 'Visible', next)}
          canReverse={_canReversePlacement(viewer, selectedPath)}
          onReverseDirection={() => _doReversePlacement(viewer, selectedPath)}
        />
      )}

      {/* Model root: read-only Transform. No lock toggle and no visibility
          toggle — those are not "off by default" here, they do not exist. */}
      {!hasLayoutObject && isRootSelected && selectedPath && (
        <LayoutTransformSection viewer={viewer} nodePath={selectedPath} locked lockFixed />
      )}

      {/* Runtime node (plan-754 D2): the same read-only Transform, addressed by
          the object instead of a path. Everything below that could WRITE is
          suppressed — there is no path to write against. */}
      {isRuntimeSelection && (
        <LayoutTransformSection viewer={viewer} nodePath="" node={selectedNode} locked lockFixed />
      )}

      {/* Signal linking is INLINE since plan-325: every componentRef+signal
          schema field renders as a SignalSlotRow inside its component section
          (the former "Signals (CONNECT)" SignalBindSection was removed). */}

      {/* Typed connections (plan-259): in/out edges of this node, add/remove,
          drag handle + connection-type editor. */}
      {selectedPath && <ConnectionsSection viewer={viewer} nodePath={selectedPath} />}

      {!hasContent ? (
        <Typography sx={{ fontSize: FS.body, color: 'text.disabled', textAlign: 'center', py: 4 }}>
          No component data
        </Typography>
      ) : (
        // Lock wraps the entire component edit area: when a LayoutObject is
        // locked we dim and pointer-block every nested ComponentSection so
        // no field, button, or override can be triggered. The lock toggle
        // itself lives in TRANSFORM's header (outside this wrapper) so the
        // user can still unlock.
        <Box sx={{ opacity: layoutLocked ? 0.5 : 1, pointerEvents: layoutLocked ? 'none' : 'auto' }}>
          {/* Real (editable) component sections FIRST — only where there is a
              path to write against. An unregistered node's components render
              through the read-only pipeline below instead (plan-754 D2). */}
          {selectedPath && nodeData.components.map(({ type, data }) => {
            // Two sources, one badge (plan-703 F7): the scene overlay's own
            // overrides, and the `AssetOverrides` an enclosing reference node
            // carries for this node. They are the same idea addressed two ways —
            // "this file changes that value" — so showing them separately would
            // make the user learn a distinction that only exists in storage.
            const overriddenFields = new Set([
              ...(state.overlay ? getOverriddenFields(selectedPath, type, state.overlay) : []),
              ...referenceOverriddenFields(viewer, selectedPath, type),
            ]);
            // Editable rows show CONFIG only (static + overlay) so the
            // override/save model stays coherent: what you see is what you
            // save. Live runtime state is shown read-only in the virtual
            // components below — never as an editable/overridable field.
            // Header value: a compact live glance (signal value or drive pos).
            const headerValue = getPrimaryDisplayValue(viewer, selectedPath, type, data).text;
            return (
              <ComponentSection
                // Keyed by NODE + type: a type-only key reused the section (and the
                // local draft of its field editors) across a selection change, so an
                // unblurred draft of node A could be committed into node B.
                key={`${selectedPath}:${type}`}
                nodePath={selectedPath}
                componentType={type}
                data={data}
                overriddenFields={overriddenFields}
                consumedOnly={consumedOnly}
                signalValue={headerValue}
                headerAction={type === 'AASLink'
                  ? <AasDetailHeaderAction viewer={viewer} nodePath={selectedPath} data={data} />
                  : undefined}
                onFieldEdit={(fieldName, value) => handleFieldEdit(type, fieldName, value)}
                onFieldReset={(fieldName) => handleFieldReset(type, fieldName)}
                onResetComponent={() => handleComponentReset(type)}
                viewer={viewer}
                signalStore={signalStore}
              />
            );
          })}

          {/* An unregistered node's own components, read-only: the values are
              worth seeing, but nothing here can be overridden or saved. */}
          {isRuntimeSelection && nodeData.components.map(({ type, data }) => (
            <ComponentSection
              key={`runtime:${type}`}
              nodePath=""
              componentType={type}
              data={data}
              overriddenFields={EMPTY_OVERRIDES}
              consumedOnly={consumedOnly}
              readOnlyLive
              onFieldEdit={NOOP_FIELD_EDIT}
              onFieldReset={NOOP_FIELD_RESET}
              onResetComponent={NOOP_RESET}
              viewer={viewer}
              signalStore={signalStore}
            />
          ))}

          {/* Ephemeral read-only "virtual components" (behavior live state,
              snap data) AFTER the editable sections — same header / collapse /
              color pipeline, but rendered read-only (no editor / overlay). */}
          {virtualComponents.map(({ type, data, extraContent }) => (
            <ComponentSection
              key={`virtual:${type}`}
              nodePath={selectedPath ?? ''}
              componentType={type}
              data={data}
              overriddenFields={EMPTY_OVERRIDES}
              consumedOnly={consumedOnly}
              readOnlyLive
              extraContent={extraContent}
              onFieldEdit={NOOP_FIELD_EDIT}
              onFieldReset={NOOP_FIELD_RESET}
              onResetComponent={NOOP_RESET}
              viewer={viewer}
              signalStore={signalStore}
            />
          ))}
        </Box>
      )}

      {/* "Add Component" (asset editor only — renders nothing when the active
          EditTarget doesn't support component authoring). Outside the
          hasContent branch so the FIRST component can be added to bare nodes. */}
      {selectedPath && <AddComponentSection viewer={viewer} nodePath={selectedPath} />}

      {/* Footer inside scroll area for detached mode */}
      {detached && footerContent}
    </Box>
  );

  // ── Detached: floating FloatingPanel ──────────────────────────────────
  if (detached) {
    return (
      <FloatingPanel
        open
        onClose={handleClose}
        title={nodeName}
        titleColor={LINK}
        subtitle={selectedPath ?? undefined}
        defaultWidth={420}
        defaultHeight={500}
        zIndex={1600}
        toolbar={toolbarButtons}
      >
        {scrollContent}
      </FloatingPanel>
    );
  }

  // ── Pinned: docked LeftPanel ──────────────────────────────────────────
  return (
    <LeftPanel
      title={
        // Single-line title — same style as the hierarchy window header for a
        // unified look across all docked windows. Full path stays available as
        // the native hover tooltip (no grey subtitle line).
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            fontSize: '0.8rem',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={selectedPath ?? undefined}
        >
          {nodeName}
        </Typography>
      }
      onClose={handleClose}
      width={state.inspectorWidth}
      leftOffset={ACTIVITY_BAR_WIDTH + state.panelWidth}
      resizable
      minWidth={INSPECTOR_MIN_WIDTH}
      maxWidth={INSPECTOR_MAX_WIDTH}
      onResize={(w) => plugin.setInspectorWidth(w)}
      innerShadow
      toolbar={toolbarButtons}
      footer={footerContent}
    >
      {scrollContent}
    </LeftPanel>
  );
}

// ── Reverse-direction helpers ──────────────────────────────────────────
// Bridge between the inspector UI and the LayoutPlannerPlugin's
// `reversePlacement` action. Kept here (instead of as plugin imports)
// because the inspector is plugin-agnostic.

function _canReversePlacement(viewer: RVViewer, nodePath: string): boolean {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return false;
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const placed = planner?.findPlacedAncestor(node);
  if (!placed) return false;
  // Has at least one paired snap?
  const snapReg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
  if (!snapReg) return false;
  for (const sp of snapReg.getAll()) {
    if (sp.ownerRoot === placed.root && sp.pairedSnapId) return true;
  }
  return false;
}

function _doReversePlacement(viewer: RVViewer, nodePath: string): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const placed = planner?.findPlacedAncestor(node);
  if (!placed) return;
  planner!.reversePlacement(placed.id);
}
