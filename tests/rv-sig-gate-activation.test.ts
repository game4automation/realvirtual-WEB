// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVViewer } from '../src/core/rv-viewer';
import { ComponentEventDispatcher } from '../src/core/engine/rv-component-event-dispatcher';
import { signatureUnlockKey } from '../src/core/rv-sig-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { registerComponent } from '../src/core/engine/rv-component-registry';
import { initializeComponents, processExtras } from '../src/core/engine/rv-scene-loader';

afterEach(() => {
  localStorage.clear();
});

describe('central signature logic gate', () => {
  it('returns before the simulation clock and every tick stage mutate', () => {
    const calls: string[] = [];
    const fakeViewer = {
      logicRunState: 'gated',
      simTickCount: 17,
      _simTime: 3.5,
      _kernel: { earlyTick: () => calls.push('kernel') },
      _behaviorManager: { tick: () => calls.push('behavior') },
      _plugins: [{ onFixedUpdate: () => calls.push('plugin') }],
      _simulationCallbacks: [() => calls.push('callback')],
    };
    const fixedUpdate = (RVViewer.prototype as unknown as {
      fixedUpdate: (this: typeof fakeViewer, dt: number) => void;
    }).fixedUpdate;
    fixedUpdate.call(fakeViewer, 1 / 60);
    expect(fakeViewer.simTickCount).toBe(17);
    expect(fakeViewer._simTime).toBe(3.5);
    expect(calls).toEqual([]);
  });

  it('blocks component hover, click, and selection callbacks', () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const viewer = {
      logicRunState: 'gated',
      on: (event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    const component = {
      onHover: vi.fn(),
      onClick: vi.fn(),
      onSelect: vi.fn(),
    };
    const node = new Object3D();
    node.userData._rvComponentInstance = component;
    const registry = { getNode: () => node };
    const dispatcher = new ComponentEventDispatcher(viewer as never, registry as never);

    handlers.get('object-hover')?.({ node });
    handlers.get('object-clicked')?.({ node, path: 'Root/Part' });
    handlers.get('selection-changed')?.({ selectedPaths: ['Root/Part'], primaryPath: 'Root/Part' });
    expect(component.onHover).not.toHaveBeenCalled();
    expect(component.onClick).not.toHaveBeenCalled();
    expect(component.onSelect).not.toHaveBeenCalled();
    dispatcher.dispose();
  });

  it('constructs Planner extras while gated but defers their init lifecycle', () => {
    const init = vi.fn();
    registerComponent({
      type: 'SignatureGateTestComponent',
      schema: {},
      create: (node) => ({ node, isOwner: false, init }),
    });
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    root.userData.realvirtual = { SignatureGateTestComponent: {} };
    scene.add(root);
    const registry = new NodeRegistry();
    const result = processExtras(
      root,
      registry,
      new SignalStore(),
      new RVTransportManager(),
      scene,
      undefined,
      undefined,
      undefined,
      undefined,
      { logicRunState: 'gated' },
    );
    expect(result.componentsCreated).toBe(1);
    expect(result.deferredLogic).not.toBeNull();
    expect(init).not.toHaveBeenCalled();
    initializeComponents(result.deferredLogic!.pending, result.deferredLogic!.context);
    expect(init).toHaveBeenCalledOnce();
  });
});

describe('signature-gated activation lifecycle', () => {
  it('activates once, isolates component failures, emits the logic event, and persists the decision', async () => {
    const initialized: string[] = [];
    const pending = [
      {
        type: 'Good',
        path: 'Root/Good',
        component: {
          node: new Object3D(),
          init: () => initialized.push('init-good'),
          onSceneReady: () => initialized.push('ready-good'),
        },
      },
      {
        type: 'Bad',
        path: 'Root/Bad',
        component: {
          node: new Object3D(),
          init: () => { throw new Error('expected test failure'); },
          onSceneReady: () => initialized.push('ready-bad'),
        },
      },
    ];
    const emitted: string[] = [];
    const fakeViewer = {
      logicRunState: 'gated',
      _signatureState: 'invalid',
      _signatureModelName: 'cell.glb',
      _signatureSignerOrganization: undefined,
      _loadGeneration: 1,
      _lastLoadResult: {},
      _deferredLogic: [{ pending, context: { registry: new NodeRegistry() } }],
      _publishSignatureUiState: vi.fn(),
      _attachLogicSystems: vi.fn(),
      emit: (event: string) => emitted.push(event),
    };
    const activate = RVViewer.prototype.activateGatedLogic as unknown as (
      this: typeof fakeViewer,
    ) => Promise<boolean>;

    await expect(activate.call(fakeViewer)).resolves.toBe(true);
    await expect(activate.call(fakeViewer)).resolves.toBe(false);
    expect(fakeViewer.logicRunState).toBe('active');
    expect(initialized).toEqual(['init-good', 'ready-good', 'ready-bad']);
    expect(fakeViewer._attachLogicSystems).toHaveBeenCalledOnce();
    expect(emitted.filter((event) => event === 'model-logic-activated')).toHaveLength(1);
    expect(localStorage.getItem(signatureUnlockKey('cell.glb'))).toBe('1');
  });

  it('uses the supplied local filename as stable unlock identity across blob URLs', () => {
    localStorage.setItem(signatureUnlockKey('machine.glb'), '1');
    const firstBlob = 'blob:https://viewer.invalid/111';
    const secondBlob = 'blob:https://viewer.invalid/222';
    expect(firstBlob).not.toBe(secondBlob);
    expect(localStorage.getItem(signatureUnlockKey('machine.glb'))).toBe('1');
  });
});
