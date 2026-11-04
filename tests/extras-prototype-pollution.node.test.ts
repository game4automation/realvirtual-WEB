// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Prototype pollution through model CONTENT (Codex round 3): a `.kin.json`
// behavior of type `__proto__` merged attacker props into Object.prototype, and
// the next trusted demo load inherited a WebComponent. Every content merge point
// must skip `__proto__` / `constructor` / `prototype` and merge only into OWN
// records; the WebComponent scan reads OWN properties only (rv-safe-keys.ts).

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { applyKinematicsSpec, deepMerge, type KinematicsSpec } from '../src/core/behavior-runtime';
import {
  applyComponentPatch, applyOverrideLayers, mergeComponentPatches, OVERRIDE_STRENGTH, readAssetOverridesRecord,
} from '../src/core/engine/rv-asset-reference';
import { countWebComponents, parseWebComponent } from '../src/core/engine/rv-web-component-registry';
import { mergeModelConfig } from '../src/core/engine/rv-model-config';
import { sidecarChangedDocument } from '../src/core/engine/rv-script-trust';

const PROTO = Object.prototype as unknown as Record<string, unknown>;
const FN_PROTO = Function.prototype as unknown as Record<string, unknown>;
const OBJ_FN = Object as unknown as Record<string, unknown>;

function expectClean(): void {
  for (const k of ['WebComponent', 'Active', 'Code', 'polluted']) {
    expect(Object.prototype.hasOwnProperty.call(PROTO, k), `Object.prototype.${k}`).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(FN_PROTO, k), `Function.prototype.${k}`).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(OBJ_FN, k), `Object.${k}`).toBe(false);
  }
  expect(({} as Record<string, unknown>).WebComponent).toBeUndefined();
}

afterEach(() => {
  // Never leave a polluted prototype behind for the other tests of this worker.
  for (const k of ['WebComponent', 'Active', 'Code', 'polluted']) {
    delete PROTO[k]; delete FN_PROTO[k]; delete OBJ_FN[k];
  }
});

const victim = (): { root: Group; node: Object3D } => {
  const root = new Group(); root.name = 'Root';
  const node = new Object3D(); node.name = 'Victim'; root.add(node);
  return { root, node };
};

const WC = '{"WebComponent":{"Active":true,"Code":"function setup(self) { return {}; }"}}';

describe('sidecar behaviors (applyKinematicsSpec)', () => {
  it.each(['__proto__', 'constructor', 'prototype'])('refuses and reports behavior type %s', (type) => {
    const { root, node } = victim();
    const spec = JSON.parse(`{"behaviors":[{"target":"Victim","type":"${type}","props":${WC}}]}`) as KinematicsSpec;
    const report = applyKinematicsSpec(root, spec);
    expectClean();
    expect(report.applied.behaviors).toBe(0);
    expect(report.warnings.join('\n')).toContain('refused component type');
    expect(sidecarChangedDocument(report)).toBe(false);
    expect(countWebComponents(root)).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(node.userData.realvirtual ?? {}, type)).toBe(false);
  });

  it('strict mode throws instead of applying', () => {
    const { root } = victim();
    const spec = JSON.parse(`{"strict":true,"behaviors":[{"target":"Victim","type":"__proto__","props":${WC}}]}`) as KinematicsSpec;
    expect(() => applyKinematicsSpec(root, spec)).toThrow(/refused component type/);
    expectClean();
  });

  it('skips prototype keys at every level of the props merge', () => {
    const { root, node } = victim();
    const spec = JSON.parse(`{"behaviors":[{"target":"Victim","type":"Foo","props":{"A":1,"__proto__":{"polluted":1},`
      + `"constructor":{"prototype":{"polluted":1}},"Nested":{"__proto__":{"polluted":1},"B":2}}}]}`) as KinematicsSpec;
    applyKinematicsSpec(root, spec);
    expectClean();
    const foo = (node.userData.realvirtual as Record<string, Record<string, unknown>>).Foo!;
    expect(foo.A).toBe(1);
    expect((foo.Nested as Record<string, unknown>).B).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(foo, 'constructor')).toBe(false);
    // A second merge onto the same record (deep path) stays clean too.
    deepMerge(foo, JSON.parse('{"Nested":{"__proto__":{"polluted":1}}}'), true);
    expectClean();
  });
});

describe('WebComponent scan reads OWN properties only', () => {
  it('an inherited WebComponent / realvirtual / Code is no entry', () => {
    const { root, node } = victim();
    node.userData.realvirtual = {};
    PROTO.WebComponent = { Active: true, Code: 'function setup(self) { return {}; }' };
    try {
      expect(countWebComponents(root)).toBe(0);
    } finally {
      delete PROTO.WebComponent;
    }
    const inherited = Object.create({ realvirtual: { WebComponent: { Code: 'x' } } }) as Record<string, unknown>;
    node.userData = inherited;
    expect(countWebComponents(root)).toBe(0);
    PROTO.Code = 'function setup(self) { return {}; }';
    try {
      expect(parseWebComponent({ Active: true })?.code).toBe('');
    } finally {
      delete PROTO.Code;
    }
    expectClean();
  });
});

describe('other rv_extras merge points', () => {
  it('applyComponentPatch / AssetOverrides layers skip prototype keys', () => {
    const { node } = victim();
    const patch = JSON.parse(`{"__proto__":${WC},"constructor":{"polluted":1},"Drive":{"__proto__":{"polluted":1},"Speed":5}}`);
    applyComponentPatch(node, patch);
    applyOverrideLayers(node, [{ strength: OVERRIDE_STRENGTH.OUTER_REFERENCE, patch }]);
    expectClean();
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive!.Speed).toBe(5);
    expect(Object.prototype.hasOwnProperty.call(rv, 'constructor')).toBe(false);
  });

  it('mergeModelConfig ignores a __proto__ plugin key', () => {
    const merged = mergeModelConfig({}, { pluginConfig: JSON.parse('{"__proto__":{"polluted":1},"p":{"a":1}}') }, {});
    expectClean();
    expect(merged.pluginConfig?.p).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(merged.pluginConfig)).toBe(Object.prototype);
  });

  it('AssetOverrides normalization rejects __proto__ addresses and component types; merges read OWN records', () => {
    const raw = JSON.parse(`{"byAddress":{"__proto__":${WC},"#a":{"__proto__":${WC},"Drive":{"Speed":1}}},`
      + `"byNodeId":{"__proto__":${WC}},"byPath":{"__proto__":${WC},"A/B":{"__proto__":${WC},"Drive":{"Speed":2}}}}`);
    const rec = readAssetOverridesRecord(raw)!;
    expectClean();
    expect(Object.keys(rec.byAddress).sort()).toEqual(['#a']);
    expect(Object.getPrototypeOf(rec.byAddress)).toBe(Object.prototype);
    const a = rec.byAddress['#a']!;
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(a, 'WebComponent')).toBe(false);
    expect(a.Drive).toEqual({ Speed: 1 });
    expect(Object.keys(rec.legacyByPath ?? {})).toEqual(['A/B']);
    expect(Object.getPrototypeOf(rec.legacyByPath!['A/B'])).toBe(Object.prototype);
    // An inherited WebComponent on the base is never copied into an own entry.
    const base = Object.create({ WebComponent: { Code: 'function setup(self) { return {}; }' } }) as Record<string, Record<string, unknown>>;
    const merged = mergeComponentPatches(base, JSON.parse('{"WebComponent":{"Active":true},"__proto__":{"polluted":1}}'));
    expect(merged.WebComponent).toEqual({ Active: true });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expectClean();
  });
});
