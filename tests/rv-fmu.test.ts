// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.3 — the `Fmu` component: registry, signal children, scoping,
 * instance key and the Phase-1 states.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import '../src/core/engine/rv-fmu';
import {
  RVFmu,
  fmuInstanceLocalKey,
  fmuSignalTypeOf,
  getFmuInstances,
  setFmuDocumentIdProvider,
  RV_FMU_SIGNAL,
} from '../src/core/engine/rv-fmu';
import {
  applySchema,
  getCapabilities,
  getSchemaDefaults,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

/** Variables mirroring the causality/type mix of Feedthrough.fmu. */
export const FEEDTHROUGH_VARS = [
  { name: 'Float64_fixed_parameter', valueReference: 5, causality: 'parameter', variability: 'fixed', type: 'Real', start: '0' },
  { name: 'Float64_tunable_parameter', valueReference: 6, causality: 'parameter', variability: 'tunable', type: 'Real', start: '2.5' },
  { name: 'Float64_continuous_input', valueReference: 7, causality: 'input', variability: 'continuous', type: 'Real', start: '0' },
  { name: 'Float64_continuous_output', valueReference: 8, causality: 'output', variability: 'continuous', type: 'Real' },
  { name: 'Int32_input', valueReference: 19, causality: 'input', variability: 'discrete', type: 'Integer', start: '3' },
  { name: 'Int32_output', valueReference: 20, causality: 'output', variability: 'discrete', type: 'Integer' },
  { name: 'Boolean_input', valueReference: 27, causality: 'input', variability: 'discrete', type: 'Boolean', start: 'true' },
  { name: 'Boolean_output', valueReference: 28, causality: 'output', variability: 'discrete', type: 'Boolean' },
  { name: 'String_input', valueReference: 29, causality: 'input', variability: 'discrete', type: 'String', start: 'Set me!' },
  { name: 'Enumeration_output', valueReference: 34, causality: 'output', variability: 'discrete', type: 'Enumeration' },
];

export function fmuExtras(sha: string | null, vars: unknown[] = FEEDTHROUGH_VARS): Record<string, unknown> {
  return {
    StepSize: 0.01,
    Tolerance: 0.000001,
    AllowViewerToFmu: true,
    FmuEmbed: sha
      ? { fileName: 'Feedthrough.fmu', sha256: sha, guid: '{g}', modelName: 'Feedthrough', fmiVersion: '2.0', byteLength: 3, bufferView: -1 }
      : {},
    FmuVariables: vars,
  };
}

interface Env { store: SignalStore; registry: NodeRegistry; scene: Scene; ctx: ComponentContext }

function env(): Env {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  return { store, registry, scene, ctx: { registry, signalStore: store, scene } as unknown as ComponentContext };
}

/** scene > ModelRoot > ...path — returns the last node. */
function chain(scene: Scene, names: string[]): Object3D {
  let parent: Object3D = scene;
  for (const n of names) {
    const o = new Object3D();
    o.name = n;
    parent.add(o);
    parent = o;
  }
  return parent;
}

function attachFmu(e: Env, node: Object3D, extras: Record<string, unknown>): RVFmu {
  node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), Fmu: extras };
  const inst = new RVFmu(node);
  applySchema(inst as unknown as Record<string, unknown>, RVFmu.schema, extras);
  e.registry.registerNode(NodeRegistry.computeNodePath(node), node);
  inst.init(e.ctx);
  return inst;
}

beforeEach(() => {
  binaryResources._resetForTesting();
  resetProblemsForTests();
  setFmuDocumentIdProvider(null);
  for (const i of [...getFmuInstances()]) i.dispose();
});

