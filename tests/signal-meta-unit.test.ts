// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 §9.2 — `SignalMeta.unit/unitDef`: additive merge, the FMU as the v1
 * unit source (BouncingBall: `h [m]`, `v [m/s]`), `UnitDefinitions` → `FmuUnits`
 * → `unitDef`, and two FMUs with an equally named, differently defined unit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { RVFmu } from '../src/core/engine/rv-fmu';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { readModelDescription, sha256OfPackage } from '../src/core/engine/rv-fmu-model-description';
import { buildFmuExtras, fmuUnitsExtras, type FmuPackage } from '../src/core/ops/rv-fmu-ops';
import { validateFmuExtras } from '../src/core/engine/rv-extras-validator';
import { conversion } from '../src/core/engine/rv-units';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';

async function bouncingBall(): Promise<FmuPackage> {
  const bytes = new Uint8Array(await (await fetch(bouncingBallUrl)).arrayBuffer());
  return {
    fileName: 'BouncingBall.fmu',
    sha256: await sha256OfPackage(bytes),
    bytes,
    description: await readModelDescription(bytes),
  };
}

function initFmu(name: string, extras: Record<string, unknown>): { fmu: RVFmu; store: SignalStore } {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const node = new Object3D();
  node.name = name;
  root.add(node);
  node.userData.realvirtual = { Fmu: extras };
  registry.registerNode(NodeRegistry.computeNodePath(node), node);
  const fmu = new RVFmu(node);
  applySchema(fmu as unknown as Record<string, unknown>, RVFmu.schema, extras);
  fmu.init({ registry, signalStore: store, scene } as unknown as ComponentContext);
  return { fmu, store };
}

beforeEach(() => {
  resetProblemsForTests();
  binaryResources._resetForTesting();
});

describe('SignalMeta.unit / unitDef (plan-512 F1)', () => {
  it('merges unit and unitDef additively, like address/comment/source', () => {
    const store = new SignalStore();
    store.setSignalMeta('A', { address: '%I0.0', source: 'S7' });
    store.setSignalMeta('A', { unit: 'm' });
    expect(store.getSignalMeta('A')).toEqual({ address: '%I0.0', source: 'S7', unit: 'm' });
    const def = { dims: { m: 1 }, factor: 1, offset: 0 };
    store.setSignalMeta('A', { unitDef: def, comment: 'height' });
    expect(store.getSignalMeta('A')).toEqual({ address: '%I0.0', source: 'S7', unit: 'm', unitDef: def, comment: 'height' });
    // A later meta without unit keeps it.
    store.setSignalMeta('A', { source: 'FMU' });
    expect(store.getSignalMeta('A')?.unit).toBe('m');
  });
});

describe('FMU as the unit source (plan-512 F2/F11)', () => {
  it('reads UnitDefinitions and gives every signal its unit and the package definition', async () => {
    const pkg = await bouncingBall();
    expect(pkg.description.units).toEqual({ m: { m: 1 }, 'm/s': { m: 1, s: -1 }, 'm/s2': { m: 1, s: -2 } });
    const h = pkg.description.variables.find((v) => v.name === 'h');
    expect(h?.unit).toBe('m');

    const extras = { ...buildFmuExtras(pkg), ...fmuUnitsExtras(pkg) };
    expect(validateFmuExtras(extras).issues).toEqual([]);
    const { fmu, store } = initFmu('Ball', extras);
    const hName = fmu.signalOf('h')!.name;
    const vName = fmu.signalOf('v')!.name;
    expect(store.getSignalMeta(hName)?.unit).toBe('m');
    expect(store.getSignalMeta(hName)?.unitDef).toEqual({ dims: { m: 1 }, factor: 1, offset: 0 });
    expect(store.getSignalMeta(vName)?.unit).toBe('m/s');
    expect(store.getSignalMeta(vName)?.source).toMatch(/^FMU/);
    // The [unit] comment fragment stays for display.
    expect(store.getSignalMeta(hName)?.comment).toContain('[m]');
    // The control signal has no unit.
    expect(store.getSignalMeta(fmu.restartSignalName)?.unit).toBeUndefined();
  });

  it('a package attached before plan-512 (no FmuUnits) still carries the unit, without unitDef', async () => {
    const pkg = await bouncingBall();
    const { fmu, store } = initFmu('Ball', buildFmuExtras(pkg));
    const meta = store.getSignalMeta(fmu.signalOf('h')!.name);
    expect(meta?.unit).toBe('m');
    expect(meta && 'unitDef' in meta).toBe(false);
    // The built-in table still answers.
    expect(conversion(meta!.unit!, 'mm')).toEqual({ ok: true, factor: 1000 });
  });

  it('two FMUs with an equally named, differently defined unit do not collide', () => {
    const vars = [{ name: 'x', valueReference: 1, causality: 'output', variability: 'continuous', type: 'Real', unit: 'in' }];
    const embed = (sha: string) => ({ fileName: 'a.fmu', sha256: sha, guid: '{g}', modelName: 'A', fmiVersion: '2.0', byteLength: 1, bufferView: -1 });
    const a = initFmu('A', { FmuEmbed: embed('a'.repeat(64)), FmuVariables: vars, FmuUnits: { in: { m: 1, factor: 0.0254 } } });
    const b = initFmu('B', { FmuEmbed: embed('b'.repeat(64)), FmuVariables: vars, FmuUnits: { in: { m: 1, factor: 0.5 } } });
    const metaA = a.store.getSignalMeta(a.fmu.signalOf('x')!.name)!;
    const metaB = b.store.getSignalMeta(b.fmu.signalOf('x')!.name)!;
    expect(metaA.unit).toBe('in');
    expect(metaB.unit).toBe('in');
    expect(metaA.unitDef).not.toEqual(metaB.unitDef);
    const fa = conversion('in', 'mm', { fromDef: metaA.unitDef });
    const fb = conversion('in', 'mm', { fromDef: metaB.unitDef });
    expect(fa.ok && fa.factor).toBeCloseTo(25.4, 9);
    expect(fb.ok && fb.factor).toBeCloseTo(500, 9);
  });

  it('a malformed FmuUnits record is named by the validator and ignored', () => {
    const check = validateFmuExtras({ FmuUnits: { m: { m: 'one' }, x: 3, y: { z: 1 } } });
    expect(check.issues).toEqual([
      'FmuUnits.m.m is not a number',
      'FmuUnits.x is not a BaseUnit object',
      'FmuUnits.y.z is not a BaseUnit attribute',
    ]);
    expect(validateFmuExtras({ FmuUnits: [] }).issues).toEqual(['FmuUnits is not an object']);
  });
});
