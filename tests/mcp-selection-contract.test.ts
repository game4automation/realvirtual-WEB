// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.20 — the MCP selection contract after selection moved to objects.
 *
 * `web_select` keeps taking PATHS: that is the document's vocabulary and an
 * agent has no other handle on a node. What changes is the answer — a selection
 * can now contain something the document does not address (a chunk mesh, a
 * light, an overlay), and `web_selection_get` has to say so instead of silently
 * reporting a shorter list than the user sees selected.
 *
 * `paths` therefore keeps its exact old meaning (addressable nodes only) and the
 * additive `nodes[]` carries the whole truth: `{ uuid, name }` plus either a
 * `path` or `runtime: true`.
 *
 * Phase 3 (F11) extends the same contract to the node tools: `web_node_tree`
 * flags what the document does not address, and `web_node_bounds` can measure
 * the paths that tree hands out.
 */

import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { McpSceneTools } from '../src/plugins/mcp-bridge/rv-mcp-scene-tools';
import { SelectionManager } from '../src/core/engine/rv-selection-manager';
import type { RVViewer } from '../src/core/rv-viewer';

function makeWorld() {
  const scene = new Scene();
  const robot = new Group(); robot.name = 'Robot';
  const axis = new Group(); axis.name = 'Axis1';
  const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  chunk.name = 'mover:Robot/Axis1|tex:cafe';
  chunk.userData._rvBakeChunk = true;
  axis.add(chunk);
  robot.add(axis);
  scene.add(robot);

  const paths = new Map<Object3D, string>([[robot, 'Robot'], [axis, 'Robot/Axis1']]);
  const byPath = new Map([...paths].map(([n, p]) => [p, n] as const));

  // A light: unregistered, no bake marker — the `runtime` half of the rule.
  const lamp = new Object3D(); lamp.name = 'Lamp';
  robot.add(lamp);

  const selectionManager = new SelectionManager();
  const viewer = {
    scene,
    currentModelRoot: robot,
    selectionManager,
    highlighter: { highlightSelection: vi.fn(), clearSelection: vi.fn() },
    registry: {
      getNode: (p: string) => byPath.get(p) ?? null,
      getPathForNode: (n: Object3D) => paths.get(n) ?? null,
    },
    emit: vi.fn(),
  };
  selectionManager.init(viewer as never);
  const tools = new McpViewTools(() => viewer as unknown as RVViewer);
  const sceneTools = new McpSceneTools(() => viewer as unknown as RVViewer);
  return { viewer, tools, sceneTools, selectionManager, robot, axis, chunk, lamp };
}

const parse = (s: string) => JSON.parse(s) as {
  error?: string;
  selected?: number; primary?: string | null;
  paths?: string[];
  nodes?: Array<{ uuid: string; name: string; path?: string; runtime?: boolean }>;
  unresolved?: string[];
};

describe('web_select (§9.20)', () => {
  it('selects by path and reports the primary path back', async () => {
    const w = makeWorld();
    const out = parse(await w.tools.webSelect('Robot/Axis1', 'replace'));
    expect(out.selected).toBe(1);
    expect(out.primary).toBe('Robot/Axis1');
    expect(w.selectionManager.getSnapshot().primaryNode).toBe(w.axis);
  });

  it('selects several paths, and names the ones it could not resolve', async () => {
    const w = makeWorld();
    const out = parse(await w.tools.webSelect('Robot,Robot/Axis1,Robot/Nope', 'replace'));
    expect(out.selected).toBe(2);
    expect(out.unresolved).toEqual(['Robot/Nope']);
  });

  it('refuses a selection where nothing resolves', async () => {
    const w = makeWorld();
    const out = parse(await w.tools.webSelect('Nothing/Here', 'replace'));
    expect(out.error).toContain('Nothing/Here');
  });

  it('clear empties the selection', async () => {
    const w = makeWorld();
    await w.tools.webSelect('Robot/Axis1', 'replace');
    const out = parse(await w.tools.webSelect('', 'clear'));
    expect(out.selected).toBe(0);
    expect(w.selectionManager.count).toBe(0);
  });
});

