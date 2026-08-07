// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sdk-supervisory.test.ts — plan-210 phase 1b supervisory API:
 *
 *  - `self.findAll(type)` + plain forEach = "call method on ALL of a type"
 *  - `self.component(path).send` / `onMessage` — deterministic script→script
 *    messaging through the target's event list
 *  - `self.broadcast`
 *  - `self.every` — recurring events, cancellable, auto-torn-down on reload
 *  - `onError(err, phase)` — soft error layer inside the script
 *  - `self.raiseError/clearError` — component-error event + `<Name>.Error`
 *    signal + readable via `component(path).error`
 *  - cell-coordinator e2e: ONE supervisor script drives TWO worker scripts
 *    over messages and reacts to a raised error.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import {
  RVWebComponentRegistry,
  parseWebComponent,
} from '../src/core/engine/rv-web-component-registry';
import type { SdkDriveTarget } from '../src/core/sdk/rv-sdk-self';

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

const FIXED_DT = 1 / 60;

interface World {
  drives: Array<SdkDriveTarget & { stopped: number }>;
  signals: Map<string, boolean | number>;
  events: Array<{ event: string; data: Record<string, unknown> }>;
  disabled: Array<{ nodePath: string; reason: string }>;
}

function makeWorld(): World {
  const mkDrive = (): SdkDriveTarget & { stopped: number } => ({
    currentPosition: 0, currentSpeed: 0, targetSpeed: 100,
    isAtTarget: true, jogForward: false, jogBackward: false,
    stopped: 0,
    startMove() {},
    stop() { this.stopped++; },
  });
  return {
    drives: [mkDrive(), mkDrive(), mkDrive()],
    signals: new Map(),
    events: [],
    disabled: [],
  };
}

function makeRegistry(host: RVScriptHost, world: World): RVWebComponentRegistry {
  return new RVWebComponentRegistry({
    host,
    callDeadlineMs: 500,
    emit: (event, data) => world.events.push({ event, data: data as Record<string, unknown> }),
    onInstanceDisabled: (nodePath, reason) => world.disabled.push({ nodePath, reason }),
    buildEnv: ({ nodePath, nodeName, node, props, scheduler }) => ({
      name: nodeName,
      path: nodePath,
      node,
      props,
      componentsAll: {
        drive: () => world.drives,
      },
      signals: {
        get: (n) => world.signals.get(n),
        set: (n, v) => world.signals.set(n, v),
      },
      scheduler,
      log: () => {},
    }),
  });
}

function addScript(registry: RVWebComponentRegistry, path: string, code: string): void {
  const node = new Object3D();
  node.name = path.split('/').pop()!;
  registry.create(path, node, parseWebComponent({ Code: code })!);
}

function tick(registry: RVWebComponentRegistry, seconds: number): void {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) registry.tickAll(FIXED_DT);
}

