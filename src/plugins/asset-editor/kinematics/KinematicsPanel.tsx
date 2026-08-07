// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * KinematicsPanel — the editor's right-docked "Quick Edit" window: the web
 * port of Unity's QuickEdit overlay, context-sensitive on the current
 * selection, headed by a Kinematics object list.
 *
 * Sections (visibility mirrors Unity QuickEditVisibility — see
 * quick-edit-context.ts):
 *  - Selection header (name + component badges)
 *  - Kinematics (one row per kinematic object: hover previews the group,
 *                click selects, per-row hide / isolate — see KinematicsList;
 *                Add Kinematic creates an axis + empty group and arms Auto Assign)
 *  - Transform  (zero local, rotate ±90°, to ground, pivot to bottom, align Y up)
 *  - Create     (empty child, group selection into empty, empty at root)
 *  - Components (Drive/Kinematic/TransportSurface/Sensor/Source/Sink/Grip +
 *                drive-behavior palette + assign-to-group)
 *  - Signals    (create PLC in/out signals; convert type / flip direction)
 *  - Logic Steps (starter container or full step palette)
 *  - Drive Test (ephemeral jog preview + target speed)
 *
 * Every action is an undoable AssetDocument op EXCEPT the drive jog, which is
 * a pure preview (EditorJogController) restored before save.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, ComponentType } from 'react';
import {
  Box, Button, Chip, Divider, IconButton, InputBase, Tooltip, Typography,
} from '@mui/material';
import {
  Add, AddBox, Anchor, CenterFocusWeak, Colorize, CreateNewFolder,
  FastForward, FastRewind, Hub, Input as InputIcon, Label as LabelIcon, LibraryAdd,
  LinearScale, Login, Logout, North, PanTool, RestartAlt, Rotate90DegreesCw,
  RotateRight, Sensors, Stop, SwapHoriz, VerticalAlignBottom, Output as OutputIcon,
  AccountTree,
} from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { useSelection } from '../../../hooks/use-selection';
import { LeftPanel } from '../../../core/hmi/LeftPanel';
import { KinematicsList, AutoAssignToggle, KINEMATIC_ACCENT } from './KinematicsList';
import { DragNumberField } from '../../../core/hmi/DragNumberField';
import {
  KINEMATICS_PANEL_MIN_WIDTH, KINEMATICS_PANEL_MAX_WIDTH,
  LS_KEY_KINEMATICS_PANEL_WIDTH, getStoredKinematicsPanelWidth,
} from '../../../core/hmi/layout-constants';
import { RV_SCROLL_CLASS } from '../../../core/hmi/shared-sx';
import { DriveDirection } from '../../../core/engine/rv-coordinate-utils';
import { getActiveAssetContext, subscribeActiveAsset, getActiveAssetVersion } from '../active-asset-store';
import type { ActiveAssetContext } from '../active-asset-store';
import { groupSelection, listGroupNamesForMenu } from '../group-actions';
import { computeQuickEditContext, DRIVE_BEHAVIOR_TYPES } from './quick-edit-context';
import type { QuickEditContext } from './quick-edit-context';
import {
  zeroLocalPosition, rotate90, toGround, pivotToBottom, alignYUp, nodeHasOwnMesh,
  centerKinematicToGroup, kinematicGroupMemberCount,
} from './transform-actions';
import {
  createEmptyChild, createEmptyAtRoot, groupIntoEmpty, addComponentTo,
  createKinematicWithGroup, createSignalNode, convertSignalType,
  toggleSignalDirection, addLogicStep, LOGIC_STEP_PALETTE,
} from './create-actions';
import { EditorJogController } from './editor-jog-controller';
import { startPivotPick } from '../pivot-pick';
import { Section, ActionButton, ButtonGrid, buttonSimSx } from '../panel-primitives';
import { useButtonSim } from '../button-sim-store';

const AXIS_COLORS = { x: '#ef5350', y: '#66bb6a', z: '#42a5f5' } as const;

/** Shared "no selection" disabled reason. Every section is always visible now
 *  (Unity-style show/hide replaced by always-show + grey-out); most actions
 *  gate on having a selection. */
const SELECT_FIRST = 'Select an object first';

// Stable no-op fallbacks for useSyncExternalStore while no document is active.
const _noopSubscribe = () => () => {};
const _nullSnapshot = () => null;