describe('web_selection_get (§9.20)', () => {
  it('reports a registered selection with its path, in both fields', async () => {
    const w = makeWorld();
    w.selectionManager.selectNode(w.axis);
    const out = parse(await w.tools.webSelectionGet());
    expect(out.paths).toEqual(['Robot/Axis1']);
    expect(out.primary).toBe('Robot/Axis1');
    expect(out.nodes).toEqual([{ uuid: w.axis.uuid, name: 'Axis1', path: 'Robot/Axis1' }]);
  });

  it('reports an UNREGISTERED selection as { uuid, runtime: true } with no path', async () => {
    const w = makeWorld();
    w.selectionManager.selectNode(w.chunk);
    const out = parse(await w.tools.webSelectionGet());
    // The old fields stay honest: nothing addressable is selected.
    expect(out.paths).toEqual([]);
    expect(out.primary).toBeNull();
    // …and the new one says what IS selected.
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes![0]).toMatchObject({ uuid: w.chunk.uuid, runtime: true });
    expect(out.nodes![0].path).toBeUndefined();
  });

  it('reports a mixed selection in selection order', async () => {
    const w = makeWorld();
    w.selectionManager.selectNodes([w.axis, w.chunk]);
    const out = parse(await w.tools.webSelectionGet());
    expect(out.paths).toEqual(['Robot/Axis1']);
    expect(out.nodes!.map((n) => n.uuid)).toEqual([w.axis.uuid, w.chunk.uuid]);
    expect(out.nodes!.map((n) => n.runtime ?? false)).toEqual([false, true]);
  });

  it('reports an empty selection as empty, not as an error', async () => {
    const w = makeWorld();
    const out = parse(await w.tools.webSelectionGet());
    expect(out.paths).toEqual([]);
    expect(out.nodes).toEqual([]);
    expect(out.error).toBeUndefined();
  });
});

// ─── F11: the node tools report the panel's graph ────────────────────────

type TreeEntry = {
  name: string; path: string; types: string[];
  runtime?: boolean; chunk?: boolean; children?: TreeEntry[];
};

describe('web_node_tree flags what the document does not address (F11)', () => {
  it('reports chunk meshes as chunk and unregistered objects as runtime', async () => {
    const w = makeWorld();
    const tree = JSON.parse(await w.sceneTools.webNodeTree('', 5)) as TreeEntry;
    expect(tree.path).toBe('Robot');
    expect(tree.runtime ?? false).toBe(false);

    const axis = tree.children!.find((c) => c.name === 'Axis1')!;
    expect(axis.path).toBe('Robot/Axis1');
    expect(axis.chunk ?? false).toBe(false);
    expect(axis.runtime ?? false).toBe(false);

    // The chunk mesh IS the document's geometry — `chunk`, never `runtime`.
    const chunk = axis.children![0];
    expect(chunk.chunk).toBe(true);
    expect(chunk.runtime).toBeUndefined();
    expect(chunk.path).toBe('Robot/Axis1/mover:Robot/Axis1|tex:cafe');

    // A plain unregistered object is the other half of the rule.
    const lamp = tree.children!.find((c) => c.name === 'Lamp')!;
    expect(lamp.runtime).toBe(true);
    expect(lamp.chunk).toBeUndefined();
  });

  it('takes component types from the node itself, so an unregistered node is badged too', async () => {
    const w = makeWorld();
    w.lamp.userData.realvirtual = { Drive: { TargetSpeed: 1 } };
    const tree = JSON.parse(await w.sceneTools.webNodeTree('', 5)) as TreeEntry;
    const lamp = tree.children!.find((c) => c.name === 'Lamp')!;
    expect(lamp.types).toEqual(['Drive']);
  });
});

describe('web_node_bounds measures the paths web_node_tree hands out (F11)', () => {
  it('resolves a chunk-mesh path through the scene graph and flags it', async () => {
    const w = makeWorld();
    const out = JSON.parse(await w.tools.webNodeBounds('Robot/Axis1/mover:Robot/Axis1|tex:cafe', false)) as {
      nodes: Array<{ path: string; chunk?: boolean; runtime?: boolean; meshCount: number }>;
      unresolved?: string[]; selected?: number;
    };
    expect(out.unresolved).toBeUndefined();
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].chunk).toBe(true);
    expect(out.nodes[0].meshCount).toBe(1);
    // Nothing unaddressable ever reaches the selection.
    expect(out.selected).toBeUndefined();
  });

  it('still reports a path that resolves nowhere', async () => {
    const w = makeWorld();
    const out = JSON.parse(await w.tools.webNodeBounds('Robot/Nope', false)) as { unresolved?: string[] };
    expect(out.unresolved).toEqual(['Robot/Nope']);
  });
});
