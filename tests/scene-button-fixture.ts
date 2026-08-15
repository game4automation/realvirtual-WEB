// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-button-fixture.ts — shared harness for the plan-417 scene-button tests.
 *
 * Builds the REAL demo hierarchy of `DemoRealvirtualWeb.glb` (verified by a
 * GLB JSON parse), so the tests exercise the same shapes the product loads:
 *
 *   PushButtonAutomatic  [PushButton3D]
 *     SimpleButton
 *       Base   (mesh)    [SceneButtonBase]      ← collider / click target
 *       Button (mesh)    [SceneButtonMoveable]  ← animated cap
 *
 *   EmergencyButton      [EmergencyButton3D]
 *     PushButton
 *       Base   (mesh)
 *       Button (mesh)    [SceneButtonMoveable + SceneButtonBase]  ← BOTH on one node
 *
 *   HandleSwitchOn       [HandleSwitch3D]
 *     Handle
 *       Cylinder (mesh)  [SceneButtonBase]
 *       Plane    (mesh)  [SceneButtonMoveable, angularMovement]
 *
 * Everything goes through `processExtras()` — the same construct → resolve →
 * init pipeline the loader runs — instead of hand-wiring instances.
 *
 * Frozen statics. TWO loader passes freeze the cap, and the ORDER relative to
 * component construction is the whole point — the fixture reproduces it exactly
 * (`frozenStatics`, default on), because a fixture that runs both passes up
 * front is green while production is broken:
 *
 *   1. `processMeshes()` — loader Phase 1, BEFORE construction →
 *      `matrixAutoUpdate = false` on every mesh that is not under a Drive, the
 *      cap meshes included. A thaw in `init()` survives this one.
 *   2. `freezeStaticMatrices()` — loader Phase 11, AFTER construction →
 *      `matrixWorldAutoUpdate = false` on every node the mover closure does not
 *      reach. This pass runs LAST, so it overwrites whatever `init()` thawed.
 *      The cap only stays dynamic because `SceneButtonMoveable` is part of
 *      `MOVER_KEY`. That mismatch was measured live: the cap had
 *      `matrixAutoUpdate = true` (early pass, thaw survived) but
 *      `matrixWorldAutoUpdate = false` (late pass won) — the lever never moved.
 *
 * The REAL `freezeStaticMatrices()` is imported and called, not re-implemented,
 * so the mover closure under test is the shipping one. It bakes all world
 * matrices before freezing, so every frozen node keeps its final transform.
 */

import {
  BoxGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import { processExtras, runOnSceneReady } from '../src/core/engine/rv-scene-loader';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SceneButtonManager } from '../src/core/engine/rv-scene-button-manager';
import type { ComponentContext, RVComponent } from '../src/core/engine/rv-component-registry';
import type { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import type { RVSceneButtonMoveable } from '../src/core/engine/rv-scene-button-moveable';

export interface ButtonHarness {
  scene: Scene;
  root: Object3D;
  registry: NodeRegistry;
  signalStore: SignalStore;
  transportManager: RVTransportManager;
  sceneButtonManager: SceneButtonManager;
  ctx: ComponentContext;
  /** Run the loader's Phase-8d late-init pass over the constructed components. */
  sceneReady(): void;
  base(path: string): RVSceneButtonBase;
  cap(path: string): RVSceneButtonMoveable;
  get<T>(type: string, path: string): T;
}

/** A component reference exactly as the Unity exporter writes it. */
export function ref(path: string, componentType: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType, componentIndex: 0 };
}

export function node(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const obj = new Object3D();
  obj.name = name;
  parent.add(obj);
  if (extras) obj.userData.realvirtual = extras;
  return obj;
}

