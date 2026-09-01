// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 T7 — `web_editor_descend` / `web_editor_back` and the breadcrumb.
 *
 * The two tools sit on the SEAMS, never on `RvDocumentStack` itself:
 * `rv-descend-request` for the way down (the same seam the hierarchy browser's
 * double-click uses) and the published `ActiveDocumentView` for the way back and
 * for the chain. That is what lets them be tested — and shipped — without the
 * private editor plugin, which owns the stack and is absent from this checkout.
 *
 * So the fixture here installs a descend handler and publishes a view, exactly
 * as the plugin would, and the assertions are about what the TOOLS do with
 * them: which seam they reach, what they refuse, and what they report.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { Group, Scene } from 'three';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { setDescendHandler } from '../src/core/editor/rv-descend-request';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import {
  setActiveAssetContext,
  type ActiveAssetContext,
} from '../src/core/editor/active-asset-store';
import type { RvStackCrumb } from '../src/core/ops/rv-document-stack';
import type { RVViewer } from '../src/core/rv-viewer';

/** Crumbs for a chain `depth` frames deep; the last one is `current`. */
function crumbs(depth: number): RvStackCrumb[] {
  return Array.from({ length: depth }, (_, i) => ({
    index: i,
    label: `Frame${i}`,
    occurrence: i === 0 ? '' : `occ${i}`,
    referenceNodeId: i === 0 ? null : `ref${i}`,
    dirty: false,
    stale: false,
    current: i === depth - 1,
  }));
}

const onCrumbCalls: RvStackCrumb[] = [];

/** Publish a view whose Back handler shortens the chain, like the stack's pop. */
function publishChain(depth: number): void {
  const view = {
    name: 'Fixture',
    crumbs: crumbs(depth),
    dirty: false, busy: false, stackDirty: false, stale: false,
    saveVerb: 'save', sourceMode: 'editor',
    canUndo: false, canRedo: false,
    actions: {
      save: async () => ({ status: 'no-op' as const }),
      onCrumb: (c: RvStackCrumb) => {
        onCrumbCalls.push(c);
        // The real handler pops back to the clicked frame; the depth change is
        // what the tool polls for, so the fixture has to make it.
        publishChain(c.index + 1);
      },
    },
  } as unknown as ActiveDocumentView;
  setActiveDocumentView(view);
}

function buildViewer(): RVViewer {
  const scene = new Scene();
  const root = new Group(); root.name = 'Robot';
  const ref = new Group(); ref.name = 'GripperRef';
  root.add(ref);
  scene.add(root);
  const registry = new NodeRegistry();
  root.traverse((n) => {
    const path = NodeRegistry.computeNodePath(n);
    if (path) registry.registerNode(path, n);
  });
  return {
    modes: { activeMode: 'editor' },
    registry,
    currentModelRoot: root,
    scene,
    selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) },
  } as unknown as RVViewer;
}

let viewer: RVViewer;
let tools: McpEditorTools;

beforeEach(() => {
  onCrumbCalls.length = 0;
  viewer = buildViewer();
  tools = new McpEditorTools(() => viewer);
  setActiveAssetContext({
    doc: {
      id: 'doc_1',
      name: 'Robot',
      // `web_editor_status` reads a whole snapshot; the descend tools read only
      // the id. One stub serves both so the two halves of T7 share a fixture.
      getSnapshot: () => ({
        name: 'Robot', base: { kind: 'empty' }, dirty: false, busy: false,
        canUndo: false, canRedo: false, undoLabel: null, opCount: 0,
      }),
    },
    viewer,
  } as unknown as ActiveAssetContext);
});

afterEach(() => {
  setDescendHandler(null);
  resetActiveDocumentViewForTests();
  setActiveAssetContext(null);
});

// ─── descend ────────────────────────────────────────────────────────────

