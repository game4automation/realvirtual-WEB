// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeAll, describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESManager, DESMode } from '@rv/plugins/des/rv-des-manager';
import { makeScriptHookScheduler } from '@rv/plugins/des/rv-des-script-hook';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent, type SdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import type { SdkEnvironment } from '../../src/core/sdk/rv-sdk-self';

import SCRIPT_CODE from '../../examples/scripts/des-counter-persist.js?raw';
import { lintDesSafety, loadDesAstCheck } from '../../src/core/sdk/rv-des-lint';
import { canonicalJson } from '../helpers/des-continuation-harness';

beforeAll(loadDesAstCheck);
const SCRIPT_PATH = 'Cell/ScriptStation';
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
    path: SCRIPT_PATH,   // same path â‡’ same derived seed in every sim instance
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

describe('self.persist counter example', () => {
  it('passes DES safety including the AST state check', () => {
    expect(lintDesSafety(SCRIPT_CODE, { desSafe: true, checkState: true })).toEqual([]);
  });

  it('diagnoses a counter hidden in module state', () => {
    const code = 'let n = 0;\n' + SCRIPT_CODE
      .replace('st.counter++;', 'n++; st.counter = n;');
    const findings = lintDesSafety(code, { desSafe: true, checkState: true })
      .filter(d => d.rule === 'des-script-undeclared-state');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 1, severity: 'error', message: expect.stringContaining('use self.persist') }),
    ]));
  });

  it.each(['A', 'B'] as const)('%s continues bit-exactly between ticks', async mode => {
    const sim = await makeScriptSim();
    sim.runTo(2.25);
    expect(sim.manager.currentTime).toBeGreaterThan(2);
    expect(sim.manager.currentTime).toBeLessThan(3);
    const saved = sim.runner.fullSnapshot();
    sim.runTo(6.25);
    const expected = sim.state();
    expect(expected).toMatchObject({ counter: 6, history: expect.any(Array) });
    const time = sim.manager.currentTime;
    const nextEventId = sim.manager.nextEventId;
    const parts = canonicalJson(sim.runner.fullSnapshot().parts);
    const target = mode === 'A' ? sim : await makeScriptSim();
    target.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    target.runTo(6.25);
    expect(target.state()).toEqual(expected);
    expect(target.manager.currentTime).toBe(time);
    expect(target.manager.nextEventId).toBe(nextEventId);
    expect(canonicalJson(target.runner.fullSnapshot().parts)).toBe(parts);
  });

  it('B-immediate preserves the parts JSON', async () => {
    const sim = await makeScriptSim();
    sim.runTo(2.25);
    const saved = sim.runner.fullSnapshot();
    const target = await makeScriptSim();
    target.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    const restored = target.runner.fullSnapshot();
    expect(canonicalJson(restored.parts)).toBe(canonicalJson(saved.parts));
    expect(target.state()).toEqual(sim.state());
    expect(target.manager.currentTime).toBe(saved.simTime);
    expect(target.manager.nextEventId).toBe(saved.nextEventId);
  });
});