export function mesh(
  parent: Object3D,
  name: string,
  extras?: Record<string, unknown>,
  material?: MeshStandardMaterial,
): Mesh {
  const m = new Mesh(
    new BoxGeometry(),
    material ?? new MeshStandardMaterial({ color: 0x808080 }),
  );
  m.name = name;
  parent.add(m);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

/** A `PLCInputBool` / `PLCOutputBool` signal node the loader will register. */
export function signal(parent: Object3D, name: string, type: string, value = false): Object3D {
  const obj = new Object3D();
  obj.name = name;
  parent.add(obj);
  obj.userData.realvirtual = { [type]: { Name: name, Status: { Value: value } } };
  return obj;
}

/** SceneButtonMoveable extras with the demo's push-button values. */
export function moveableExtras(options: {
  capPath: string;
  baseMaterial?: string;
  activeMaterial?: string;
  angular?: boolean;
  hoverOffset?: number;
  activeOffset?: number;
  moveSpeed?: number;
  mirrorHoverOffset?: boolean;
} = { capPath: '' }): Record<string, unknown> {
  const base = options.baseMaterial ?? 'LampRedOff';
  const active = options.activeMaterial ?? 'LampRedOn';
  return {
    SceneButtonMoveable: {
      _fullTypeName: 'realvirtual.SceneButtonMoveable',
      axis: { x: 0, y: 0, z: 1 },
      moveSpeed: options.moveSpeed ?? 30,
      hoverOffset: options.hoverOffset ?? 0.002,
      activeOffset: options.activeOffset ?? -0.007,
      mirrorHoverOffset: options.mirrorHoverOffset ?? false,
      angularMovement: options.angular ?? false,
      baseMaterial: { type: 'Material', name: base, assetPath: `x/${base}.mat` },
      activeMaterial: { type: 'Material', name: active, assetPath: `x/${active}.mat` },
      renderer: ref(options.capPath, 'UnityEngine.MeshRenderer'),
      currentOffset: 0,
    },
  };
}

/** SceneButtonBase extras pointing at its cap. */
export function baseExtras(capPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    SceneButtonBase: {
      _fullTypeName: 'realvirtual.SceneButtonBase',
      moveable: ref(capPath, 'realvirtual.SceneButtonMoveable'),
      autoLight: true,
      isToggle: false,
      simpleClickTime: 0.5,
      Name: '',
      Active: 'Always',
      ...overrides,
    },
  };
}

/**
 * Build the demo hierarchy and run it through the loader pipeline.
 *
 * @param options.pushButton     extras overrides for the PushButton3D wrapper
 * @param options.frozenStatics  run the loader's two freeze passes around the
 *                               component construction, in production order
 *                               (default true — that is what the product ships)
 */
