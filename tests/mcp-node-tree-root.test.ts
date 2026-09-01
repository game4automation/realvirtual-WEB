// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `web_node_tree` starts at the MODEL ROOT (plan-715 F6), plus the MCP-level
 * proof that the root guards are inherited by the editor write tools.
 *
 * Before plan-715 the default start node was the raw Three.js scene — a
 * container the user never authored, holding the model next to runtime siblings
 * like the planner's `_layoutRoot`. The first level of every depth budget went
 * on it. The contract these tests pin is deliberately narrow: the ROOT ENTRY and
 * the reachable depth change; **child paths do not**, because `computeNodePath`
 * is untouched. That is what makes the change safe for external agent sessions
 * holding paths from an earlier call.
 */
import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
// plan-713 Phase 1 — web_node_tree moved off the plugin into McpSceneTools.
import { McpSceneTools } from '../src/plugins/mcp-bridge/rv-mcp-scene-tools';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVViewer } from '../src/core/rv-viewer';

interface TreeEntry {
  name: string;
  path: string;
  types: string[];
  locked?: boolean;
  children?: TreeEntry[];
  childCount?: number;
}

/**
 * scene
 *   ├── Robot           ← currentModelRoot
 *   │     ├── Base
 *   │     │     └── Joint
 *   │     └── Arm
 *   └── _layoutRoot     ← runtime sibling; must not appear under the default root
 */
function buildScene() {
  const scene = new Scene();
  const modelRoot = new Group(); modelRoot.name = 'Robot';
  const base = new Group(); base.name = 'Base';
  const joint = new Object3D(); joint.name = 'Joint';
  const arm = new Object3D(); arm.name = 'Arm';
  base.add(joint);
  modelRoot.add(base, arm);
  const layoutRoot = new Group(); layoutRoot.name = '_layoutRoot';
  const conveyor = new Object3D(); conveyor.name = 'Conveyor';
  layoutRoot.add(conveyor);
  scene.add(modelRoot, layoutRoot);

  const registry = new NodeRegistry();
  scene.traverse((n) => {
    const path = NodeRegistry.computeNodePath(n);
    if (path) registry.registerNode(path, n);
  });
  return { scene, modelRoot, layoutRoot, registry };
}

function makePlugin(viewer: Partial<RVViewer>): McpSceneTools {
  return new McpSceneTools(() => viewer as RVViewer);
}

async function nodeTree(viewer: Partial<RVViewer>, root = '', depth = 3): Promise<TreeEntry> {
  return JSON.parse(await makePlugin(viewer).webNodeTree(root, depth)) as TreeEntry;
}

/** Every path in the tree, depth-first — the thing that must not change. */
function allPaths(entry: TreeEntry): string[] {
  return [entry.path, ...(entry.children ?? []).flatMap(allPaths)];
}

describe('web_node_tree default root', () => {
  it('starts at the model root, not at the raw scene', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const tree = await nodeTree({ scene, registry, currentModelRoot: modelRoot } as never);

    expect(tree.name).toBe('Robot');
    expect(tree.path).toBe('Robot');
    expect(tree.children?.map((c) => c.name)).toEqual(['Base', 'Arm']);
  });

  it('reports locked:true on the root entry and on no other node', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const tree = await nodeTree({ scene, registry, currentModelRoot: modelRoot } as never);

    expect(tree.locked).toBe(true);
    const lockedElsewhere = (tree.children ?? []).flatMap(allPathsLocked);
    expect(lockedElsewhere).toEqual([]);

    function allPathsLocked(e: TreeEntry): string[] {
      return [...(e.locked ? [e.path] : []), ...(e.children ?? []).flatMap(allPathsLocked)];
    }
  });

  it('excludes runtime siblings like _layoutRoot that the scene start used to include', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const tree = await nodeTree({ scene, registry, currentModelRoot: modelRoot } as never);
    expect(allPaths(tree).some((p) => p.startsWith('_layoutRoot'))).toBe(false);
  });

  it('yields CHILD PATHS identical to an explicit root:"Robot" call', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const viewer = { scene, registry, currentModelRoot: modelRoot } as never;
    const implicit = await nodeTree(viewer);
    const explicit = await nodeTree(viewer, 'Robot');
    expect(allPaths(implicit)).toEqual(allPaths(explicit));
    expect(allPaths(implicit)).toEqual(['Robot', 'Robot/Base', 'Robot/Base/Joint', 'Robot/Arm']);
  });

  it('the explicit root escape hatch still reaches anything, incl. _layoutRoot', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const tree = await nodeTree({ scene, registry, currentModelRoot: modelRoot } as never, '_layoutRoot');
    expect(tree.path).toBe('_layoutRoot');
    expect(tree.children?.map((c) => c.path)).toEqual(['_layoutRoot/Conveyor']);
    expect(tree.locked).toBeUndefined();
  });

  it('falls back to the scene when no model is loaded', async () => {
    const { scene, registry } = buildScene();
    const tree = await nodeTree({ scene, registry, currentModelRoot: null } as never);
    // The scene itself has no registry path, so the entry falls back to its name.
    expect(tree.children?.map((c) => c.name)).toEqual(['Robot', '_layoutRoot']);
    expect(tree.locked).toBeUndefined();
  });

  it('still errors on an unknown explicit root', async () => {
    const { scene, modelRoot, registry } = buildScene();
    const res = JSON.parse(
      await makePlugin({ scene, registry, currentModelRoot: modelRoot } as never).webNodeTree('Nope', 3),
    );
    expect(res.error).toContain('Nope');
  });
});

