// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 1b — ONE resolver for component reference paths (F7 / D12).
 *
 * A reference is written ASSET-RELATIVE and read tolerantly, in exactly this
 * order (§2.3): (1) the path as written inside the asset scope; (2) if the
 * first segment is the asset root's authored or current name, strip it;
 * (3) unresolved — never guessed. `prepare` (the pre-bake registry) and the
 * runtime (`NodeRegistry.resolve`) read through the same function.
 *
 * Covered:
 *  - the three steps on a bare registry, both path forms, Unity's sanitized
 *    spelling of the root name, an unknown prefix is NOT stripped;
 *  - a child named like the root (fixture (i)): step order makes
 *    `Conveyor/Conveyor/Belt` unambiguous;
 *  - two placements of one asset with the same authored paths: a root-prefixed
 *    reference binds inside ITS instance, the unscoped lookup refuses to guess;
 *  - prepare == runtime: the same four spellings resolve to the same
 *    asset-relative targets before the bake and on the placed instance;
 *  - `assetRelativePath` — what the editor writes;
 *  - live (1a residual 3): two placements of fixture (a), whose LogicSteps
 *    reference `Arburg/Kine` (root-inclusive), each move their OWN axis.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Group, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import {
  assetRelativePath, resolveReferencePath, scopeOf,
} from '../src/core/engine/rv-reference-resolver';
import { buildPreBakeRegistry, prepareScopeOf } from '../src/core/engine/rv-pre-bake';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { detectRenamedNodes, gltfLoader, type GltfParserLike } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { inlinePickPort } from './fixtures/bake-fixture';
import { parityFixture } from './fixtures/parity-fixtures';
import {
  createParityHost, fixtureBytes, loadAsPlacements, snapshotAfter, type ParityHost,
} from './helpers/parity-harness';

// ─── Fixtures ───────────────────────────────────────────────────────────

function node(name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  return n;
}

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });

/**
 * A runtime registry with two placements of one asset — the same authored
 * paths twice — and one sub-axis in the second:
 *
 *   Layout
 *    ├─ Arburg_1 ─ Kine {Drive}
 *    └─ Arburg_2 ─ Kine {Drive}
 *                └─ Sub ─ Kine {Drive}
 */
function twoPlacements(): { reg: NodeRegistry; a1: Object3D; a2: Object3D; drives: Record<string, object> } {
  const reg = new NodeRegistry();
  const layout = node('Layout');
  const a1 = node('Arburg_1');
  const k1 = node('Kine');
  a1.add(k1);
  const a2 = node('Arburg_2');
  const k2 = node('Kine');
  const sub = node('Sub');
  const k2s = node('Kine');
  sub.add(k2s);
  a2.add(k2);
  a2.add(sub);
  layout.add(a1);
  layout.add(a2);
  const scene = new Group();
  scene.add(layout);
  const drives: Record<string, object> = {};
  layout.traverse((n) => {
    const p = NodeRegistry.computeNodePath(n);
    reg.registerNode(p, n);
    if (n.name === 'Kine') {
      drives[p] = { id: p };
      reg.register('Drive', p, drives[p]);
    }
  });
  // What `initSubtree` does for every placement: the reference node is named by
  // the planner, the asset's own root name is what a Unity export starts with.
  reg.registerScopeNames(a1, ['Arburg']);
  reg.registerScopeNames(a2, ['Arburg']);
  return { reg, a1, a2, drives };
}

// ─── The three steps ────────────────────────────────────────────────────

