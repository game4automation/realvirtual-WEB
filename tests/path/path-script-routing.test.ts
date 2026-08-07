// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-script-routing.test.ts — plan-268 Phase 6: routing/dispatch hooks over
 * the plan-210 ScriptHost, end-to-end through the REAL QuickJS VM.
 *
 * A project script (JS-in-GLB) declares `routing.*` handlers; the
 * web-component registry registers them as the path network's project router.
 * Verified here:
 *  - `routing.selectNextPath` steers a PathTraveler at a junction (sync
 *    host→VM dispatch, same pattern as the DES station handshake);
 *  - VALUE BOUNDARY (§2.4 S1): only plain JSON crosses — candidate ids as a
 *    plain string array, ctx as a POJO, path descriptors from `self.paths`;
 *  - `self.paths` queries (list/get/successors, mm lengths) and zone
 *    claim/release BY ID against the shared ZoneRegistry semantics;
 *  - default-holder ghost-claim hygiene + router unregistration on dispose;
 *  - without a script (or with an invalid pick) the default `successors[0]`
 *    routing stays untouched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { RVWebComponentRegistry, parseWebComponent } from '../../src/core/engine/rv-web-component-registry';
import {
  createPathNetworkPathsBackend,
  createPathNetworkRoutingBackend,
} from '../../src/core/sdk/rv-sdk-paths';
import { LineSegment, RVPath } from '../../src/core/engine/rv-path';
import { RVPathNetwork } from '../../src/core/engine/rv-path-network';
import { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';

const v3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const TICK = 1 / 60;
const V_06_PER_TICK = 0.6 * 1000 * 60; // mm/s advancing 0.6 m per tick

/** Junction fixture: M (1 m) forks into A and B (1 m each); B carries zone 'Cross'. */
function makeWorld(): { net: RVPathNetwork; zones: ZoneRegistry; m: RVPath } {
  const net = new RVPathNetwork();
  const zones = new ZoneRegistry();
  const m = new RVPath('M', [new LineSegment(v3(0, 0, 0), v3(0, 0, 1))], { successorIds: ['A', 'B'] });
  const a = new RVPath('A', [new LineSegment(v3(0, 0, 1), v3(-1, 0, 1))]);
  const b = new RVPath('B', [new LineSegment(v3(0, 0, 1), v3(1, 0, 1))], { zoneId: 'Cross', zoneCapacity: 1 });
  net.register(m); net.register(a); net.register(b);
  return { net, zones, m };
}

const hosts: RVScriptHost[] = [];
const registries: RVWebComponentRegistry[] = [];
afterEach(() => {
  for (const r of registries) r.dispose();
  registries.length = 0;
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

interface Fixture {
  registry: RVWebComponentRegistry;
  signals: Map<string, boolean | number>;
  net: RVPathNetwork;
  zones: ZoneRegistry;
  m: RVPath;
}

async function makeFixture(): Promise<Fixture> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  const { net, zones, m } = makeWorld();
  const signals = new Map<string, boolean | number>();
  const registry = new RVWebComponentRegistry({
    host,
    callDeadlineMs: 200,
    buildEnv: ({ nodePath, nodeName, node, props, scheduler }) => ({
      name: nodeName,
      path: nodePath,
      node,
      props,
      scheduler,
      signals: {
        get: (n) => signals.get(n),
        set: (n, v) => signals.set(n, v),
      },
      // Phase 6 backends over the ISOLATED test network/zone registry —
      // the same wiring web-component-plugin.ts uses against the defaults.
      paths: createPathNetworkPathsBackend({ network: net, zones }),
      routing: createPathNetworkRoutingBackend(nodePath, net),
      log: () => {},
    }),
  });
  registries.push(registry);
  return { registry, signals, net, zones, m };
}

function mount(f: Fixture, code: string, nodePath = 'Line1/Router'): void {
  const node = new Object3D();
  node.name = nodePath.split('/').pop()!;
  const meta = parseWebComponent({ Code: code })!;
  const inst = f.registry.create(nodePath, node, meta);
  expect(inst.ok).toBe(true);
}

describe('plan-268 Phase 6 — routing hooks from a project script (QuickJS)', () => {
  it('routing.selectNextPath steers the traveler; only plain JSON crosses the boundary', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        return {
          routing: {
            selectNextPath: function (ids, ctx) {
              // VALUE BOUNDARY probe: plain array of strings + POJO ctx.
              var plain = Array.isArray(ids)
                && typeof ids[0] === 'string'
                && typeof ctx === 'object'
                && typeof ctx.travelerId === 'string'
                && typeof ctx.currentPathId === 'string'
                && (ctx.direction === 1 || ctx.direction === -1);
              self.signal('BoundaryPlain').set(plain ? 1 : 0);
              self.signal('Candidates').set(ids.length);
              // Guest-side mutation must never leak back to the host.
              ids.push('Injected');
              return ids[1]; // 'B'
            },
            onArrive: function (pathId, agvId) {
              self.signal('Arrive.' + pathId).set(1);
            },
            requestDispatch: function (agvId) {
              var n = self.signal('Dispatch').num;
              self.signal('Dispatch').set(n + 1);
            },
          },
        };
      }
    `);

    const t = new PathTraveler('agv1', f.m, f.net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK); // crosses the M end → script routes to B

    expect(t.path?.id).toBe('B');
    expect(f.signals.get('BoundaryPlain')).toBe(1);
    expect(f.signals.get('Candidates')).toBe(2);
    expect(f.signals.get('Arrive.M')).toBe(1);
    // Host-side graph untouched by the guest push (marshalled copy).
    f.net.resolveGraph();
    expect(f.net.get('M')!.successors.map((p) => p.id)).toEqual(['A', 'B']);

    // Drive into the dead end of B → onArrive('B') + ONE dispatch request.
    t.advance(TICK);
    t.advance(TICK);
    expect(f.signals.get('Arrive.B')).toBe(1);
    expect(f.signals.get('Dispatch')).toBe(1);
    expect(t.v).toBe(0);  // the dead-end stop zeroed the speed
    t.advance(TICK);      // parked — no re-fire
    expect(f.signals.get('Dispatch')).toBe(1);
  });

  it('self.paths queries return plain descriptors (mm lengths, ids only)', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        var all = self.paths.list();
        self.signal('N').set(all.length);
        var m = self.paths.get('M');
        self.signal('M.length').set(m ? m.length : -1);        // mm
        self.signal('M.closed').set(m ? (m.closed ? 1 : 0) : -1);
        self.signal('M.succ').set(self.paths.successors('M').length);
        var b = self.paths.get('B');
        self.signal('B.zoned').set(b && b.zone === 'Cross' ? 1 : 0);
        self.signal('Unknown').set(self.paths.get('Nope') === null ? 1 : 0);
        return {};
      }
    `);
    expect(f.signals.get('N')).toBe(3);
    expect(f.signals.get('M.length')).toBeCloseTo(1000, 6); // 1 m → 1000 mm (drive parity)
    expect(f.signals.get('M.closed')).toBe(0);
    expect(f.signals.get('M.succ')).toBe(2);
    expect(f.signals.get('B.zoned')).toBe(1);
    expect(f.signals.get('Unknown')).toBe(1);
  });

  it('zone claim/release by id: default holder = component path, shared mutual exclusion', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        self.signal('Claimed').set(self.paths.claim('Cross') ? 1 : 0);
        self.signal('Held').set(self.paths.isHolder('Cross') ? 1 : 0);
        return {
          onSignal: function (name, value) {
            if (name === 'DoRelease' && value === true) self.paths.release('Cross');
          },
        };
      }
    `);
    expect(f.signals.get('Claimed')).toBe(1);
    expect(f.signals.get('Held')).toBe(1);
    // The claim is a REAL ZoneRegistry claim under the component path…
    expect(f.zones.isHolder('Cross', 'Line1/Router')).toBe(true);
    // …and blocks any other actor (capacity 1 — the Agv's own claim call).
    expect(f.zones.claim('Cross', 'agv1')).toBe(false);
    // Release by id from the script frees it for the AGV.
    f.registry.onSignalAll('DoRelease', true);
    expect(f.zones.isHolder('Cross', 'Line1/Router')).toBe(false);
    expect(f.zones.claim('Cross', 'agv1')).toBe(true);
  });

  it('dispose unregisters the router AND releases default-holder claims (ghost hygiene)', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        self.paths.claim('Cross');
        return { routing: { selectNextPath: function (ids) { return 'B'; } } };
      }
    `);
    expect(f.net.hasRouter).toBe(true);
    expect(f.zones.holderCount('Cross')).toBe(1);

    f.registry.disposeInstance('Line1/Router');

    expect(f.net.hasRouter).toBe(false);
    expect(f.zones.holderCount('Cross')).toBe(0); // bridge released the default holder
    // Default routing is back: successors[0] = A.
    const t = new PathTraveler('agv1', f.m, f.net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A');
  });

  it('an invalid script pick falls back to the default route (mechanics never derail)', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        return { routing: { selectNextPath: function (ids) { return 42; } } };
      }
    `);
    const t = new PathTraveler('agv1', f.m, f.net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A'); // non-string pick → candidates[0]
  });

  it('a script WITHOUT routing handlers registers no router (default untouched)', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        return { continuous: { fixedUpdate: function (dt) {} } };
      }
    `);
    expect(f.net.hasRouter).toBe(false);
  });

  it('hot-reload swaps the router cold (old unregistered, new active)', async () => {
    const f = await makeFixture();
    mount(f, `
      function setup(self) {
        return { routing: { selectNextPath: function (ids) { return 'B'; } } };
      }
    `);
    expect(f.net.hasRouter).toBe(true);
    f.registry.reload('Line1/Router', `
      function setup(self) {
        return { routing: { selectNextPath: function (ids) { return 'A'; } } };
      }
    `);
    expect(f.net.hasRouter).toBe(true);
    const t = new PathTraveler('agv1', f.m, f.net);
    t.v = V_06_PER_TICK;
    t.advance(TICK);
    t.advance(TICK);
    expect(t.path?.id).toBe('A'); // the NEW script routes
  });
});
