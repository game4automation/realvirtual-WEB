// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 Phase 1c — the `prepare` registry must resolve what the RUNTIME
 * registry resolves.
 *
 * The destructive pipeline hands `computeSurvival` a registry built by
 * `buildPreBakeRegistry`. On a model whose references are stored ROOT-RELATIVE
 * (no model-root prefix), every one of them resolves through the registry's
 * SUFFIX stage — and that stage cannot repair a path whose MIDDLE segment was
 * renamed by the glTF name dedup. Without the alias layer the survival model
 * therefore reported 2422 unresolved references on a model where the runtime
 * registry reported 46: pure bookkeeping, but it hides real findings and it
 * un-protects the very nodes those references point at.
 *
 * Covered here:
 *  - a root-relative reference into a RENAMED subtree resolves, and FAILS to
 *    resolve against the old alias-less registry (so the fix is really pinned);
 *  - the same for a signal node, including its typed registration;
 *  - a subtree the pre-bake hooks re-parent stays addressable under BOTH its
 *    authored and its post-hook path;
 *  - D17: a claim set that was never collected is reported as such, not as a
 *    clean `unresolvedClaims: 0`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Group, Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  buildPreBakeRegistry, createPreBakeContext, registerReparentedPaths, runPreBakeHooks,
} from '../src/core/engine/rv-pre-bake';
import { registerBuiltInPreBakeHooks } from '../src/core/engine/rv-pre-bake-hooks';
import {
  bakeRemovalReport, computeSurvival, lastBakeSurvivalCounts, recordBakeRemovalReport,
  _resetBakeRemovalReportForTesting,
} from '../src/core/engine/rv-bake-survival';
import { pathFromRoot, refTo } from './helpers/bake-survival';
// Side effect: registers every component capability the survival walk reads.
import '../src/core/engine/rv-scene-loader';

// ─── Fixtures ───────────────────────────────────────────────────────

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

/**
 * The Mauser constellation: two `Pusher` siblings, so Three.js deduped the
 * second one to `Pusher_1` and every authored path THROUGH it is dead. The
 * reference is stored ROOT-RELATIVE, exactly as that model stores its own.
 *
 *   Plant
 *    ├─ Kinematics_MC06 ─ Pusher   ─ Volumen
 *    ├─ Kinematics_MC07 ─ Pusher_1 ─ Volumen   (was: Pusher)
 *    └─ Track {EnergyChain → "Kinematics_MC07/Pusher/Volumen"}
 */
function buildRenamedPlant(): {
  root: Object3D; target: Object3D; renamed: Map<Object3D, string>;
} {
  const root = staged(node('Plant'));
  const mc06 = node('Kinematics_MC06');
  const pusher06 = node('Pusher');
  pusher06.add(node('Volumen'));
  mc06.add(pusher06);

  const mc07 = node('Kinematics_MC07');
  const pusher07 = node('Pusher_1');
  const target = node('Volumen');
  pusher07.add(target);
  mc07.add(pusher07);

  const track = node('Track', { EnergyChain: { Anchor: refTo('Kinematics_MC07/Pusher/Volumen') } });
  root.add(mc06, mc07, track);
  return { root, target, renamed: new Map([[pusher07, 'Pusher']]) };
}

// ─── 1. Aliases: root-relative reference into a renamed subtree ──────

