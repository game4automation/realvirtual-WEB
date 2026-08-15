// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GenericTooltipController — Single headless controller that replaces all
 * per-type tooltip controllers (Drive, Pipeline, Metadata, AAS).
 *
 * Core logic:
 * 1. On hover: iterate Object.keys(node.userData.realvirtual), skip non-objects,
 *    check getCapabilities(key).tooltipType, call registered data resolver,
 *    fire tooltipStore.show() for each matched section.
 * 2. Generic PDF links: also checks node.userData._rvPdfLinks and auto-stacks
 *    a 'pdf' section at the bottom of the tooltip bubble.
 * 3. Drive focus: separate useEffect for the drive-focus concept.
 * 4. 3D-click selection: pins tooltips for a limited time (PIN_AUTOHIDE_MS)
 *    so links inside the tooltip (PDFs, documents) stay clickable.
 *
 * Selections that do NOT come from a 3D click (hierarchy row click, inspector)
 * intentionally do not pin tooltips — the inspector already shows the data.
 * The distinction is `selectionManager.lastHitPoint`, which only the 3D click
 * path sets.
 *
 * While signal-linking mode is active this controller produces nothing at all:
 * the mode is exclusive, and the only card allowed on screen is the one for the
 * plug badge under the cursor.
 *
 * Renders null — purely a state bridge, no UI.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useHoveredObject } from '../../../hooks/use-hover';
import { useFocusedDrive } from '../../../hooks/use-drives';
import { useSelection } from '../../../hooks/use-selection';
import { useViewer } from '../../../hooks/use-viewer';
import { tooltipStore } from './tooltip-store';
import { tooltipRegistry } from './tooltip-registry';
import { worldToLocal } from './tooltip-utils';
import { getCapabilities } from '../../engine/rv-component-registry';
import type { TooltipData } from './tooltip-store';
import type { PdfLink } from '../pdf-viewer-store';
import {
  getSignalLinkModeSnapshot,
  subscribeSignalLinkMode,
} from '../../../plugins/signal-bind/signal-link-mode-store';

/** How long a 3D-click pinned tooltip stays before auto-hiding (ms). Long
 *  enough to move the mouse over and click a PDF/document link. */
const PIN_AUTOHIDE_MS = 10_000;

/** Check if a node has generic PDF links attached. */
function hasPdfLinks(node: import('three').Object3D): boolean {
  const links = node.userData?._rvPdfLinks as PdfLink[] | undefined;
  return !!links && links.length > 0;
}

