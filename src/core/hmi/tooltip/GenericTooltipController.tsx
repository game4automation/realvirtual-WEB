// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GenericTooltipController — Single headless controller that replaces all
 * per-type tooltip controllers (Drive, Pipeline, Metadata, AAS).
 *
 * Core logic:
 * 1. On hover: iterate Object.keys(node.userData.realvirtual), skip non-objects,
 *    check getCapabilities(key).ui.tooltip, call registered data resolver,
 *    fire tooltipStore.show() for each matched section.
 *    With no hover section, fall back to a DES tooltip within four ancestors.
 * 2. Generic PDF links: also checks node.userData._rvPdfLinks and auto-stacks
 *    a 'pdf' section at the bottom of the tooltip bubble.
 * 3. Drive focus: separate useEffect for the drive-focus concept.
 * 4. 3D-click selection: pins tooltips for a limited time (PIN_AUTOHIDE_MS)
 *    so links inside the tooltip (PDFs, documents) stay clickable — but only
 *    an UNTOUCHED pin: once the pointer has been inside the bubble the pin is
 *    the user's and stays until an explicit close (click elsewhere, Escape,
 *    orbit / wheel, another selection). A click on the part that is ALREADY
 *    selected (or `tooltipStore.requestPin()`, e.g. from an AAS badge)
 *    re-pins — a same-path `select()` changes nothing, so the selection alone
 *    cannot say so.
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

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useHoveredObject } from '../../../hooks/use-hover';
import { useFocusedDrive } from '../../../hooks/use-drives';
import { useSelection } from '../../../hooks/use-selection';
import { useViewer } from '../../../hooks/use-viewer';
import { tooltipStore } from './tooltip-store';
import { tooltipRegistry } from './tooltip-registry';
import { worldToLocal } from './tooltip-utils';
import { getCapabilities } from '../../engine/rv-component-registry';
import type { TooltipData } from './tooltip-store';
import type { ObjectHoverState } from '../../../hooks/use-hover';
import type { RVViewer } from '../../rv-viewer';
import type { PdfLink } from '../pdf-viewer-store';
import {
  getSignalLinkModeSnapshot,
  subscribeSignalLinkMode,
} from '../../../plugins/signal-bind/signal-link-mode-store';

/** How long a 3D-click pinned tooltip stays before auto-hiding (ms). Long
 *  enough to move the mouse over and click a PDF/document link. Applies only
 *  to a pin the pointer never entered. */
export const PIN_AUTOHIDE_MS = 10_000;

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Check if a node has generic PDF links attached. */
function hasPdfLinks(node: import('three').Object3D): boolean {
  const links = node.userData?._rvPdfLinks as PdfLink[] | undefined;
  return !!links && links.length > 0;
}

/** Use the nearest DES-marked ancestor only when the hovered node has no section. */
function showAncestorDesTooltip(hover: ObjectHoverState, viewer: RVViewer, newHoverIds: string[]): void {
  let ancestor = hover.node.parent;
  for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parent) {
    const rv = ancestor.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) continue;
    for (const key in rv) {
      if (!Object.prototype.hasOwnProperty.call(rv, key) || rv[key] === null || typeof rv[key] !== 'object') continue;
      const caps = getCapabilities(key);
      if (caps.ui.tooltip !== 'des-component') continue;
      const resolver = tooltipRegistry.getDataResolver('des-component');
      if (!resolver) continue;
      const data = resolver(ancestor, viewer);
      if (data) {
        const hoverId = 'tooltip-hover:des-component';
        newHoverIds.push(hoverId);
        tooltipStore.show({
          id: hoverId,
          lifecycle: 'hover',
          targetPath: hover.nodePath,
          data: data as TooltipData,
          mode: 'cursor',
          cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
          priority: caps.ui.priority,
        });
      }
      return;
    }
  }
}

