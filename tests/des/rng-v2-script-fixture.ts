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
import { scriptSeed32 } from '../../src/core/rv-rng-streams';

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

export async function makeScriptSim(code = SCRIPT_CODE, props: Record<string, number | string | boolean | null> = {}, bypassAstForControl = false): Promise<ScriptSim> {
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
    setRunRngSeed: (seed: number | null, next?: () => number | null) => adapter.setRunRngSeed(seed, next),
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
    path: SCRIPT_PATH,   // same path gives the same initial seed
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

export const CODE = `function setup(self) {
  const st = self.persist({hist: []});
  return {
    onReset() { st.hist.length = 0; self.at(self.now + 1, 'beat'); },
    des: { on(hook) { if (hook !== 'beat') return;
      st.hist.push(self.random()); self.at(self.now + 1, 'beat');
    } },
    state() { return st.hist; }
  };
}`;
export function restart(sim: ScriptSim, seed: number, version: 1 | 2 = 2): void {
  if (sim.manager.rngVersion !== version) sim.manager.reset();
  sim.manager.setRngVersion(version);
  sim.runner.setMasterSeed(seed);
  sim.runner.reset();
  sim.adapter.reset();
}

