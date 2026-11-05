// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { DesExperimentsSideButton } from '../../sim-controller/DesExperimentsButton';

import { snapshotRefusalText } from '../../../core/sdk/rv-des-snapshot-messages';
import * as snapshotFeedback from './des-snapshot-feedback-store';
import { SEVERITY_COLORS } from '../../../core/hmi/severity-pulse';

/**
 * des-hmi-plugin.ts -- HMI plugin that registers DES UI slots.
 *
 * Contributes material-flow statistics to the hub and side tools for the
 * event queue, snapshots, and experiment matrix.
 * Also publishes DES component states as integer-encoded signals
 * with DES: prefix for tooltip integration.
 *
 * Follows the existing plugin UI slot pattern from rv-ui-plugin.ts
 * and the DemoHMIPlugin pattern.
 */

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { IconButton, Tooltip, Paper, Typography } from '@mui/material';
import { Save, EventNote } from '@mui/icons-material';
import type { RVViewerPlugin } from '../../../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../../../core/rv-ui-plugin';
import type { SimDesControl } from '../../../core/material-flow/simulation-kernel';
import {
  isEventQueueWindowOpen, toggleEventQueueWindow, subscribeEventQueueWindow,
} from '../../sim-controller/event-queue-window-store';
import type { LoadResult } from '../../../core/engine/rv-scene-loader';
import type { RVViewer } from '../../../core/rv-viewer';
import { modeContext } from '../../../core/rv-mode-manager';
import { ensureDesRunCommandsRegistered } from '../../../core/hmi/des-run-commands';
import { commandRegistry } from '../../../core/hmi/rv-command-registry';
import { TOOL_GROUP } from '../../../core/hmi/button-panel-sections';
import { ToolFlyout, ToolFlyoutRow } from '../../../core/hmi/ToolFlyout';
import { DESUtilizationBody } from './DESStatsChart';
import { getDesStatsGizmos, peekDesStatsGizmos, disposeDesStatsGizmos } from './des-stats-gizmos';
import { getActiveDesRunner, desComponentsOf } from './des-active-runner';
import type {
  LibraryCatalog,
  LibraryCatalogEntry,
} from '../../layout-planner/rv-layout-store';

// Import tooltip registration side-effect
import './DESComponentTooltip';

// ── State signal publishing interval ──

const SIGNAL_PUBLISH_MS = 250;

const INDEXING_SLOT_COUNT = 4;
const INDEXING_PITCH_MM = 250;

/** Virtual planner entries for the DES-only material-flow definitions. */
export const DES_MATERIAL_FLOW_CATALOG_ENTRIES: LibraryCatalogEntry[] = [
  {
    id: 'des-pallet-source',
    name: 'Pallet Source',
    category: 'des',
    virtual: true,
    desType: 'PalletSource',
    desConfig: {
      PalletTemplateRef: '',
      BlisterTemplateRef: '',
      PartTemplateRef: '',
      BlisterCount: 4,
      PartsPerBlister: 6,
      CarrierCapacity: 6,
      GridRows: 2,
      GridColumns: 3,
      GridPitch: 100,
      MaxCapacity: 1,
    },
    gizmoSize: [1200, 150, 800],
    footprintMm: [1200, 800],
    virtualPorts: [{ name: 'XP-des', position: [600, 75, 0] }],
    tags: ['des', 'source', 'pallet'],
  },
  {
    id: 'des-indexing-conveyor',
    name: 'Indexing Conveyor',
    category: 'des',
    virtual: true,
    desType: 'IndexingConveyor',
    desConfig: {
      slotCount: INDEXING_SLOT_COUNT,
      pitch: INDEXING_PITCH_MM,
      speed: 250,
      dwellTime: 0,
      reportFreeAt: 1,
    },
    gizmoSize: [INDEXING_SLOT_COUNT * INDEXING_PITCH_MM, 200, 500],
    footprintMm: [INDEXING_SLOT_COUNT * INDEXING_PITCH_MM, 500],
    virtualPorts: [
      { name: 'XN-des', position: [-INDEXING_SLOT_COUNT * INDEXING_PITCH_MM / 2, 100, 0] },
      { name: 'XP-des', position: [INDEXING_SLOT_COUNT * INDEXING_PITCH_MM / 2, 100, 0] },
    ],
    virtualChildren: Array.from({ length: INDEXING_SLOT_COUNT }, (_, index) => ({
      name: `Carrier-${index + 1}`,
      kind: 'carrier' as const,
      position: [(index - (INDEXING_SLOT_COUNT - 1) / 2) * INDEXING_PITCH_MM, 100, 0] as [number, number, number],
      size: [150, 50, 150] as [number, number, number],
    })),
    tags: ['des', 'conveyor', 'indexing'],
  },
  {
    id: 'des-robot-handling',
    name: 'Robot Handling',
    category: 'des',
    virtual: true,
    desType: 'RobotHandling',
    desConfig: {
      mode: 'unload',
      batchSize: 1,
      timePerPick: 0,
      timePerCycle: 0,
      pickFilter: '',
      removeEmptyCarriers: true,
      maxWaitTime: 0,
    },
    gizmoSize: [800, 1000, 800],
    footprintMm: [800, 800],
    virtualPorts: [
      { name: 'XN-des', position: [-400, 500, 0] },
      { name: 'XP-des', position: [400, 500, 0] },
      { name: 'ZP-des-empty', position: [0, 500, 400] },
    ],
    tags: ['des', 'robot', 'handling'],
  },
  {
    id: 'des-path-transport',
    name: 'Path Transport',
    category: 'des',
    virtual: true,
    desType: 'PathTransport',
    desConfig: { speed: 1000, capacity: 1 },
    gizmoSize: [2000, 100, 300],
    footprintMm: [2000, 300],
    virtualPorts: [
      { name: 'XN-des', position: [-1000, 50, 0] },
      { name: 'XP-des', position: [1000, 50, 0] },
    ],
    virtualChildren: [{
      name: 'Path-1',
      kind: 'path',
      position: [-1000, 50, 0],
      size: [2000, 0, 0],
    }],
    tags: ['des', 'transport', 'path'],
  },
];

