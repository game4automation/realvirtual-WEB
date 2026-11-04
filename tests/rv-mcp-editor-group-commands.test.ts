// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-760 §9.5 — the four group verbs of the MCP bridge
 * (`web_editor_group_assign` / `_remove` / `_rename` / `_dissolve`) as views of
 * `editor.group*`, driven through the REAL {@link McpEditorTools} against a real
 * `AssetDocument` (the `mcp-editor-doc-mutations` fixture plus a GroupRegistry
 * the asset executor keeps in sync). Pinned: every mutation lands as ONE
 * undoable op, the refuse paths touch nothing, and `web_group_list.kinematic`
 * reflects a Kinematic added in this session.
 */

import { executeValue } from './helpers/execute-value';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queryValue } from './helpers/query-value';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { syncSubtreeGroups } from '../src/core/engine/rv-group-sync';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  GROUP_ASSIGN_COMMAND, GROUP_DISSOLVE_COMMAND, GROUP_REMOVE_COMMAND, GROUP_RENAME_COMMAND,
  ensureEditorCommandsRegistered,
} from '../src/core/hmi/editor-command-descriptors';
import { allSchemas } from './helpers/mcp-schemas';

// ─── Fixture ────────────────────────────────────────────────────────────

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  tools: McpEditorTools;
  groups: GroupRegistry;
  root: Group;
  selected: string[];
}

function withRv(name: string, rv?: Record<string, unknown>): Object3D {
  const o = new Object3D();
  o.name = name;
  if (rv) o.userData['realvirtual'] = rv;
  return o;
}

/**
 * Asset ▸ Axis1 (Kinematic → 'Axis1'), Part (Group 'Axis1' + Group_1 'Cover'),
 *         Part2 (Group 'Axis1'), Other (Group 'Cover'), Free (no group),
 *         Fence (prefix node), A (Group 'Left' + prefix Asset/Fence), B (Group 'FenceLeft')
 */
function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  root.add(
    withRv('Axis1', { Kinematic: { GroupName: 'Axis1' } }),
    withRv('Part', { Group: { GroupName: 'Axis1' }, Group_1: { GroupName: 'Cover' } }),
    withRv('Part2', { Group: { GroupName: 'Axis1' } }),
    withRv('Other', { Group: { GroupName: 'Cover' } }),
    withRv('Free'),
    withRv('Fence'),
    withRv('A', { Group: { GroupName: 'Left', GroupNamePrefix: 'Asset/Fence' } }),
    withRv('B', { Group: { GroupName: 'FenceLeft' } }),
  );
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const selected: string[] = [];
  let activeMode = 'editor';
  const viewer = {
    scene,
    registry,
    groups: new GroupRegistry(),
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    modes: {
      get activeMode() { return activeMode; },
      has: () => true,
      setMode: (m: string) => { activeMode = m; },
      list: () => [{ id: 'planner' }, { id: 'hmi' }, { id: 'editor' }],
      subscribe: () => () => {},
    },
    selectionManager: {
      select() {}, selectPaths() {}, selectNodes() {}, clear() {},
      getSnapshot: () => ({ selectedPaths: selected, primaryPath: selected[selected.length - 1] ?? null }),
    },
    highlighter: { highlightSelection() {}, highlightMultiple() {}, clear() {} },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;
  syncSubtreeGroups(viewer, root, 'attach');

  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });
  return {
    viewer, doc, root, selected,
    groups: viewer.groups as GroupRegistry,
    tools: new McpEditorTools(() => viewer),
  };
}

function ok(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed['error'], `tool returned an error: ${json}`).toBeUndefined();
  return parsed;
}

function err(json: string): string {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed['error'], `tool did not refuse: ${json}`).toBeTypeOf('string');
  return parsed['error'] as string;
}

function rvOf(e: Env, path: string): Record<string, Record<string, unknown>> {
  const n = e.viewer.registry?.getNode(path);
  return (n?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined) ?? {};
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  env = makeEnv();
});

