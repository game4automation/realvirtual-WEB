// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it } from 'vitest';
import { makeAuthoringRig, rvOf, type AuthoringRig } from './helpers/collider-authoring-rig';
import { executeValue } from './helpers/execute-value';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { Scene, Vector3 } from 'three';
import { InPlaceTestSession } from '@rv-private/plugins/asset-editor/in-place-test-session';
import { _resetSceneTransition } from '../src/core/hmi/scene-transition-store';
import { loadAuthoringModel } from '../src/core/editor/rv-authoring-load';
import { WebOperatorPanelHost, type RVWebOperatorPanel } from '../src/core/engine/rv-web-operator-panel';

const config = { version: 1, id: 'persistence', title: 'Panel', buttons: [], selectors: [], estops: [], stackLight: [], status: [] };
let rig: AuthoringRig | undefined;
let host: WebOperatorPanelHost | undefined;
afterEach(() => { host?.dispose(); host = undefined; setActiveAssetContext(null); rig?.dispose(); rig = undefined; });

describe('WebOperatorPanel Config through MCP, Dock and GLB', () => {
  for (const encoding of ['string', 'object'] as const) {
    for (const sequence of ['batch', 'separate', 'undo-redo'] as const) {
      it(`${encoding}, ${sequence}: preserves Config after export and reload`, async () => {
        rig = makeAuthoringRig();
        Object.assign(rig.viewer, { modes: { activeMode: 'editor', has: () => true } });
        setActiveAssetContext({ viewer: rig.viewer, doc: rig.doc });
        ensureEditorCommandsRegistered();
        const path = rig.pathOf(rig.addNode('OperatorPanel'));
        const execute = async (command: string, args: Record<string, unknown>) => {
          const result = JSON.parse(await executeValue(rig!.viewer, command, args));
          expect(result.error).toBeUndefined();
          expect(result.ok).toBe(true);
          return result;
        };
        await execute('editor.addComponent', { path, type: 'WebOperatorPanel', propsJson: '' });
        host = new WebOperatorPanelHost({ registry: rig.registry, signalStore: rig.viewer.signalStore, connectionMode: null });
        const args = { path, componentType: 'WebOperatorPanel' };
        const steps = [
          { command: 'editor.setField', args: { ...args, fieldName: 'Config', valueJson: JSON.stringify(encoding === 'string' ? JSON.stringify(config) : config) } },
          { command: 'editor.setField', args: { ...args, fieldName: 'Dock', valueJson: '"top-right"' } },
        ];
        if (sequence === 'batch') {
          const result = JSON.parse(await new McpCommandTools(() => rig!.viewer).webBatch(JSON.stringify(steps)));
          expect(result).toMatchObject({ ok: true, ran: 2 });
        } else {
          await execute(steps[0].command, steps[0].args);
          if (sequence === 'undo-redo') {
            await execute('editor.undo', { count: 1 });
            expect(rvOf(rig.registry.getNode(path)).WebOperatorPanel.Config ?? '').toBe('');
            await execute('editor.redo', { count: 1 });
          }
          await execute(steps[1].command, steps[1].args);
        }
        host.rescan();
        expect(host.entries[0].errors).toEqual([]);
        expect(host.entries[0].dock).toBe('top-right');
        const stored = rvOf(rig.registry.getNode(path)).WebOperatorPanel;
        expect(typeof stored.Config === 'string' ? JSON.parse(stored.Config) : stored.Config).toEqual(config);
        const bytes = await exportAssetGlb(rig.root, 'Panel');
        const reloaded = await loadGLB('panel.glb', new Scene(), { data: bytes, preserveHierarchy: true, preserveAuthoringHierarchy: true });
        const panel = reloaded.root.getObjectByName('OperatorPanel');
        const saved = rvOf(panel).WebOperatorPanel;
        expect(saved.Dock).toBe('top-right');
        expect(typeof saved.Config === 'string' ? JSON.parse(saved.Config) : saved.Config).toEqual(config);
        const loadedLive = reloaded.registry.getAll<RVWebOperatorPanel>('WebOperatorPanel')[0].instance;
        expect(JSON.parse(loadedLive.Config)).toEqual(config);
        const live = rig.registry.getByPath('WebOperatorPanel', path) as RVWebOperatorPanel;
        // Assert AFTER the GLB checks: object extras survive even on the old code.
        expect(JSON.parse(live.Config)).toEqual(config);
      });
    }
  }
});

