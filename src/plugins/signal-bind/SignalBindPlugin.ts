// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotEntry } from '../../core/rv-ui-plugin';
import { SIGNAL_LINK_REST_MODE, SIGNAL_LINK_TOOLBAR_CONTEXTS, isSignalLinkingAllowed } from './signal-link-gate';
import { TOOL_GROUP } from '../../core/hmi/button-panel-sections';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import { disposeSignalDrag } from '../../core/hmi/signal-drag-store';
import { SceneDragOpenController } from './scene-drag-open';
import { SignalBadgeController, type BadgePlannerLike } from './SignalBadgeController';
import { closeSignalBindPopover, openSignalBindPopover } from './signal-bind-store';
import { findSignalBindTarget, signalBindEligibility, signalBindTargetId } from './signal-bind-target';
import './SignalBindPopover';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import { mergeAppliedMappings } from './binding-inventory';
import { DropTargetOverlayController } from './drop-target-overlay';
import { SignalLinkModeButton } from './SignalLinkModeButton';
import { BindingsOverviewButton } from './BindingsOverviewButton';
import { isSignalLinkModeActive, setSignalLinkModeSuspended } from './signal-link-mode-store';
import { registerSignalBulkActions } from './component-bulk-actions';
import type { SignalBindingManager } from '../../core/engine/rv-signal-binding-manager';
import { clearUnitProblems } from '../../core/hmi/problems-store';
import { getFmuInstances, subscribeFmuInstances } from '../../core/engine/rv-fmu';
import { reconcileUnitProblems } from './unit-scale';
// Side-effect registration of the badge hover card (plan-422 F5): the
// controller registers itself with the tooltip registry, which App.tsx renders.
import './BadgeTooltipController';
import {
  SIGNAL_BIND_MENU_PLUGIN_ID,
  signalBindContextMenuItems,
} from './plc-signal-context-menu';

interface PlannerLike extends BadgePlannerLike {
  id: string;
}

/** Productive lifecycle owner for signal drag, badges, restore and teardown. */
export class SignalBindPlugin implements RVViewerPlugin {
  readonly id = 'signal-bind';
  readonly core = true;
  readonly slots: UISlotEntry[] = [{
    slot: 'button-group',
    component: SignalLinkModeButton,
    order: 64,
    group: TOOL_GROUP.model,
    // plan-423: binding model slots to live signals IS the commissioning
    // workflow — the rule must name it (ButtonPanel auto-hides ruleless entries
    // in a focused mode). The operator workspaces (hmi, viewer) are NOT in the
    // list: signal linking is engineering work (signal-link-gate.ts).
    // plan-2010: DES is not in the TOOLBAR list (Thomas, 2026-10-27).
    visibilityRule: { shownOnlyInAny: [...SIGNAL_LINK_TOOLBAR_CONTEXTS] },
  }, {
    // Directly beside the link-mode toggle: making links and reviewing them are
    // the two halves of one job (plan-425 F7).
    slot: 'button-group',
    component: BindingsOverviewButton,
    order: 65,
    group: TOOL_GROUP.model,
    visibilityRule: { shownOnlyInAny: [...SIGNAL_LINK_TOOLBAR_CONTEXTS] },
  }];

  private viewer: RVViewer | null = null;
  private dragController: SceneDragOpenController | null = null;
  private overlayController: DropTargetOverlayController | null = null;
  private badgeController: SignalBadgeController | null = null;
  private clickUnsub: (() => void) | null = null;
  /** plan-512: the manager the unit reconcile listens to (a model load builds a new one). */
  private unitManager: SignalBindingManager | null = null;
  private unitManagerUnsub: (() => void) | null = null;
  /** Targets whose binding set changed in this model — re-evaluated when an FMU attaches late. */
  private readonly unitTargets = new Set<string>();
  private fmuUnsub: (() => void) | null = null;
  private fmuSignalKey = '';
  /** plan-2010: follows the workspace mode so a switched-on link mode rests in DES. */
  private modeUnsub: (() => void) | null = null;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    // The link mode rests while the workspace is DES (its toolbar switch is not
    // offered there): the stored switch stays, badges and the tooltip gate follow
    // `active`. The mode may already be DES at boot, hence the initial sync.
    this.modeUnsub?.();
    setSignalLinkModeSuspended(viewer.modes?.activeMode === SIGNAL_LINK_REST_MODE);
    this.modeUnsub = viewer.on('mode-changed', ({ to }) => setSignalLinkModeSuspended(to === SIGNAL_LINK_REST_MODE));
    // plan-512 F7: an FMU registers its signal units in `init()`, which can run
    // AFTER the mappings that read them were applied (placements, editor
    // attach). A changed FMU signal set re-derives the unit problems.
    this.fmuUnsub = subscribeFmuInstances(() => this._onFmuInstancesChanged());
    // Auto-assign / Unbind-all as component-section actions (plan-325 F5) —
    // registered once; component schemas are in place at plugin init.
    registerSignalBulkActions();
    // "Link signal…" on raw PLC signal rows of the hierarchy tree (plan-418 F2).
    // Registration is model-independent (the condition resolves per open), so it
    // lives here and is torn down symmetrically in dispose().
    viewer.contextMenu.register({
      pluginId: SIGNAL_BIND_MENU_PLUGIN_ID,
      items: signalBindContextMenuItems(viewer),
    });
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.teardownModel();
    this.viewer = viewer;
    // Before the restore traverse below: its applyMappings calls are what the
    // unit problems of a loaded model are derived from.
    this._attachUnitReconcile(viewer);
    const overlay = new DropTargetOverlayController(viewer);
    this.overlayController = overlay;
    this.dragController = new SceneDragOpenController(viewer, () => overlay.nearestBindTarget);