describe('prepare registry — glTF-dedup aliases (plan-754 Phase 1c)', () => {
  it('resolves a ROOT-RELATIVE reference into a renamed subtree', () => {
    const { root, target, renamed } = buildRenamedPlant();
    const registry = buildPreBakeRegistry(root, renamed);
    expect(registry.getNode('Kinematics_MC07/Pusher/Volumen')).toBe(target);
    // The canonical spelling keeps working — aliases are additive.
    expect(registry.getNode('Plant/Kinematics_MC07/Pusher_1/Volumen')).toBe(target);
  });

  it('the OLD alias-less registry misses it — the defect this pins', () => {
    const { root, target } = buildRenamedPlant();
    const registry = buildPreBakeRegistry(root);
    expect(registry.getNode('Kinematics_MC07/Pusher/Volumen')).toBeNull();

    const model = computeSurvival(root, registry);
    expect(model.counts.unresolvedReferences).toBe(1);
    // …and the reference target is left unprotected.
    expect(model.survives(target)).toBe(false);
  });

  it('with the aliases the reference resolves and PROTECTS its target', () => {
    const { root, target, renamed } = buildRenamedPlant();
    const model = computeSurvival(root, buildPreBakeRegistry(root, renamed));
    expect(model.counts.unresolvedReferences).toBe(0);
    expect(model.reasonOf(target)).toBe('referenced');
    expect(model.removalTops.map((n) => pathFromRoot(n, root))).not.toContain('Plant/Kinematics_MC07/Pusher_1/Volumen');
  });

  it('publishes BOTH historical spellings of a reserved-character name', () => {
    // Raw `-Kettenrad 201:1` sanitizes to `-Kettenrad_2011`; Three additionally
    // deduped it. Content exported before plan-734 addresses the sanitized
    // spelling, the glTF file itself the raw one — both must resolve.
    const root = staged(node('Plant'));
    const cell = node('Kinematics_MC07');
    const renamedNode = node('-Kettenrad_2011_1');
    const leaf = node('Volumen');
    renamedNode.add(leaf);
    cell.add(renamedNode);
    root.add(cell);

    const registry = buildPreBakeRegistry(root, new Map([[renamedNode, '-Kettenrad 201:1']]));
    expect(registry.getNode('Kinematics_MC07/-Kettenrad 201:1/Volumen')).toBe(leaf);
    expect(registry.getNode('Kinematics_MC07/-Kettenrad_2011/Volumen')).toBe(leaf);
  });

  it('an empty rename map costs nothing and changes nothing', () => {
    const { root } = buildRenamedPlant();
    const registry = buildPreBakeRegistry(root, new Map());
    expect(registry.getNode('Kinematics_MC07/Pusher/Volumen')).toBeNull();
    expect(registry.getNode('Plant/Kinematics_MC06/Pusher/Volumen')).toBeTruthy();
  });
});

// ─── 2. Signal nodes ────────────────────────────────────────────────

describe('prepare registry — signal nodes (plan-754 Phase 1c)', () => {
  /**
   *   Plant
   *    ├─ Kinematics_MC06 ─ Signals ─ MC0604I00W
   *    ├─ Kinematics_MC07 ─ Signals ─ MC0704I00W_1  {PLCOutputBool}  (raw: MC07.04I00W)
   *    └─ Axis {Drive → "Kinematics_MC07/Signals/MC07.04I00W"}
   */
  function buildSignalPlant(): { root: Object3D; signal: Object3D; renamed: Map<Object3D, string> } {
    const root = staged(node('Plant'));
    const mc06 = node('Kinematics_MC06');
    const sig06 = node('Signals');
    sig06.add(node('MC0604I00W', { PLCOutputBool: { Name: 'MC06.04I00W' } }));
    mc06.add(sig06);

    const mc07 = node('Kinematics_MC07');
    const sig07 = node('Signals');
    const signal = node('MC0704I00W_1', { PLCOutputBool: { Name: 'MC07.04I00W' } });
    sig07.add(signal);
    mc07.add(sig07);

    const axis = node('Axis', {
      Drive: { Forward: refTo('Kinematics_MC07/Signals/MC07.04I00W', 'realvirtual.PLCOutputBool') },
    });
    root.add(mc06, mc07, axis);
    return { root, signal, renamed: new Map([[signal, 'MC07.04I00W']]) };
  }

  it('resolves a reference that names the signal by its AUTHORED path', () => {
    const { root, signal, renamed } = buildSignalPlant();
    const registry = buildPreBakeRegistry(root, renamed);
    expect(registry.getNode('Kinematics_MC07/Signals/MC07.04I00W')).toBe(signal);
    expect(computeSurvival(root, registry).counts.unresolvedReferences).toBe(0);
  });

  it('…and misses it without the aliases', () => {
    const { root } = buildSignalPlant();
    const registry = buildPreBakeRegistry(root);
    expect(registry.getNode('Kinematics_MC07/Signals/MC07.04I00W')).toBeNull();
    expect(computeSurvival(root, registry).counts.unresolvedReferences).toBe(1);
  });

  it('registers the signal node as a TYPED component, like registerSignal does', () => {
    const { root, signal, renamed } = buildSignalPlant();
    const registry = buildPreBakeRegistry(root, renamed);
    const path = NodeRegistry.computeNodePath(signal);
    expect(registry.getComponentTypes(path)).toEqual(['PLCOutputBool']);
    expect(registry.getByPath('PLCOutputBool', path)).toEqual({
      address: path,
      signalName: 'MC07.04I00W',
    });
    // A plain node stays untyped — this is bounded by the signal count.
    expect(registry.getComponentTypes('Plant/Kinematics_MC07')).toEqual([]);
  });

  it('falls back to the node name when the signal carries no explicit Name', () => {
    const root = staged(node('Plant'));
    const signal = node('Fwd', { PLCInputBool: {} });
    root.add(signal);
    const registry = buildPreBakeRegistry(root);
    expect(registry.getByPath('PLCInputBool', 'Plant/Fwd')).toEqual({
      address: 'Plant/Fwd', signalName: 'Fwd',
    });
  });
});

