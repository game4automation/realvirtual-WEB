// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * empty-code.test.ts — plan-210 §7: `Code: ''` (or Active:false) means NO VM
 * is created, no error is raised and the instance stays inactive — but it
 * remains registered so the phase-3 editor can reload real code into it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { makeWorld, makeRegistry, makeNode, meta, FIXED_DT } from './_web-component-kit';

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

const PATH = 'Line1/Gate';

describe('empty code — no VM, no error, inactive (§7)', () => {
  it("Code:'' creates no context and ticks harmlessly", async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);

    const inst = registry.create(PATH, makeNode('Gate'), meta(''));
    expect(inst.active).toBe(false);
    expect(inst.component).toBeNull();
    expect(inst.adapter).toBeNull();
    expect(inst.error).toBeNull();
    expect(host.contextCount).toBe(0);

    expect(() => {
      registry.tickAll(FIXED_DT);
      registry.lateTickAll(FIXED_DT);
      registry.resetAll();
    }).not.toThrow();
    registry.dispose();
  });

  it('whitespace-only code and Active:false are equally inactive', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const ws = registry.create('Line1/A', makeNode('A'), meta('   \n\t  '));
    const inactive = registry.create('Line1/B', makeNode('B'),
      meta('function setup(self) { return {}; }', { active: false }));
    expect(ws.active).toBe(false);
    expect(inactive.active).toBe(false);
    expect(host.contextCount).toBe(0);
    registry.dispose();
  });

  it('reload with real code activates the previously empty instance', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    registry.create(PATH, makeNode('Gate'), meta(''));
    expect(host.contextCount).toBe(0);

    registry.reload(PATH, `
      function setup(self) {
        var n = 0;
        return {
          continuous: { fixedUpdate: function (dt) { n++; } },
          probe: function () { return n; },
        };
      }
    `);
    const inst = registry.get(PATH)!;
    expect(inst.active).toBe(true);
    expect(host.contextCount).toBe(1);
    registry.tickAll(FIXED_DT);
    const probe = inst.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(1);

    // And back to empty: reload('') disposes the VM again.
    registry.reload(PATH, '');
    expect(registry.get(PATH)!.active).toBe(false);
    expect(host.contextCount).toBe(0);
    registry.dispose();
  });
});