// ── Slot components ──

export function DESSnapshotFeedback() {
  const feedback = useSyncExternalStore(snapshotFeedback.subscribe, snapshotFeedback.getSnapshot);
  if (!feedback) return null;
  return <Paper role={feedback.severity === 'warning' ? 'alert' : 'status'}
    data-testid="des-snapshot-feedback"
    sx={{ p: 1.5, borderLeft: `3px solid ${SEVERITY_COLORS[feedback.severity]}`, pointerEvents: 'auto' }}>
    <Typography variant="body2">{feedback.text}</Typography>
  </Paper>;
}

/**
 * DES Snapshot menu (plan-2010) — ONE side-toolbar button that opens a small
 * menu with "Save snapshot" and "Load snapshot…" (these used to be two icons),
 * so the snapshot actions live with the other DES-specific tools instead of
 * crowding the top sim-control toolbar.
 * Driven entirely through the PUBLIC `SimDesControl` surface — no private import.
 * Only visible while a DES runner is active (mode:des).
 */
export function DESSnapshotMenu({ viewer }: UISlotProps) {
  const [hasDes, setHasDes] = useState(false);

  useEffect(() => {
    const check = (): void => setHasDes(!!viewer.simulationKernel?.desControl?.());
    check();
    const u1 = viewer.on('model-loaded', check);
    const u2 = viewer.on('simulation-mode-changed', check);
    return () => { u1(); u2(); };
  }, [viewer]);

  const ctl = useCallback(
    (): SimDesControl | null => viewer.simulationKernel?.desControl?.() ?? null,
    [viewer],
  );

  const handleSave = useCallback(() => {
    // Snapshot contract or fingerprint violations refuse with a throw.
    let json: string | undefined;
    try { json = ctl()?.snapshotJson?.(); }
    catch (e) { snapshotFeedback.post(snapshotRefusalText(e), 'warning'); return; }
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'des-snapshot.json';
    a.click();
    URL.revokeObjectURL(url);
    snapshotFeedback.post('Snapshot saved.', 'success');
  }, [ctl]);

  const handleLoad = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (): Promise<void> => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const control = ctl();
        if (!control?.restoreJson) return;
        // An async restore waits for transient snapshot gates (PLC deploy, script load) instead of refusing.
        await control.whenCycleOwnersReady?.();
        control.restoreJson(text);
        snapshotFeedback.post('Snapshot loaded.', 'success');
      } catch (e) { snapshotFeedback.post(snapshotRefusalText(e), 'warning'); }
    };
    input.click();
  }, [ctl]);

  if (!hasDes) return null;

  return (
    <ToolFlyout title="DES snapshot" icon={<Save />} testId="des-side-snapshot">
      <ToolFlyoutRow label="Save snapshot" onSelect={handleSave} testId="des-side-snapshot-save" />
      <ToolFlyoutRow label="Load snapshot…" onSelect={handleLoad} testId="des-side-snapshot-load" />
    </ToolFlyout>
  );
}

