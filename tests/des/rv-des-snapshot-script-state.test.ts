// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-261 tests §9.1 / §9.11 — script-state serialization:
 *
 *  - 9.1  Determinism core of F3/F4: a script holding state in a FREE closure
 *         variable (deliberately NOT via self.prop) plus `self.random()` runs
 *         IDENTICALLY after a snapshot/restore — verified at the restore
 *         point, at an intermediate point, and at the end (guards against
 *         false-green via random re-convergence). State is persisted via the
 *         onSnapshot()/onRestore() hooks — the only supported channel.
 *  - 9.11 Negative (B7): a `self.prop.x = 5` write inside the QuickJS script
 *         never reaches the host prop bag and is NOT persisted in the
 *         snapshot; only the onSnapshot() payload is.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESManager, DESMode } from '@rv-private/plugins/des/rv-des-manager';
import { makeScriptHookScheduler } from '@rv-private/plugins/des/rv-des-script-hook';
import { createSnapshot, restoreSnapshot } from '@rv-private/plugins/des/rv-des-snapshot';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent, type SdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import type { SdkEnvironment } from '../../src/core/sdk/rv-sdk-self';

const SCRIPT_PATH = 'Cell/ScriptStation';

/**
 * Counter + seeded-random history in FREE closure variables, beat chain via
 * absolute-time one-shots (`self.at`). onSnapshot stores the closure state +
 * the next beat time; onRestore re-injects it and re-arms the chain — exact
 * continuation, no drift.
 */
const SCRIPT_CODE = `
function setup(self) {
  let n = 0;
  let hist = [];
  let nextAt = 1.0;
  self.at(nextAt, 'beat');
  return {
    des: { on(hook) {
      if (hook !== 'beat') return;
      n = n + 1;
      hist.push([self.now, Math.floor(self.random() * 1000000)]);
      nextAt = self.now + 1.0;
      self.at(nextAt, 'beat');
    } },
    onSnapshot() { return { n: n, hist: hist, nextAt: nextAt }; },
    onRestore(s) { n = s.n; hist = s.hist; nextAt = s.nextAt; self.at(nextAt, 'beat'); },
    state() { return { n: n, hist: hist }; },
  };
}
`;

interface ScriptSim {
  manager: DESManager;
  adapter: RVScriptComponentAdapter;
  component: SdkComponent;
  runTo(t: number): void;
  state(): unknown;
}

const hosts: RVScriptHost[] = [];
const components: SdkComponent[] = [];
afterEach(() => {
  for (const c of components) c.dispose();
  components.length = 0;
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

async function makeScriptSim(code = SCRIPT_CODE, props: Record<string, number | string | boolean | null> = {}): Promise<ScriptSim> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  const manager = new DESManager();
  manager.mode = DESMode.Animated;
  manager.duration = 100000;

  const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
    mode: 'des',
    desScheduler: makeScriptHookScheduler(manager, {
      dispatchScriptHook: (hook, mu, data) => adapter.dispatchScriptHook(hook, mu, data),
    }),
  });
  const node = new Object3D();
  node.name = 'ScriptStation';
  const env: SdkEnvironment = {
    name: 'ScriptStation',
    path: SCRIPT_PATH,   // same path ⇒ same derived seed in every sim instance
    node,
    props,
    scheduler: adapter.scheduler,
    log: () => {},
  };
  const component = createSdkComponent(host, env, code, { callDeadlineMs: 500 });
  expect(component.ok).toBe(true);
  components.push(component);
  adapter.attach(component);

  return {
    manager, adapter, component,
    runTo(t: number): void {
      let guard = 0;
      while (manager.currentTime < t && guard++ < 200000) manager.processAnimated(0.05);
    },
    state(): unknown {
      const r = component.callHandler('state');
      expect(r.ok).toBe(true);
      return r.value;
    },
  };
}

