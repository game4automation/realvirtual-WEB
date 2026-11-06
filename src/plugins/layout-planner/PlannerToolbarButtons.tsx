// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PlannerToolbarButtons — floating left-toolbar entries (`button-group` slot)
 * for layout authoring (planner and DES, `AUTHORING_TOOL_RULE`).
 *
 *   - `PlannerSnapFlyout`        — ONE menu button (plan-2010) for the four snap
 *                                  switches: Grid snap, Drop to surface, Magnetic
 *                                  snap, Chain mode; plus rows that open the
 *                                  grid / magnetic settings popovers.
 *   - `PlannerUndoButton` / `PlannerRedoButton` / `PlannerDeleteButton` — the
 *                                  editing block; Delete removes ALL selected
 *                                  layout instances through the same path as the
 *                                  Delete / Backspace shortcut (one SceneStore op).
 *   - `PlannerVanishMUsButton`, `PlannerLibraryButton`, `PlannerDocModeButton`.
 *
 * These were previously in the planner side-panel footer; moving them to
 * the left toolbar frees vertical space in the panel and keeps frequently-
 * used spatial-mode toggles next to other workspace buttons.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Divider,
  IconButton,
  Popover,
  Stack,
  SvgIcon,
  type SvgIconProps,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Adjust,
  AutoDelete,
  BorderOuter,
  DeleteOutline,
  GridOn,
  JoinInner,
  Link as LinkIcon,
  MenuBook,
  Redo,
  Rotate90DegreesCcw,
  SettingsEthernet,
  Straighten,
  Tag,
  Undo,
  VerticalAlignBottom,
  ViewSidebar,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useSelection } from '../../hooks/use-selection';
import { useVanishMUs } from '../../core/hmi/visual-settings-store';
import { ToolFlyout, ToolFlyoutDivider, ToolFlyoutRow } from '../../core/hmi/ToolFlyout';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import { LAYOUT_PANEL_WIDTH } from '../../core/hmi/layout-constants';
import type { SceneSnapshot } from '../../core/hmi/scene/scene-store';
import { DragNumberField } from '../../core/hmi/DragNumberField';
import { parseDecimal } from '../../core/hmi/rv-number-format';
import type { LayoutPlannerPlugin } from './index';
import type { LayoutSnapshot } from './rv-layout-store';
import { aiTouchSx, useCommandView } from '../../core/hmi/rv-command-view';
import { getAiTouchMs } from '../../core/hmi/button-sim-state';
import { alignClose, alignOpen, getAlignSnapshot, subscribeAlign } from './align/align-state';

/**
 * plan-499: sx for a planner IconButton that is a command view — the simulated
 * hover/press of the MCP choreography and the AI afterglow (colour + opacity
 * only, no transform, so reduced motion needs no special case).
 */
function commandButtonSx(view: ReturnType<typeof useCommandView>): Record<string, unknown> {
  return {
    ...(view.simPhase === 'hover' || view.simPhase === 'pressed' ? { bgcolor: 'rgba(79,195,247,0.18)' } : null),
    ...(view.touch ? aiTouchSx(view.aiTouch, getAiTouchMs()) : null),
  };
}

// Sane bounds for typed values — keeps the gizmo from getting micro-snap or
// >360° steps. The user can still set anything within these ranges precisely.
const MIN_TRANSLATION_MM = 0; // 0 = translation snapping off (grid not drawn)
const MAX_TRANSLATION_MM = 100_000;
const MIN_ROTATION_DEG = 0.1;
const MAX_ROTATION_DEG = 180;

// ─── Hook: planner plugin + snapshot ─────────────────────────────────────

/**
 * Get the planner plugin and its store snapshot. ButtonPanel already filters
 * these components out unless the 'planner' UI context is active (via the
 * `visibilityRule: { shownOnlyIn: ['planner'] }` on the slot entry), so we
 * don't re-check `isOpen` here. The `null` fallbacks remain as a defensive
 * boot-race guard for the brief window between viewer construction and
 * plugin registration.
 */
function usePlannerToolbarState(): {
  plugin: LayoutPlannerPlugin | null;
  snapshot: LayoutSnapshot | null;
} {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner') ?? null;
  const store = plugin?.store;
  // useSyncExternalStore needs stable subscribe / getSnapshot fns even when
  // there's no store yet — use no-op fallbacks. Snapshot is null in that case.
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => null as unknown as LayoutSnapshot),
  );
  return { plugin, snapshot };
}