describe('T7 — web_editor_descend', () => {
  it('refuses a path that does not exist, naming it', async () => {
    const out = JSON.parse(await tools.webEditorDescend('Robot/Nope')) as { error: string };
    expect(out.error).toContain('Robot/Nope');
  });

  it('refuses an empty path instead of descending into whatever is selected', async () => {
    const out = JSON.parse(await tools.webEditorDescend('  ')) as { error: string };
    expect(out.error).toContain('path is required');
  });

  it('refuses a real node that is not a descendable reference, and says WHY', async () => {
    // No handler installed at all — the "not a reference" verdict.
    const out = JSON.parse(await tools.webEditorDescend('Robot/GripperRef')) as { error: string };
    expect(out.error).toContain('cannot be descended into');
    // The refusal has to distinguish itself from "node not found", or the agent
    // fixes the wrong thing.
    expect(out.error).toContain('reference');
  });

  it('goes through the descend SEAM and reports the deepened breadcrumb', async () => {
    publishChain(1);
    const asked: string[] = [];
    setDescendHandler({
      canDescend: (p) => p === 'Robot/GripperRef',
      descend: async (p) => { asked.push(p); publishChain(2); },
    });

    const out = JSON.parse(await tools.webEditorDescend('Robot/GripperRef')) as {
      descended: boolean; path: string; depth: number; breadcrumb: { current: boolean }[];
    };
    expect(out.descended).toBe(true);
    expect(asked, 'the tool must use the same seam as the double-click gesture')
      .toEqual(['Robot/GripperRef']);
    expect(out.depth).toBe(2);
    expect(out.breadcrumb).toHaveLength(2);
    expect(out.breadcrumb.filter(c => c.current)).toHaveLength(1);
  });

  it('asks canDescend BEFORE requesting, so a refusal carries a reason', async () => {
    let descendCalled = false;
    setDescendHandler({
      canDescend: () => false,
      descend: async () => { descendCalled = true; },
    });
    const out = JSON.parse(await tools.webEditorDescend('Robot/GripperRef')) as { error: string };
    expect(out.error).toContain('cannot be descended into');
    expect(descendCalled, 'a refused descend must not reach the handler').toBe(false);
  });

  it('is editor-gated like every other authoring tool', async () => {
    const planner = new McpEditorTools(() => ({ modes: { activeMode: 'planner' } } as unknown as RVViewer));
    const out = JSON.parse(await planner.webEditorDescend('Robot/GripperRef')) as { error: string };
    expect(out.error).toContain('Not in editor mode');
  });
});

// ─── back ───────────────────────────────────────────────────────────────

describe('T7 — web_editor_back', () => {
  it('refuses at the root and points at the verb that DOES apply there', async () => {
    publishChain(1);
    const out = JSON.parse(await tools.webEditorBack()) as { error: string };
    expect(out.error).toContain('root document');
    expect(out.error).toContain('web_editor_close');
  });

  it('pops one level via the crumb handler and reports where it landed', async () => {
    publishChain(3);
    const out = JSON.parse(await tools.webEditorBack()) as {
      back: boolean; to: string; depth: number;
    };
    expect(out.back).toBe(true);
    // ONE level: the parent, not the root — a Back that jumped to the root
    // would be a different verb wearing this one's name.
    expect(onCrumbCalls.map(c => c.index)).toEqual([1]);
    expect(out.to).toBe('Frame1');
    expect(out.depth).toBe(2);
  });

  it('descend then back returns to the original depth', async () => {
    publishChain(1);
    setDescendHandler({ canDescend: () => true, descend: async () => { publishChain(2); } });
    await tools.webEditorDescend('Robot/GripperRef');
    const out = JSON.parse(await tools.webEditorBack()) as { depth: number };
    expect(out.depth).toBe(1);
  });

  it('is editor-gated', async () => {
    const planner = new McpEditorTools(() => ({ modes: { activeMode: 'planner' } } as unknown as RVViewer));
    const out = JSON.parse(await planner.webEditorBack()) as { error: string };
    expect(out.error).toContain('Not in editor mode');
  });
});

// ─── the breadcrumb on the status ───────────────────────────────────────

describe('T7 — web_editor_status carries the chain', () => {
  it('reports depth and breadcrumb while a chain is published', async () => {
    publishChain(2);
    const out = JSON.parse(await tools.webEditorStatus()) as {
      depth?: number; breadcrumb?: { label: string }[];
    };
    expect(out.depth).toBe(2);
    expect(out.breadcrumb?.map(c => c.label)).toEqual(['Frame0', 'Frame1']);
  });

  it('omits both fields rather than inventing a depth when no view is published', async () => {
    resetActiveDocumentViewForTests();
    const out = JSON.parse(await tools.webEditorStatus()) as Record<string, unknown>;
    // Absent, not `depth: 0` — a status that claims depth 0 would read as "the
    // stack is empty" when the truth is "nothing published a chain".
    expect(out['depth']).toBeUndefined();
    expect(out['breadcrumb']).toBeUndefined();
  });
});