describe('DES snapshot — script state determinism (9.1)', () => {
  it('restore + continue == uninterrupted run (closure var + self.random, via onSnapshot/onRestore)', async () => {
    // Reference: uninterrupted run to t=8.
    const ref = await makeScriptSim();
    ref.runTo(8.2);
    const refState = ref.state() as { n: number; hist: Array<[number, number]> };
    expect(refState.n).toBeGreaterThanOrEqual(8);

    // Cut: run to t=3.6, snapshot (incl. script state via the B4 access path).
    const cut = await makeScriptSim();
    cut.runTo(3.6);
    const snap = createSnapshot(cut.manager, [], [], [], null, [
      { path: SCRIPT_PATH, adapter: cut.adapter },
    ]);
    const cutState = cut.state() as { n: number };
    expect(snap.version).toBe(3);
    expect(snap.scriptStates?.[SCRIPT_PATH]).toBeDefined();
    expect(typeof snap.scriptStates![SCRIPT_PATH].rng).toBe('number');

    // Fresh sim + fresh VM: restore — state matches EXACTLY at the cut point.
    const fresh = await makeScriptSim();
    restoreSnapshot(snap, fresh.manager, [], [], [], null, undefined, [
      { path: SCRIPT_PATH, adapter: fresh.adapter },
    ]);
    expect(fresh.manager.currentTime).toBeCloseTo(cut.manager.currentTime, 9);
    expect(fresh.state()).toEqual(cut.state());
    expect((fresh.state() as { n: number }).n).toBe(cutState.n);

    // Intermediate comparison (guards against random re-convergence): the
    // reference history prefix must match exactly.
    fresh.runTo(6.1);
    const midState = fresh.state() as { n: number; hist: Array<[number, number]> };
    expect(midState.hist).toEqual(refState.hist.slice(0, midState.hist.length));
    expect(midState.hist.length).toBeGreaterThan(cutState.n);

    // End comparison: full equality with the uninterrupted run.
    fresh.runTo(8.2);
    expect(fresh.state()).toEqual(refState);
  });

  it('a snapshot WITHOUT script sources restores with a warning for unknown script paths', async () => {
    const cut = await makeScriptSim();
    cut.runTo(2.2);
    const snap = createSnapshot(cut.manager, [], [], [], null, [
      { path: SCRIPT_PATH, adapter: cut.adapter },
    ]);

    // Restore into a sim whose script lives at a DIFFERENT path.
    const other = await makeScriptSim();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      restoreSnapshot(snap, other.manager, [], [], [], null, undefined, [
        { path: 'Cell/Other', adapter: other.adapter },
      ]);
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes('Unknown script component path'))).toBe(true);
  });
});

describe('DES snapshot — self.prop is NOT persisted (9.11, B7 negative)', () => {
  it('a self.prop write in the QuickJS script neither reaches the host nor the snapshot', async () => {
    const PROP_CODE = `
function setup(self) {
  let n = 0;
  self.at(1.0, 'tick');
  return {
    des: { on(hook) {
      if (hook !== 'tick') return;
      n = n + 1;
      self.prop.x = 5;           // guest-side VM copy only — never marshalled back
      self.prop.Speed = 999;
    } },
    onSnapshot() { return { n: n }; },
    readProp() { return self.prop.x; },
  };
}
`;
    const hostProps: Record<string, number | string | boolean | null> = { Speed: 1.0 };
    const sim = await makeScriptSim(PROP_CODE, hostProps);
    sim.runTo(1.5);

    // Guest sees its own write...
    const guest = sim.component.callHandler('readProp');
    expect(guest.ok).toBe(true);
    expect(guest.value).toBe(5);

    // ...but the HOST prop bag is untouched (read-only configuration, B7).
    expect(hostProps['Speed']).toBe(1.0);
    expect('x' in hostProps).toBe(false);

    // And the snapshot persists ONLY the onSnapshot() payload.
    const snap = createSnapshot(sim.manager, [], [], [], null, [
      { path: SCRIPT_PATH, adapter: sim.adapter },
    ]);
    const saved = snap.scriptStates?.[SCRIPT_PATH];
    expect(saved).toBeDefined();
    expect(saved!.state).toEqual({ n: 1 });
    expect(JSON.stringify(saved)).not.toContain('999');
  });
});