/**
 * Clamp + sanity-check a numeric input. Returns null when input is empty or
 * not a number (caller keeps the editor in "draft" state without committing).
 * Comma and dot are both decimal separators (plan-510, `parseDecimal`).
 */
export function clampNumber(raw: string, min: number, max: number): number | null {
  const n = parseDecimal(raw);
  if (n === null) return null;
  return Math.min(max, Math.max(min, n));
}

// ─── Grid snap settings popover ───────────────────────────────────────────

interface SettingsPopoverProps {
  /** Where the popover opens: the snap flyout trigger. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

/** The grid-snap settings (translation / rotation step), opened from the snap flyout. */
export function GridSnapSettingsPopover({ anchorEl, onClose }: SettingsPopoverProps) {
  const { plugin, snapshot } = usePlannerToolbarState();

  // Local "draft" state so users can type freely without each keystroke
  // committing to the store (which would drive a viewer redraw).
  // Synced from snapshot whenever the popover opens or the snapshot value
  // changes externally (e.g. preset chip clicked).
  const [transDraft, setTransDraft] = useState<string>('');
  const [rotDraft, setRotDraft] = useState<string>('');

  useEffect(() => {
    if (!snapshot) return;
    setTransDraft(String(snapshot.gridSizeMm));
    setRotDraft(String(snapshot.rotationSnapDeg));
  }, [snapshot?.gridSizeMm, snapshot?.rotationSnapDeg, anchorEl]);

  if (!plugin || !snapshot) return null;

  const enabled = snapshot.gridEnabled;
  const sizeMm = snapshot.gridSizeMm;
  const rotDeg = snapshot.rotationSnapDeg;

  /** Commit the typed translation value: clamp, store, refresh the input. */
  const commitTranslation = () => {
    const n = clampNumber(transDraft, MIN_TRANSLATION_MM, MAX_TRANSLATION_MM);
    if (n === null) {
      setTransDraft(String(sizeMm)); // revert
      return;
    }
    plugin.setGridSize(n);
    setTransDraft(String(n));
    // Typing a non-zero value implies "I want snap on". A 0 means translation
    // snapping off, so don't auto-enable the grid for it.
    if (n > 0 && !enabled) plugin.toggleGrid();
  };

  const commitRotation = () => {
    const n = clampNumber(rotDraft, MIN_ROTATION_DEG, MAX_ROTATION_DEG);
    if (n === null) {
      setRotDraft(String(rotDeg));
      return;
    }
    plugin.setRotationSnapDeg(n);
    setRotDraft(String(n));
    if (!enabled) plugin.toggleGrid();
  };

  return (
    <Popover
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
      transformOrigin={{ vertical: 'center', horizontal: 'left' }}
      slotProps={{ paper: { sx: { ml: 1, width: 250, p: 0 }, 'data-testid': 'snap-grid-settings' } as never }}
    >
      {/* Header row — title (the Grid snap row of the flyout is the on/off toggle) */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25 }}>
        <GridOn sx={{ fontSize: 18, color: enabled ? 'primary.main' : 'text.disabled' }} />
        <Typography variant="subtitle2" sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          Snap to grid
        </Typography>
      </Box>

      <Divider />

      {/* Body — one-line rows (no section captions); fades when snap is off
          but stays interactive so the user can pre-set values then enable. */}
      <Stack
        spacing={0.5}
        sx={{ px: 2, py: 1.5, opacity: enabled ? 1 : 0.55, transition: 'opacity 120ms ease' }}
      >
        <DragNumberField
          label="Translation"
          icon={<Straighten sx={{ fontSize: 16 }} />}
          unit="mm"
          value={transDraft}
          onValueChange={setTransDraft}
          onCommit={commitTranslation}
          min={MIN_TRANSLATION_MM}
          max={MAX_TRANSLATION_MM}
          step={1}
          ariaLabel="Translation"
        />
        <DragNumberField
          label="Rotation"
          icon={<Rotate90DegreesCcw sx={{ fontSize: 16 }} />}
          unit="°"
          value={rotDraft}
          onValueChange={setRotDraft}
          onCommit={commitRotation}
          min={MIN_ROTATION_DEG}
          max={MAX_ROTATION_DEG}
          step={0.1}
          ariaLabel="Rotation"
        />
      </Stack>
    </Popover>
  );
}

// ─── Magnetic-snap settings popover ──────────────────────────────────────