afterEach(() => {
  setActiveAssetContext(null);
  env.doc.dispose();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('web_editor_group_* — schemas and bindings', () => {
  it('keeps the four group commands as writes while retiring their tool schemas', () => {
    ensureEditorCommandsRegistered();
    const names = allSchemas().map((s) => s.name);
    for (const n of ['web_editor_group_assign', 'web_editor_group_remove', 'web_editor_group_rename', 'web_editor_group_dissolve']) {
      expect(names).not.toContain(n);
    }
    for (const id of [GROUP_ASSIGN_COMMAND, GROUP_REMOVE_COMMAND, GROUP_RENAME_COMMAND, GROUP_DISSOLVE_COMMAND]) {
      const d = commandRegistry.get(id);
      expect(d, id).toBeDefined();
      expect(d!.readOnly).toBe(false);
      expect(d!.mcp?.tool).toBe(`web_editor_group_${id.replace('editor.group', '').toLowerCase()}`);
    }
  });
});

describe('web_editor_group_assign', () => {
  it('stamps a Group on the given nodes without creating a kinematic — one undoable op', async () => {
    const r = ok(await executeValue(env.viewer, 'editor.groupAssign', { name: 'Hood', paths: 'Asset/Free, Asset/Part2' }));
    expect(r).toMatchObject({ ok: true, group: 'Hood', added: 2, skipped: 0, kinematicsUpdated: 0 });
    expect(env.groups.get('Hood')?.nodes).toHaveLength(2);
    expect(env.root.children.some((c) => c.name === 'Hood')).toBe(false);
    expect(env.doc.getSnapshot().opCount).toBe(1);
    ok(await executeValue(env.viewer, 'editor.undo', { count: 1 }));
    expect(env.groups.get('Hood')).toBeUndefined();
  });

  it('falls back to the current selection when paths are omitted; nothing selected is refused', async () => {
    const refused = err(await executeValue(env.viewer, 'editor.groupAssign', { name: 'Hood', paths: '' }));
    expect(refused).toMatch(/nothing selected/i);
    env.selected.push('Asset/Free');
    const r = ok(await executeValue(env.viewer, 'editor.groupAssign', { name: 'Hood', paths: '' }));
    expect(r).toMatchObject({ added: 1 });
    expect(env.groups.get('Hood')?.nodes[0].name).toBe('Free');
  });
});

describe('web_editor_group_rename and _assign refuse "", "  " and "a/b" without touching the document', () => {
  for (const bad of ['', '  ', 'a/b']) {
    it(`name ${JSON.stringify(bad)}`, async () => {
      expect(err(await executeValue(env.viewer, 'editor.groupAssign', { name: bad, paths: 'Asset/Free' }))).toMatch(/empty|"\/"/);
      expect(err(await executeValue(env.viewer, 'editor.groupRename', { name: 'Cover', newName: bad }))).toMatch(/empty|"\/"/);
      expect(err(await executeValue(env.viewer, 'editor.groupRename', { name: bad, newName: 'Hood' }))).toMatch(/empty|"\/"/);
      expect(err(await executeValue(env.viewer, 'editor.groupRemove', { name: bad, paths: 'Asset/Part' }))).toMatch(/empty|"\/"/);
      expect(err(await executeValue(env.viewer, 'editor.groupDissolve', { name: bad }))).toMatch(/empty|"\/"/);
      expect(env.doc.getSnapshot().opCount).toBe(0);
      expect(env.doc.dirty).toBe(false);
    });
  }
});

describe('web_editor_group_rename', () => {
  it('dispatches editor.groupRename: members AND the owning Kinematic, one undoable op', async () => {
    const r = ok(await executeValue(env.viewer, 'editor.groupRename', { name: 'Axis1', newName: 'Axis1_Rot' }));
    expect(r).toMatchObject({ ok: true, group: 'Axis1_Rot', previous: 'Axis1', renamed: 2, kinematicsUpdated: 1 });
    expect(env.groups.get('Axis1')).toBeUndefined();
    expect(env.groups.get('Axis1_Rot')?.nodes).toHaveLength(2);
    expect(rvOf(env, 'Asset/Axis1').Kinematic.GroupName).toBe('Axis1_Rot');
    expect(env.doc.getSnapshot().opCount).toBe(1);
    ok(await executeValue(env.viewer, 'editor.undo', { count: 1 }));
    expect(env.groups.get('Axis1')?.nodes).toHaveLength(2);
    expect(rvOf(env, 'Asset/Axis1').Kinematic.GroupName).toBe('Axis1');
  });

  it('refuses a collision (registry and kinematic names) and an unknown group — nothing recorded', async () => {
    expect(err(await executeValue(env.viewer, 'editor.groupRename', { name: 'Cover', newName: 'Axis1' }))).toMatch(/already exists/);
    expect(err(await executeValue(env.viewer, 'editor.groupRename', { name: 'Nope', newName: 'Hood' }))).toMatch(/Unknown group/);
    expect(env.doc.getSnapshot().opCount).toBe(0);
  });

  it('same name is a no-op without an op', async () => {
    const r = ok(await executeValue(env.viewer, 'editor.groupRename', { name: 'Cover', newName: 'Cover' }));
    expect(r).toMatchObject({ group: 'Cover', renamed: 0, kinematicsUpdated: 0 });
    expect(env.doc.getSnapshot().opCount).toBe(0);
  });

  it('refuses a new name that would drop a prefixed key\'s prefix (case c)', async () => {
    expect(err(await executeValue(env.viewer, 'editor.groupRename', { name: 'FenceLeft', newName: 'Hood' }))).toMatch(/drop prefix "Fence" on Asset\/A/);
    expect(env.doc.getSnapshot().opCount).toBe(0);
    expect(env.groups.get('FenceLeft')?.nodes).toHaveLength(2);
    // Keeping the prefix is fine: per-key suffix on A, full name on B.
    ok(await executeValue(env.viewer, 'editor.groupRename', { name: 'FenceLeft', newName: 'FenceRight' }));
    expect(rvOf(env, 'Asset/A').Group.GroupName).toBe('Right');
    expect(rvOf(env, 'Asset/B').Group.GroupName).toBe('FenceRight');
  });
});

describe('web_editor_group_remove', () => {
  it('strips the matching Group keys, keeps other groups, reports non-members as skipped', async () => {
    const r = ok(await executeValue(env.viewer, 'editor.groupRemove', { name: 'Cover', paths: 'Asset/Part, Asset/Part2' }));
    expect(r).toMatchObject({ ok: true, group: 'Cover', removed: 1, skipped: 1 });
    expect(rvOf(env, 'Asset/Part').Group_1).toBeUndefined();
    expect(rvOf(env, 'Asset/Part').Group.GroupName).toBe('Axis1');
    expect(env.groups.get('Cover')?.nodes).toHaveLength(1);
    ok(await executeValue(env.viewer, 'editor.undo', { count: 1 }));
    expect(env.groups.get('Cover')?.nodes).toHaveLength(2);
  });

  it('refuses an unknown group', async () => {
    expect(err(await executeValue(env.viewer, 'editor.groupRemove', { name: 'Nope', paths: 'Asset/Part' }))).toMatch(/Unknown group/);
    expect(env.doc.getSnapshot().opCount).toBe(0);
  });
});

describe('web_editor_group_dissolve', () => {
  it('removes the members\' Group keys and clears the Kinematic link; undo restores both', async () => {
    const r = ok(await executeValue(env.viewer, 'editor.groupDissolve', { name: 'Axis1' }));
    expect(r).toMatchObject({ ok: true, group: 'Axis1', dissolved: 2, kinematicsUpdated: 1 });
    expect(env.groups.get('Axis1')).toBeUndefined();
    expect(rvOf(env, 'Asset/Axis1').Kinematic.GroupName).toBe('');
    expect(rvOf(env, 'Asset/Part').Group_1.GroupName).toBe('Cover');
    expect(env.viewer.registry!.getNode('Asset/Part')).not.toBeNull();
    expect(env.doc.getSnapshot().opCount).toBe(1);
    ok(await executeValue(env.viewer, 'editor.undo', { count: 1 }));
    expect(env.groups.get('Axis1')?.nodes).toHaveLength(2);
    expect(rvOf(env, 'Asset/Axis1').Kinematic.GroupName).toBe('Axis1');
  });

  it('refuses an unknown group', async () => {
    expect(err(await executeValue(env.viewer, 'editor.groupDissolve', { name: 'Nope' }))).toMatch(/Unknown group/);
    expect(env.doc.getSnapshot().opCount).toBe(0);
  });
});

describe('web_group_list.kinematic', () => {
  it('reflects a Kinematic added this session (live scan OR load-time flag)', async () => {
    const before = JSON.parse(await queryValue(env.viewer, 'group.list')) as { groups: { name: string; kinematic: boolean }[] };
    expect(before.groups.find((g) => g.name === 'Cover')?.kinematic).toBe(false);
    expect(before.groups.find((g) => g.name === 'Axis1')?.kinematic).toBe(true);    // never marked by a loader
    expect(env.groups.isKinematic('Axis1')).toBe(false);

    // A Kinematic authored THIS session (the document op path; the component
    // schema registry of this fixture knows no `Kinematic`, so not via the tool).
    env.doc.addComponent('Asset/Free', 'Kinematic', { GroupName: 'Cover' });
    await env.doc.whenIdle();
    const after = JSON.parse(await queryValue(env.viewer, 'group.list')) as { groups: { name: string; kinematic: boolean }[] };
    expect(after.groups.find((g) => g.name === 'Cover')?.kinematic).toBe(true);

    // The load-time mark still counts on its own (baked HMI models, no Kinematic in the scene).
    env.groups.markAsKinematic('FenceLeft');
    const marked = JSON.parse(await queryValue(env.viewer, 'group.list')) as { groups: { name: string; kinematic: boolean }[] };
    expect(marked.groups.find((g) => g.name === 'FenceLeft')?.kinematic).toBe(true);
  });
});