export function buildButtonScene(options: {
  pushButton?: Record<string, unknown>;
  pushButtonBase?: Record<string, unknown>;
  withLightSignal?: boolean;
  frozenStatics?: boolean;
} = {}): ButtonHarness {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'DemoCell';
  scene.add(root);

  // ── Signals ────────────────────────────────────────────────────
  const plc = node(root, 'PLCInterface');
  signal(plc, 'AutomaticButton', 'PLCInputBool');
  signal(plc, 'AutomaticLight', 'PLCOutputBool');
  signal(plc, 'EmergencyButton', 'PLCInputBool');
  signal(plc, 'OnSwitch', 'PLCInputBool');

  const withLight = options.withLightSignal !== false;

  // ── PushButtonAutomatic (base + cap on separate nodes) ─────────
  const push = node(root, 'PushButtonAutomatic', {
    PushButton3D: {
      _fullTypeName: 'realvirtual.PushButton3D',
      stateSignal: ref('DemoCell/PLCInterface/AutomaticButton', 'realvirtual.PLCInputBool'),
      ...(withLight
        ? { lightSignal: ref('DemoCell/PLCInterface/AutomaticLight', 'realvirtual.PLCOutputBool') }
        : {}),
      label: 'Automatic',
      timer: 0.3,
      toggle: false,
      activeOnStart: false,
      Name: '',
      Active: 'Always',
      ...(options.pushButton ?? {}),
    },
  });
  const pushInner = node(push, 'SimpleButton');
  const capPath = 'DemoCell/PushButtonAutomatic/SimpleButton/Button';
  mesh(pushInner, 'Base', baseExtras(capPath, options.pushButtonBase ?? {}));
  mesh(pushInner, 'Button', moveableExtras({ capPath }));

  // ── EmergencyButton (base + cap on the SAME node) ──────────────
  const emergency = node(root, 'EmergencyButton', {
    EmergencyButton3D: {
      _fullTypeName: 'realvirtual.EmergencyButton3D',
      stateSignal: ref('DemoCell/PLCInterface/EmergencyButton', 'realvirtual.PLCInputBool'),
      activeOnStart: false,
      Name: '',
      Active: 'Always',
    },
  });
  const emergencyInner = node(emergency, 'PushButton');
  mesh(emergencyInner, 'Base');
  const emergencyCapPath = 'DemoCell/EmergencyButton/PushButton/Button';
  mesh(emergencyInner, 'Button', {
    ...moveableExtras({
      capPath: emergencyCapPath,
      baseMaterial: 'PlasticRed',
      activeMaterial: 'PlasticRed',
      activeOffset: -0.005,
    }),
    ...baseExtras(emergencyCapPath, { isToggle: true, autoLight: false }),
  });

  // ── HandleSwitchOn (rotating cap) ──────────────────────────────
  const handle = node(root, 'HandleSwitchOn', {
    HandleSwitch3D: {
      _fullTypeName: 'realvirtual.HandleSwitch3D',
      stateSignal: ref('DemoCell/PLCInterface/OnSwitch', 'realvirtual.PLCInputBool'),
      activeOnStart: true,
      Name: '',
      Active: 'Always',
    },
  });
  const handleInner = node(handle, 'Handle');
  const handleCapPath = 'DemoCell/HandleSwitchOn/Handle/Plane';
  mesh(handleInner, 'Cylinder', baseExtras(handleCapPath, { isToggle: true, autoLight: false }));
  mesh(handleInner, 'Plane', moveableExtras({
    capPath: handleCapPath,
    baseMaterial: 'PlasticRed',
    activeMaterial: 'PlasticRed',
    angular: true,
    hoverOffset: -5,
    activeOffset: 90,
    mirrorHoverOffset: true,
  }));

  const freeze = options.frozenStatics !== false;

  // ── Loader Phase 1: processMeshes() — BEFORE construction ──────
  // No mesh here sits under a Drive, so every one of them is classified static.
  if (freeze) {
    root.traverse((n) => {
      if ((n as Mesh).isMesh) n.matrixAutoUpdate = false;
    });
  }

  // ── Runtime systems + loader pipeline ──────────────────────────
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const sceneButtonManager = new SceneButtonManager();

  processExtras(
    root,
    registry,
    signalStore,
    transportManager,
    scene,
    undefined,          // gizmoManager
    undefined,          // events
    undefined,          // errorStore
    undefined,          // instructionStore
    undefined,          // options
    undefined,          // outlineManager
    undefined,          // lampManager
    undefined,          // energyChainManager
    sceneButtonManager,
  );

  // ── Loader Phase 11: freezeStaticMatrices() — AFTER construction ──
  // The real shipping pass, so the mover closure under test is the product's.
  // Running it here (and not before processExtras) is what makes the fixture
  // able to fail: it overwrites anything the components thawed in init().
  if (freeze) freezeStaticMatrices(root);

  const ctx: ComponentContext = {
    registry,
    signalStore,
    scene,
    transportManager,
    root,
    sceneButtonManager,
    expectSceneReady: true,
  };

  const harness: ButtonHarness = {
    scene,
    root,
    registry,
    signalStore,
    transportManager,
    sceneButtonManager,
    ctx,
    sceneReady() {
      // processExtras() already ran the Phase-8d late pass. Re-running it is the
      // idempotency check the "reload" tests want, so this is a real second pass
      // over every constructed component rather than a no-op.
      const pending = [] as { component: RVComponent; type: string; path: string }[];
      root.traverse((n) => {
        for (const inst of (n.userData._rvComponentInstances ?? []) as RVComponent[]) {
          pending.push({ component: inst, type: '', path: '' });
        }
      });
      runOnSceneReady(pending, ctx);
    },
    base(path: string) {
      const inst = registry.getByPath<RVSceneButtonBase>('SceneButtonBase', path);
      if (!inst) throw new Error(`no SceneButtonBase at "${path}"`);
      return inst;
    },
    cap(path: string) {
      const inst = registry.getByPath<RVSceneButtonMoveable>('SceneButtonMoveable', path);
      if (!inst) throw new Error(`no SceneButtonMoveable at "${path}"`);
      return inst;
    },
    get<T>(type: string, path: string) {
      const inst = registry.getByPath<T>(type, path);
      if (!inst) throw new Error(`no ${type} at "${path}"`);
      return inst;
    },
  };
  return harness;
}

/** Canonical demo paths, so the tests read like the hierarchy. */
export const PATHS = {
  pushWrapper: 'DemoCell/PushButtonAutomatic',
  pushBase: 'DemoCell/PushButtonAutomatic/SimpleButton/Base',
  pushCap: 'DemoCell/PushButtonAutomatic/SimpleButton/Button',
  emergencyWrapper: 'DemoCell/EmergencyButton',
  emergencyNode: 'DemoCell/EmergencyButton/PushButton/Button',
  handleWrapper: 'DemoCell/HandleSwitchOn',
  handleBase: 'DemoCell/HandleSwitchOn/Handle/Cylinder',
  handleCap: 'DemoCell/HandleSwitchOn/Handle/Plane',
  automaticButtonSignal: 'DemoCell/PLCInterface/AutomaticButton',
  automaticLightSignal: 'DemoCell/PLCInterface/AutomaticLight',
  emergencySignal: 'DemoCell/PLCInterface/EmergencyButton',
  onSwitchSignal: 'DemoCell/PLCInterface/OnSwitch',
} as const;
