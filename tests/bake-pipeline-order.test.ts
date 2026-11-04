// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.5 — the ONE pipeline and its `onPreBake` hooks (D18).
 *
 *  - `prepare` runs on the raw tree: hooks re-parent and stamp plain data, in
 *    the declared order, before anything is constructed;
 *  - the kinematic hook does the work loader Phase 8b used to do — group
 *    members end up under the axis, and the authored path stays resolvable;
 *  - a component type WITHOUT a hook survives the pipeline unchanged;
 *  - a `Drive` node re-parented by the hook still initialises against its
 *    AUTHORED home pose;
 *  - LINT (R2b): no hook module imports a runtime-instance API.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import {
  buildPreBakeRegistry, createPreBakeContext, localSourceBounds, runPreBakeHooks,
  PRE_BAKE_TYPE_ORDER,
} from '../src/core/engine/rv-pre-bake';
import { registerBuiltInPreBakeHooks } from '../src/core/engine/rv-pre-bake-hooks';
import { RV_DRIVE_HOME_KEY, RV_SENSOR_BEAM_KEY } from '../src/core/engine/rv-pre-bake-keys';
import { preBakeHookOf, registerPreBakeHook } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { printParitySummary, resetParityValidator } from '../src/core/engine/rv-extras-validator';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import { buildInitContext } from '../src/core/engine/rv-init-context';
import '../src/core/engine/rv-scene-loader';   // side effect: registers the built-in hooks

const material = new MeshStandardMaterial({ color: 0x224466 });

function mesh(name: string, pos: [number, number, number], extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material);
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function node(name: string, extras?: Record<string, unknown>): Group {
  const g = new Group();
  g.name = name;
  if (extras) g.userData.realvirtual = extras;
  return g;
}

/** A detached root under a parentless holder — the loader's staging shape. */
function staged(root: Object3D): Object3D {
  const staging = new Object3D();
  staging.name = '_rvLoadStaging';
  staging.add(root);
  return root;
}

beforeEach(() => { registerBuiltInPreBakeHooks(); });