    const planner = viewer.getPlugin<PlannerLike>('layout-planner');
    if (viewer.signalBindingManager) {
      this.badgeController = new SignalBadgeController(viewer, planner ?? null);
    }
    if (planner && viewer.signalBindingManager) {
      const placedItems = planner.store.getSnapshot().placed as ReadonlyArray<{ id: string; signalMappings?: SignalMapping[] }>;
      for (const placed of placedItems) {
        const root = planner.getPlacedRootById(placed.id);
        if (root && placed.signalMappings) {
          const target = { kind: 'placed' as const, placedId: placed.id, node: root };
          const applied = viewer.signalBindingManager.applyMappings(placed.id, root, placed.signalMappings);
          // Unresolved links are kept (merged back), never dropped by this write.
          const merged = mergeAppliedMappings(placed.signalMappings, applied);
          if (placed.signalMappings.some((mapping, i) => !mapping.interfaceId && !!merged[i]?.interfaceId)) {
            createSignalBindingPersistence(viewer, target).write(merged);
          }
        }
      }
    }

    this.clickUnsub = viewer.on('object-clicked', ({ node }) => {
      // The click-to-open path exists for the signal-link workflow only: outside
      // an active link mode (explicit toggle or a running signal drag) a scene
      // click must never surface the binding popover.
      if (!isSignalLinkModeActive()) return;
      // A link toggle left on in an engineering mode stays dormant in the
      // operator workspaces (signal-link-gate.ts).
      if (!isSignalLinkingAllowed(viewer)) return;
      const target = findSignalBindTarget(viewer, node);
      if (!target || target.kind === 'placed') return;
      if (!signalBindEligibility(viewer, target).eligible) return;
      openSignalBindPopover(target);
    });

