// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * webcomponent-wiring.test.ts — plan-210 §7 defensive parsing of the
 * `WebComponent` rv_extras entry and the scene wiring entry point
 * `wireWebComponents()` including the §10 trust gate (allowScripts default
 * FALSE — no instance is created without explicit opt-in).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import {
  parseWebComponent,
  wireWebComponents,
  countWebComponents,
} from '../src/core/engine/rv-web-component-registry';
import { makeWorld, makeRegistry, FIXED_DT } from './_web-component-kit';

const hosts: RVScriptHost[] = [];
async function makeHost(): Promise<RVScriptHost> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  return host;
}
afterEach(() => {
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

describe('parseWebComponent — §7 defensive parsing', () => {
  it('applies the §7 defaults for missing fields', () => {
    const parsed = parseWebComponent({})!;
    expect(parsed).toEqual({
      active: true,
      apiVersion: 1,
      language: 'js',
      desSafe: false,
      typeId: '',
      code: '',
      props: {},
    });
  });

  it('reads explicit §7 fields', () => {
    const parsed = parseWebComponent({
      Active: false,
      ApiVersion: 2,
      Language: 'js',
      DesSafe: true,
      TypeId: 'Turntable',
      Code: 'function setup(self){ return {}; }',
    })!;
    expect(parsed.active).toBe(false);
    expect(parsed.apiVersion).toBe(2);
    expect(parsed.desSafe).toBe(true);
    expect(parsed.typeId).toBe('Turntable');
    expect(parsed.code).toContain('setup');
  });

  it('rejects non-object input and coerces malformed field types to defaults', () => {
    expect(parseWebComponent(null)).toBeNull();
    expect(parseWebComponent('code')).toBeNull();
    expect(parseWebComponent(42)).toBeNull();
    expect(parseWebComponent([1, 2])).toBeNull();
    const parsed = parseWebComponent({
      Active: 'yes', ApiVersion: 'two', DesSafe: 1, TypeId: 7, Code: { js: 'x' },
    })!;
    expect(parsed.active).toBe(true);       // only explicit false deactivates
    expect(parsed.apiVersion).toBe(1);
    expect(parsed.desSafe).toBe(false);
    expect(parsed.typeId).toBe('');
    expect(parsed.code).toBe('');           // Code ?? '' — no VM later
  });

  it('collects extra primitive fields as the self.prop bag (v1 shim)', () => {
    const parsed = parseWebComponent({
      Code: 'x', ProcessTime: 2.5, Label: 'Gate A', Enabled: true, Ref: { nested: 1 },
    })!;
    expect(parsed.props).toEqual({ ProcessTime: 2.5, Label: 'Gate A', Enabled: true });
  });
});

function makeSceneTree(): Object3D {
  const root = new Object3D();
  root.name = 'Model';
  const line = new Object3D();
  line.name = 'Line1';
  root.add(line);

  const gate = new Object3D();
  gate.name = 'Gate';
  gate.userData.realvirtual = {
    WebComponent: {
      Code: 'function setup(self){ var n = 0; return { continuous: { fixedUpdate: function(){ n++; } }, probe: function(){ return n; } }; }',
      ProcessTime: 1.5,
    },
  };
  line.add(gate);

  const turn = new Object3D();
  turn.name = 'Turntable';
  turn.userData.realvirtual = {
    WebComponent: { TypeId: 'Turntable', Code: 'function setup(self){ return {}; }' },
  };
  line.add(turn);

  const plain = new Object3D();
  plain.name = 'Conveyor';
  plain.userData.realvirtual = { Drive: { TargetSpeed: 100 } };
  line.add(plain);

  const malformed = new Object3D();
  malformed.name = 'Broken';
  malformed.userData.realvirtual = { WebComponent: 'not-an-object' };
  line.add(malformed);

  return root;
}

describe('wireWebComponents — scene wiring + trust gate (§10)', () => {
  it('counts WebComponent nodes for the trust-gate scan', () => {
    expect(countWebComponents(makeSceneTree())).toBe(3);   // incl. malformed
  });

  it('trust gate: allowScripts defaults to FALSE — no instance is created', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const result = wireWebComponents(makeSceneTree(), registry);
    expect(result.created).toEqual([]);
    expect(result.blocked).toBe(2);
    expect(result.malformed).toBe(1);
    expect(registry.size).toBe(0);
    expect(host.contextCount).toBe(0);
    registry.dispose();
  });

  it('allowScripts=true creates instances with full hierarchy paths and running VMs', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const result = wireWebComponents(makeSceneTree(), registry, { allowScripts: true });

    // Path convention mirrors NodeRegistry.computeNodePath: the parentless
    // root (scene/GLB root) is excluded from hierarchy paths.
    expect(result.created.map((i) => i.nodePath).sort()).toEqual([
      'Line1/Gate', 'Line1/Turntable',
    ]);
    expect(result.blocked).toBe(0);
    expect(result.malformed).toBe(1);
    expect(registry.size).toBe(2);
    expect(host.contextCount).toBe(2);

    // Parsed props flow into self.prop; the instance ticks.
    const gate = registry.get('Line1/Gate')!;
    expect(gate.meta.props).toEqual({ ProcessTime: 1.5 });
    expect(gate.ok).toBe(true);
    registry.tickAll(FIXED_DT);
    const probe = gate.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(1);

    const turn = registry.get('Line1/Turntable')!;
    expect(turn.meta.typeId).toBe('Turntable');
    registry.dispose();
  });
});