// Legacy files bypass setField: exercise the real decode/schema/init/export path too.
describe('legacy object Config and test-session snapshot restore', () => {
  for (const encoding of ['string', 'object'] as const) {
    it(`${encoding}: survives authoring reload, restoreFromSnapshot and a second export`, async () => {
      rig = makeAuthoringRig();
      rig.addNode('OperatorPanel', { extras: { WebOperatorPanel: {
        Config: encoding === 'string' ? JSON.stringify(config) : config, Dock: 'top-right',
      } } });
      const snapshot = rig.doc.captureSessionState();
      const bytes = await exportAssetGlb(rig.root, 'Panel');
      let loaded!: Awaited<ReturnType<typeof loadGLB>>;
      const authoringViewer = {
        async loadModel(url: string, options?: Parameters<typeof loadGLB>[2]) {
          loaded = await loadGLB(url, new Scene(), options);
        },
        async whenSceneReady() {}, // no placements in this fixture
        get currentModelRoot() { return loaded?.root ?? null; },
      };
      expect(await loadAuthoringModel(authoringViewer, 'snapshot.glb', {
        data: bytes, keepBaked: true, identity: {},
      })).toMatchObject({ ok: true, placementsReady: true });
      Object.assign(rig.viewer, { registry: loaded.registry });
      Object.defineProperty(rig.viewer, 'currentModelRoot', { get: () => loaded.root });
      rig.doc.restoreFromSnapshot(snapshot);
      const component = loaded.registry.getAll<RVWebOperatorPanel>('WebOperatorPanel')[0].instance;
      expect(component.Dock).toBe('top-right');
      const second = await exportAssetGlb(loaded.root, 'Panel');
      const restored = await loadGLB('restored.glb', new Scene(), {
        data: second, preserveHierarchy: true, preserveAuthoringHierarchy: true,
      });
      const stored = rvOf(restored.root.getObjectByName('OperatorPanel')).WebOperatorPanel.Config;
      expect(typeof stored === 'string' ? JSON.parse(stored) : stored).toEqual(config);
      expect(JSON.parse(component.Config)).toEqual(config);
      expect(JSON.parse(restored.registry.getAll<RVWebOperatorPanel>('WebOperatorPanel')[0].instance.Config)).toEqual(config);
    });
  }
});

describe('editor.setField on WebOperatorPanel.Config answers what it stored', () => {
  async function setup() {
    rig = makeAuthoringRig();
    Object.assign(rig.viewer, { modes: { activeMode: 'editor', has: () => true } });
    setActiveAssetContext({ viewer: rig.viewer, doc: rig.doc });
    ensureEditorCommandsRegistered();
    const path = rig.pathOf(rig.addNode('OperatorPanel'));
    await executeValue(rig.viewer, 'editor.addComponent', { path, type: 'WebOperatorPanel', propsJson: '' });
    return path;
  }
  const set = (path: string, valueJson: string) => executeValue(rig!.viewer, 'editor.setField',
    { path, componentType: 'WebOperatorPanel', fieldName: 'Config', valueJson }).then((r) => JSON.parse(r));

  it('stores a raw object as its canonical JSON string and says so (normalized)', async () => {
    const path = await setup();
    const result = await set(path, JSON.stringify(config));
    expect(result.ok).toBe(true);
    expect(result.normalized).toBe(true);
    const stored = rvOf(rig!.registry.getNode(path)).WebOperatorPanel.Config;
    expect(typeof stored).toBe('string');
    expect(JSON.parse(stored as string)).toEqual(config);
  });

  it('a string-encoded config is not flagged as normalized', async () => {
    const path = await setup();
    const result = await set(path, JSON.stringify(JSON.stringify(config)));
    expect(result.ok).toBe(true);
    expect(result.normalized).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it('an unusable Config is reported at once as warnings', async () => {
    const path = await setup();
    const result = await set(path, JSON.stringify('{"version":1'));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/not valid JSON/);
  });
});

describe('real in-place test-session start/stop', () => {
  for (const encoding of ['string', 'object'] as const) {
    it(`${encoding}: restores frozen Config after a runtime change`, async () => {
      _resetSceneTransition();
      rig = makeAuthoringRig();
      rig.addNode('OperatorPanel', { extras: { WebOperatorPanel: {
        Config: encoding === 'string' ? JSON.stringify(config) : config, Dock: 'top-right',
      } } });
      let currentRoot = rig.root as import('three').Object3D;
      Object.defineProperty(rig.viewer, 'currentModelRoot', { get: () => currentRoot });
      Object.assign(rig.viewer, {
        async loadModel(url: string, options?: Parameters<typeof loadGLB>[2]) {
          const loaded = await loadGLB(url, new Scene(), {
            ...options, data: await (await fetch(url)).arrayBuffer(),
          });
          currentRoot = loaded.root;
          Object.assign(rig!.viewer, { registry: loaded.registry });
        },
        async whenSceneReady() {},
        camera: { position: new Vector3() },
        controls: { target: new Vector3(), update() {} },
        cancelCameraAnimation() {},
        markRenderDirty() {},
        runtime: { beginEditorTest() {}, endEditorTest() {} },
        getPlugin: undefined, // force recorder is outside this fixture
      });
      const errors: string[] = [];
      const session = new InPlaceTestSession({
        viewer: rig.viewer, getDocument: () => rig!.doc,
        onError: (message) => errors.push(message),
      });
      try {
        await session.start();
        expect(errors).toEqual([]);
        expect(session.state).toBe('running');
        rvOf(currentRoot.getObjectByName('OperatorPanel')).WebOperatorPanel.Config = '';
        await session.stop();
        expect(errors).toEqual([]);
        expect(session.state).toBe('idle');
        const bytes = await exportAssetGlb(currentRoot, 'AfterStop');
        const loaded = await loadGLB('after-stop.glb', new Scene(), { data: bytes, preserveHierarchy: true });
        const stored = rvOf(loaded.root.getObjectByName('OperatorPanel')).WebOperatorPanel.Config;
        expect(typeof stored === 'string' ? JSON.parse(stored) : stored).toEqual(config);
        expect(JSON.parse(loaded.registry.getAll<RVWebOperatorPanel>('WebOperatorPanel')[0].instance.Config)).toEqual(config);
      } finally {
        session.dispose();
      }
    });
  }
});