describe('the three-step tolerant read (plan-757 §2.3)', () => {
  it('step 1: the path as written, inside the asset scope', () => {
    const { reg, a1, a2 } = twoPlacements();
    expect(resolveReferencePath(reg, 'Kine', reg.scopeFor(a1)).node).toBe(a1.getObjectByName('Kine'));
    const r = resolveReferencePath(reg, 'Sub/Kine', reg.scopeFor(a2));
    expect(r.step).toBe('as-written');
    expect(r.node).toBe(a2.getObjectByName('Sub')!.children[0]);
  });

  it('step 2: a root-prefixed (Unity) path strips the authored root name, in either spelling', () => {
    const { reg, a1, a2 } = twoPlacements();
    const r1 = resolveReferencePath(reg, 'Arburg/Kine', reg.scopeFor(a1));
    expect(r1.step).toBe('root-stripped');
    expect(r1.node).toBe(a1.children[0]);
    // The CURRENT name of the reference node counts too.
    expect(resolveReferencePath(reg, 'Arburg_2/Sub/Kine', reg.scopeFor(a2)).node).toBe(a2.getObjectByName('Sub')!.children[0]);
    // Three.js' sanitized spelling of a root name with spaces.
    const reg2 = new NodeRegistry();
    const root = node('Press_720_A');
    const ram = node('Ram');
    root.add(ram);
    new Group().add(root);
    reg2.registerNode('Press_720_A', root);
    reg2.registerNode('Press_720_A/Ram', ram);
    reg2.registerScopeNames(root, ['Press 720 A']);
    expect(resolveReferencePath(reg2, 'Press 720 A/Ram', reg2.scopeFor(root)).node).toBe(ram);
    // The root itself.
    expect(resolveReferencePath(reg, 'Arburg', reg.scopeFor(a1)).node).toBe(a1);
  });

  it('step 3: an unknown first segment is NOT stripped — unresolved, not guessed', () => {
    const { reg, a1 } = twoPlacements();
    const r = resolveReferencePath(reg, 'Somewhere/Kine', reg.scopeFor(a1));
    expect(r.node).toBeNull();
    expect(r.step).toBe('unresolved');
    expect(resolveReferencePath(reg, '', reg.scopeFor(a1)).node).toBeNull();
  });

  it('a scoped hit never leaves the scope; the second placement resolves its own axis', () => {
    const { reg, a1, a2, drives } = twoPlacements();
    const d1 = reg.resolve(driveRef('Arburg/Kine'), a1).drive;
    const d2 = reg.resolve(driveRef('Arburg/Kine'), a2).drive;
    expect(d1).toBe(drives['Layout/Arburg_1/Kine']);
    expect(d2).toBe(drives['Layout/Arburg_2/Kine']);
    expect(d1).not.toBe(d2);
    // The nested axis of the second placement by its asset-relative path.
    expect(reg.resolve(driveRef('Sub/Kine'), a2).drive).toBe(drives['Layout/Arburg_2/Sub/Kine']);
    // A node BELOW the scope root resolves relative to the enclosing scope, not to itself.
    expect(reg.resolve(driveRef('Arburg/Kine'), a2.getObjectByName('Sub')!).drive).toBe(drives['Layout/Arburg_2/Kine']);
  });

  it('without a scope the same bare leaf is ambiguous and refused (F10), never the first hit', () => {
    const { reg } = twoPlacements();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(reg.resolve(driveRef('Kine')).drive).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Ambiguous'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a child named like the root (fixture (i)) — step ORDER makes it unambiguous', () => {
  /**
   *   Conveyor            (root; registry path `Conveyor`)
   *    ├─ Belt
   *    └─ Conveyor_1      (authored `Conveyor`, deduped by the loader → alias `Conveyor/Conveyor`)
   *        └─ Belt
   */
  function conveyor(): { reg: NodeRegistry; root: Object3D; rootBelt: Object3D; childBelt: Object3D } {
    const reg = new NodeRegistry();
    const root = node('Conveyor');
    const rootBelt = node('Belt');
    const child = node('Conveyor_1');
    const childBelt = node('Belt');
    child.add(childBelt);
    root.add(rootBelt);
    root.add(child);
    new Group().add(root);
    root.traverse((n) => reg.registerNode(NodeRegistry.computeNodePath(n), n));
    // The renamed-node aliases `registerNodeAliases` publishes for the deduped child.
    reg.registerAlias('Conveyor/Conveyor', child);
    reg.registerAlias('Conveyor/Conveyor/Belt', childBelt);
    reg.registerScopeNames(root, []);
    return { reg, root, rootBelt, childBelt };
  }

  it('`Conveyor/Belt` written asset-relative means the CHILD\'s belt (step 1 via the alias), not the root\'s (step 2)', () => {
    const { reg, root, childBelt } = conveyor();
    const r = resolveReferencePath(reg, 'Conveyor/Belt', reg.scopeFor(root));
    expect(r.step).toBe('as-written');
    expect(r.node).toBe(childBelt);
  });

  it('`Belt` alone is the root\'s belt; `Conveyor/Conveyor/Belt` (Unity form) is the child\'s', () => {
    const { reg, root, rootBelt, childBelt } = conveyor();
    expect(resolveReferencePath(reg, 'Belt', reg.scopeFor(root)).node).toBe(rootBelt);
    const r = resolveReferencePath(reg, 'Conveyor/Conveyor/Belt', reg.scopeFor(root));
    expect(r.node).toBe(childBelt);
  });

  it('without the child, the same `Conveyor/Belt` is the root-prefixed form of the root\'s belt', () => {
    const reg = new NodeRegistry();
    const root = node('Conveyor');
    const belt = node('Belt');
    root.add(belt);
    new Group().add(root);
    reg.registerNode('Conveyor', root);
    reg.registerNode('Conveyor/Belt', belt);
    const r = resolveReferencePath(reg, 'Conveyor/Belt', reg.scopeFor(root));
    expect(r.step).toBe('root-stripped');
    expect(r.node).toBe(belt);
  });
});

describe('assetRelativePath — what the editor writes (D12)', () => {
  it('strips the scope root, keeps a foreign path, names the root as ""', () => {
    const root = node('Arburg_1');
    const scope = scopeOf(root, 'Layout/Arburg_1', ['Arburg']);
    expect(assetRelativePath('Layout/Arburg_1/Mount/Kine', scope)).toBe('Mount/Kine');
    expect(assetRelativePath('Layout/Arburg_1', scope)).toBe('');
    expect(assetRelativePath('Layout/Signals/Start', scope)).toBe('Layout/Signals/Start');
    // A root at the origin: everything is already relative.
    expect(assetRelativePath('Mount/Kine', scopeOf(root, ''))).toBe('Mount/Kine');
  });
});

// ─── prepare == runtime ─────────────────────────────────────────────────

/**
 *   Machine
 *   ├─ Mount                      bare reference target
 *   ├─ Cad ─ Kine {Kinematic → Parent 'Machine/Mount' (Unity form), Drive}   re-parented under Mount
 *   └─ Axis {Drive}
 */
function buildMachine(): Group {
  const root = new Group();
  root.name = 'Machine';
  root.add(node('Mount'));
  const cad = node('Cad');
  cad.add(node('Kine', {
    Kinematic: { KinematicParentEnable: true, Parent: 'Machine/Mount' },
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
  }));
  root.add(cad);
  root.add(node('Axis', { Drive: { Direction: 'LinearY', TargetSpeed: 100 } }));
  return root;
}

/** Path of `n` relative to `root` ('' for the root). */
function relPath(n: Object3D, root: Object3D): string {
  const parts: string[] = [];
  for (let cur: Object3D | null = n; cur && cur !== root; cur = cur.parent) parts.unshift(cur.name);
  return parts.join('/');
}

const SPELLINGS = ['Mount', 'Machine/Mount', 'Axis', 'Machine/Axis', 'Cad/Kine', 'Machine/Cad/Kine', 'Mount/Kine'];

describe('prepare == runtime — the same spellings resolve to the same targets (R3)', () => {
  it('pre-bake registry over a PARENTLESS tree and over a STAGED tree, then the placed instance', async () => {
    // (a) prepare, parentless (the model cache's decode): root path ''.
    const parentless = buildMachine();
    const prepA = buildPreBakeRegistry(parentless);
    const scopeA = prepareScopeOf(parentless);
    // (b) prepare, staged (the loader): root path 'Machine'.
    const staged = buildMachine();
    const staging = new Object3D();
    staging.add(staged);
    const prepB = buildPreBakeRegistry(staged);
    const scopeB = prepareScopeOf(staged);
    const before = (reg: NodeRegistry, scope: ReturnType<typeof prepareScopeOf>, root: Object3D): Record<string, string | null> => {
      const out: Record<string, string | null> = {};
      for (const p of SPELLINGS) {
        const n = resolveReferencePath(reg, p, scope).node;
        out[p] = n ? relPath(n, root) : null;
      }
      return out;
    };
    const a = before(prepA, scopeA, parentless);
    const b = before(prepB, scopeB, staged);
    expect(a).toEqual(b);
    // Before the hooks, `Kine` still sits under `Cad`.
    expect(a['Cad/Kine']).toBe('Cad/Kine');
    expect(a['Machine/Cad/Kine']).toBe('Cad/Kine');
    expect(a['Mount/Kine']).toBeNull();
    expect(a['Machine/Mount']).toBe('Mount');

    // (c) runtime: bake + place, then a runtime registry over the instance, as
    // `initSubtree` builds it (paths, the asset's alias table, the scope).
    const gltf = await gltfLoader.parseAsync(await objectToGlb(sceneMirroringLoad(buildMachine())), '');
    const renamedNodes = detectRenamedNodes((gltf as unknown as { parser?: GltfParserLike }).parser);
    const baked = await prepareAndBake(gltf.scene, {
      assetId: 'prep-eq-runtime', renamedNodes, signatureState: 'none',
      uber: new RVUberMaterial(false), isWebGPU: false, pickPort: inlinePickPort(),
    });
    const bakeReg = new BakeRegistry();
    const layout = new Group();
    layout.name = 'Layout';
    new Group().add(layout);
    const placed = new Group();
    placed.name = 'Machine_1';
    layout.add(placed);
    const inst = bakeReg.instantiate(baked, placed);
    const runtime = new NodeRegistry();
    placed.traverse((n) => {
      if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) return;
      runtime.registerNode(NodeRegistry.computeNodePath(n), n);
    });
    for (const { path, node: target } of inst.aliases) runtime.registerAlias(`Layout/Machine_1/${path}`, target);
    runtime.registerScopeNames(placed, [baked.template.name]);
    const scope = runtime.scopeFor(placed);
    expect(scope.rootPath).toBe('Layout/Machine_1');
    const after: Record<string, string | null> = {};
    for (const p of SPELLINGS) {
      const n = resolveReferencePath(runtime, p, scope).node;
      after[p] = n ? relPath(n, placed) : null;
    }
    // The hook moved Kine under Mount: its AUTHORED spellings resolve through
    // the asset's alias table, its FINAL spelling directly — on both forms.
    expect(after['Cad/Kine']).toBe('Mount/Kine');
    expect(after['Machine/Cad/Kine']).toBe('Mount/Kine');
    expect(after['Mount/Kine']).toBe('Mount/Kine');
    // Everything the hooks did not move resolves to the same target as before the bake.
    for (const p of ['Mount', 'Machine/Mount', 'Axis', 'Machine/Axis']) expect(after[p], p).toBe(a[p]);
    bakeReg.release(inst);
    baked.dispose();
  });
});

// ─── Live: two placements, root-prefixed references (1a residual 3) ─────

describe('two placements of fixture (a) — `Arburg/Kine` binds inside each instance', () => {
  let host: ParityHost | null = null;
  afterEach(() => { host?.dispose(); host = null; });

  it('both LogicStep cycles drive their OWN Kine; the reference resolves per instance', async () => {
    host = await createParityHost();
    const fixture = parityFixture('a');
    const bytes = await fixtureBytes(fixture.build());
    const placed = await loadAsPlacements(host, bytes, fixture.rootName, 2);
    expect(placed.map((p) => p.assetRoot.name)).toEqual(['Arburg_1', 'Arburg_2']);
    const registry = host.viewer.registry!;
    for (const p of placed) {
      const drive = registry.resolve(driveRef('Arburg/Kine'), p.assetRoot).drive;
      expect(drive, `${p.rootPath}: Arburg/Kine`).toBeTruthy();
      expect(registry.getPathForNode(drive!.node)).toBe(`${p.rootPath}/Kine`);
    }
    // Behaviour: the same sixty steps the parity block runs — both axes move.
    const before = placed.map((p) => p.assetRoot.getObjectByName('Kine')!.position.x);
    for (let i = 0; i < fixture.steps; i++) host.viewer._tickOnce(1 / 60);
    const b1 = snapshotAfter(placed[0], 0);
    const b2 = snapshotAfter(placed[1], 0);
    expect(b1.drives['Kine']).toBeGreaterThan(0);
    expect(b2.drives['Kine']).toBeGreaterThan(0);
    expect(b1.drives['Kine']).toBe(b2.drives['Kine']);
    for (let i = 0; i < 2; i++) {
      expect(placed[i].assetRoot.getObjectByName('Kine')!.position.x, `Kine ${i + 1} moved`).not.toBe(before[i]);
    }
    for (const p of placed) p.release();
  });
});