    result.root.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      const raw = (rv?.SignalLinks as { Mappings?: unknown } | undefined)?.Mappings;
      if (!Array.isArray(raw)) return;
      const target = findSignalBindTarget(viewer, node);
      if (!target || target.kind !== 'node') return;
      const mappings = (raw as SignalMapping[]).map((mapping) => ({ ...mapping }));
      const applied = viewer.signalBindingManager?.applyMappings(signalBindTargetId(target), target.node, mappings);
      const merged = applied ? mergeAppliedMappings(mappings, applied) : null;
      if (merged && mappings.some((mapping, i) => !mapping.interfaceId && !!merged[i]?.interfaceId)) {
        createSignalBindingPersistence(viewer, target).write(merged);
      }
    });

    // The traverse above can only restore what is THERE. Anything saved against
    // a node this model no longer has is invisible to it, so it is looked for
    // from the op side — once, now that the overlay and the registry are both
    // settled (plan-422 F9).
    void this._reportOrphanedBindings(viewer, result);
  }

  /**
   * One `orphaned-bindings` notice for every carrier that is gone — or silence.
   * Nothing is moved or written (plan-2234: no carrier migration by signal name).
   *
   * Dynamically imported so a viewer that never edits a scene does not pull the
   * scene store into its bundle, and deliberately fail-quiet: a diagnostic that
   * throws during model load would cost more than the diagnosis is worth.
   */
  private async _reportOrphanedBindings(viewer: RVViewer, result: LoadResult): Promise<void> {
    try {
      const [
        { findOrphanedBindingCarriers },
        { getSceneStore },
        { materialise },
        { reportOrphanedBindings },
      ] = await Promise.all([
        import('./orphaned-bindings'),
        import('../../core/hmi/scene/scene-store-singleton'),
        import('../../core/hmi/scene/rv-scene-edits'),
        import('../../core/hmi/scene/rv-scene-live-sync'),
      ]);
      const ops = getSceneStore()?.getSnapshot().draft?.edits.ops;
      if (!ops || ops.length === 0) return;
      // The check is "does this path resolve" — and the placed references of a
      // layout document reach the registry only AFTER `model-loaded` (plan-753).
      // Judged earlier, every op addressed into a placement reads as orphaned,
      // a carrier that is merely late.
      // Optional call: narrow test hosts do not carry the scene-ready contract.
      await viewer.whenSceneReady?.();
      if ('lastLoadResult' in viewer && viewer.lastLoadResult !== result) return; // document changed meanwhile
      // `materialise` is the SAME projection the bake feeds to `splitOverlay()`,
      // so a mapping that would be written is exactly one that is checked.
      const overlay = materialise(ops).overlay;
      const registry = viewer.registry;
      if (!registry) return;
      // Slot-level breakage is a SEPARATE finding from a missing carrier: the
      // node is right there, one component below it moved. The restore traverse
      // above has already run, so the manager knows which mappings it had to
      // drop and which of those it could locate again (plan-425 F3/F4).
      let repairable = 0;
      for (const unresolved of viewer.signalBindingManager?.getAllUnresolvedMappings().values() ?? []) {
        for (const item of unresolved) if (item.candidateComponentPath) repairable++;
      }

      const carriers = findOrphanedBindingCarriers(overlay, registry);
      if (carriers.length === 0) {
        if (repairable > 0) {
          reportOrphanedBindings(viewer.currentModelUrl ?? result.root.name ?? 'model', [], repairable);
        }
        return;
      }

      // plan-2234: an orphan stays an orphan — no move by `carrierSignalName`, no write.
      const stillOrphaned = carriers.map((c) => c.nodePath);
      if (stillOrphaned.length === 0 && repairable === 0) return;
      reportOrphanedBindings(
        viewer.currentModelUrl ?? result.root.name ?? 'model', stillOrphaned, repairable);
    } catch {
      /* a diagnostic must never be the reason a model fails to open */
    }
  }

  onModelCleared(): void {
    this.teardownModel();
  }

  onRender(): void {
    this.overlayController?.onRender();
    this.badgeController?.onRender();
    // A manager built after onModelLoaded (logic gated at load) is picked up
    // here — one reference comparison per frame, no allocation.
    if (this.viewer && this.viewer.signalBindingManager !== this.unitManager) this._attachUnitReconcile(this.viewer);
  }

  /**
   * Hook the unit-problem reconcile onto the binding manager's "binding set
   * changed" notification (plan-512 F7) — fired after every applyMappings AND
   * every unbindAll, so load, bind, unbind, bulk actions, undo/redo, repair and
   * the planner are all covered without a path of their own.
   */
  private _attachUnitReconcile(viewer: RVViewer): void {
    const manager = viewer.signalBindingManager ?? null;
    if (manager === this.unitManager) return;
    this.unitManagerUnsub?.();
    this.unitManagerUnsub = null;
    this.unitManager = manager;
    if (!manager) return;
    this.unitManagerUnsub = manager.addBindingsChangedListener((targetId, mappings) => {
      this.unitTargets.add(targetId);
      reconcileUnitProblems(viewer, targetId, mappings);
    });
  }

  private _onFmuInstancesChanged(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const key = getFmuInstances().map((f) => f.signalNames.join('|')).join('\u0001');
    if (key === this.fmuSignalKey) return;
    this.fmuSignalKey = key;
    for (const targetId of this.unitTargets) reconcileUnitProblems(viewer, targetId);
  }

  onRenderBackendChanged(backend: 'three' | 'omniverse'): void {
    this.overlayController?.onRenderBackendChanged(backend);
  }

  dispose(): void {
    this.teardownModel();
    this.modeUnsub?.();
    this.modeUnsub = null;
    setSignalLinkModeSuspended(false);
    this.unitManagerUnsub?.();
    this.unitManagerUnsub = null;
    this.unitManager = null;
    this.fmuUnsub?.();
    this.fmuUnsub = null;
    // Symmetric to init() — without this a dispose/re-init cycle leaves a menu
    // item closing over the OLD viewer (plan-418 Entscheidungs-Log).
    this.viewer?.contextMenu.unregister(SIGNAL_BIND_MENU_PLUGIN_ID);
    this.viewer = null;
  }

  private teardownModel(): void {
    // A model switch mid-drag used to leave a zombie: nothing between here and
    // the drag store's reset() ended a running drag, so candidate states and
    // hover pointers survived into the next model (plan-341 §2.3). This is a
    // LIFECYCLE teardown — it clears silently and emits no outcome.
    disposeSignalDrag();
    this.clickUnsub?.();
    this.clickUnsub = null;
    this.dragController?.dispose();
    this.dragController = null;
    this.overlayController?.dispose();
    this.overlayController = null;
    this.badgeController?.dispose();
    this.badgeController = null;
    closeSignalBindPopover();
    // plan-512: unit problems belong to the model they were derived from.
    this.unitTargets.clear();
    clearUnitProblems();
  }
}