/**
 * DES Event Queue toggle — side tool menu. Opens the private DESEventQueueWindow
 * (with filter/category) via the shared public open-store. Moved off the top sim
 * toolbar so all DES tools sit together in the side group. Only with a DES runner.
 */
function DESEventQueueButton({ viewer }: UISlotProps) {
  const [hasDes, setHasDes] = useState(false);
  const open = useSyncExternalStore(subscribeEventQueueWindow, isEventQueueWindowOpen);

  useEffect(() => {
    const check = (): void => setHasDes(!!viewer.simulationKernel?.desControl?.());
    check();
    const u1 = viewer.on('model-loaded', check);
    const u2 = viewer.on('simulation-mode-changed', check);
    return () => { u1(); u2(); };
  }, [viewer]);

  if (!hasDes) return null;

  return (
    <Tooltip title="Event Queue" placement="right">
      <IconButton
        size="small"
        onClick={toggleEventQueueWindow}
        sx={{ color: open ? '#4fc3f7' : 'inherit', p: 0.75 }}
        data-testid="des-side-event-queue"
      >
        <EventNote fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

// ── Plugin ──

export class DESHMIPlugin implements RVViewerPlugin {
  constructor() {
    ensureDesRunCommandsRegistered();
  }

  readonly id = 'des-hmi';
  readonly order = 100;

  // The DES sim controls now live in the top toolbar (public DESControllerToolbar,
  // gated to mode:des) and the Event Queue window opens from there. This plugin
  // contributes statistics to the hub alongside library registration and state signals.
  // DES side-tool buttons. The ButtonPanel hides rule-less entries in a focused
  // workspace mode, so these opt IN to mode:des explicitly (otherwise they'd
  // only show in the default HMI view, never in the DES workspace).
  readonly slots: UISlotEntry[] = [
    { slot: 'messages', component: DESSnapshotFeedback, order: 52,
      visibilityId: 'des-snapshot-feedback', visibilityRule: { shownOnlyInAny: [modeContext('des')] } },
    // Event Queue toggle — side tool menu (moved off the top sim toolbar).
    {
      slot: 'button-group', component: DESEventQueueButton, order: 51, group: TOOL_GROUP.analysis,
      visibilityId: 'des-event-queue', visibilityRule: { shownOnlyInAny: [modeContext('des')] },
    },
    // DES snapshot menu (Save / Load) — ONE side tool button (moved off the top sim toolbar).
    {
      slot: 'button-group', component: DESSnapshotMenu, order: 52, group: TOOL_GROUP.analysis,
      visibilityId: 'des-snapshot', visibilityRule: { shownOnlyInAny: [modeContext('des')] },
    },
    // Experiments window opener (plan-265; core button since plan-2211 G5).
    {
      slot: 'button-group', component: DesExperimentsSideButton, order: 53, group: TOOL_GROUP.analysis,
      visibilityId: 'des-experiments', visibilityRule: { shownOnlyInAny: [modeContext('des')] },
    },
  ];

  private _viewer: RVViewer | null = null;
  private _unregisterStats: (() => void) | null = null;
  private _publishInterval = 0;
  private _offModeChanged: (() => void) | null = null;

  init(viewer: RVViewer): void {
    if (this._unregisterStats) return;
    this._viewer = viewer;
    this._watchMode(viewer);
    this._unregisterStats = viewer.stats.register({
      id: 'des.utilization', title: 'Material flow', order: 10,
      isAvailable: () => viewer.modes?.activeMode === 'des' && !!getActiveDesRunner(viewer),
      subscribe: (notify) => {
        const off = ['mode-changed', 'model-cleared', 'model-loaded', 'simulation-mode-changed']
          .map(event => viewer.on(event, notify));
        return () => { for (const unsubscribe of off) unsubscribe(); };
      },
      Body: DESUtilizationBody,
      settings: [{
        id: 'des.badges', label: 'In-scene badges',
        get: () => peekDesStatsGizmos(viewer)?.enabled ?? false,
        set: (on) => getDesStatsGizmos(viewer).setEnabled(on),
        // The `des.badges` command (MCP, bindings) switches the badges outside the hub.
        subscribe: (cb) => commandRegistry.onExecuted((event) => { if (event.id === 'des.badges') cb(); }),
      }],
    });
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._watchMode(viewer);
    this._registerLibraryEntries();  // no-op outside the DES mode
    this._startSignalPublishing();
  }

  // Also called from slots — DESToolbarButton passes viewer
  ensureViewer(viewer: RVViewer): void {
    if (!this._viewer) {
      this._viewer = viewer;
      this._watchMode(viewer);
      this._registerLibraryEntries();
    }
  }

  onModelCleared(): void {
    if (this._viewer) disposeDesStatsGizmos(this._viewer);
    this._stopSignalPublishing();
  }

  /**
   * Per frame: in-scene stats badges follow their (moving) nodes and keep their
   * screen size (plan-612 CP1d-a). No-op without badges; never marks the frame
   * dirty itself — the badges only move while the scene is rendered anyway.
   */
  onRender(): void {
    if (this._viewer) peekDesStatsGizmos(this._viewer)?.updateFrame();
  }

  dispose(): void {
    this._unregisterStats?.();
    this._unregisterStats = null;
    if (this._viewer) disposeDesStatsGizmos(this._viewer);
    this._stopSignalPublishing();
    this._offModeChanged?.();
    this._offModeChanged = null;
    this._viewer = null;
  }

  /**
   * The DES catalog follows the DES mode. It used to be injected on every
   * model load, which put "DES Components" into the Assets tree of every
   * session; now it appears when the mode is entered and leaves with it.
   */
  private _watchMode(viewer: RVViewer): void {
    // Minimal hosts (tests, constrained shells) may carry no event bus.
    if (this._offModeChanged || typeof viewer.on !== 'function') return;
    this._offModeChanged = viewer.on('mode-changed', (data: unknown) => {
      const to = (data as { to?: string } | undefined)?.to;
      if (to === 'des') this._registerLibraryEntries();
      else {
        disposeDesStatsGizmos(viewer);
        this._unregisterLibraryEntries();
      }
    });
  }

  // ── Library registration ──
  // Inject DES virtual components into the layout planner library.

  private _registerLibraryEntries(): void {
    if (!this._viewer) return;
    // Only while the DES mode is active — the catalog must not auto-load
    // into every session's Assets tree (user decision 2026-08-12).
    if (this._viewer.modes?.activeMode !== 'des') return;
    const layoutPlugin = this._viewer.getPlugin('layout-planner') as
      { store?: { addCatalogDirect?(key: string, catalog: LibraryCatalog): void } } | null;
    if (!layoutPlugin?.store?.addCatalogDirect) return;

    // plan-2006 Phase 5: the native DESSource/DESSink/DESConveyor entries left with the
    // retired DES engine (the runner never bound them); only material-flow entries remain.
    const entries: LibraryCatalogEntry[] = [...DES_MATERIAL_FLOW_CATALOG_ENTRIES];

    if (entries.length > 0) {
      layoutPlugin.store.addCatalogDirect('des-components', {
        version: '1.0',
        name: 'DES Components',
        entries,
      });
    }
  }

  /** The mode is gone, and its palette goes with it. Safe when never added. */
  private _unregisterLibraryEntries(): void {
    const layoutPlugin = this._viewer?.getPlugin('layout-planner') as
      { store?: { removeCatalog?(url: string): void } } | null;
    layoutPlugin?.store?.removeCatalog?.('des-components');
  }

  // ── Signal publishing ──
  // Publish DES component states as integer-encoded signals with DES: prefix.
  // This allows the existing tooltip system and signal store to display states.
  // Encoding: 0=Empty, 1=Working, 2=Blocked, 3=Failure, 4=Paused, 5=Transport.

  private _startSignalPublishing(): void {
    this._stopSignalPublishing();
    this._publishInterval = window.setInterval(() => this._publishStates(), SIGNAL_PUBLISH_MS);
  }

  private _stopSignalPublishing(): void {
    if (this._publishInterval) {
      clearInterval(this._publishInterval);
      this._publishInterval = 0;
    }
  }

  private _publishStates(): void {
    if (!this._viewer) return;

    const source = getActiveDesRunner(this._viewer);
    if (!source) return;

    const signalStore = this._viewer.signalStore;
    if (!signalStore) return;

    const components = desComponentsOf(source);
    for (const comp of components) {
      const signalName = `DES:${comp.path}.state`;
      signalStore.set(signalName, comp.state);
    }
  }
}