describe('onPreBake hooks (plan-754 D18 / §9.5)', () => {
  it('the built-in hooks are registered and ordered structurally', () => {
    for (const type of ['Drive', 'Kinematic', 'Sensor', 'MachiningVolume', 'RibbonPath']) {
      expect(preBakeHookOf(type), type).toBeTruthy();
    }
    // The drive HOME pose (old Phase 8a) must precede the kinematic re-parent
    // (old Phase 8b) — the re-parent rewrites the local TRS it captures.
    expect(PRE_BAKE_TYPE_ORDER.indexOf('Drive')).toBeLessThan(PRE_BAKE_TYPE_ORDER.indexOf('Kinematic'));
  });

  it('the Kinematic hook re-parents group members under the axis and reports the move', () => {
    const root = staged(node('Plant'));
    const axis = node('Axis', {
      Drive: { Direction: 'LinearY' },
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'Carriage' },
    });
    root.add(axis);
    const member = mesh('Plate', [3, 0, 0], { Group: { GroupName: 'Carriage' } });
    root.add(member);

    const session = createPreBakeContext(root);
    const result = runPreBakeHooks(root, session);

    expect(member.parent).toBe(axis);
    expect(result.reparented.map((r) => r.previousPath)).toContain('Plant/Plate');
    expect(result.reparented[0].node).toBe(member);
    // `attach` preserves the world transform.
    member.updateWorldMatrix(true, false);
    expect(member.getWorldPosition(member.position.clone()).x).toBeCloseTo(3, 5);
  });

  it('the Kinematic hook runs ONCE per tree, whichever axis it is called for first', () => {
    const root = staged(node('Plant'));
    const a = node('A', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' } });
    const b = node('B', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' } });
    root.add(a); root.add(b);
    const member = node('M', { Group: { GroupName: 'G' } });
    root.add(member);
    const result = runPreBakeHooks(root);
    // Unity parity, unchanged from `applyKinematicParenting`: both axes claim
    // the group and the LAST one wins. What the once-per-tree guard buys is
    // that the pass runs once in total — not once per `Kinematic` node — so
    // the member is moved twice, not four times.
    expect(member.parent).toBe(b);
    expect(result.reparented.length).toBe(2);
    expect(result.reparented.map((r) => r.node)).toEqual([member, member]);
    void a;
  });

  it('KinematicParentEnable re-parents the axis itself; a cycle is refused', () => {
    const root = staged(node('Plant'));
    const base = node('Base');
    const arm = node('Arm', { Kinematic: { KinematicParentEnable: true, Parent: { path: 'Plant/Base' } } });
    root.add(base); root.add(arm);
    runPreBakeHooks(root);
    expect(arm.parent).toBe(base);

    // Cycle: Base would move under its own descendant — refused, tree unchanged.
    const root2 = staged(node('P2'));
    const outer = node('Outer', { Kinematic: { KinematicParentEnable: true, Parent: { path: 'P2/Outer/Inner' } } });
    const inner = node('Inner');
    outer.add(inner);
    root2.add(outer);
    runPreBakeHooks(root2);
    expect(outer.parent).toBe(root2);
  });

  it('the Drive hook stamps the AUTHORED home pose as plain JSON data', () => {
    const root = staged(node('Plant'));
    const axis = node('Axis', { Drive: { Direction: 'LinearY' } });
    axis.position.set(1, 2, 3);
    root.add(axis);
    runPreBakeHooks(root);
    const home = axis.userData[RV_DRIVE_HOME_KEY];
    expect(home).toEqual({ p: [1, 2, 3], q: [0, 0, 0, 1], s: [1, 1, 1] });
    // Plain data: it must survive a JSON round trip, because the template
    // carries `userData` and `Object3D.clone` JSON-round-trips it.
    expect(JSON.parse(JSON.stringify(home))).toEqual(home);
  });

  it('the Sensor hook derives the beam while the source meshes are still there', () => {
    const root = staged(node('Plant'));
    const sensor = node('S1', { Sensor: {} });
    const body = mesh('Body', [0, 0, 0]);
    body.scale.set(4, 1, 1);
    sensor.add(body);
    root.add(sensor);
    runPreBakeHooks(root);
    const beam = sensor.userData[RV_SENSOR_BEAM_KEY];
    expect(beam).toBeTruthy();
    expect(beam.lengthMm).toBeGreaterThan(0);
    expect(beam.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(JSON.parse(JSON.stringify(beam))).toEqual(beam);
  });

  it('a component type WITHOUT a hook survives prepare unchanged', () => {
    const root = staged(node('Plant'));
    const lamp = mesh('Beacon', [0, 0, 0], { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } });
    root.add(lamp);
    const before = JSON.stringify(lamp.userData);
    const result = runPreBakeHooks(root);
    expect(preBakeHookOf('Lamp')).toBeNull();
    expect(JSON.stringify(lamp.userData)).toBe(before);
    expect(result.types).not.toContain('Lamp');
  });

  it('a throwing hook is logged and skipped, never fails the load', () => {
    registerPreBakeHook('Lamp', () => { throw new Error('boom'); });
    const root = staged(node('Plant'));
    root.add(mesh('Beacon', [0, 0, 0], { Lamp: {} }));
    expect(() => runPreBakeHooks(root)).not.toThrow();
    registerBuiltInPreBakeHooks();
  });

  it('the context exposes only resolvePath / resolveStored / localBounds / keepMaterial / notifyReparented', () => {
    const root = staged(node('Plant'));
    const part = mesh('Part', [2, 0, 0]);
    root.add(part);
    const { ctx } = createPreBakeContext(root);
    // plan-769 Phase 1b: `resolveStored` reads a STORED path field by the file's verdict.
    expect(Object.keys(ctx).sort()).toEqual(
      ['keepMaterial', 'localBounds', 'notifyReparented', 'resolvePath', 'resolveStored', 'root'],
    );
    // Without an identity record (a hand-built tree) it is the plain resolver.
    expect(ctx.resolveStored!('Plant/Part')).toBe(part);
    expect(ctx.resolvePath('Plant/Part')).toBe(part);
    expect(ctx.resolvePath('Plant/Nope')).toBeNull();
    expect(ctx.localBounds(part)!.isEmpty()).toBe(false);
    expect(ctx.localBounds(node('Empty'))).toBeNull();
  });

  it('the prepare registry answers the SAME paths the runtime registry will', () => {
    const root = staged(node('Plant'));
    const child = node('Child');
    root.add(child);
    const registry = buildPreBakeRegistry(root);
    expect(registry.getNode(NodeRegistry.computeNodePath(child))).toBe(child);
    expect(NodeRegistry.computeNodePath(child)).toBe('Plant/Child');
  });

  it('localSourceBounds is expressed in the NODE frame, not the world frame', () => {
    const root = staged(node('Plant'));
    const holder = node('Holder');
    holder.position.set(10, 0, 0);
    const part = mesh('Part', [0, 0, 0]);
    holder.add(part);
    root.add(holder);
    const box = localSourceBounds(holder)!;
    expect(box.getCenter(part.position.clone()).x).toBeCloseTo(0, 5);
  });
});

/**
 * plan-757 Phase 3 commit B — the cases the deleted runtime re-parent passes of
 * `applyKinematicParenting` used to pin (rv-kinematic-parenting.test.ts #1, #4,
 * #5, #6, #7, #8, #10), moved onto the ONE re-parent mechanism left: the
 * `Kinematic` pre-bake hook.
 */
describe('the Kinematic hook — the re-parent cases the init used to own', () => {
  it('re-parents the group member under the kinematic node, world position preserved', () => {
    const root = staged(node('Root'));
    const kin = node('Kinematic1', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'MyGroup' } });
    kin.position.set(100, 0, 0);
    const member = node('Part1', { Group: { GroupName: 'MyGroup' } });
    member.position.set(50, 0, 0);
    root.add(kin, member);
    root.updateMatrixWorld(true);
    const before = member.getWorldPosition(member.position.clone());
    runPreBakeHooks(root);
    expect(member.parent).toBe(kin);
    member.updateWorldMatrix(true, false);
    expect(member.getWorldPosition(member.position.clone()).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('falls back to GroupName when GroupNamePrefix does not resolve', () => {
    const root = staged(node('Root'));
    const kin = node('Kin', {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'Arm', GroupNamePrefix: { path: 'NonExistent/Path' } },
    });
    const member = node('Arm', { Group: { GroupName: 'Arm' } });
    root.add(kin, member);
    runPreBakeHooks(root);
    expect(member.parent).toBe(kin);
  });

  it('resolves GroupNamePrefix to prefixNode.name + GroupName on BOTH sides (member and axis)', () => {
    const root = staged(node('Root'));
    const prefix = node('Robot1');
    const kin = node('Kin', {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'Arm', GroupNamePrefix: { path: 'Root/Robot1' } },
    });
    // The member spells the same prefixed name — Unity resolves both through the prefix node.
    const member = node('PartA', { Group: { GroupName: 'Arm', GroupNamePrefix: { path: 'Root/Robot1' } } });
    const unrelated = node('PartB', { Group: { GroupName: 'Arm' } });
    root.add(prefix, kin, member, unrelated);
    runPreBakeHooks(root);
    expect(member.parent).toBe(kin);
    expect(unrelated.parent).toBe(root);
  });

  it('SimplifyHierarchy moves mesh members only', () => {
    const root = staged(node('Root'));
    const kin = node('Kin', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'Parts', SimplifyHierarchy: true } });
    const meshMember = mesh('MeshPart', [1, 0, 0], { Group: { GroupName: 'Parts' } });
    const emptyMember = node('EmptyPart', { Group: { GroupName: 'Parts' } });
    root.add(kin, meshMember, emptyMember);
    runPreBakeHooks(root);
    expect(meshMember.parent).toBe(kin);
    expect(emptyMember.parent).toBe(root);
  });

  it('sets matrixAutoUpdate = true on the moved subtree', () => {
    const root = staged(node('Root'));
    const kin = node('Kin', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' } });
    const member = node('Group', { Group: { GroupName: 'G' } });
    const child = mesh('ChildMesh', [0, 0, 0]);
    child.matrixAutoUpdate = false;
    member.matrixAutoUpdate = false;
    member.add(child);
    root.add(kin, member);
    runPreBakeHooks(root);
    expect(member.parent).toBe(kin);
    expect(child.matrixAutoUpdate).toBe(true);
    expect(member.matrixAutoUpdate).toBe(true);
  });

  it('KinematicParentEnable re-parents the axis under its parent, world position preserved', () => {
    const root = staged(node('Root'));
    const target = node('Target');
    target.position.set(200, 0, 0);
    const kin = node('Kin', { Kinematic: { KinematicParentEnable: true, Parent: { path: 'Root/Target' } } });
    kin.position.set(50, 0, 0);
    root.add(target, kin);
    root.updateMatrixWorld(true);
    const before = kin.getWorldPosition(kin.position.clone());
    runPreBakeHooks(root);
    expect(kin.parent).toBe(target);
    kin.updateWorldMatrix(true, false);
    expect(kin.getWorldPosition(kin.position.clone()).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('processes IntegrateGroup before KinematicParent: member under the axis, axis under its parent', () => {
    const root = staged(node('Root'));
    const kin = node('Kin', {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'G', KinematicParentEnable: true, Parent: { path: 'Root/Parent' } },
    });
    const parent = node('Parent');
    const member = node('Part', { Group: { GroupName: 'G' } });
    root.add(kin, parent, member);
    runPreBakeHooks(root);
    expect(member.parent).toBe(kin);
    expect(kin.parent).toBe(parent);
  });

  it('only TOP-LEVEL group members move; a member below another member travels with it', () => {
    const root = staged(node('Root'));
    const kin = node('Kin', { Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' } });
    const outer = node('Outer', { Group: { GroupName: 'G' } });
    const inner = node('Inner', { Group: { GroupName: 'G' } });
    outer.add(inner);
    root.add(kin, outer);
    runPreBakeHooks(root);
    expect(outer.parent).toBe(kin);
    expect(inner.parent).toBe(outer);
  });
});

describe('ONE init for every entry (plan-754 F13 / D19)', () => {
  /**
   * `processExtras` used to be a SECOND, leaner traversal that validated
   * nothing. These three pin the collapse: the same validation, the same
   * construction, and — structurally — a single traversal with `processExtras`
   * as a wrapper of `initSubtree`.
   */
  function runtime(): ReturnType<typeof buildInitContext> {
    return buildInitContext({
      registry: new NodeRegistry(), signalStore: new SignalStore(), transportManager: new RVTransportManager(), scene: new Scene(),
    });
  }

  it('a placed subtree is validated exactly like the main model', () => {
    resetParityValidator();
    const root = staged(node('Placed'));
    root.add(node('Axis', { Drive: { Direction: 'LinearY', NotAFieldAtAll: 7 } }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      processExtras(root, runtime());
      printParitySummary();
      const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(said).toContain('Drive.NotAFieldAtAll');
    } finally {
      warn.mockRestore();
      resetParityValidator();
    }
  });

  it('a placed subtree gets the main traversal in full, not a subset', () => {
    const root = staged(node('Placed'));
    const mu = node('Box', { MU: {} });
    const link = node('Cell', { AASLink: { AASId: 'urn:x', Description: 'd' } });
    const hidden = node('Secret', { Hidden: true });
    root.add(mu); root.add(link); root.add(hidden);

    processExtras(root, runtime());

    // All three were main-load-only before the collapse.
    expect(mu.visible).toBe(false);                       // MU template hidden
    expect(link.userData._rvAasLink).toEqual({ aasId: 'urn:x', description: 'd', serverUrl: '' });
    expect(hidden.visible).toBe(false);                   // authored rv.Hidden honoured
  });

  it('the loader has ONE traversal, and processExtras is a wrapper of it', async () => {
    // `?raw&import` answers a JS module (`export default "…"`) whose newlines
    // are escaped — decode it so a multi-line pattern can match real source.
    const module = await (await fetch('/src/core/engine/rv-scene-loader.ts?raw&import')).text();
    const literal = /export default\s*("(?:[^"\\]|\\[\s\S])*")/.exec(module);
    expect(literal, 'raw module did not answer a string literal').toBeTruthy();
    const source = JSON.parse(literal![1]) as string;
    // The definition plus the ONE call, inside `initSubtree`. A third
    // occurrence means a second construction path grew back.
    expect([...source.matchAll(/\btraverseAndRegister\(/g)].length).toBe(2);
    // The definition plus its two call sites: `loadGLB` and `processExtras`.
    expect([...source.matchAll(/\binitSubtree\(/g)].length).toBe(3);
    // …and the wrapper delegates immediately, with no traversal of its own.
    expect(source).toMatch(
      // plan-652: one synchronous safety-net note (no construction) may precede it.
      /export function processExtras\([\s\S]{0,1200}?\): ProcessExtrasResult \{\s*(?:\/\/[^\n]*\n\s*)*(?:noteDeferredComponentTypes\([^)]*\);\s*)?const result = initSubtree\(/,
    );
  });
});

describe('onPreBake hook lint (plan-754 R2b)', () => {
  /**
   * A hook may touch extras and the tree and nothing else. The cheap, durable
   * check is its module's import list: a runtime-instance API cannot be used
   * without importing it, and the hook module is deliberately the ONLY place
   * built-in hooks live.
   */
  it('rv-pre-bake-hooks.ts imports no runtime-instance API', async () => {
    const source = await (await fetch('/src/core/engine/rv-pre-bake-hooks.ts?raw&import')).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    const forbidden = [
      'rv-signal-store', 'rv-transport-manager', 'rv-viewer', 'rv-simulation',
      'rv-drive', 'rv-mu', 'rv-logic-engine', 'rv-node-knowledge', 'rv-bake-registry',
    ];
    for (const imp of imports) {
      for (const f of forbidden) {
        expect(imp.includes(f), `hook module must not import ${imp}`).toBe(false);
      }
    }
    // It must also not reach into the viewer or a live component instance.
    expect(/getComponentsAt|signalStore|viewer\./.test(source)).toBe(false);
  });
});