export function GenericTooltipController() {
  const viewer = useViewer();
  const hover = useHoveredObject();
  const focus = useFocusedDrive();
  const selection = useSelection();
  const prevHoverIds = useRef<string[]>([]);
  const prevPinnedIds = useRef<Set<string>>(new Set());
  const pinAutohideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Signal linking is an EXCLUSIVE mode: while it is on, the only thing the
  // user is asking about is the plug under the cursor, so every object card
  // this controller would produce stands down and leaves the field to the
  // badge hover card (BadgeTooltipController).
  const linkModeActive = useSyncExternalStore(
    subscribeSignalLinkMode,
    () => getSignalLinkModeSnapshot().active,
  );

  // ── Hover: check ALL rv_extras keys on the resolved node ──
  useEffect(() => {
    const newHoverIds: string[] = [];

    if (hover && !linkModeActive) {
      const node = hover.node;
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      const targetPath = hover.nodePath;

      if (rv) {
        for (const key of Object.keys(rv)) {
          // Guard: skip non-object values (scalar fields like _rvType)
          if (typeof rv[key] !== 'object') continue;

          const caps = getCapabilities(key);
          if (!caps.tooltipType) continue;

          const resolver = tooltipRegistry.getDataResolver(caps.tooltipType);
          if (!resolver) continue;

          const data = resolver(node, viewer);
          if (!data) continue;

          const hoverId = `tooltip-hover:${caps.tooltipType}`;
          newHoverIds.push(hoverId);

          tooltipStore.show({
            id: hoverId,
            lifecycle: 'hover',
            targetPath,
            data: data as TooltipData,
            mode: 'cursor',
            cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
            priority: caps.hoverPriority ?? 5,
          });
        }
      }

      // Generic PDF links — auto-stack at bottom of any tooltip bubble
      if (hasPdfLinks(node)) {
        const pdfResolver = tooltipRegistry.getDataResolver('pdf');
        const pdfData = pdfResolver?.(node, viewer);
        if (pdfData) {
          const pdfHoverId = 'tooltip-hover:pdf';
          newHoverIds.push(pdfHoverId);
          tooltipStore.show({
            id: pdfHoverId,
            lifecycle: 'hover',
            targetPath,
            data: pdfData as TooltipData,
            mode: 'cursor',
            cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
            priority: 1, // lowest = rendered last (bottom of bubble)
          });
        }
      }
    }

    // Hide hover entries that are no longer active
    for (const oldId of prevHoverIds.current) {
      if (!newHoverIds.includes(oldId)) tooltipStore.hide(oldId);
    }
    prevHoverIds.current = newHoverIds;
  }, [hover?.nodePath, hover?.pointer?.x, hover?.pointer?.y, viewer, linkModeActive]);

  // ── Drive focus tooltip (unique to Drive — no other type has this concept) ──
  useEffect(() => {
    if (focus.drive && focus.node && !linkModeActive) {
      const nodePath = viewer.registry?.getPathForNode(focus.node) ?? undefined;
      const path = nodePath ?? focus.drive.name;
      tooltipStore.show({
        id: 'drive-focus',
        lifecycle: 'hover',
        targetPath: path,
        data: { type: 'drive', driveName: focus.drive.name, nodePath },
        mode: 'world',
        worldTarget: focus.node,
        priority: 10,
      });
    } else {
      tooltipStore.hide('drive-focus');
    }
  }, [focus.drive, focus.node, viewer, linkModeActive]);

  // ── 3D-click selection: temporarily pinned tooltips ──
  // Only selections made by clicking in the 3D scene pin tooltips (so PDF /
  // document links inside stay reachable). Hierarchy or inspector selections
  // don't set lastHitPoint and therefore never pin. Pins auto-hide after
  // PIN_AUTOHIDE_MS unless the selection changes first.
  useEffect(() => {
    if (pinAutohideTimer.current) { clearTimeout(pinAutohideTimer.current); pinAutohideTimer.current = null; }
    const newPinnedIds = new Set<string>();
    const clickedIn3D = viewer.selectionManager?.lastHitPoint != null;

    if (clickedIn3D && !linkModeActive) {
      for (const path of selection.selectedPaths) {
        const node = viewer.registry?.getNode(path);
        if (!node) continue;
        const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;

        if (rv) {
          for (const key of Object.keys(rv)) {
            if (typeof rv[key] !== 'object') continue;

            const caps = getCapabilities(key);
            if (!caps.tooltipType) continue;

            const resolver = tooltipRegistry.getDataResolver(caps.tooltipType);
            if (!resolver) continue;

            const data = resolver(node, viewer);
            if (!data) continue;

            const pinId = `tooltip-pin:${caps.tooltipType}:${path}`;
            newPinnedIds.add(pinId);

            tooltipStore.show({
              id: pinId,
              lifecycle: 'pinned',
              targetPath: path,
              data: data as TooltipData,
              mode: 'world',
              worldTarget: node,
              worldAnchor: viewer.selectionManager?.lastHitPoint
                ? worldToLocal(viewer.selectionManager.lastHitPoint, node)
                : undefined,
              priority: caps.pinPriority ?? 3,
            });
          }
        }

        // Generic PDF links — auto-stack at bottom of pinned tooltip
        if (hasPdfLinks(node)) {
          const pdfResolver = tooltipRegistry.getDataResolver('pdf');
          const pdfData = pdfResolver?.(node, viewer);
          if (pdfData) {
            const pdfPinId = `tooltip-pin:pdf:${path}`;
            newPinnedIds.add(pdfPinId);
            tooltipStore.show({
              id: pdfPinId,
              lifecycle: 'pinned',
              targetPath: path,
              data: pdfData as TooltipData,
              mode: 'world',
              worldTarget: node,
              worldAnchor: viewer.selectionManager?.lastHitPoint
                ? worldToLocal(viewer.selectionManager.lastHitPoint, node)
                : undefined,
              priority: 1,
            });
          }
        }
      }
    }

    // Cleanup stale pins
    for (const oldId of prevPinnedIds.current) {
      if (!newPinnedIds.has(oldId)) tooltipStore.hide(oldId);
    }
    prevPinnedIds.current = newPinnedIds;

    // Auto-hide: the pins disappear after a while (nothing else clicked).
    if (newPinnedIds.size > 0) {
      pinAutohideTimer.current = setTimeout(() => {
        pinAutohideTimer.current = null;
        for (const id of prevPinnedIds.current) tooltipStore.hide(id);
        prevPinnedIds.current = new Set();
      }, PIN_AUTOHIDE_MS);
    }
  }, [selection.selectedPaths, viewer, linkModeActive]);

  // ── Camera interaction dismisses pins ──
  // As soon as the user starts orbiting/panning/zooming (controls 'start',
  // fired on pointerdown on the canvas), any pinned tooltip is dismissed.
  // This also guarantees the bubble (pointerEvents: auto) can never sit in
  // the way of the NEXT drag gesture.
  useEffect(() => {
    const controls = viewer.controls as unknown as {
      addEventListener?: (type: string, cb: () => void) => void;
      removeEventListener?: (type: string, cb: () => void) => void;
    } | undefined;
    if (!controls?.addEventListener) return;
    const onInteractStart = () => {
      if (pinAutohideTimer.current) { clearTimeout(pinAutohideTimer.current); pinAutohideTimer.current = null; }
      for (const id of prevPinnedIds.current) tooltipStore.hide(id);
      prevPinnedIds.current = new Set();
    };
    controls.addEventListener('start', onInteractStart);
    return () => controls.removeEventListener?.('start', onInteractStart);
  }, [viewer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const id of prevHoverIds.current) tooltipStore.hide(id);
      for (const id of prevPinnedIds.current) tooltipStore.hide(id);
      if (pinAutohideTimer.current) clearTimeout(pinAutohideTimer.current);
    };
  }, []);

  return null; // headless — renders nothing
}

// Self-register in tooltip controller registry
tooltipRegistry.registerController({
  types: ['*'], // generic — handles all types
  component: GenericTooltipController,
});
