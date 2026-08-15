// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotEntry } from '../../core/rv-ui-plugin';
import { modeContext } from '../../core/rv-mode-manager';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import { disposeSignalDrag } from '../../core/hmi/signal-drag-store';
import { SceneDragOpenController } from './scene-drag-open';
import { SignalBadgeController, type BadgePlannerLike } from './SignalBadgeController';
import { closeSignalBindPopover, openSignalBindPopover } from './signal-bind-store';
import { findSignalBindTarget, signalBindEligibility, signalBindTargetId } from './signal-bind-target';
import './SignalBindPopover';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import { DropTargetOverlayController } from './drop-target-overlay';
import { SignalLinkModeButton } from './SignalLinkModeButton';
import { BindingsOverviewButton } from './BindingsOverviewButton';
import { isSignalLinkModeActive } from './signal-link-mode-store';
import { isDuplicateSignalName } from '../../core/engine/rv-signal-construction';
import { registerSignalBulkActions } from './component-bulk-actions';
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
    visibilityRule: {
      shownOnlyInAny: [
        modeContext('hmi'),
        modeContext('planner'),
        modeContext('des'),
        modeContext('editor'),
        // plan-423: binding model slots to live signals IS the commissioning
        // workflow — without this opt-in the Signal Link button would not exist
        // in the very workspace built for it (ButtonPanel auto-hides ruleless
        // entries in a focused mode, so nothing else grants it).
        modeContext('commissioning'),
      ],
    },
  }, {
    // Directly beside the link-mode toggle: making links and reviewing them are
    // the two halves of one job (plan-425 F7).
    slot: 'button-group',
    component: BindingsOverviewButton,
    order: 65,
    visibilityRule: {
      shownOnlyInAny: [
        modeContext('hmi'),
        modeContext('planner'),
        modeContext('des'),
        modeContext('editor'),
      ],
    },
  }];

  private viewer: RVViewer | null = null;
  private dragController: SceneDragOpenController | null = null;
  private overlayController: DropTargetOverlayController | null = null;
  private badgeController: SignalBadgeController | null = null;
  private clickUnsub: (() => void) | null = null;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
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
          if (placed.signalMappings.some((mapping, i) => !mapping.interfaceId && !!applied[i]?.interfaceId)) {
            createSignalBindingPersistence(viewer, target).write(applied);
          }
        }
      }
    }

    this.clickUnsub = viewer.on('object-clicked', ({ node }) => {
      // The click-to-open path exists for the signal-link workflow only: outside
      // an active link mode (explicit toggle or a running signal drag) a scene
      // click must never surface the binding popover.
      if (!isSignalLinkModeActive()) return;
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
      if (applied && mappings.some((mapping, i) => !mapping.interfaceId && !!applied[i]?.interfaceId)) {
        createSignalBindingPersistence(viewer, target).write(applied);
      }
    });

    // The traverse above can only restore what is THERE. Anything saved against
    // a node this model no longer has is invisible to it, so it is looked for
    // from the op side — once, now that the overlay and the registry are both
    // settled (plan-422 F9).
    void this._reportOrphanedBindings(viewer, result);
  }

  /**
   * Self-heal what can be healed, then one `orphaned-bindings` notice for the
   * rest — or silence.
   *
   * Dynamically imported so a viewer that never edits a scene does not pull the
   * scene store into its bundle, and deliberately fail-quiet: a diagnostic that
   * throws during model load would cost more than the diagnosis is worth.
   *
   * ## Why the case-A repair happens HERE and not in the restore traverse
   *
   * The traverse in `onModelLoaded` walks the nodes of the LOADED model. An op
   * addressed to a path this model does not have is never materialised onto any
   * node, so the traverse cannot read the `carrierSignalName` inside it — the
   * anchor would be unreachable in precisely the case it exists for (plan-425
   * F2, review round 1). The overlay is the one place that payload is still
   * legible, and this scan is already reading it.
   */
  private async _reportOrphanedBindings(viewer: RVViewer, result: LoadResult): Promise<void> {
    try {
      const [
        { findOrphanedBindingCarriers, planCarrierMigrations },
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

      const store = viewer.signalStore;
      const { migrations, stillOrphaned } = store
        ? planCarrierMigrations(
          carriers,
          {
            getPath: (name) => store.getPath(name),
            isDuplicate: (name) => isDuplicateSignalName(store, name),
          },
          registry,
          new Set(Object.keys(overlay?.nodes ?? {})),
        )
        : { migrations: [], stillOrphaned: carriers.map((c) => c.nodePath) };

      for (const migration of migrations) await this._migrateCarrier(viewer, migration);
      if (stillOrphaned.length === 0 && repairable === 0) return;
      reportOrphanedBindings(
        viewer.currentModelUrl ?? result.root.name ?? 'model', stillOrphaned, repairable);
    } catch {
      /* a diagnostic must never be the reason a model fails to open */
    }
  }

  /**
   * Move one carrier's mappings from a dead path onto the live one, then bind.
   *
   * The two ops are ONE transaction, and the `unsetField` half is not optional
   * bookkeeping (plan-425, review round 2): writing only the new path leaves the
   * old op in the log, so the very next load finds the same dead carrier again
   * and reports an orphan the user has already had repaired. The pair is what
   * makes the repair stick.
   */
  private async _migrateCarrier(
    viewer: RVViewer,
    migration: { from: string; to: string; mappings: SignalMapping[] },
  ): Promise<void> {
    const [{ getActiveEditTarget }, { syncNodeSignalBindingPersistence }] = await Promise.all([
      import('../../core/hmi/rv-edit-target'),
      import('./signal-binding-persistence'),
    ]);
    const target = getActiveEditTarget();
    if (!target.available) return;
    const node = viewer.registry?.getNode(migration.to);
    if (!node) return;

    await target.withTransaction('Reconnect moved signal links', async () => {
      target.setField(migration.to, 'SignalLinks', 'Mappings', migration.mappings, undefined);
      target.unsetField(migration.from, 'SignalLinks', 'Mappings', migration.mappings);
    });

    const bindTarget = findSignalBindTarget(viewer, node);
    if (!bindTarget || bindTarget.kind !== 'node') return;
    syncNodeSignalBindingPersistence(bindTarget.node, migration.mappings);
    viewer.signalBindingManager?.applyMappings(
      signalBindTargetId(bindTarget), bindTarget.node, migration.mappings);
  }

  onModelCleared(): void {
    this.teardownModel();
  }

  onRender(): void {
    this.overlayController?.onRender();
    this.badgeController?.onRender();
  }

  onRenderBackendChanged(backend: 'three' | 'omniverse'): void {
    this.overlayController?.onRenderBackendChanged(backend);
  }

  dispose(): void {
    this.teardownModel();
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
  }
}