// ─── 3. Pre-bake re-parenting ───────────────────────────────────────

describe('prepare registry — re-parented subtrees (plan-754 D18)', () => {
  beforeEach(() => { registerBuiltInPreBakeHooks(); });

  it('a moved subtree resolves under BOTH the authored and the new path', () => {
    const root = staged(node('Plant'));
    const axis = node('Axis', {
      Drive: { Direction: 'LinearY' },
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'Carriage' },
    });
    const plate = node('Plate', { Group: { GroupName: 'Carriage' } });
    const tip = node('Tip');
    plate.add(tip);
    root.add(axis, plate);

    const registry = buildPreBakeRegistry(root);
    const session = createPreBakeContext(root, registry);
    const result = runPreBakeHooks(root, session);
    expect(plate.parent).toBe(axis);
    registerReparentedPaths(registry, result.reparented);

    // Authored (pre-hook) spelling — what a serialized reference names …
    expect(registry.getNode('Plant/Plate')).toBe(plate);
    expect(registry.getNode('Plant/Plate/Tip')).toBe(tip);
    // … and the post-hook spelling, for anything addressing the moved tree.
    expect(registry.getNode('Plant/Axis/Plate')).toBe(plate);
    expect(registry.getNode('Plant/Axis/Plate/Tip')).toBe(tip);
  });

  it('a reference to the authored path of a moved node still protects it', () => {
    const root = staged(node('Plant'));
    const axis = node('Axis', {
      Drive: { Direction: 'LinearY' },
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'Carriage' },
    });
    const plate = node('Plate', { Group: { GroupName: 'Carriage' } });
    const marker = node('Marker');
    plate.add(marker);
    const track = node('Track', { EnergyChain: { Anchor: refTo('Plant/Plate/Marker') } });
    root.add(axis, plate, track);

    const registry = buildPreBakeRegistry(root);
    const session = createPreBakeContext(root, registry);
    registerReparentedPaths(registry, runPreBakeHooks(root, session).reparented);

    const model = computeSurvival(root, registry);
    expect(model.counts.unresolvedReferences).toBe(0);
    expect(model.reasonOf(marker)).toBe('referenced');
  });
});

// ─── 3b. plan-757 F7 — BOTH path forms through the ONE resolver ─────

