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

async function makeScriptSim(code = SCRIPT_CODE, props: Record<string, number | string | boolean | null> = {}): Promise<ScriptSim> {
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
  adapter.attach(component);
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

describe('self.every snapshot data', () => {
  const code = `function setup(self) {
    const st = self.persist({pid: 0, hits: [], next: 0});
    return { state() { return st; }, des: { on(hook, mu, data) {
      if (hook === 'create') st.pid = self.every(1, 'beat', {value: 7});
      if (hook === 'beat') st.hits.push([self.now, data.value]);
      if (hook === 'cancel') self.cancel(st.pid);
      if (hook === 'next') st.next = self.every(10, 'other');
    } } };
  }`;
  it.each(['A', 'B'])('%s restores a runtime timer, cancellation and the next pid', async mode => {
    const sim = await makeScriptSim(code);
    sim.adapter.dispatchScriptHook('create', null, null);
    sim.runTo(2.25);
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(5.25);
    const expected = sim.state();
    sim.adapter.dispatchScriptHook('next', null, null);
    const next = (sim.state() as {next: number}).next;
    sim.adapter.dispatchScriptHook('cancel', null, null);
    const target = mode === 'A' ? sim : await makeScriptSim(code);
    target.runner.restoreFull(snapshot);
    target.runTo(5.25);
    expect(target.state()).toEqual(expected);
    target.adapter.dispatchScriptHook('next', null, null);
    expect((target.state() as {next: number}).next).toBe(next);
  });
  it.each(['A', 'B'])('%s cancels immediately after restore', async mode => {
    const sim = await makeScriptSim(code);
    sim.adapter.dispatchScriptHook('create', null, null);
    sim.runTo(2.25);
    const snapshot = sim.runner.fullSnapshot();
    const expected = sim.state();
    const target = mode === 'A' ? sim : await makeScriptSim(code);
    target.runner.restoreFull(snapshot);
    target.adapter.dispatchScriptHook('cancel', null, null);
    target.runTo(5.25);
    expect(target.state()).toEqual(expected);
  });
  it('validates timer payloads before the guest dump', async () => {
    const sim = await makeScriptSim(`function setup(self) {
      return { des: { on() { self.every(1, 'beat', {get value() {return 1}}); } } };
    }`);
    sim.adapter.dispatchScriptHook('create', null, null);
    expect(() => sim.runner.fullSnapshot()).toThrow('des-snapshot-contract');
  });
});
