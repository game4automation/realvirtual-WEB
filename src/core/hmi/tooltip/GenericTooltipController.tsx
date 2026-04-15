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
 * 3. On selection: same pattern for pinned tooltips.
 * 4. Drive focus: separate useEffect for the drive-focus concept.
 *
 * Renders null — purely a state bridge, no UI.
 */

import { useEffect, useRef } from 'react';
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

  // ── Hover: check ALL rv_extras keys on the resolved node ──
  useEffect(() => {
    const newHoverIds: string[] = [];

    if (hover) {
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
  }, [hover?.nodePath, hover?.pointer?.x, hover?.pointer?.y, viewer]);

  // ── Drive focus tooltip (unique to Drive — no other type has this concept) ──
  useEffect(() => {
    if (focus.drive && focus.node) {
      const path = viewer.registry?.getPathForNode(focus.node) ?? focus.drive.name;
      tooltipStore.show({
        id: 'drive-focus',
        lifecycle: 'hover',
        targetPath: path,
        data: { type: 'drive', driveName: focus.drive.name },
        mode: 'world',
        worldTarget: focus.node,
        priority: 10,
      });
    } else {
      tooltipStore.hide('drive-focus');
    }
  }, [focus.drive, focus.node, viewer]);

  // ── Selection: pinned tooltips ──
  useEffect(() => {
    const newPinnedIds = new Set<string>();

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

    // Cleanup stale pins
    for (const oldId of prevPinnedIds.current) {
      if (!newPinnedIds.has(oldId)) tooltipStore.hide(oldId);
    }
    prevPinnedIds.current = newPinnedIds;
  }, [selection.selectedPaths, viewer]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const id of prevHoverIds.current) tooltipStore.hide(id);
      for (const id of prevPinnedIds.current) tooltipStore.hide(id);
    };
  }, []);

  return null; // headless — renders nothing
}

// Self-register in tooltip controller registry
tooltipRegistry.registerController({
  types: ['*'], // generic — handles all types
  component: GenericTooltipController,
});
