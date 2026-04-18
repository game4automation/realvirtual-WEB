// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocsBrowserPlugin — Sidebar button that enters a document browsing mode.
 *
 * Uses the same isolate mechanism as the Groups window: marks doc-bearing
 * subtrees with ISOLATE_FOCUS_LAYER, sets GroupRegistry.externalIsolateActive,
 * and lets the viewer's existing 3-pass composite (dim backdrop + overlay +
 * focus on top) handle the rendering. No mesh baking, no material mutation,
 * no per-frame work — just one layer.enable() per node on activate.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { PictureAsPdf } from '@mui/icons-material';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { NavButton } from '../core/hmi/NavButton';
import type { PdfLink } from '../core/hmi/pdf-viewer-store';
import { activateContext, deactivateContext } from '../core/hmi/ui-context-store';
import { withInfoOverlay } from '../core/hmi/info-overlay-store';

// ─── Helpers ────────────────────────────────────────────────────────────

function getDocNodes(viewer: RVViewer): Object3D[] {
  const nodes: Object3D[] = [];
  viewer.scene.traverse(node => {
    const links = node.userData?._rvPdfLinks as PdfLink[] | undefined;
    if (links && links.length > 0) nodes.push(node);
  });
  return nodes;
}

function findDocAncestor(node: Object3D): Object3D | null {
  let cur: Object3D | null = node;
  while (cur) {
    const links = cur.userData?._rvPdfLinks as PdfLink[] | undefined;
    if (links && links.length > 0) return cur;
    cur = cur.parent;
  }
  return null;
}

// ─── Button ─────────────────────────────────────────────────────────────

function DocsButton({ viewer }: UISlotProps) {
  const [active, setActive] = useState(false);
  const [count, setCount] = useState(0);
  const overrideRef = useRef<((node: Object3D) => Object3D | null) | null>(null);
  /** Doc roots and their prior `.visible` state (so deactivate can restore). */
  const isolatedRef = useRef<{ node: Object3D; visible: boolean }[]>([]);

  useEffect(() => {
    const update = () => setCount(getDocNodes(viewer).length);
    update();
    const timer = setInterval(update, 2000);
    const off = viewer.on('model-loaded', () => setTimeout(update, 1000));
    return () => { clearInterval(timer); off(); };
  }, [viewer]);

  const deactivate = useCallback(() => {
    viewer.groups?.setExternalIsolated(null);
    for (const { node, visible } of isolatedRef.current) {
      node.visible = visible;
    }
    isolatedRef.current = [];

    if (viewer.raycastManager) {
      if (overrideRef.current) {
        viewer.raycastManager.removeAncestorOverride(overrideRef.current);
        overrideRef.current = null;
      }
      viewer.raycastManager.setAllowFilter(null);
    }
    deactivateContext('docs');
    viewer.markRenderDirty?.();
    setActive(false);
  }, [viewer]);

  const activate = useCallback(() => {
    const docNodes = getDocNodes(viewer);
    if (docNodes.length === 0) return;

    // Expand each doc-bearing leaf to its containing group root so the
    // isolate covers the same subtree the user would get by picking the
    // surrounding group in the Groups window. Falls back to the doc node
    // itself if it's not inside any registered group.
    const roots = viewer.groups?.expandToContainingGroups(docNodes) ?? docNodes;

    // Force-visible so a hidden root (e.g. inside a defaultHidden group)
    // can still be isolated. Save prior visibility for deactivate.
    for (const node of roots) {
      isolatedRef.current.push({ node, visible: node.visible });
      node.visible = true;
    }
    // Hand the roots to the registry — it tags ISOLATE_FOCUS_LAYER and the
    // viewer's per-frame refreshIsolateLayer() catches dynamic descendants.
    viewer.groups?.setExternalIsolated(roots);

    // Ancestor override: redirect hover to nearest doc parent.
    const override = (node: Object3D): Object3D | null => findDocAncestor(node);
    overrideRef.current = override;
    if (viewer.raycastManager) {
      viewer.raycastManager.addAncestorOverride(override);
      // Allow filter: only nodes with a doc ancestor are hoverable/clickable.
      viewer.raycastManager.setAllowFilter((node) => findDocAncestor(node) !== null);
    }

    activateContext('docs');
    viewer.markRenderDirty?.();
    setActive(true);
  }, [viewer]);

  const handleClick = useCallback(() => {
    if (active) {
      deactivate();
      return;
    }
    withInfoOverlay('Entering document mode…', () => {
      activate();
    });
  }, [active, deactivate, activate]);

  useEffect(() => {
    return () => { deactivate(); };
  }, [deactivate]);

  if (count === 0) return null;

  return (
    <NavButton
      icon={<PictureAsPdf />}
      label="Documents"
      badge={count || undefined}
      active={active}
      onClick={handleClick}
    />
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class DocsBrowserPlugin implements RVViewerPlugin {
  readonly id = 'docs-browser';

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: DocsButton, order: 46 },
  ];
}