describe('prepare registry — asset-relative and root-inclusive references resolve alike (plan-757 F7)', () => {
  beforeEach(() => { registerBuiltInPreBakeHooks(); });

  /**
   *   Plant                     (staged: registry path `Plant`; parentless: ``)
   *    ├─ Mount
   *    ├─ Axis {Drive}
   *    ├─ TrackRel  {EnergyChain → 'Mount'}            asset-relative (plan-757 write form)
   *    ├─ TrackUnity{EnergyChain → 'Plant/Mount'}      root-inclusive (Unity export form)
   *    └─ TrackBad  {EnergyChain → 'Elsewhere/Mount'}  unknown prefix — unresolved, not guessed
   */
  function plant(stagedTree: boolean): { root: Object3D; mount: Object3D } {
    const root = stagedTree ? staged(node('Plant')) : node('Plant');
    const mount = node('Mount');
    root.add(mount);
    root.add(node('Axis', { Drive: { Direction: 'LinearY' } }));
    root.add(node('TrackRel', { EnergyChain: { Anchor: refTo('Mount') } }));
    root.add(node('TrackUnity', { EnergyChain: { Anchor: refTo('Plant/Mount') } }));
    root.add(node('TrackBad', { EnergyChain: { Anchor: refTo('Elsewhere/Mount') } }));
    return { root, mount };
  }

  for (const stagedTree of [true, false]) {
    it(`${stagedTree ? 'staged (loader)' : 'parentless (model cache)'} tree: relative + root-inclusive resolve, the unknown prefix does not`, () => {
      const { root, mount } = plant(stagedTree);
      const registry = buildPreBakeRegistry(root);
      const session = createPreBakeContext(root, registry);
      runPreBakeHooks(root, session);
      const model = computeSurvival(root, registry, undefined, { scope: session.scope });
      // Exactly the unknown-prefix reference is unresolved; the two forms of
      // the good one both protected the target.
      expect(model.counts.unresolvedReferences).toBe(1);
      expect(model.unresolvedReferences.map((u) => u.path)).toEqual(['Elsewhere/Mount']);
      expect(model.reasonOf(mount)).toBe('referenced');
      // The hooks read the same way (a hook path through `ctx.resolvePath`).
      expect(session.ctx.resolvePath('Mount')).toBe(mount);
      expect(session.ctx.resolvePath('Plant/Mount')).toBe(mount);
      expect(session.ctx.resolvePath('Elsewhere/Mount')).toBeNull();
    });
  }

  it('the default scope of computeSurvival is the tree root itself — same verdict without an explicit scope', () => {
    const { root, mount } = plant(true);
    const model = computeSurvival(root, buildPreBakeRegistry(root));
    expect(model.counts.unresolvedReferences).toBe(1);
    expect(model.reasonOf(mount)).toBe('referenced');
  });

  it('a plugin claim is read through the same resolver: relative or root-inclusive', () => {
    const { root, mount } = plant(true);
    const registry = buildPreBakeRegistry(root);
    const model = computeSurvival(root, registry, [
      { path: 'Mount', role: 'chunk' },
      { path: 'Plant/Axis', role: 'merge' },
      { path: 'Nowhere/Axis', role: 'merge' },
    ]);
    expect(model.claimed.has(mount)).toBe(true);
    expect(model.claimed.has(root.getObjectByName('Axis')!)).toBe(true);
    expect(model.unresolvedClaims.map((c) => c.path)).toEqual(['Nowhere/Axis']);
  });
});

// ─── 4. D17 — claims that were never collected ──────────────────────

describe('bake removal report — claim collection honesty (plan-754 D17)', () => {
  beforeEach(() => { _resetBakeRemovalReportForTesting(); });
  afterEach(() => { vi.restoreAllMocks(); });

  function tinyModel(): { root: Object3D; registry: NodeRegistry } {
    const root = staged(node('Plant'));
    root.add(node('Frame'));
    return { root, registry: buildPreBakeRegistry(root) };
  }

  it('reports claimsComplete by default — a caller with no plugin layer has no gap', () => {
    const { root, registry } = tinyModel();
    recordBakeRemovalReport('plant.glb', root, registry, [], (n) => pathFromRoot(n, root));
    expect(bakeRemovalReport[0].claimsComplete).toBe(true);
    expect(lastBakeSurvivalCounts()).toMatchObject({ claimsComplete: true });
  });

  it('a claim set that was never collected is NOT a clean zero', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, registry } = tinyModel();
    recordBakeRemovalReport(
      'plant.glb', root, registry, [], (n) => pathFromRoot(n, root),
      { claimsComplete: false },
    );
    const report = bakeRemovalReport[0];
    // The number alone would be indistinguishable from a healthy run …
    expect(report.counts.unresolvedClaims).toBe(0);
    // … which is exactly why the flag has to be read with it.
    expect(report.claimsComplete).toBe(false);
    expect(lastBakeSurvivalCounts()).toMatchObject({ claimsComplete: false });
    expect(String(warn.mock.calls[0][0])).toContain('Plugin bake claims were NOT collected');
  });

  it('warns once per asset, not once per load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { root, registry } = tinyModel();
    for (let i = 0; i < 3; i++) {
      recordBakeRemovalReport(
        'plant.glb', root, registry, [], (n) => pathFromRoot(n, root),
        { claimsComplete: false },
      );
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('NOT collected'))).toHaveLength(1);
    expect(bakeRemovalReport.every((r) => r.claimsComplete === false)).toBe(true);
  });
});
