// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * simulation-kernel-des-lifecycle.test.ts — plan-645 L1 / R2-1.
 *
 * The kernel is the emitter of the DES lifecycle: it forwards the runner's
 * events, holds `bound` back while `setMode` runs (a listener then sees the new
 * mode and `desControl() !== null`), delivers ending events (`reset`,
 * `disposed`) synchronously before the teardown, drops a failed start's
 * `bound` on rollback and replays `bound` to a late subscriber. Public test:
 * a fake DES executor stands in for the private runner.
 */

import { describe, it, expect } from 'vitest';
import {
  SimulationKernel,
  type DesLifecycleEvent,
  type DesLifecycleListener,
} from '../src/core/material-flow/simulation-kernel';
import { ContinuousRunner } from '../src/core/material-flow/continuous-runner';
import type { SimulationExecutor } from '../src/core/material-flow/simulation-executor';

const TOPO = { root: {} as never };

function continuous(): ContinuousRunner {
  const transport = { mus: [] as unknown[], update(): void {}, reset(): void { this.mus.length = 0; } };
  return new ContinuousRunner(transport, { tick(): void {} });
}

interface FakeDes extends SimulationExecutor {
  failStart: boolean;
  generation: number;
}

/** A fake DES executor with the lifecycle service (bound on start, reset on clear). */
function fakeDes(): FakeDes {
  const listeners: DesLifecycleListener[] = [];
  let state: 'idle' | 'bound' | 'ended' | 'disposed' = 'idle';
  const fake = {
    mode: 'des' as const,
    muCount: 0,
    failStart: false,
    generation: 0,
    subMode: 'animated',
    setSubMode(): void {},
    emit(type: DesLifecycleEvent['type']): void {
      fake.generation++;
      const e = { type, generation: fake.generation, runnerId: 7 };
      for (const fn of listeners.slice()) fn(e);
    },
    onLifecycle(fn: DesLifecycleListener): () => void {
      listeners.push(fn);
      return () => { listeners.splice(listeners.indexOf(fn), 1); };
    },
    start(): void {
      state = 'bound';
      fake.emit('bound');
      if (fake.failStart) throw new Error('start failed');
    },
    clearMUs(): void { if (state === 'bound') { state = 'ended'; fake.emit('reset'); } },
    suspend(): void { fake.clearMUs(); },
    reset(): void { fake.clearMUs(); fake.start(); },
    tick(): void {},
    dispose(): void { fake.clearMUs(); state = 'disposed'; fake.emit('disposed'); },
  };
  return fake as unknown as FakeDes;
}

function kernelWith(des: FakeDes): SimulationKernel {
  return new SimulationKernel({ continuousRunner: continuous(), topology: TOPO, desRunnerFactory: () => des });
}

describe('plan-645 L1 / R2-1 — kernel DES lifecycle forwarding', () => {
  it('bound is held back until the switch committed: the listener sees mode des and desControl()', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    const seen: string[] = [];
    k.onDesLifecycle((e) => { seen.push(`${e.type}@${e.generation} mode=${k.mode} ctl=${k.desControl() !== null}`); });
    k.setMode('des');
    expect(seen).toEqual(['bound@1 mode=des ctl=true']);
    expect(k.hasDesLifecycle()).toBe(true);
  });

  it('reset arrives synchronously inside setMode, before the outgoing runner is torn down', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    k.setMode('des');
    const seen: string[] = [];
    k.onDesLifecycle((e) => { seen.push(`${e.type} switching=${k.isSwitching}`); });
    k.setMode('continuous');
    expect(seen).toEqual(['reset switching=true']);
  });

  it('a failed start drops its bound (and swallows its reset); the kernel stays continuous', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    const seen: string[] = [];
    k.onDesLifecycle((e) => seen.push(e.type));
    des.failStart = true;
    const origError = console.error;
    console.error = () => {};
    try { k.setMode('des'); } finally { console.error = origError; }
    expect(k.mode).toBe('continuous');
    expect(seen, 'nobody saw the failed runner bound').toEqual([]);
    des.failStart = false;
    k.setMode('des');
    expect(seen).toEqual(['bound']);
  });

  it('outside setMode everything is delivered at once (kernel.reset → reset, bound)', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    k.setMode('des');
    const seen: string[] = [];
    k.onDesLifecycle((e) => seen.push(e.type));
    k.reset();
    expect(seen).toEqual(['reset', 'bound']);
  });

  it('replay delivers the current bound to a late subscriber, only in DES mode', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    const early: string[] = [];
    k.onDesLifecycle((e) => early.push(e.type), { replay: true });
    expect(early, 'nothing bound yet').toEqual([]);
    k.setMode('des');
    const late: DesLifecycleEvent[] = [];
    k.onDesLifecycle((e) => late.push(e), { replay: true });
    expect(late.map((e) => `${e.type}@${e.generation}`)).toEqual(['bound@1']);
    k.setMode('continuous');
    const afterOut: string[] = [];
    k.onDesLifecycle((e) => afterOut.push(e.type), { replay: true });
    expect(afterOut, 'no replay outside DES').toEqual([]);
  });

  it('dispose forwards disposed; a throwing listener does not stop the others; unsubscribe works', () => {
    const des = fakeDes();
    const k = kernelWith(des);
    k.setMode('des');
    const seen: string[] = [];
    const origError = console.error;
    console.error = () => {};
    k.onDesLifecycle(() => { throw new Error('boom'); });
    const off = k.onDesLifecycle(() => seen.push('gone'));
    off();
    k.onDesLifecycle((e) => seen.push(e.type));
    try { k.dispose(); } finally { console.error = origError; }
    expect(seen).toEqual(['reset', 'disposed']);
  });

  it('an executor without onLifecycle never emits (older private build)', () => {
    const plain = fakeDes() as unknown as Record<string, unknown>;
    delete plain.onLifecycle;
    const k = kernelWith(plain as unknown as FakeDes);
    const seen: string[] = [];
    k.onDesLifecycle((e) => seen.push(e.type));
    k.setMode('des');
    expect(seen).toEqual([]);
    expect(k.hasDesLifecycle()).toBe(false);
  });
});
