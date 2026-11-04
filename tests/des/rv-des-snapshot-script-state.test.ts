// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESManager, DESMode } from '@rv/plugins/des/rv-des-manager';
import { makeScriptHookScheduler } from '@rv/plugins/des/rv-des-script-hook';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent, type SdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import type { SdkEnvironment } from '../../src/core/sdk/rv-sdk-self';

const SCRIPT_PATH = 'Cell/ScriptStation';

// The pending beat is restored from queue data, without re-arming.
const SCRIPT_CODE = `
function setup(self) {
  const st = self.persist({ n: 0, hist: [], nextAt: 1 });
  self.at(st.nextAt, 'beat');
  return {
    des: { on(hook) {
      if (hook !== 'beat') return;
      st.n++;
      st.hist.push([self.now, Math.floor(self.random() * 1000000)]);
      st.nextAt = self.now + 1;
      self.at(st.nextAt, 'beat');
    } },
    state() { return st; },
  };
}
`;

interface ScriptSim {
  runner: DESRunner;
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

async function makeScriptSim(code = SCRIPT_CODE, props: Record<string, number | string | boolean | null> = {}, bypassAstForControl = false): Promise<ScriptSim> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  const runner = new DESRunner();
  const manager = runner.getManager();
  manager.mode = DESMode.Animated;
  manager.duration = 100000;

  const dispatcher = { dispatchScriptHook: (hook: string, mu: Parameters<RVScriptComponentAdapter['dispatchScriptHook']>[1], data: unknown) => adapter.dispatchScriptHook(hook, mu, data) };
  const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
    mode: 'des',
    desScheduler: makeScriptHookScheduler(manager, dispatcher),
  });
  runner.setScriptComponentSource(() => [{ path: SCRIPT_PATH, desId: '#ScriptStation@Script', source: code, adapter: Object.assign(dispatcher, {
    captureScriptState: () => adapter.captureScriptState(),
    restoreScriptState: (state: Parameters<RVScriptComponentAdapter['restoreScriptState']>[0]) => adapter.restoreScriptState(state),
  }) }]);
  runner.start([], { root: new Object3D() });
  await whenDocumentHashesSettled();
  manager.mode = DESMode.Animated;
  manager.duration = 100000;
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
  // Only the negative control bypasses the production binding gate.
  adapter.attach(bypassAstForControl ? { ...component, source: undefined } : component);
  return {
    runner, manager, adapter, component,
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

describe('DES script snapshot continuation', () => {
  it.each(['A', 'B'])('%s: pending hook fires exactly once and persist identity survives', async mode => {
    const sim = await makeScriptSim();
    sim.runTo(3.25);
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(7.25);
    const expected = sim.state();
    const target = mode === 'A' ? sim : await makeScriptSim();
    target.runner.restoreFull(snapshot);
    target.runTo(7.25);
    expect(target.state()).toEqual(expected);
    expect((target.state() as { n: number }).n).toBe(7);
  });
  it('Mode B control: bypassing the gate loses a factory closure counter', async () => {
    const code = `function setup(self) {
      function make(n = 0) { return () => ++n; }
      return { state: make(), des: { on() {} } };
    }`;
    const sim = await makeScriptSim(code, {}, true);
    expect(sim.state()).toBe(1);
    const snapshot = sim.runner.fullSnapshot();
    expect(sim.state()).toBe(2);
    const fresh = await makeScriptSim(code, {}, true);
    fresh.runner.restoreFull(snapshot);
    expect(sim.state()).toBe(3);
    expect(fresh.state()).toBe(1);
  });
  it('review: replaced intrinsics cannot fake the guest verdict (gate bypassed)', async () => {
    const sim = await makeScriptSim(`function setup(self) {
      const st = self.persist({ x: 1 });
      return { des: { on() { Object.getOwnPropertyDescriptor = () => ({ enumerable: true, value: 0 });
        JSON.stringify = () => '{}'; st.bad = () => 1; } } };
    }`, {}, true);
    sim.adapter.dispatchScriptHook('go', null, null);
    expect(() => sim.runner.fullSnapshot()).toThrow('des-snapshot-contract');
  });
  it('does not bind factory closure handlers in DES mode', async () => {
    await expect(makeScriptSim(`function setup(self) {
      function make(n=0) { return () => ++n; }
      return {des:{on:make()}};
    }`)).rejects.toThrow('des-script-undeclared-state');
  });
  it('keeps the legacy facade without re-arming hooks', async () => {
    const sim = await makeScriptSim(`function setup(self) {
      const st = self.persist({n: 1});
      return { onSnapshot() { return {saved: st.n}; },
        onRestore(s) { st.n = s.saved; }, state() { return st.n; },
        des: { on() { st.n++; } } };
    }`);
    const snapshot = sim.runner.fullSnapshot();
    sim.adapter.dispatchScriptHook('increment', null, null);
    sim.runner.restoreFull(snapshot);
    expect(sim.state()).toBe(1);
  });
  it('refuses an unknown hook owner before mutation', async () => {
    const sim = await makeScriptSim();
    sim.runTo(2.25);
    const snapshot = sim.runner.fullSnapshot();
    const event = snapshot.eventQueue.find(e => e.action === 'Script.Hook')!;
    event.data = {hook: 'beat', desId: 'unknown', mu: null, data: null};
    const before = sim.state();
    expect(() => sim.runner.restoreFull(snapshot)).toThrow('des-snapshot-contract');
    expect(sim.state()).toEqual(before);
  });
  it.each(['({x: NaN})', '({x: -0})', 'new Map()', '({get x(){return 1}})', '({x: undefined})', '([,1])', '({$map: []})', '(() => { const x = {}; return {a:x,b:x}; })()', '(() => { const x = {}; x.x=x; return x; })()'])('refuses guest value %s', async value => {
    const sim = await makeScriptSim(`function setup(self) { const st = self.persist({x: 1}); return { des: { on() { st.bad = ${value}; } } }; }`);
    sim.adapter.dispatchScriptHook('mutate', null, null);
    expect(() => sim.runner.fullSnapshot()).toThrow('des-snapshot-contract');
  });
});
