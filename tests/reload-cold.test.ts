// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * reload-cold.test.ts — plan-210 §4.4/§11: hot-reload resets closure state
 * (COLD policy, the default and only v1 policy) and swaps atomically under
 * the swap guard (a reload issued mid-tick is deferred to the tick end).
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

/** Closure counter: state that MUST be gone after a COLD reload. */
const COUNTER_CODE = `
function setup(self) {
  var n = 0;
  return {
    continuous: { fixedUpdate: function (dt) { n++; } },
    probe: function () { return n; },
  };
}
`;

const PATH = 'Line1/Gate';

describe('hot-reload — COLD state policy', () => {
  it('reload resets closure state; no ghost state survives', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    registry.create(PATH, makeNode('Gate'), meta(COUNTER_CODE));

    for (let i = 0; i < 10; i++) registry.tickAll(FIXED_DT);
    let probe = registry.get(PATH)!.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(10);

    registry.reload(PATH, COUNTER_CODE);

    // Fresh instance: closure counter starts at 0 again (like a sim reset
    // for this one component).
    probe = registry.get(PATH)!.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(0);
    for (let i = 0; i < 3; i++) registry.tickAll(FIXED_DT);
    probe = registry.get(PATH)!.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(3);
    registry.dispose();
  });

  it('reload emits component-reloaded and swaps to new code', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const events: string[] = [];
    const registry = makeRegistry(host, world, {
      emit: (event, data) => events.push(`${event}:${data.nodePath}`),
    });
    registry.create(PATH, makeNode('Gate'), meta(COUNTER_CODE));

    registry.reload(PATH, `
      function setup(self) {
        return { probe: function () { return 'v2'; } };
      }
    `);
    expect(events).toEqual([`component-reloaded:${PATH}`]);
    const probe = registry.get(PATH)!.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe('v2');
    registry.dispose();
  });

  it('swap guard: reload issued mid-tick is deferred to the tick end (no half-disposed tick)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    // The script calls self.setState every tick; the host onSetState hook
    // triggers a reload FROM WITHIN the tick pass — exactly the re-entrant
    // case the swap guard must defer.
    let reloadIssued = false;
    const registry = makeRegistry(host, world, {
      onSetState: (nodePath) => {
        if (!reloadIssued) {
          reloadIssued = true;
          registry.reload(nodePath, COUNTER_CODE);
          // Deferred: the instance must NOT have been swapped yet.
          expect(registry.get(PATH)).toBe(before);
        }
      },
    });
    registry.create(PATH, makeNode('Gate'), meta(`
      function setup(self) {
        return { continuous: { fixedUpdate: function (dt) { self.setState('tick'); } } };
      }
    `));
    const before = registry.get(PATH)!;

    registry.tickAll(FIXED_DT);

    expect(reloadIssued).toBe(true);
    const after = registry.get(PATH)!;
    expect(after).not.toBe(before);          // swap applied after the pass
    expect(before.isDisposed).toBe(true);    // old instance fully torn down
    expect(after.ok).toBe(true);
    // The swapped-in instance ticks normally from the next tick on.
    registry.tickAll(FIXED_DT);
    const probe = after.component!.callHandler('probe');
    expect(probe.ok && probe.value).toBe(1);
    registry.dispose();
  });

  it('reload of an unknown path warns and is a no-op', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    expect(() => registry.reload('Nope/Missing', COUNTER_CODE)).not.toThrow();
    expect(registry.size).toBe(0);
    registry.dispose();
  });
});