export function GenericTooltipController() {
  const viewer = useViewer();
  const hover = useHoveredObject();
  const focus = useFocusedDrive();
  const selection = useSelection();
  const prevHoverIds = useRef<string[]>([]);
  const prevPinnedIds = useRef<Set<string>>(new Set());
  const pinAutohideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pointer has been inside the current pin's bubble — no auto-hide any more. */
  const pinTouched = useRef(false);

  // Signal linking is an EXCLUSIVE mode: while it is on, the only thing the
  // user is asking about is the plug under the cursor, so every object card
  // this controller would produce stands down and leaves the field to the
  // badge hover card (BadgeTooltipController).
  const linkModeActive = useSyncExternalStore(
    subscribeSignalLinkMode,
    () => getSignalLinkModeSnapshot().active,
  );

  // Explicit re-pin requests (same-part click, AAS badge) — see requestPin().
  const pinRequestSeq = useSyncExternalStore(
    tooltipStore.subscribePinRequest,
    tooltipStore.getPinRequestSeq,
  );

  // Pin lifetime helpers — refs only, so one stable object for all effects.
  const pins = useMemo(() => {
    const clearTimer = () => {
      if (pinAutohideTimer.current) { clearTimeout(pinAutohideTimer.current); pinAutohideTimer.current = null; }
    };
    const hideAll = () => {
      clearTimer();
      pinTouched.current = false;
      for (const id of prevPinnedIds.current) tooltipStore.hide(id);
      prevPinnedIds.current = new Set();
    };
    /** Start the auto-hide — never for a pin the pointer is in or has been in. */
    const arm = () => {
      clearTimer();
      if (prevPinnedIds.current.size === 0 || pinTouched.current || tooltipStore.pointerInsidePinned) return;
      pinAutohideTimer.current = setTimeout(() => {
        pinAutohideTimer.current = null;
        if (pinTouched.current || tooltipStore.pointerInsidePinned) return;
        hideAll();
      }, PIN_AUTOHIDE_MS);
    };
    return { clearTimer, hideAll, arm };
  }, []);

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
          if (!caps.ui.tooltip) continue;

          const resolver = tooltipRegistry.getDataResolver(caps.ui.tooltip);
          if (!resolver) continue;

          const data = resolver(node, viewer);
          if (!data) continue;

          const hoverId = `tooltip-hover:${caps.ui.tooltip}`;
          newHoverIds.push(hoverId);

          tooltipStore.show({
            id: hoverId,
            lifecycle: 'hover',
            targetPath,
            data: data as TooltipData,
            mode: 'cursor',
            cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
            priority: caps.ui.priority,
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

      if (newHoverIds.length === 0) showAncestorDesTooltip(hover, viewer, newHoverIds);
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
    pins.clearTimer();
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
            if (!caps.ui.tooltip) continue;

            const resolver = tooltipRegistry.getDataResolver(caps.ui.tooltip);
            if (!resolver) continue;

            const data = resolver(node, viewer);
            if (!data) continue;

            const pinId = `tooltip-pin:${caps.ui.tooltip}:${path}`;
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
              priority: caps.ui.priority,
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
    // A different set of pins is a new, untouched pin.
    if (!sameIds(newPinnedIds, prevPinnedIds.current)) pinTouched.current = false;
    prevPinnedIds.current = newPinnedIds;

    // Auto-hide: an untouched pin disappears after a while.
    pins.arm();
  }, [selection.selectedPaths, viewer, linkModeActive, pinRequestSeq, pins]);

  // ── Pointer inside a pinned bubble: the pin is taken, it no longer auto-hides ──
  useEffect(() => tooltipStore.subscribePinnedPointer((inside) => {
    if (inside && prevPinnedIds.current.size > 0) { pinTouched.current = true; pins.clearTimer(); }
  }), [pins]);

  // ── Click on the part that is already selected → re-pin ──
  // The pin may have been dismissed (auto-hide, orbit, wheel, touch tap) while
  // the selection stayed; select() of the same path is a no-op, so the click
  // event is the only signal left.
  useEffect(() => {
    const on = (viewer as unknown as {
      on?: (event: string, cb: (p: { path?: string } | undefined) => void) => (() => void) | void;
    }).on;
    if (typeof on !== 'function') return;
    const off = on.call(viewer, 'object-clicked', (p) => {
      if (p?.path && viewer.selectionManager?.isSelected?.(p.path)) tooltipStore.requestPin();
    });
    return typeof off === 'function' ? off : undefined;
  }, [viewer]);

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
    const onInteractStart = () => pins.hideAll();
    controls.addEventListener('start', onInteractStart);
    return () => controls.removeEventListener?.('start', onInteractStart);
  }, [viewer, pins]);

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
