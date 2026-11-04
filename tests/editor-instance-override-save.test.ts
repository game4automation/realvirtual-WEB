// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 § 9.1 (F1) — a component value edited INSIDE a placed reference in
 * the asset editor survives the save.
 *
 * The edit is admitted by the reference guard as `scope: 'override'` and
 * applied to the live node, but the editor saves through `exportAssetGlb`,
 * which prunes everything under a reference node — so before plan-774 Phase 1
 * the value was lost: nothing wrote it to `AssetOverrides.byAddress` of the
 * OUTERMOST reference node. This test was the red proof of that defect
 * (Phase 0); Phase 1 writes the override in the setField executor.
 *
 * Modes: `deferred` (the production editor load since plan-774 Phase 2) and
 * `graft` (the pre-Phase-2 load, forced through the compose seam installed
 * below). The executor's write does not depend on the load path, so both are
 * green since Phase 1.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { CELL_REF_NODE_ID, OUTER_URL, SLIDE_NODE_ID, jsonNodes } from './helpers/nested-placement-fixture';
import { openEditorDocument, type EditorDocumentHarness } from './helpers/editor-document-harness';

vi.mock('../src/core/engine/rv-glb-compose', async (importOriginal) =>
  (await import('./helpers/editor-defer-seam')).deferringComposeModule(importOriginal as never));

interface GlbNode { name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> } }

function findNodeById(nodes: GlbNode[], id: string): GlbNode | undefined {
  return nodes.find((n) => n.extras?.realvirtual?.NodeId === id);
}

let h: EditorDocumentHarness | null = null;
afterEach(() => { h?.dispose(); h = null; });

describe('plan-774 9.1 — a field edit inside a reference persists on save (F1)', () => {
  it.each(['graft', 'deferred'] as const)('persists Drive.TargetSpeed set on Slide inside Cell_1 as byAddress on the reference node (%s)', async (mode) => {
    h = await openEditorDocument(OUTER_URL, { mode });
    const slide = h.nodeById(SLIDE_NODE_ID);

    await h.doc.setFieldAwaited(h.pathOf(slide), 'Drive', 'TargetSpeed', 250, 200);

    const bytes = await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    const nodes = jsonNodes(bytes) as GlbNode[];
    const ref = findNodeById(nodes, CELL_REF_NODE_ID);
    expect(ref, 'the reference node Cell_1 is written').toBeDefined();
    const overrides = ref!.extras?.realvirtual?.AssetOverrides as
      { byAddress?: Record<string, { Drive?: { TargetSpeed?: unknown } }> } | undefined;
    expect(overrides?.byAddress?.[`#${SLIDE_NODE_ID}`]?.Drive?.TargetSpeed).toBe(250);
    expect(ref!.children ?? []).toHaveLength(0);
  });
});