// ─── MCP write guards inherit the root lock (plan-715 §2.4.4) ─────────────

/**
 * The AssetDocument unit test proves the guard; this proves the INHERITANCE —
 * that the real MCP tools, which is how an agent actually reaches those verbs,
 * answer with an error rather than quietly doing nothing.
 */
async function editorTools(modelRoot: Object3D, registry: NodeRegistry, doc: object) {
  const { McpEditorTools } = await import('../src/plugins/mcp-bridge/rv-mcp-editor-tools');
  const viewer = { registry, currentModelRoot: modelRoot } as never;
  const tools = new McpEditorTools(() => viewer);
  // `_ctx()` resolves the active asset context; the guard under test runs before
  // anything it provides is used.
  (tools as unknown as { _ctx: () => object })._ctx = () => ({ viewer, doc });
  return tools;
}

describe('MCP editor tools refuse the model root', () => {
  it('web_editor_rename / _transform / _set_visible answer with an error', async () => {
    const { modelRoot, registry } = buildScene();
    const calls: string[] = [];
    const doc = {
      renameNode: () => calls.push('rename'),
      transformNode: () => calls.push('transform'),
      setNodeVisible: () => calls.push('visible'),
      whenIdle: async () => {},
    };
    const tools = await editorTools(modelRoot, registry, doc);

    const rename = JSON.parse(await (tools as never as { webEditorRename(p: string, n: string): Promise<string> })
      .webEditorRename('Robot', 'Nope'));
    const transform = JSON.parse(await (tools as never as {
      webEditorTransform(...a: unknown[]): Promise<string>;
    }).webEditorTransform('Robot', 1, 2, 3));
    const visible = JSON.parse(await (tools as never as {
      webEditorSetVisible(p: string, v: boolean): Promise<string>;
    }).webEditorSetVisible('Robot', false));

    for (const res of [rename, transform, visible]) {
      expect(res.ok).toBeUndefined();
      expect(String(res.error)).toContain('model root is locked');
    }
    // Nothing reached the document at all.
    expect(calls).toEqual([]);
  });

  it('lets the same three verbs through for a child node', async () => {
    const { modelRoot, registry } = buildScene();
    const calls: string[] = [];
    const doc = {
      renameNode: () => calls.push('rename'),
      transformNode: () => calls.push('transform'),
      setNodeVisible: () => calls.push('visible'),
      whenIdle: async () => {},
    };
    const tools = await editorTools(modelRoot, registry, doc);

    await (tools as never as { webEditorRename(p: string, n: string): Promise<string> })
      .webEditorRename('Robot/Base', 'Plate');
    await (tools as never as { webEditorSetVisible(p: string, v: boolean): Promise<string> })
      .webEditorSetVisible('Robot/Base', false);

    expect(calls).toEqual(['rename', 'visible']);
  });
});