describe('Fmu component', () => {
  it('registers with claimsNode true, merge bake, select pick, authorable, FMU filter', () => {
    const caps = getCapabilities('Fmu');
    expect(caps.claimsNode).toBe(true);
    expect(caps.bake).toBe('merge');
    expect(caps.pick).toBe('select');
    expect(caps.authorable).toBe(true);
    expect(caps.ui.filter).toBe('FMU');
    expect(caps.ui.tooltip).toBe('fmu');
  });

  it('has complete schema defaults for the generic "Add component" path', () => {
    expect(getSchemaDefaults('Fmu')).toEqual({
      StepSize: 0.01, Tolerance: 0.000001, AllowViewerToFmu: true, FmuEmbed: {}, FmuVariables: [],
      // plan-502
      FmuStartOverrides: {}, RestartOnReset: true,
      // plan-512
      FmuUnits: {},
    });
  });

  it('maps causality × type to the PLC signal convention (shared fixture table)', () => {
    const t = (causality: string, type: string, variability = 'continuous') =>
      fmuSignalTypeOf({ name: 'v', valueReference: 1, causality: causality as never, type: type as never, variability });
    expect(t('input', 'Real')).toBe('PLCInputFloat');
    expect(t('output', 'Real')).toBe('PLCOutputFloat');
    expect(t('calculatedParameter', 'Integer')).toBe('PLCOutputInt');
    expect(t('parameter', 'Real', 'tunable')).toBe('PLCInputFloat');
    expect(t('parameter', 'Real', 'fixed')).toBeNull();
    expect(t('input', 'Enumeration')).toBe('PLCInputInt');
    expect(t('output', 'Boolean')).toBe('PLCOutputBool');
    expect(t('input', 'String')).toBe('unsupported');
  });

  it('creates Bool/Float/Int children under <node>/Signals/<var> and lists String vars as unsupported', () => {
    const e = env();
    binaryResources.put(SHA_A, new Uint8Array([1, 2, 3]), 'doc');
    const node = chain(e.scene, ['Model', 'Machine', 'Hydraulics']);
    const fmu = attachFmu(e, node, fmuExtras(SHA_A));

    const signals = node.children.find((c) => c.name === 'Signals')!;
    expect(signals).toBeTruthy();
    expect(signals.userData[RV_FMU_SIGNAL]).toBe(true);
    const leaves = signals.children.map((c) => c.name).sort();
    expect(leaves).toEqual([
      'Boolean_input', 'Boolean_output', 'Enumeration_output',
      'Float64_continuous_input', 'Float64_continuous_output', 'Float64_tunable_parameter',
      'Int32_input', 'Int32_output',
      // plan-502 F12 — the viewer-owned restart control leaf (not an FMU variable).
      'Restart',
    ]);
    for (const leaf of signals.children) expect(leaf.userData[RV_FMU_SIGNAL]).toBe(true);

    // Wire name = <FMU node>.<var>; path = <node>/Signals/<var>.
    expect(e.store.getPath('Hydraulics.Float64_continuous_input')).toBe('Model/Machine/Hydraulics/Signals/Float64_continuous_input');
    expect(e.store.getType('Hydraulics.Float64_continuous_input')).toBe('PLCInputFloat');
    expect(e.store.getType('Hydraulics.Float64_continuous_output')).toBe('PLCOutputFloat');
    expect(e.store.getType('Hydraulics.Int32_output')).toBe('PLCOutputInt');
    expect(e.store.getType('Hydraulics.Boolean_input')).toBe('PLCInputBool');
    expect(e.store.getType('Hydraulics.Enumeration_output')).toBe('PLCOutputInt');
    // Seeds from `start`.
    expect(e.store.get('Hydraulics.Float64_tunable_parameter')).toBe(2.5);
    expect(e.store.get('Hydraulics.Int32_input')).toBe(3);
    expect(e.store.get('Hydraulics.Boolean_input')).toBe(true);
    expect(e.store.getSignalMeta('Hydraulics.Int32_input')?.source).toBe('FMU · Feedthrough');
    // Not exposed / unsupported.
    expect(e.store.get('Hydraulics.Float64_fixed_parameter')).toBeUndefined();
    expect(e.store.get('Hydraulics.String_input')).toBeUndefined();
    expect(fmu.unsupportedVariables).toEqual(['String_input (String)']);
    expect(fmu.signalNames).toHaveLength(8);
    expect(getProblems().some((p) => p.code === 'fmu-variable-unsupported')).toBe(true);
  });

  it('scopes wire names inside a placement and keeps instanceKey stable across reload (nested: _layoutNestedId)', () => {
    setFmuDocumentIdProvider(() => 'doc-1');
    const build = () => {
      const e = env();
      const placement = chain(e.scene, ['Model', 'Layout', 'Cell_1']);
      placement.userData._layoutId = 'rec-42';
      placement.userData.realvirtual = { LayoutObject: { Label: 'Cell', CatalogId: 'c', Locked: false } };
      const node = chain(placement as unknown as Scene, ['Content', 'Hydraulics']);
      const fmu = attachFmu(e, node, fmuExtras(SHA_A));
      return { e, fmu };
    };
    const first = build();
    expect(first.fmu.instanceKey).toBe('doc-1#rec-42#Content/Hydraulics');
    expect(first.e.store.get('Cell_1.Hydraulics.Int32_input')).toBe(3);
    first.fmu.dispose();
    const second = build();
    expect(second.fmu.instanceKey).toBe(first.fmu.instanceKey);

    // Nested placement: the innermost root carries the reload-stable occurrence chain.
    const e = env();
    const outer = chain(e.scene, ['Model', 'Layout', 'Cell_1']);
    outer.userData._layoutId = 'rec-42';
    const inner = chain(outer as unknown as Scene, ['Machine_2']);
    inner.userData._layoutNestedOf = 'rec-42';
    inner.userData._layoutNestedId = 'rec-42/node-7';
    const node = chain(inner as unknown as Scene, ['Hydraulics']);
    expect(fmuInstanceLocalKey(node)).toBe('rec-42/node-7#Hydraulics');
    // Main model: asset-relative path, model root stripped.
    expect(fmuInstanceLocalKey(chain(env().scene, ['Model', 'Machine', 'Hyd']))).toBe('Machine/Hyd');
  });

  it('is unsupported without FmuEmbed and standalone without transport', () => {
    const e = env();
    const bare = attachFmu(e, chain(e.scene, ['Model', 'Bare']), fmuExtras(null, []));
    expect(bare.state).toBe('unsupported');
    expect(bare.node.children).toHaveLength(0);
    expect(getProblems().find((p) => p.code === 'fmu-unsupported')?.severity).toBe('warning');

    binaryResources.put(SHA_A, new Uint8Array([1]), 'doc');
    const ok = attachFmu(e, chain(e.scene, ['Model', 'Ok']), fmuExtras(SHA_A));
    expect(ok.state).toBe('standalone');
    expect(ok.hasPackage).toBe(true);
    expect(getProblems().find((p) => p.code === 'fmu-not-runnable')?.severity).toBe('info');

    // A package record whose bytes never arrived (saved with bufferView -1).
    const missing = attachFmu(e, chain(e.scene, ['Model', 'Missing']), fmuExtras(SHA_B));
    expect(missing.state).toBe('unsupported');
    expect(missing.signalNames.length).toBeGreaterThan(0); // children still show start values
  });

  it('dispose removes the children, their signals and the instance', () => {
    const e = env();
    binaryResources.put(SHA_A, new Uint8Array([1]), 'doc');
    const node = chain(e.scene, ['Model', 'Hyd']);
    const fmu = attachFmu(e, node, fmuExtras(SHA_A));
    expect(getFmuInstances()).toContain(fmu);
    const leafPath = e.store.getPath('Hyd.Int32_input')!;
    fmu.dispose();
    expect(node.children.find((c) => c.name === 'Signals')).toBeUndefined();
    expect(e.store.get('Hyd.Int32_input')).toBeUndefined();
    expect(e.registry.getNode(leafPath)).toBeNull();
    expect(getFmuInstances()).not.toContain(fmu);
    expect(getProblems().filter((p) => p.code.startsWith('fmu-'))).toEqual([]);
  });
});
