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
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { MathUtils } from 'three';
import { RV_SCROLL_CLASS } from './shared-sx';
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
  OpenInNew,
  PushPin,
} from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import { getOverriddenFields } from '../engine/rv-extras-overlay-store';
import { LeftPanel } from './LeftPanel';
import { AasDetailHeaderAction } from '../../plugins/aas-link-plugin';
import { ChartPanel } from './ChartPanel';
import { INSPECTOR_PANEL_WIDTH } from './layout-constants';
import {
  isHiddenComponentType,
  componentColor,
  getSignalDisplayValue,
  getDriveDisplayValue,
  getLiveDriveFields,
  type ReverseReference,
} from './rv-inspector-helpers';
import { navigateToRef } from './rv-reference-display';
import { ComponentSection } from './rv-component-section';
import { Vector3Editor } from './rv-field-editors';
import { StepState } from '../engine/rv-logic-step';
import type { StepStateInfo } from '../engine/rv-logic-engine';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';

// Re-export isHiddenComponentType for backward compatibility
export { isHiddenComponentType } from './rv-inspector-helpers';

// ── Consumed-only filter persistence ────────────────────────────────────

const LS_KEY_CONSUMED_ONLY = 'rv-inspector-consumed-only';
const LS_KEY_DETACHED = 'rv-inspector-detached';

function loadConsumedOnly(): boolean {
  try { return localStorage.getItem(LS_KEY_CONSUMED_ONLY) === 'true'; }
  catch { return false; }
}

function loadDetached(): boolean {
  try { return localStorage.getItem(LS_KEY_DETACHED) === 'true'; }
  catch { return false; }
}

// ── LogicStep Runtime Section ─────────────────────────────────────────────

interface RuntimeFieldRowProps {
  label: string;
  value: string;
  color?: string;
}

function RuntimeFieldRow({ label, value, color }: RuntimeFieldRowProps) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.15 }}>
      <Typography sx={{ fontSize: 10, color: 'text.disabled', width: 100, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 10, color: color ?? 'text.primary', fontWeight: 500 }}>
        {value}
      </Typography>
    </Box>
  );
}