// ─── Sections ───────────────────────────────────────────────────────────

function SelectionHeader({ qe }: { qe: QuickEditContext }) {
  if (!qe.hasSelection || !qe.node) {
    return (
      <Box sx={{ px: 1, py: 0.75 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 11 }}>
          No selection — click an object in the 3D view.
        </Typography>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>
          All tools stay listed below — each greys out until it applies to the selection.
        </Typography>
      </Box>
    );
  }
  const rv = (qe.node.userData as Record<string, unknown>)['realvirtual'] as Record<string, unknown> | undefined;
  const badges = Object.keys(rv ?? {}).filter(k => k !== 'Hidden');
  if (badges.length === 0) return null;
  return (
    <Box sx={{ px: 1, py: 0.75 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {badges.map(b => (
          <Chip key={b} label={b} size="small" sx={{
            height: 16, fontSize: 9, bgcolor: 'rgba(79,195,247,0.12)', color: '#4fc3f7',
            '& .MuiChip-label': { px: 0.75 },
          }} />
        ))}
      </Box>
    </Box>
  );
}

/** One of the three axis-colored ±90° rotate buttons — a local component so
 *  it can subscribe to the button-sim store (MCP web_editor_rotate90). */
function RotateAxisButton({ axis, disabled, disabledReason, onRotate }: {
  axis: 'x' | 'y' | 'z';
  disabled: boolean;
  disabledReason: string;
  onRotate: (sign: 1 | -1) => void;
}) {
  const simPhase = useButtonSim(`qe.rotate-${axis}`);
  return (
    <Tooltip
      placement="left"
      title={disabled ? disabledReason : `Rotate +90° around local ${axis.toUpperCase()} — Shift-click: −90°`}
    >
      <span style={{ display: 'flex', minWidth: 0 }}>
        <Button
          size="small" variant="outlined" disabled={disabled}
          onClick={(e) => onRotate(e.shiftKey ? -1 : 1)}
          data-rv-button-id={`qe.rotate-${axis}`}
          startIcon={<Rotate90DegreesCw sx={{ fontSize: 14 }} />}
          sx={{
            width: '100%', textTransform: 'none', fontSize: 10, fontWeight: 600,
            height: 24, py: 0, px: 0.75, minWidth: 0,
            color: disabled ? 'text.disabled' : AXIS_COLORS[axis],
            borderColor: 'rgba(255,255,255,0.15)',
            '&:hover': { borderColor: AXIS_COLORS[axis] },
            '& .MuiButton-startIcon': { mr: 0.5, ml: 0 },
            transition: 'transform 120ms ease, background-color 120ms ease',
            ...buttonSimSx(simPhase, AXIS_COLORS[axis]),
          }}
        >
          {axis.toUpperCase()}
        </Button>
      </span>
    </Tooltip>
  );
}

function TransformSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const nodePath = qe.nodePath;
  const hasMesh = qe.node ? nodeHasOwnMesh(qe.node) : false;
  const hasChildren = (qe.node?.children.length ?? 0) > 0;
  const noSel = !qe.hasSelection || !nodePath;
  const rotationDisabled = noSel || !qe.isSingle || qe.hasLogicStep;
  const rotationReason = noSel ? SELECT_FIRST
    : !qe.isSingle ? 'Select a single object'
      : 'Not available for LogicStep objects';
  return (
    <Section title="Transform">
      <ButtonGrid>
        <ActionButton
          label="Zero Position" icon={CenterFocusWeak} flashId="qe.zero-position"
          disabled={busy || noSel} disabledReason={SELECT_FIRST}
          tooltip="Set local position to (0, 0, 0)"
          onClick={() => { if (nodePath) void zeroLocalPosition(ctx.viewer, ctx.doc, qe.selectedPaths); }}
        />
        <ActionButton
          label="To Ground" icon={VerticalAlignBottom} flashId="qe.to-ground"
          disabled={busy || noSel} disabledReason={SELECT_FIRST}
          tooltip="Shift the object so its bounding box rests on Y = 0"
          onClick={() => { if (nodePath) toGround(ctx.viewer, ctx.doc, nodePath); }}
        />
        <ActionButton
          label="Pivot to Bottom" icon={Anchor} flashId="qe.pivot-bottom"
          disabled={busy || noSel || !hasChildren || hasMesh}
          disabledReason={noSel ? SELECT_FIRST : hasMesh
            ? 'The object itself has a mesh — moving its pivot would move the geometry'
            : 'Needs child objects (pivot moves, children stay in place)'}
          tooltip="Move the pivot to the bottom-center of the children's bounds — children keep their world position"
          onClick={() => { if (nodePath) void pivotToBottom(ctx.viewer, ctx.doc, nodePath); }}
        />
        <ActionButton
          label="Align Y Up" icon={North} flashId="qe.align-y-up"
          disabled={busy || noSel || !hasChildren || hasMesh}
          disabledReason={noSel ? SELECT_FIRST : hasMesh
            ? 'The object itself has a mesh — re-orienting its pivot would move the geometry'
            : 'Needs child objects (orientation changes, children stay in place)'}
          tooltip="Rotate the object so its local +Y points up — children keep their world position"
          onClick={() => { if (nodePath) void alignYUp(ctx.viewer, ctx.doc, nodePath); }}
        />
        <ActionButton
          label="Pivot to Object" icon={Colorize} flashId="qe.pivot-to-object"
          disabled={busy || noSel || !qe.isSingle}
          disabledReason={noSel ? SELECT_FIRST : !qe.isSingle ? 'Select a single object' : undefined}
          tooltip="Then click an object in the 3D view — this object's pivot jumps to the clicked object's center (children stay in place). Esc / right-click cancels."
          onClick={() => { if (nodePath) startPivotPick(ctx.viewer, ctx.doc, nodePath); }}
        />
      </ButtonGrid>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5, mt: 0.5 }}>
        {(['x', 'y', 'z'] as const).map(axis => (
          <RotateAxisButton
            key={axis} axis={axis}
            disabled={busy || rotationDisabled}
            disabledReason={rotationReason}
            onRotate={(sign) => { if (nodePath) rotate90(ctx.viewer, ctx.doc, nodePath, axis, sign); }}
          />
        ))}
      </Box>
    </Section>
  );
}

function CreateSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const multi = qe.selectedPaths.length;
  return (
    <Section title="Create">
      <ButtonGrid>
        <ActionButton
          label="Empty Child" icon={AddBox} flashId="qe.empty-child"
          disabled={busy || !qe.hasSelection}
          disabledReason="Select a parent object first"
          tooltip="Create an empty object under the selection (at local zero)"
          onClick={() => { void createEmptyChild(ctx.viewer, ctx.doc, qe.nodePath); }}
        />
        <ActionButton
          label="Empty at Root" icon={LibraryAdd} flashId="qe.empty-root" disabled={busy}
          tooltip="Create an empty object at the asset root"
          onClick={() => { void createEmptyAtRoot(ctx.viewer, ctx.doc); }}
        />
        <ActionButton
          label={multi > 1 ? `Group ${multi} into Empty` : 'Group into Empty'} icon={CreateNewFolder} flashId="qe.group-into-empty"
          disabled={busy || !qe.hasSelection}
          disabledReason="Select the objects to group first"
          tooltip="Create an empty next to the selection and move all selected objects into it (world positions preserved)"
          onClick={() => { void groupIntoEmpty(ctx.viewer, ctx.doc, qe.selectedPaths); }}
        />
      </ButtonGrid>
    </Section>
  );
}

function ComponentsSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const nodePath = qe.nodePath;
  const [groupName, setGroupName] = useState('');
  const groupNames = useMemo(() => listGroupNamesForMenu(ctx.viewer), [ctx.viewer]);

  // Section gate (mirrors the old show/hide: components hid without a selection
  // or on a LogicStep node) — now expressed as a greyed-out reason.
  const gate = !qe.hasSelection || !nodePath ? SELECT_FIRST
    : qe.hasLogicStep ? 'Not available on a LogicStep object'
      : null;

  const assignGroup = () => {
    const name = groupName.trim();
    if (!name) return;
    void groupSelection(ctx.viewer, ctx.doc, [...qe.selectedPaths], name);
    setGroupName('');
  };

  const add = (type: string) => () => { if (nodePath) addComponentTo(ctx.doc, nodePath, type); };

  return (
    <Section title="Components">
      <ButtonGrid>
        <ActionButton
          label="Drive" icon={RotateRight} flashId="qe.add-drive"
          disabled={busy || !!gate || qe.hasDrive}
          disabledReason={gate ?? (qe.hasDrive ? 'Already has a Drive' : undefined)}
          tooltip="Add a Drive (linear/rotational motion) — direction defaults to Linear X"
          onClick={add('Drive')}
        />
        <ActionButton
          label="Kinematic" icon={Hub} flashId="qe.add-kinematic"
          disabled={busy || !!gate || qe.hasKinematic}
          disabledReason={gate ?? (qe.hasKinematic ? 'Already has a Kinematic' : undefined)}
          tooltip="Add a Kinematic (collects grouped meshes under this axis) — applies after save & reload"
          onClick={add('Kinematic')}
        />
        <ActionButton
          label="Transport Surface" icon={LinearScale} flashId="qe.add-transportsurface"
          disabled={busy || !!gate} disabledReason={gate ?? undefined}
          tooltip="Add a TransportSurface (conveyor surface moving MUs)"
          onClick={add('TransportSurface')}
        />
        <ActionButton
          label="Sensor" icon={Sensors} flashId="qe.add-sensor"
          disabled={busy || !!gate} disabledReason={gate ?? undefined}
          tooltip="Add a Sensor (detects MUs by collision)"
          onClick={add('Sensor')}
        />
        <ActionButton
          label="Source" icon={InputIcon} flashId="qe.add-source"
          disabled={busy || !!gate} disabledReason={gate ?? undefined}
          tooltip="Add a Source (spawns MUs)"
          onClick={add('Source')}
        />
        <ActionButton
          label="Sink" icon={OutputIcon} flashId="qe.add-sink"
          disabled={busy || !!gate} disabledReason={gate ?? undefined}
          tooltip="Add a Sink (destroys MUs)"
          onClick={add('Sink')}
        />
        <ActionButton
          label="Grip" icon={PanTool} flashId="qe.add-grip"
          disabled={busy || !!gate || qe.isUnderTransportSurface}
          disabledReason={gate ?? (qe.isUnderTransportSurface ? 'Not available under a Transport Surface' : undefined)}
          tooltip="Add a Grip (pick & place MUs)"
          onClick={add('Grip')}
        />
      </ButtonGrid>

      {/* Assign to group — feeds the Kinematic/Group workflow. Field styling
          mirrors the Property Inspector's inputs (18px, 11px monospace,
          0.04 fill, 0.08/0.15 border). */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75,
        bgcolor: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, pl: 1, pr: 0.5,
        '&:hover': { borderColor: 'rgba(255,255,255,0.15)' },
        '&:focus-within': { borderColor: 'primary.main' },
        opacity: gate ? 0.5 : 1,
      }}>
        <LabelIcon sx={{ fontSize: 14, color: 'rgba(255,255,255,0.35)' }} />
        <InputBase
          placeholder={gate ? SELECT_FIRST : 'Assign to group…'}
          value={groupName}
          disabled={busy || !!gate}
          onChange={e => setGroupName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') assignGroup(); }}
          inputProps={{ list: 'rv-kinematics-group-names' }}
          sx={{
            flex: 1, fontSize: 11, fontFamily: 'monospace', color: 'white',
            '& input': { py: 0.25, px: 0, height: 18, boxSizing: 'border-box' },
            '& input::placeholder': { color: 'rgba(255,255,255,0.3)', opacity: 1 },
          }}
        />
        <datalist id="rv-kinematics-group-names">
          {groupNames.map(n => <option key={n} value={n} />)}
        </datalist>
        <Button
          size="small" disabled={busy || !!gate || !groupName.trim()}
          onClick={assignGroup}
          sx={{ textTransform: 'none', fontSize: 10, fontWeight: 600, minWidth: 0, px: 0.5, py: 0 }}
        >
          Add
        </Button>
      </Box>
    </Section>
  );
}

function DriveBehaviorsSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const nodePath = qe.nodePath;
  // Behaviors attach to a Drive — grey the whole palette until one exists.
  const gate = !qe.hasSelection || !nodePath ? SELECT_FIRST
    : !qe.hasDrive ? 'Add a Drive to this object first'
      : null;
  return (
    <Section title="Drive Behaviors">
      <ButtonGrid>
        {DRIVE_BEHAVIOR_TYPES.map(type => {
          const present = qe.existingDriveBehaviors.has(type);
          return (
            <ActionButton
              key={type}
              flashId={`qe.add-${type.toLowerCase()}`}
              label={type.replace('Drive_', '').replace(/([a-z])([A-Z])/g, '$1 $2')}
              disabled={busy || !!gate || present}
              disabledReason={gate ?? (present ? 'Already on this drive' : undefined)}
              tooltip={`Add ${type} to the drive`}
              onClick={() => { if (nodePath) addComponentTo(ctx.doc, nodePath, type); }}
            />
          );
        })}
      </ButtonGrid>
    </Section>
  );
}

function SignalsSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const nodePath = qe.nodePath;
  // Create-signal gate (mirrors the old show/hide: signals only on plain objects).
  const createGate = !qe.hasSelection || !nodePath ? SELECT_FIRST
    : (qe.hasDrive || qe.hasKinematic || qe.hasLogicStep)
      ? 'Signals attach to plain objects (no Drive / Kinematic / LogicStep)'
      : null;
  // Convert/flip acts on a SELECTED signal node.
  const sig = qe.hasSignal && qe.signalNodePath && qe.signalType ? qe.signalType : null;
  const convertGate = sig ? null : 'Select a signal object to convert';

  const createRow = (dir: 'PLCOutput' | 'PLCInput') => (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: dir === 'PLCInput' ? 0.5 : 0 }}>
      <Tooltip title={dir === 'PLCOutput' ? 'PLC outputs — read by the viewer' : 'PLC inputs — written by the viewer'} placement="left">
        {dir === 'PLCOutput'
          ? <Logout sx={{ fontSize: 14, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />
          : <Login sx={{ fontSize: 14, color: 'rgba(255,255,255,0.35)', flexShrink: 0 }} />}
      </Tooltip>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5, flex: 1 }}>
        {(['Bool', 'Int', 'Float'] as const).map(dt => (
          <ActionButton
            key={dt}
            label={`${dir === 'PLCOutput' ? 'Out' : 'In'} ${dt}`}
            disabled={busy || !!createGate} disabledReason={createGate ?? undefined}
            tooltip={`Create a ${dir}${dt} signal as a child object`}
            onClick={() => { if (nodePath) void createSignalNode(ctx.viewer, ctx.doc, nodePath, `${dir}${dt}`); }}
          />
        ))}
      </Box>
    </Box>
  );

  return (
    <Section title="Signals">
      {createRow('PLCOutput')}
      {createRow('PLCInput')}
      <Box sx={{ mt: 0.75 }}>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: 10 }}>
          Selected signal: {sig ?? '—'}
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 0.5, mt: 0.25 }}>
          {(['Bool', 'Int', 'Float'] as const).map(dt => {
            const isCurrent = sig ? sig.endsWith(dt) : false;
            return (
              <ActionButton
                key={dt}
                label={`To ${dt}`}
                disabled={busy || !!convertGate || isCurrent}
                disabledReason={convertGate ?? (isCurrent ? 'Already this datatype' : undefined)}
                tooltip={`Convert the signal to ${dt} (direction kept)`}
                onClick={() => { if (qe.signalNodePath) void convertSignalType(ctx.viewer, ctx.doc, qe.signalNodePath, dt); }}
              />
            );
          })}
          <ActionButton
            label={sig?.startsWith('PLCOutput') ? 'To Input' : 'To Output'}
            icon={SwapHoriz}
            disabled={busy || !!convertGate} disabledReason={convertGate ?? undefined}
            tooltip="Flip the signal between PLC output and PLC input (value kept)"
            onClick={() => { if (qe.signalNodePath) void toggleSignalDirection(ctx.viewer, ctx.doc, qe.signalNodePath); }}
          />
        </Box>
      </Box>
    </Section>
  );
}

function LogicStepsSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const noSel = !qe.hasSelection || !qe.nodePath;
  // Starter container — only for "plain" objects (Unity parity).
  const starterGate = noSel ? SELECT_FIRST
    : qe.isUnderSerialContainer ? 'Already inside a container — use the steps below'
      : (qe.hasLogicStep || qe.hasOtherRvComponents) ? 'Only on a plain object (no components yet)'
        : null;
  // Step palette — only usable inside a serial container.
  const paletteGate = noSel ? SELECT_FIRST
    : !qe.isUnderSerialContainer ? 'Add these inside a LogicSteps Container'
      : null;
  return (
    <Section title="Logic Steps">
      <ActionButton
        label="LogicSteps Container" icon={AccountTree}
        disabled={busy || !!starterGate} disabledReason={starterGate ?? undefined}
        tooltip="Add a serial LogicStep container — child objects then hold the steps in sequence"
        onClick={() => { if (!noSel) void addLogicStep(ctx.viewer, ctx.doc, qe, 'LogicStep_SerialContainer'); }}
      />
      <Box sx={{ mt: 0.5 }}>
        <ButtonGrid>
          {LOGIC_STEP_PALETTE.map(({ type, label }) => (
            <ActionButton
              key={type} label={label} icon={AccountTree}
              disabled={busy || !!paletteGate} disabledReason={paletteGate ?? undefined}
              tooltip={`Add ${type.replace('LogicStep_', '')}${qe.hasLogicStep ? ' as the next step (new sibling object)' : ' to this object'}`}
              onClick={() => { if (!paletteGate) void addLogicStep(ctx.viewer, ctx.doc, qe, type); }}
            />
          ))}
        </ButtonGrid>
      </Box>
    </Section>
  );
}

