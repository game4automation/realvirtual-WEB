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
import { isSignalLinkModeActive } from './signal-link-mode-store';
import { registerSignalBulkActions } from './component-bulk-actions';

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