// Snap-distance bounds — keep the tolerance physically meaningful.
const MIN_BBOX_TOL_MM = 1;
const MAX_BBOX_TOL_MM = 1000;
// Max auto-measure distance bounds for the neighbor-distance overlay.
const MIN_NEIGHBOR_MAX_MM = 100;
const MAX_NEIGHBOR_MAX_MM = 100_000;

/**
 * The magnetic-snap settings: Mid / Side reference-point toggles, neighbor
 * distances and the snap distance (tolerance) in millimetres. Magnetic snap
 * aligns the bounding-box edges (Side) and centres (Mid) of a dragged object to
 * placed objects within the tolerance. Hold Alt during drag to temporarily
 * suppress.
 *
 * Independent of grid snap — both can be active. Bbox snap takes priority
 * within its tolerance; grid is the fallback quantizer. Opened from the snap flyout.
 */
export function MagneticSnapSettingsPopover({ anchorEl, onClose }: SettingsPopoverProps) {
  const { plugin, snapshot } = usePlannerToolbarState();
  const [tolDraft, setTolDraft] = useState<string>('');
  const [maxDistDraft, setMaxDistDraft] = useState<string>('');

  useEffect(() => {
    if (!snapshot) return;
    setTolDraft(String(snapshot.bboxSnapToleranceMm));
    setMaxDistDraft(String(snapshot.neighborDistanceMaxMm));
  }, [snapshot?.bboxSnapToleranceMm, snapshot?.neighborDistanceMaxMm, anchorEl]);

  if (!plugin || !snapshot) return null;

  const enabled = snapshot.bboxSnapEnabled;
  const mid = snapshot.bboxSnapMid;
  const side = snapshot.bboxSnapSide;
  const showDistance = snapshot.showNeighborDistances;
  const tolMm = snapshot.bboxSnapToleranceMm;
  const maxDistMm = snapshot.neighborDistanceMaxMm;

  const commitTolerance = () => {
    const n = clampNumber(tolDraft, MIN_BBOX_TOL_MM, MAX_BBOX_TOL_MM);
    if (n === null) {
      setTolDraft(String(tolMm));
      return;
    }
    plugin.store.setBboxSnapToleranceMm(n);
    setTolDraft(String(n));
    if (!enabled) plugin.store.setBboxSnap(true); // typing implies "I want snap on"
  };

  const commitMaxDist = () => {
    const n = clampNumber(maxDistDraft, MIN_NEIGHBOR_MAX_MM, MAX_NEIGHBOR_MAX_MM);
    if (n === null) {
      setMaxDistDraft(String(maxDistMm));
      return;
    }
    plugin.store.setNeighborDistanceMaxMm(n);
    setMaxDistDraft(String(n));
  };

  return (
    <Popover
      anchorEl={anchorEl}
      open={!!anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'center', horizontal: 'right' }}
      transformOrigin={{ vertical: 'center', horizontal: 'left' }}
      slotProps={{ paper: { sx: { ml: 1, width: 250, p: 0 }, 'data-testid': 'snap-magnetic-settings' } as never }}
    >
      {/* Header — title (the Magnetic snap row of the flyout is the on/off toggle) */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25 }}>
        <JoinInner sx={{ fontSize: 18, color: enabled ? 'primary.main' : 'text.disabled' }} />
        <Typography variant="subtitle2" sx={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          Magnetic snap
        </Typography>
      </Box>

      <Divider />

      {/* Body — one uniform list of single-line rows (toggles + numeric), no
          section captions. Fades when snap is off but stays interactive. */}
      <Stack
        spacing={0.5}
        sx={{ px: 2, py: 1.5, opacity: enabled ? 1 : 0.55, transition: 'opacity 120ms ease' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Adjust sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography sx={{ fontSize: 12, flex: 1 }}>Mid</Typography>
          <Switch size="small" checked={mid} onChange={() => plugin.store.setBboxSnapMid(!mid)} />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <BorderOuter sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography sx={{ fontSize: 12, flex: 1 }}>Side</Typography>
          <Switch size="small" checked={side} onChange={() => plugin.store.setBboxSnapSide(!side)} />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Tag sx={{ fontSize: 16, color: 'text.secondary' }} />
          <Typography sx={{ fontSize: 12, flex: 1 }}>Neighbor distances</Typography>
          <Switch
            size="small"
            checked={showDistance}
            onChange={() => plugin.store.setShowNeighborDistances(!showDistance)}
          />
        </Box>

        <DragNumberField
          label="Snap distance"
          icon={<SettingsEthernet sx={{ fontSize: 16 }} />}
          unit="mm"
          value={tolDraft}
          onValueChange={setTolDraft}
          onCommit={commitTolerance}
          min={MIN_BBOX_TOL_MM}
          max={MAX_BBOX_TOL_MM}
          step={1}
          ariaLabel="Snap distance"
        />
        <DragNumberField
          label="Max measure"
          icon={<Straighten sx={{ fontSize: 16 }} />}
          unit="mm"
          value={maxDistDraft}
          onValueChange={setMaxDistDraft}
          onCommit={commitMaxDist}
          min={MIN_NEIGHBOR_MAX_MM}
          max={MAX_NEIGHBOR_MAX_MM}
          step={50}
          ariaLabel="Max measure distance"
        />
      </Stack>
    </Popover>
  );
}

// ─── Snap flyout ──────────────────────────────────────────────────────────

/**
 * Toolbar menu button (plan-2010) — ONE trigger for the four layout-snap
 * switches that used to be four toolbar icons: Grid snap, Drop to surface,
 * Magnetic snap and Chain mode, as checkbox rows with their current state,
 * plus two rows that open the grid / magnetic settings popovers at the trigger.
 * The trigger is coloured while at least one switch is on; its tooltip names
 * the active ones. Chain mode moves assets connected via snap points together
 * with the dragged one (independent of magnetic snap: the snap-point plugin
 * reads `store.chainModeEnabled` itself).
 */
export function PlannerSnapFlyout() {
  const { plugin, snapshot } = usePlannerToolbarState();
  const [settings, setSettings] = useState<{ kind: 'grid' | 'magnetic'; anchor: HTMLElement } | null>(null);
  if (!plugin || !snapshot) return null;

  const grid = snapshot.gridEnabled;
  const drop = snapshot.dropToSurface;
  const magnetic = snapshot.bboxSnapEnabled;
  const chain = snapshot.chainModeEnabled;
  const activeNames = [
    grid && 'grid', drop && 'drop', magnetic && 'magnetic', chain && 'chain',
  ].filter(Boolean) as string[];
  const title = activeNames.length > 0 ? `Snap — ${activeNames.join(', ')} on` : 'Snap — all off';
  const gridDescription = `${snapshot.gridSizeMm > 0 ? `${snapshot.gridSizeMm} mm` : 'translation off'} / ${snapshot.rotationSnapDeg}°`;

  return (
    <>
      <ToolFlyout
        title={title}
        menuLabel="Snap"
        icon={<GridOn />}
        active={activeNames.length > 0}
        testId="planner-snap-flyout"
      >
        <ToolFlyoutRow
          kind="checkbox" label="Grid snap" icon={<GridOn />} checked={grid}
          description={gridDescription} testId="snap-row-grid"
          onSelect={() => plugin.toggleGrid()}
        />
        <ToolFlyoutRow
          kind="checkbox" label="Drop to surface" icon={<VerticalAlignBottom />} checked={drop}
          testId="snap-row-drop"
          onSelect={() => plugin.store.setDropToSurface(!drop)}
        />
        <ToolFlyoutRow
          kind="checkbox" label="Magnetic snap" icon={<JoinInner />} checked={magnetic}
          description={`${snapshot.bboxSnapToleranceMm} mm`} testId="snap-row-magnetic"
          onSelect={() => plugin.store.setBboxSnap(!magnetic)}
        />
        <ToolFlyoutRow
          kind="checkbox" label="Chain mode" icon={<LinkIcon />} checked={chain}
          testId="snap-row-chain"
          onSelect={() => plugin.store.setChainMode(!chain)}
        />
        <ToolFlyoutDivider />
        <ToolFlyoutRow
          label="Grid snap settings…" testId="snap-row-grid-settings"
          onSelect={(anchor) => setSettings({ kind: 'grid', anchor })}
        />
        <ToolFlyoutRow
          label="Magnetic snap settings…" testId="snap-row-magnetic-settings"
          onSelect={(anchor) => setSettings({ kind: 'magnetic', anchor })}
        />
      </ToolFlyout>
      <GridSnapSettingsPopover
        anchorEl={settings?.kind === 'grid' ? settings.anchor : null}
        onClose={() => setSettings(null)}
      />
      <MagneticSnapSettingsPopover
        anchorEl={settings?.kind === 'magnetic' ? settings.anchor : null}
        onClose={() => setSettings(null)}
      />
    </>
  );
}

// ─── Vanish-MUs button ───────────────────────────────────────────────────

/**
 * Toolbar button — toggles "vanish MUs at end of line". When on, an MU that
 * runs off the last transport surface (no successor belt picks it up) is
 * deleted after a short delay. State is persisted (localStorage) and pushed
 * onto the live transport manager via `viewer.setVanishMUs`.
 */
export function PlannerVanishMUsButton() {
  const viewer = useViewer();
  const on = useVanishMUs();

  return (
    <Tooltip title={on ? 'Vanish MUs at end of line: ON' : 'Vanish MUs at end of line: OFF'} placement="right">
      <IconButton
        size="small"
        onClick={() => viewer.setVanishMUs(!on)}
        sx={{
          p: 0.75,
          color: on ? 'primary.main' : 'text.disabled',
        }}
        aria-label="Toggle vanish MUs at end of line"
      >
        <AutoDelete sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ─── Align tool button (plan-779) ────────────────────────────────────────

/** Corner-to-corner icon: dashed box A, arrow from its corner onto the dotted corner of box B. */
function AlignCornerIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 1.6" />
      <rect x="12.5" y="12.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.5 9.5 L11.6 11.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12.6 9.6 L12.6 12.6 L9.6 12.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12.5" cy="12.5" r="1.9" fill="currentColor" />
    </SvgIcon>
  );
}

/**
 * Toolbar button — opens / closes the Align tool (corner of placement A onto
 * a corner of any geometry B). The tool's runtime and panel load on the first
 * open; this button only imports the tiny state store.
 */
export function PlannerAlignButton() {
  const viewer = useViewer();
  const open = useSyncExternalStore(subscribeAlign, () => getAlignSnapshot().open);

  const onClick = () => {
    if (open) { alignClose(); return; }
    void import('./align/align-pick').then((m) => {
      m.ensureAlignRuntime(viewer);
      alignOpen();
    });
  };

  return (
    <Tooltip title={open ? 'Close Align tool' : 'Align: corner of A onto corner of B'} placement="right">
      <IconButton
        size="small"
        onClick={onClick}
        sx={{ p: 0.75, color: open ? 'primary.main' : 'text.secondary' }}
        aria-label="Toggle Align tool"
        aria-pressed={open}
      >
        <AlignCornerIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ─── Documentation-mode button ───────────────────────────────────────────

/**
 * Toolbar button — toggles documentation mode. When on, component datasheets
 * (the standard AAS drive docs attached by the transport library components)
 * are shown on hover / selection while the planner is active; when off, the
 * planner stays clean. Outside the planner the datasheets are always visible,
 * so this toggle only matters in planner mode.
 */
export function PlannerDocModeButton() {
  const { plugin, snapshot } = usePlannerToolbarState();
  if (!plugin || !snapshot) return null;

  const on = snapshot.docMode;
  return (
    <Tooltip title={on ? 'Documentation mode: ON (component datasheets visible)' : 'Documentation mode: OFF'} placement="right">
      <IconButton
        size="small"
        onClick={() => plugin.store.setDocMode(!on)}
        sx={{
          p: 0.75,
          color: on ? 'primary.main' : 'text.disabled',
        }}
        aria-label="Toggle documentation mode"
      >
        <MenuBook sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ─── Signal-linking mode button ──────────────────────────────────────────

/**
 * Toolbar button — toggles Planner Signal Linking mode (plan-226). When on,
 * every placed element with bindable standard-signal slots shows a 3D status
 * badge; clicking a badge opens the CONNECT signal picker. When off, no badges
 * and no picker (pure layout). The whole feature is gated by the viewer's
 * `plannerSignalLinking` flag — when that flag is off there is no
 * `signalBindingManager`, so the button hides itself entirely.
 */
// ─── Delete-selection button ─────────────────────────────────────────────

/**
 * Toolbar button — removes every currently-selected layout instance. Shares
 * its remove-path (`plugin.removeSelected()`) with the Delete / Backspace
 * keyboard shortcut, so both gestures emit the same single composite op
 * (single Ctrl+Z restores the lot).
 *
 * Disabled state reactivly tracks the SelectionManager so the user gets an
 * immediate visual cue when nothing is selected.
 */
export function PlannerDeleteButton() {
  const { plugin } = usePlannerToolbarState();
  const selection = useSelection();
  // plan-499: a view of `layout.remove` with `id: null` = "the selection" — the
  // Delete key and web_layout_remove are the others. Disabled + tooltip come
  // from the command's rule; the afterglow of web_layout_remove lands here.
  const viewer = useViewer();
  const view = useCommandView({ id: 'layout.remove', args: () => ({ id: null }), viewer });
  if (!plugin) return null;

  // Spawned MUs are registered selectable scene nodes, so they appear in
  // SelectionManager paths just like layout objects — no special-casing here.
  const count = selection.selectedPaths.length;
  const disabled = view.disabled;
  const tooltip = disabled
    ? (view.reason ?? 'Delete (select something first)')
    : count <= 1 ? 'Delete' : `Delete ${count} items`;

  return (
    <Tooltip title={tooltip} placement="right">
      {/* Tooltip on a disabled IconButton needs a wrapping span — MUI swallows
          pointer events on disabled buttons otherwise. */}
      <span>
        <IconButton
          size="small"
          onClick={view.onClick}
          disabled={disabled}
          {...view.dataAttrs}
          aria-description={view.touch ? 'Triggered by AI' : undefined}
          sx={{
            p: 0.75,
            color: disabled ? 'text.disabled' : '#ef5350',
            ...commandButtonSx(view),
          }}
          aria-label="Delete selected"
        >
          <DeleteOutline sx={{ fontSize: 18 }} />
        </IconButton>
      </span>
    </Tooltip>
  );
}

// ─── Library toggle ──────────────────────────────────────────────────────

/**
 * Toolbar button — toggles the planner Library window (the right-docked parts
 * catalog). Makes the library OPTIONAL in planner mode: closing it just hides
 * the panel; the planner stays active and the workspace mode is unchanged (the
 * mode ↔ library coupling lives in the plugin's lpm subscription). Active
 * (primary) while the library is open.
 */
export function PlannerLibraryButton() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isOpen = snap.right.activePanel === 'layout-planner';

  return (
    <Tooltip title={isOpen ? 'Hide Library' : 'Show Library'} placement="right">
      <IconButton
        size="small"
        onClick={() => {
          if (isOpen) lpm.close('layout-planner');
          else lpm.open('layout-planner', LAYOUT_PANEL_WIDTH, 'right');
        }}
        sx={{ p: 0.75, color: isOpen ? 'primary.main' : 'text.disabled' }}
        aria-label="Toggle planner library"
      >
        <ViewSidebar sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ─── Undo / Redo buttons ─────────────────────────────────────────────────

// Stable no-op fallbacks for useSyncExternalStore while the SceneStore singleton
// hasn't been created yet (brief boot window before planner UI shows).
const _noopSubscribe = () => () => {};
const _nullSnapshot = () => null as unknown as SceneSnapshot;

/**
 * One history button. Reuses the existing SceneStore undo/redo op-log — the
 * same store that the keyboard shortcuts (Ctrl+Z / Ctrl+Y) and the scene card
 * drive — so planner edits, deletes and placements all share one history.
 */
function HistoryButton({ kind }: { kind: 'undo' | 'redo' }) {
  const store = getSceneStore();
  const snap = useSyncExternalStore(
    store?.subscribe ?? _noopSubscribe,
    store?.getSnapshot ?? _nullSnapshot,
  );
  // plan-499: a view of `layout.undo` / `layout.redo` (the SceneStore history —
  // no second one); the snapshot subscription above re-renders on every op.
  const viewer = useViewer();
  const view = useCommandView({ id: kind === 'undo' ? 'layout.undo' : 'layout.redo', viewer });
  if (!store) return null;

  const enabled = !view.disabled;
  const label = (kind === 'undo' ? snap.undoLabel : snap.redoLabel) ?? view.reason ?? (kind === 'undo' ? 'Undo' : 'Redo');

  return (
    <Tooltip title={label} placement="right">
      {/* Tooltip on a disabled IconButton needs a wrapping span. */}
      <span>
        <IconButton
          size="small"
          onClick={view.onClick}
          disabled={!enabled}
          {...view.dataAttrs}
          sx={{ p: 0.75, color: enabled ? 'text.secondary' : 'text.disabled', ...commandButtonSx(view) }}
          aria-label={kind === 'undo' ? 'Undo' : 'Redo'}
        >
          {kind === 'undo' ? <Undo sx={{ fontSize: 18 }} /> : <Redo sx={{ fontSize: 18 }} />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function PlannerUndoButton() { return <HistoryButton kind="undo" />; }
export function PlannerRedoButton() { return <HistoryButton kind="redo" />; }