function DriveTestSection({ qe, ctx, busy }: { qe: QuickEditContext; ctx: ActiveAssetContext; busy: boolean }) {
  const drive = qe.drive;
  const nodePath = qe.nodePath;
  const [, setTick] = useState(0);
  const [speedDraft, setSpeedDraft] = useState('');
  const controllerRef = useRef<EditorJogController | null>(null);

  // One controller per live drive; disposal restores the preview pose.
  useEffect(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    if (drive) {
      const controller = new EditorJogController(ctx.viewer, drive);
      controller.onTick = () => setTick(t => t + 1);
      controllerRef.current = controller;
    }
    setSpeedDraft(drive ? String(drive.TargetSpeed) : '');
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [drive, ctx.viewer]);

  const behaviorsPresent = qe.existingDriveBehaviors.size > 0;
  const virtualDrive = drive?.Direction === DriveDirection.Virtual;
  const beltDrive = drive?.isTransportSurface === true;
  const reason = !qe.hasSelection || !nodePath
    ? 'Select a drive object'
    : !qe.isSingle
      ? 'Select a single object'
      : !drive
        ? (qe.hasDrive ? 'The drive becomes testable after save & reload' : 'This object has no Drive')
        : behaviorsPresent
          ? 'Drive has behaviors — jogging is disabled (Unity parity)'
          : virtualDrive
            ? 'Virtual drives have no axis to move'
            : beltDrive
              ? 'Transport-surface drives animate the surface at runtime only'
              : undefined;
  const jogDisabled = busy || reason !== undefined;
  const controller = controllerRef.current;
  const dir = controller?.direction ?? 0;
  const unit = drive?.isRotary ? '°' : 'mm';

  const commitSpeed = () => {
    if (!drive || !nodePath) return;
    const v = Number(speedDraft);
    if (!Number.isFinite(v) || v < 0) { setSpeedDraft(String(drive.TargetSpeed)); return; }
    const key = findDriveKey(qe);
    if (key) ctx.doc.setField(nodePath, key, 'TargetSpeed', v, drive.TargetSpeed);
    drive.targetSpeed = v;
    drive.TargetSpeed = v;
  };

  const jogButton = (label: string, d: -1 | 0 | 1, Icon: ComponentType<{ sx?: object }>) => (
    <Tooltip title={jogDisabled ? (reason ?? '') : label} placement="left">
      <span style={{ display: 'flex', flex: 1 }}>
        <IconButton
          size="small"
          disabled={jogDisabled}
          onClick={() => controller?.jog(d)}
          sx={{
            flex: 1, height: 24, borderRadius: 1,
            border: '1px solid rgba(255,255,255,0.15)',
            color: dir === d && d !== 0 ? 'primary.main' : 'text.secondary',
            bgcolor: dir === d && d !== 0 ? 'rgba(79,195,247,0.12)' : 'transparent',
          }}
        >
          <Icon sx={{ fontSize: 16 }} />
        </IconButton>
      </span>
    </Tooltip>
  );

  return (
    <Section title="Drive Test">
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        {jogButton('Jog backward', -1, FastRewind)}
        {jogButton('Stop (keeps position)', 0, Stop)}
        {jogButton('Jog forward', 1, FastForward)}
        <Tooltip title="Reset to the position before jogging" placement="left">
          <span style={{ display: 'flex' }}>
            <IconButton
              size="small"
              disabled={jogDisabled || !controller?.hasPreviewPose}
              onClick={() => controller?.resetToStart()}
              sx={{ height: 24, width: 24, borderRadius: 1, border: '1px solid rgba(255,255,255,0.15)', color: 'text.secondary' }}
            >
              <RestartAlt sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 0.75, gap: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, whiteSpace: 'nowrap' }}>
          Position: <Box component="span" sx={{ color: 'white', fontVariantNumeric: 'tabular-nums' }}>
            {drive ? drive.currentPosition.toFixed(1) : '—'}
          </Box> {drive ? unit : ''}
        </Typography>
        {/* Speed — the inspector's compact number-field style (18px input,
            11px monospace, 1px scrub bar) with an inline 11px caption label. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, whiteSpace: 'nowrap' }}>
            Speed
          </Typography>
          <DragNumberField
            compact
            value={speedDraft}
            onValueChange={setSpeedDraft}
            onCommit={commitSpeed}
            min={0}
            max={1_000_000}
            step={10}
            unit={drive ? `${unit}/s` : ''}
            disabled={busy || !drive}
            ariaLabel="Target speed"
            sx={{ width: 110 }}
          />
        </Box>
      </Box>
      {controller?.hasPreviewPose && (
        <Typography variant="caption" sx={{ color: '#ffa726', fontSize: 10, display: 'block', mt: 0.5 }}>
          Preview pose — not saved. Reset restores; Save resets automatically.
        </Typography>
      )}
    </Section>
  );
}

/** Concrete rv_extras key of the Drive on the context node. */
function findDriveKey(qe: QuickEditContext): string | null {
  const rv = (qe.node?.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (/^Drive(_\d+)?$/.test(key)) return key;
  }
  return null;
}

// ─── Panel ──────────────────────────────────────────────────────────────

export function KinematicsPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const lpmSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const ctx = getActiveAssetContext();
  const docSnapshot = useSyncExternalStore(
    ctx?.doc.subscribe ?? _noopSubscribe,
    ctx?.doc.getSnapshot ?? _nullSnapshot,
  );
  const selection = useSelection();

  // Re-derive the context when the op log changes scene structure (component
  // adds/removes, renames, undo/redo) — selection changes re-render anyway.
  const [structureTick, setStructureTick] = useState(0);
  useEffect(() => {
    return viewer.on('editor-structure-changed', () => setStructureTick(t => t + 1));
  }, [viewer]);

  const qe = useMemo(
    () => computeQuickEditContext(viewer, selection),
    // structureTick + opCount invalidate on component/structure edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, selection, structureTick, docSnapshot?.opCount],
  );

  const open = lpmSnapshot.right.activePanel === 'kinematics';
  const handleClose = useCallback(() => {
    lpm.close('kinematics');
    try { localStorage.setItem('rv-editor-kinematics-open', 'false'); } catch { /* private mode */ }
  }, [lpm]);

  // Auto Assign mode — opt-in per session (not persisted): clicking 3D objects
  // assigns them to the selected kinematic's group. See KinematicsList.
  const [autoAssign, setAutoAssign] = useState(false);

  // "Add Kinematic": new axis node + fresh empty group in one undo step; arms
  // Auto Assign so the very next 3D clicks fill the group.
  const handleAddKinematic = useCallback(() => {
    const c = getActiveAssetContext();
    if (!c) return;
    void createKinematicWithGroup(viewer, c.doc).then(() => setAutoAssign(true));
  }, [viewer]);

  if (!open || !ctx) return null;
  const busy = docSnapshot?.busy === true;

  // "Center to Group": moves the SELECTED kinematic axis' pivot to the center
  // of the objects its group collects (the objects stay put). Enabled only for
  // a single selected kinematic whose group already has members.
  const centerKinNode = qe.hasKinematic && qe.isSingle && qe.node ? qe.node : null;
  const centerMemberCount = centerKinNode ? kinematicGroupMemberCount(viewer, centerKinNode) : 0;
  const centerDisabled = busy || !centerKinNode || !qe.nodePath || centerMemberCount === 0;
  const centerReason = !qe.hasSelection || !qe.isSingle ? 'Select a single kinematic object'
    : !qe.hasKinematic ? 'Select a kinematic object'
      : centerMemberCount === 0 ? "This kinematic's group has no objects yet"
        : undefined;

  return (
    <LeftPanel
      title="Quick Edit"
      anchor="right"
      mobile="hidden"
      onClose={handleClose}
      width={lpmSnapshot.right.activePanelWidth || getStoredKinematicsPanelWidth()}
      resizable
      minWidth={KINEMATICS_PANEL_MIN_WIDTH}
      maxWidth={KINEMATICS_PANEL_MAX_WIDTH}
      onResize={(w) => {
        lpm.open('kinematics', w, 'right');
        try { localStorage.setItem(LS_KEY_KINEMATICS_PANEL_WIDTH, String(w)); } catch { /* private mode */ }
      }}
    >
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, pb: 1 }}>
        <SelectionHeader qe={qe} />
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />
        {/* Kinematics first — one row per kinematic object (hover previews the
            group, click selects, eye/isolate control the group). The header
            carries the Kinematic badge color to set it apart from the tool
            sections below. */}
        <Section
          title="Kinematics"
          defaultOpen
          accent={KINEMATIC_ACCENT}
          headerAction={<AutoAssignToggle checked={autoAssign} onChange={setAutoAssign} />}
        >
          <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 320, overflowY: 'auto' }}>
            <KinematicsList autoAssign={autoAssign} />
          </Box>
          {/* Below the list scroll area so it never scrolls out of reach. */}
          <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5, mt: 0.75 }}>
            <Tooltip
              placement="top"
              title="Create a new kinematic axis with its own group and turn on Auto Assign — then click objects in the 3D view to add them"
            >
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={handleAddKinematic}
                  startIcon={<Add sx={{ fontSize: 14 }} />}
                  sx={{
                    // ActionButton metrics (height 24, 10px/600) in the
                    // kinematic accent, centered instead of full-width.
                    textTransform: 'none', fontSize: 10, fontWeight: 600,
                    height: 24, py: 0, px: 1, minWidth: 0,
                    color: busy ? 'text.disabled' : KINEMATIC_ACCENT,
                    borderColor: KINEMATIC_ACCENT + '55',
                    '&:hover': { borderColor: KINEMATIC_ACCENT, bgcolor: KINEMATIC_ACCENT + '14' },
                    '& .MuiButton-startIcon': { mr: 0.5, ml: 0 },
                  }}
                >
                  Add Kinematic
                </Button>
              </span>
            </Tooltip>
            <Tooltip
              placement="top"
              title={centerDisabled
                ? (centerReason ?? 'Center the kinematic on its group')
                : "Move the selected kinematic's pivot to the center of its group objects — the objects don't move"}
            >
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={centerDisabled}
                  onClick={() => { if (qe.nodePath) void centerKinematicToGroup(viewer, ctx.doc, qe.nodePath); }}
                  startIcon={<Anchor sx={{ fontSize: 14 }} />}
                  sx={{
                    textTransform: 'none', fontSize: 10, fontWeight: 600,
                    height: 24, py: 0, px: 1, minWidth: 0,
                    color: centerDisabled ? 'text.disabled' : KINEMATIC_ACCENT,
                    borderColor: KINEMATIC_ACCENT + '55',
                    '&:hover': { borderColor: KINEMATIC_ACCENT, bgcolor: KINEMATIC_ACCENT + '14' },
                    '& .MuiButton-startIcon': { mr: 0.5, ml: 0 },
                  }}
                >
                  Center to Group
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Section>
        {/* Every section is always shown; each button greys out via context
            (Unity-style show/hide replaced by always-show + disabled reasons). */}
        <TransformSection qe={qe} ctx={ctx} busy={busy} />
        <CreateSection qe={qe} ctx={ctx} busy={busy} />
        <ComponentsSection qe={qe} ctx={ctx} busy={busy} />
        <DriveBehaviorsSection qe={qe} ctx={ctx} busy={busy} />
        <SignalsSection qe={qe} ctx={ctx} busy={busy} />
        <LogicStepsSection qe={qe} ctx={ctx} busy={busy} />
        <DriveTestSection qe={qe} ctx={ctx} busy={busy} />
      </Box>
    </LeftPanel>
  );
}