describe('SDK phase 1b — supervisory API', () => {
  it('findAll + forEach stops ALL drives (call-method-on-all pattern)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    addScript(registry, 'Cell/Supervisor', `
      function setup(self) {
        return {
          stopAll: function () {
            var drives = self.findAll('Drive');
            drives.forEach(function (d) { d.stop(); });
            return drives.length;
          },
        };
      }
    `);
    const inst = registry.get('Cell/Supervisor')!;
    const r = inst.component!.callHandler('stopAll');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(3);
    expect(world.drives.map((d) => d.stopped)).toEqual([1, 1, 1]);
    registry.dispose();
  });

  it('component(path).send → onMessage roundtrip via the event list (deterministic, next tick)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);

    addScript(registry, 'Cell/Worker', `
      function setup(self) {
        var received = [];
        self.setState('idle');
        return {
          onMessage: function (topic, data, from) {
            received.push(topic + ':' + JSON.stringify(data) + ':' + from);
            if (topic === 'start') self.setState('running');
          },
          received: function () { return received; },
        };
      }
    `);
    addScript(registry, 'Cell/Supervisor', `
      function setup(self) {
        return {
          kick: function () {
            var worker = self.component('Cell/Worker');
            if (!worker) return 'missing';
            return { sent: worker.send('start', { speed: 250 }), state: worker.state };
          },
          workerState: function () {
            return self.component('Cell/Worker').state;
          },
        };
      }
    `);

    const sup = registry.get('Cell/Supervisor')!.component!;
    const worker = registry.get('Cell/Worker')!.component!;

    const r = sup.callHandler('kick');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sent: true, state: 'idle' }); // not yet delivered

    // Delivery happens on the WORKER's next event dispatch (its tick drain).
    tick(registry, 2 * FIXED_DT);
    const rec = worker.callHandler('received');
    expect(rec.ok).toBe(true);
    expect(rec.value).toEqual(['start:{"speed":250}:Cell/Supervisor']);
    const ws = sup.callHandler('workerState');
    expect(ws.ok && ws.value).toBe('running');
    registry.dispose();
  });

  it('broadcast reaches every OTHER script component', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const workerCode = `
      function setup(self) {
        var topics = [];
        return {
          onMessage: function (topic) { topics.push(topic); },
          topics: function () { return topics; },
        };
      }
    `;
    addScript(registry, 'Cell/W1', workerCode);
    addScript(registry, 'Cell/W2', workerCode);
    addScript(registry, 'Cell/Supervisor', `
      function setup(self) {
        return { go: function () { return self.broadcast('halt', null); } };
      }
    `);
    const r = registry.get('Cell/Supervisor')!.component!.callHandler('go');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(2);
    tick(registry, 2 * FIXED_DT);
    for (const p of ['Cell/W1', 'Cell/W2']) {
      const t = registry.get(p)!.component!.callHandler('topics');
      expect(t.ok && t.value).toEqual(['halt']);
    }
    registry.dispose();
  });

  it('self.every fires repeatedly, cancel stops it, reload tears the chain down', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    const code = `
      function setup(self) {
        var fired = 0;
        var id = self.every(0.1, 'beat', { n: 1 });
        return {
          des: { on: function (hook, mu, data) { if (hook === 'beat' && data && data.n === 1) fired++; } },
          fired: function () { return fired; },
          stop: function () { self.cancel(id); },
        };
      }
    `;
    addScript(registry, 'Cell/Clock', code);
    const inst = registry.get('Cell/Clock')!;

    tick(registry, 0.55); // ~5 slices at 0.1 s
    let f = inst.component!.callHandler('fired');
    expect(f.ok).toBe(true);
    expect(f.value).toBe(5);

    // cancel → no further fires.
    expect(inst.component!.callHandler('stop').ok).toBe(true);
    tick(registry, 0.5);
    f = inst.component!.callHandler('fired');
    expect(f.value).toBe(5);

    // Reload (COLD) — the OLD chain must be dead, the new one starts fresh.
    registry.reload('Cell/Clock', code);
    const inst2 = registry.get('Cell/Clock')!;
    expect(inst2).not.toBe(inst);
    tick(registry, 0.25);
    const f2 = inst2.component!.callHandler('fired');
    expect(f2.value).toBe(2);
    // Old component's pending timers were cancelled on dispose.
    expect(inst.component!.bridge.pendingTimerCount).toBe(0);
    registry.dispose();
  });

  it('onError catches a handler error (handled=true keeps the component alive)', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    addScript(registry, 'Cell/Fragile', `
      function setup(self) {
        var caught = [];
        var boom = true;
        return {
          continuous: {
            fixedUpdate: function (dt) {
              if (boom) { boom = false; throw new Error('kaputt'); }
            },
          },
          onError: function (err, phase) {
            caught.push(phase + ':' + String(err && err.message));
            return true; // handled — keep running
          },
          caught: function () { return caught; },
        };
      }
    `);
    const inst = registry.get('Cell/Fragile')!;
    tick(registry, 0.1);
    expect(inst.ok).toBe(true);           // NOT disabled — onError handled it
    expect(world.disabled).toEqual([]);
    const c = inst.component!.callHandler('caught');
    expect(c.ok && c.value).toEqual(['fixedUpdate:kaputt']);
    registry.dispose();
  });

  it('unhandled first-tick error keeps the default behavior: instance disabled', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    addScript(registry, 'Cell/Broken', `
      function setup(self) {
        return {
          continuous: { fixedUpdate: function () { throw new Error('unhandled'); } },
          onError: function () { return false; },   // NOT handled
        };
      }
    `);
    tick(registry, FIXED_DT);
    const inst = registry.get('Cell/Broken')!;
    expect(inst.ok).toBe(false);
    expect(world.disabled.length).toBeGreaterThanOrEqual(1);
    expect(world.disabled[0].reason).toContain('unhandled');
    registry.dispose();
  });

  it('raiseError: component-error event + <Name>.Error signal + readable via component(path); clearError resets', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);
    addScript(registry, 'Cell/Machine', `
      function setup(self) {
        return {
          fail: function () { self.raiseError('E42', 'gripper jam'); },
          heal: function () { self.clearError(); },
        };
      }
    `);
    addScript(registry, 'Cell/Watcher', `
      function setup(self) {
        return {
          check: function () {
            var m = self.component('Cell/Machine');
            return m ? m.error : 'missing';
          },
        };
      }
    `);
    const machine = registry.get('Cell/Machine')!.component!;
    const watcher = registry.get('Cell/Watcher')!.component!;

    expect(machine.callHandler('fail').ok).toBe(true);
    expect(world.events).toEqual([
      { event: 'component-error', data: { nodePath: 'Cell/Machine', code: 'E42', message: 'gripper jam' } },
    ]);
    expect(world.signals.get('Machine.Error')).toBe(true);
    const seen = watcher.callHandler('check');
    expect(seen.ok && seen.value).toEqual({ code: 'E42', message: 'gripper jam' });

    expect(machine.callHandler('heal').ok).toBe(true);
    expect(world.signals.get('Machine.Error')).toBe(false);
    const cleared = watcher.callHandler('check');
    expect(cleared.ok).toBe(true);
    expect(cleared.value).toBeNull();
    registry.dispose();
  });

  it('cell coordinator e2e: supervisor starts two workers over messages and halts the cell on a raised error', async () => {
    const host = await makeHost();
    const world = makeWorld();
    const registry = makeRegistry(host, world);

    const workerCode = `
      function setup(self) {
        self.setState('idle');
        return {
          onMessage: function (topic, data, from) {
            if (topic === 'start') self.setState('running');
            if (topic === 'halt') self.setState('halted');
          },
          jam: function () { self.raiseError('E1', 'jam'); },
        };
      }
    `;
    addScript(registry, 'Cell/Worker1', workerCode);
    addScript(registry, 'Cell/Worker2', workerCode);
    addScript(registry, 'Cell/Supervisor', `
      function setup(self) {
        var workers = ['Cell/Worker1', 'Cell/Worker2'];
        var phase = 'boot';
        self.setState('boot');
        return {
          continuous: {
            fixedUpdate: function (dt) {
              if (phase === 'boot') {
                workers.forEach(function (w) { self.component(w).send('start', null); });
                phase = 'supervising'; self.setState('supervising');
                return;
              }
              if (phase === 'supervising') {
                for (var i = 0; i < workers.length; i++) {
                  var w = self.component(workers[i]);
                  if (w && w.error) {
                    self.broadcast('halt', { because: w.path });
                    phase = 'halted'; self.setState('halted');
                    return;
                  }
                }
              }
            },
          },
        };
      }
    `);

    // Boot: supervisor starts both workers; messages arrive on the next tick.
    tick(registry, 3 * FIXED_DT);
    expect(registry.getInfo('Cell/Worker1')!.state).toBe('running');
    expect(registry.getInfo('Cell/Worker2')!.state).toBe('running');
    expect(registry.getInfo('Cell/Supervisor')!.state).toBe('supervising');

    // Worker1 jams → supervisor sees the raised error and halts the cell.
    registry.get('Cell/Worker1')!.component!.callHandler('jam');
    tick(registry, 3 * FIXED_DT);
    expect(registry.getInfo('Cell/Supervisor')!.state).toBe('halted');
    expect(registry.getInfo('Cell/Worker1')!.state).toBe('halted');
    expect(registry.getInfo('Cell/Worker2')!.state).toBe('halted');
    registry.dispose();
  });
});
