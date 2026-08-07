// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * setup-failure-isolation.test.ts — plan-210 §4.4: a failure in setup (or in
 * the FIRST tick) disables that one instance; the rest of the scene keeps
 * ticking. Later handler errors only log — the poison backoff owns hard
 * disables.
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

const GOOD_CODE = `
function setup(self) {
  var n = 0;
  return {
    continuous: { fixedUpdate: function (dt) { n++; } },
    probe: function () { return n; },
  };
}
`;

describe('setup-failure isolation (§4.4)', () => {
  it('setup throw disables the instance; sibling instance keeps ticking', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const disabled: string[] = [];
    const registry = makeRegistry(host, world, {
      onInstanceDisabled: (nodePath, reason) => disabled.push(`${nodePath}: ${reason}`),
    });

    registry.create('Line1/Broken', makeNode('Broken'), meta(`
      function setup(self) { throw new Error('boom in setup'); }
    `));
    const good = registry.create('Line1/Good', makeNode('Good'), meta(GOOD_CODE));

    const broken = registry.get('Line1/Broken')!;
    expect(broken.ok).toBe(false);
    expect(broken.isDisabled).toBe(true);
    expect(broken.error?.message).toContain('boom in setup');
    expect(disabled.length).toBe(1);
    expect(disabled[0]).toContain('Line1/Broken');

    // The scene keeps running: the good instance ticks unaffected.
    for (let i = 0; i < 5; i++) registry.tickAll(FIXED_DT);
    const probe = good.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(5);
    registry.dispose();
  });

  it('missing global setup function disables the instance', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const inst = registry.create('Line1/NoSetup', makeNode('NoSetup'), meta(`var x = 1;`));
    expect(inst.ok).toBe(false);
    expect(inst.error?.message).toContain('setup');
    registry.dispose();
  });

  it('first-tick handler error disables; later handler errors only log', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const disabled: string[] = [];
    const registry = makeRegistry(host, world, {
      onInstanceDisabled: (nodePath, reason) => disabled.push(reason),
    });

    // Fails on the FIRST tick → disabled (§4.4 "Fehler beim setup/erstem Tick").
    const firstTick = registry.create('Line1/FirstTick', makeNode('FirstTick'), meta(`
      function setup(self) {
        return { continuous: { fixedUpdate: function (dt) { throw new Error('first tick boom'); } } };
      }
    `));
    // Fails LATER (tick 3) → keeps running, only logs.
    const lateTick = registry.create('Line1/LateTick', makeNode('LateTick'), meta(`
      function setup(self) {
        var n = 0;
        return {
          continuous: { fixedUpdate: function (dt) { n++; if (n === 3) throw new Error('late boom'); } },
          probe: function () { return n; },
        };
      }
    `));

    registry.tickAll(FIXED_DT);
    expect(firstTick.isDisabled).toBe(true);
    expect(disabled.some((r) => r.includes('first tick boom'))).toBe(true);

    for (let i = 0; i < 4; i++) registry.tickAll(FIXED_DT);
    expect(lateTick.isDisabled).toBe(false);
    const probe = lateTick.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(5);   // survived the tick-3 throw
    registry.dispose();
  });
});
