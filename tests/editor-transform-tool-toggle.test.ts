// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 F3 — the editor's transform-tool toggle.
 *
 *   - default OFF: selecting a node selects it, no gizmo is attached;
 *   - ON attaches the gizmo to the current selection, OFF detaches it again;
 *   - the selection itself is never touched by the toggle;
 *   - `editor.toggleTransformTool` flips without args and sets with `on`;
 *   - every editor entry resets the tool to OFF (`_finishActivation`).
 *
 * Fake viewer in the style of `rv-transform-gizmo.test.ts` (the gizmo is the
 * real `TransformGizmo`; only the viewer surface it reads is stubbed).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  ensureEditorCommandsRegistered,
  SHORTCUT_BRANCHES,
  TOGGLE_TRANSFORM_TOOL_COMMAND,
} from '../src/core/hmi/editor-command-descriptors';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import { EditorTransformTool } from '@rv-private/plugins/asset-editor/EditorTransformTool';
import {
  isTransformToolOn, resetTransformTool, setTransformToolOn, subscribeTransformTool,
} from '@rv-private/plugins/asset-editor/transform-tool-store';
// The plugin source, to pin the reset-on-entry call order (see the last case).
import assetEditorIndexSource from '@rv-private/plugins/asset-editor/index.ts?raw';

function makeFixture() {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 10);
  const assetRoot = new Object3D();
  assetRoot.name = 'Asset';
  scene.add(assetRoot);
  const nodes = new Map<string, Object3D>();
  const addNode = (path: string, x: number) => {
    const n = new Object3D();
    n.name = path.split('/').pop()!;
    n.position.set(x, 0, 0);
    assetRoot.add(n);
    n.updateMatrixWorld(true);
    nodes.set(path, n);
    return n;
  };
  let selectedPaths: string[] = [];
  const listeners = new Set<() => void>();
  const viewer = {
    camera,
    renderer: { domElement: document.createElement('canvas') },
    scene,
    controls: { enabled: true },
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
    currentModelRoot: assetRoot,
    modes: { activeMode: 'editor' },
    registry: {
      getNode: (p: string) => (p === 'Asset' ? assetRoot : nodes.get(p) ?? null),
      getPathForNode: (n: Object3D) => {
        if (n === assetRoot) return 'Asset';
        for (const [p, node] of nodes) if (node === n) return p;
        return null;
      },
    },
    selectionManager: {
      get selectedPaths() { return selectedPaths; },
      subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
  } as unknown as RVViewer;
  const select = (paths: string[]) => {
    selectedPaths = paths;
    for (const fn of listeners) fn();
  };
  const doc = { transformNode: vi.fn(), withTransaction: vi.fn(), applyOp: vi.fn() } as unknown as AssetDocument;
  return { viewer, scene, addNode, select, doc, selected: () => selectedPaths };
}

/** The gizmo root is visible exactly while it is attached. */
function gizmoVisible(scene: Scene): boolean {
  return scene.getObjectByName('__rvTransformGizmo')?.visible ?? false;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  resetTransformTool();
});

describe('transform-tool-store', () => {
  it('defaults to OFF, notifies on change only, resets to OFF', () => {
    resetTransformTool();
    expect(isTransformToolOn()).toBe(false);
    const cb = vi.fn();
    cleanups.push(subscribeTransformTool(cb));
    setTransformToolOn(true);
    setTransformToolOn(true); // unchanged: no second notification
    expect(isTransformToolOn()).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    resetTransformTool();
    expect(isTransformToolOn()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('EditorTransformTool gated by the toggle', () => {
  it('OFF: selecting attaches no gizmo; ON attaches; OFF detaches; selection unchanged', () => {
    const { viewer, scene, addNode, select, doc, selected } = makeFixture();
    addNode('Asset/A', 0);
    addNode('Asset/B', 4);
    const tool = new EditorTransformTool(viewer, doc);
    tool.install();
    cleanups.push(() => tool.uninstall());

    select(['Asset/A']);
    expect(gizmoVisible(scene)).toBe(false);
    expect(selected()).toEqual(['Asset/A']);

    setTransformToolOn(true);
    expect(gizmoVisible(scene)).toBe(true);
    expect(selected()).toEqual(['Asset/A']);

    // Selection changes while ON follow as before.
    select(['Asset/A', 'Asset/B']);
    expect(gizmoVisible(scene)).toBe(true);
    expect(scene.getObjectByName('__rvTransformGizmo')!.position.x).toBe(2);

    setTransformToolOn(false);
    expect(gizmoVisible(scene)).toBe(false);
    expect(selected()).toEqual(['Asset/A', 'Asset/B']);

    // OFF again: a new selection still attaches nothing.
    select(['Asset/B']);
    expect(gizmoVisible(scene)).toBe(false);
  });

  it('an uninstalled tool no longer follows the toggle', () => {
    const { viewer, scene, addNode, select, doc } = makeFixture();
    addNode('Asset/A', 0);
    const tool = new EditorTransformTool(viewer, doc);
    tool.install();
    select(['Asset/A']);
    tool.uninstall();
    expect(() => setTransformToolOn(true)).not.toThrow();
    expect(scene.getObjectByName('__rvTransformGizmo')).toBeUndefined();
  });
});

describe('editor.toggleTransformTool command', () => {
  it('flips without args and sets with on=true/false', async () => {
    ensureEditorCommandsRegistered();
    const { viewer, doc } = makeFixture();
    setActiveAssetContext({ viewer, doc } as unknown as ActiveAssetContext);
    cleanups.push(() => setActiveAssetContext(null));
    resetTransformTool();

    const run = (args: unknown) => commandRegistry.execute<{ transformTool: boolean }>(
      TOGGLE_TRANSFORM_TOOL_COMMAND, args, { origin: 'shortcut', viewer },
    );
    let r = await run({});
    expect(r.ok).toBe(true);
    expect(isTransformToolOn()).toBe(true);
    await run({ on: true });
    expect(isTransformToolOn()).toBe(true);
    await run({ on: false });
    expect(isTransformToolOn()).toBe(false);
    r = await run({ on: null });
    expect(isTransformToolOn()).toBe(true);
    expect(r.ok && r.value?.transformTool).toBe(true);
  });

  it('is bound to the T key with the shared on/off/flip arg', () => {
    const branch = SHORTCUT_BRANCHES.find((b) => b.id === TOGGLE_TRANSFORM_TOOL_COMMAND);
    expect(branch?.when).toEqual({ keys: 'T' });
    expect(branch?.args({})).toEqual({ on: null });
    expect(branch?.args({ arg: 'on' })).toEqual({ on: true });
    expect(branch?.args({ arg: 'off' })).toEqual({ on: false });
  });
});

describe('reset on editor entry', () => {
  it('_finishActivation resets the tool to OFF before installing the authoring tools', () => {
    // The plugin's activation needs a full viewer + document stack; pin the
    // call order at the source instead (the store's own reset is tested above).
    const body = assetEditorIndexSource.slice(assetEditorIndexSource.indexOf('private _finishActivation('));
    const reset = body.indexOf('resetTransformTool();');
    const install = body.indexOf('this._installAuthoringTools(');
    expect(reset).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(reset);
  });
});