function LogicStepRuntimeSection({ info }: { info: StepStateInfo }) {
  const stateColor = STEP_STATE_COLORS[info.state];
  const stateLabel = STEP_STATE_LABELS[info.state];

  return (
    <Box sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
      {/* Section header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1,
          py: 0.5,
          bgcolor: stateColor + '18',
          borderBottom: `2px solid ${stateColor}44`,
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: stateColor,
            mr: 0.75,
            flexShrink: 0,
          }}
        />
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: stateColor, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Runtime Status
        </Typography>
        <Typography sx={{ fontSize: 9, color: stateColor, fontWeight: 600 }}>
          {stateLabel}
        </Typography>
      </Box>

      {/* Runtime fields */}
      <Box sx={{ py: 0.5 }}>
        <RuntimeFieldRow label="State" value={info.state} color={stateColor} />
        <RuntimeFieldRow label="Type" value={info.type} />

        {/* Progress bar */}
        <Box sx={{ px: 1, py: 0.25 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontSize: 10, color: 'text.disabled', width: 100, flexShrink: 0 }}>
              Progress
            </Typography>
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <LinearProgress
                variant="determinate"
                value={Math.min(100, info.progress)}
                sx={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  bgcolor: 'rgba(255,255,255,0.06)',
                  '& .MuiLinearProgress-bar': { bgcolor: stateColor, borderRadius: 2 },
                }}
              />
              <Typography sx={{ fontSize: 9, color: 'text.secondary', minWidth: 28, textAlign: 'right' }}>
                {info.progress.toFixed(0)}%
              </Typography>
            </Box>
          </Box>
        </Box>

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

interface LayoutTransformSectionProps {
  viewer: RVViewer;
  nodePath: string;
  locked: boolean;
  onToggleLock?: () => void;
}

function LayoutTransformSection({ viewer, nodePath, locked, onToggleLock }: LayoutTransformSectionProps) {
  const node = viewer.registry?.getNode(nodePath);

  // Poll position/rotation at 200ms for live updates (e.g. during TransformControls drag)
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  useEffect(() => {
    const id = setInterval(() => { tickRef.current++; setTick(tickRef.current); }, 200);
    return () => clearInterval(id);
  }, []);

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

  const fieldRowSx = { display: 'flex', alignItems: 'center', px: 1, py: 0.25 };
  const labelSx = { fontSize: 10, color: locked ? 'text.disabled' : 'text.secondary', width: 52, flexShrink: 0, cursor: 'default' };
  const resetBtnSx = { p: 0.15, color: 'text.disabled', flexShrink: 0, '&:hover': { color: '#ffa726' } };

  return (
    <Box sx={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1, py: 0.5, bgcolor: 'rgba(100, 181, 246, 0.08)', borderBottom: '2px solid rgba(100, 181, 246, 0.2)' }}>
        <Typography sx={{ fontSize: 10, fontWeight: 700, color: '#64b5f6', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 }}>
          Transform
        </Typography>
        <Tooltip title={locked ? 'Unlock object' : 'Lock object'}>
          <IconButton
            size="small"
            onClick={onToggleLock}
            sx={{ p: 0.25, color: locked ? '#ffa726' : 'text.secondary', '&:hover': { color: locked ? '#ffb74d' : 'text.primary' } }}
          >
            {locked ? <Lock sx={{ fontSize: 14 }} /> : <LockOpen sx={{ fontSize: 14 }} />}
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ py: 0.5, opacity: locked ? 0.5 : 1, pointerEvents: locked ? 'none' : 'auto' }}>
        <Box sx={fieldRowSx}>
          <Typography sx={labelSx}>Position</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={pos} onChange={handlePositionChange} />
          </Box>
          <Tooltip title="Reset position to 0,0,0">
            <IconButton size="small" onClick={handleResetPosition} sx={resetBtnSx}>
              <RestartAlt sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={fieldRowSx}>
          <Typography sx={labelSx}>Rotation</Typography>
          <Box sx={{ flex: 1 }}>
            <Vector3Editor value={rot} onChange={handleRotationChange} />
          </Box>
          <Tooltip title="Reset rotation to 0,0,0">
            <IconButton size="small" onClick={handleResetRotation} sx={resetBtnSx}>
              <RestartAlt sx={{ fontSize: 12 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export interface PropertyInspectorProps {
  viewer: RVViewer;
}

export function PropertyInspector({ viewer }: PropertyInspectorProps) {
  const { plugin, state } = useEditorPlugin();
  const selectedPath = state.selectedNodePath;

  // Find the selected node in the scene and read its userData
  const nodeData = useMemo(() => {
    if (!selectedPath || !viewer.registry) return null;

    const node = viewer.registry.getNode(selectedPath);
    if (!node) return null;

    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv) return null;

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

    return { components, layoutObj };
    // Note: state.overlay intentionally excluded — overlay changes should not re-scan node components.
    // Overlay-dependent data (overridden fields) is computed separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, viewer.registry]);

  // Check if the selected node has a LayoutObject (for transform section)
  // Re-read Locked from live userData on any state change (state is always a new ref after notify())
  const hasLayoutObject = !!nodeData?.layoutObj;
  const layoutLocked = useMemo(() => {
    if (!selectedPath || !viewer.registry) return false;
    const node = viewer.registry.getNode(selectedPath);
    const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return !!(rv?.LayoutObject?.Locked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, viewer.registry, state]);

  // Check if the selected node has a LogicStep component
  const hasLogicStep = nodeData?.components.some(c => c.type.startsWith('LogicStep_')) ?? false;

  // Get logic step runtime info
  const logicEngine = viewer.logicEngine;
  const stepInfo = hasLogicStep && logicEngine && selectedPath
    ? logicEngine.getStepInfo(selectedPath)
    : null;

  // Find reverse references: who points to this node via ComponentReference?
  // Uses the pre-built index in NodeRegistry (O(1) lookup instead of full scene scan).
  const referencedBy = useMemo<readonly ReverseReference[]>(() => {
    if (!selectedPath || !viewer.registry) return [];
    return viewer.registry.getReferencesTo(selectedPath);
  }, [selectedPath, viewer.registry]);

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
      plugin.updateOverlayField(selectedPath, componentType, fieldName, value);
    },
    [plugin, selectedPath],
  );

  const handleFieldReset = useCallback(
    (componentType: string, fieldName: string) => {
      if (!selectedPath || !plugin) return;
      plugin.resetField(selectedPath, componentType, fieldName);
    },
    [plugin, selectedPath],
  );

  const handleComponentReset = useCallback(
    (componentType: string) => {
      if (!selectedPath || !plugin) return;
      plugin.resetComponent(selectedPath, componentType);
    },
    [plugin, selectedPath],
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

  if (!plugin || !selectedPath || !nodeData) return null;

  const nodeName = selectedPath.split('/').pop() ?? selectedPath;

  // Show runtime section only when step is not Idle (matching C# ShowIf pattern)
  const showRuntimeSection = stepInfo && stepInfo.state !== StepState.Idle;

  // ── Shared toolbar buttons ────────────────────────────────────────────
  const toolbarButtons = (
    <>
      <Tooltip title={consumedOnly ? 'Showing active fields only \u2014 click to show all' : 'Click to show only active fields'}>
        <IconButton size="small" onClick={toggleConsumedOnly} sx={{ color: consumedOnly ? '#66bb6a' : 'text.secondary', p: 0.25 }}>
          <FilterList sx={{ fontSize: 14 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={detached ? 'Dock to hierarchy panel' : 'Detach as floating window'}>
        <IconButton size="small" onClick={toggleDetached} sx={{ color: 'text.secondary', p: 0.25 }}>
          {detached ? <PushPin sx={{ fontSize: 14 }} /> : <OpenInNew sx={{ fontSize: 14 }} />}
        </IconButton>
      </Tooltip>
    </>
  );

  // ── Shared footer ─────────────────────────────────────────────────────
  const footerContent = (
    <>
      {/* Referenced by section */}
      {referencedBy.length > 0 && (
        <Box sx={{ px: 1, py: 0.75, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{ fontSize: 9, color: 'text.disabled', mb: 0.5, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
            Referenced by
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
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
                      fontSize: 9,
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
      {/* Override count + Reset */}
      <Box sx={{ px: 1, py: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ fontSize: 10, color: 'text.disabled', flex: 1 }}>
          {totalOverrides > 0
            ? `${totalOverrides} override${totalOverrides !== 1 ? 's' : ''}`
            : 'No overrides'}
        </Typography>
        {totalOverrides > 0 && (
          <Button
            size="small"
            variant="text"
            startIcon={<RestartAlt sx={{ fontSize: 12 }} />}
            onClick={handleResetAll}
            sx={{
              fontSize: 10,
              textTransform: 'none',
              color: '#ffa726',
              py: 0,
              px: 0.5,
              minWidth: 0,
              '&:hover': { bgcolor: 'rgba(255,167,38,0.1)' },
            }}
          >
            Reset All
          </Button>
        )}
      </Box>
    </>
  );

  // ── Shared scrollable content ─────────────────────────────────────────
  const scrollContent = (
    <Box
      className={RV_SCROLL_CLASS}
      sx={{
        flex: 1,
        overflow: 'auto',
      }}
    >
      {/* LogicStep Runtime Status (above component sections, hidden when Idle) */}
      {showRuntimeSection && <LogicStepRuntimeSection info={stepInfo} />}

      {/* Layout Object Transform (position + rotation editing) */}
      {hasLayoutObject && selectedPath && (
        <LayoutTransformSection
          viewer={viewer}
          nodePath={selectedPath}
          locked={layoutLocked}
          onToggleLock={() => handleFieldEdit('LayoutObject', 'Locked', !layoutLocked)}
        />
      )}

      {nodeData.components.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
          No component data
        </Typography>
      ) : (
        nodeData.components.map(({ type, data }) => {
          const overriddenFields = new Set(
            state.overlay ? getOverriddenFields(selectedPath, type, state.overlay) : [],
          );
          // Merge live runtime values for Drive components (position, speed, status)
          const liveFields = getLiveDriveFields(viewer.registry, selectedPath, type);
          const displayData = liveFields ? { ...data, ...liveFields } : data;
          // Header value: signal value OR drive position
          const headerValue = getSignalDisplayValue(signalStore, selectedPath, type, data)
            ?? getDriveDisplayValue(viewer.registry, selectedPath, type);
          return (
            <ComponentSection
              key={type}
              nodePath={selectedPath}
              componentType={type}
              data={displayData}
              overriddenFields={overriddenFields}
              consumedOnly={consumedOnly}
              signalValue={headerValue}
              headerAction={type === 'AASLink' ? <AasDetailHeaderAction data={data} /> : undefined}
              onFieldEdit={(fieldName, value) => handleFieldEdit(type, fieldName, value)}
              onFieldReset={(fieldName) => handleFieldReset(type, fieldName)}
              onResetComponent={() => handleComponentReset(type)}
              viewer={viewer}
              signalStore={signalStore}
            />
          );
        })
      )}

      {/* Footer inside scroll area for detached mode */}
      {detached && footerContent}
    </Box>
  );

  // ── Detached: floating ChartPanel ─────────────────────────────────────
  if (detached) {
    return (
      <ChartPanel
        open
        onClose={handleClose}
        title={nodeName}
        titleColor="#90caf9"
        subtitle={selectedPath}
        defaultWidth={420}
        defaultHeight={500}
        panelId="property-inspector"
        zIndex={1600}
        toolbar={toolbarButtons}
      >
        {scrollContent}
      </ChartPanel>
    );
  }

  // ── Pinned: docked LeftPanel ──────────────────────────────────────────
  return (
    <LeftPanel
      title={
        <Box sx={{ overflow: 'hidden' }}>
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {nodeName}
          </Typography>
          <Typography sx={{ fontSize: 9, color: 'text.disabled', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedPath}
          </Typography>
        </Box>
      }
      onClose={handleClose}
      width={INSPECTOR_PANEL_WIDTH}
      leftOffset={state.panelWidth + 16}
      toolbar={toolbarButtons}
      footer={footerContent}
    >
      {scrollContent}
    </LeftPanel>
  );
}
