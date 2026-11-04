// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Stress-test finding (2026-11-03, PalletYard 8 h FF): the first run after load and every
// run after Reset differed in the state shares (Conveyor_A2 Empty 0.3 % / Blocked 96.3 %
// first, 0.1 % / 96.5 % after Reset) with an identical event count. Cause: Reset kept each
// component's state machine (`currentStateName` 'Blocked' at the end of the run), so the
// next run started at t = 0 already "Blocked" with load 0 and booked its initial empty
// period as Blocked. A run after Reset must start exactly like the first run.

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { selfRunStateOf } from '../../src/core/material-flow/material-flow-self';

type Kpis = { states: Record<string, { duration: number; entries: number }>; current: string; processed: number; rawProcessed: number };

describe('DES run after Reset equals the first run after load', () => {
  it('reports the same state shares, entries and counters for every component', () => {
    // Source -> Station -> End (end of line, holds its MU forever): Station fills once,
    // cannot hand over to the full End station and ends the run Blocked; before its
    // first MU arrives it is Empty.
    const scene = new Scene();
    for (const [name, props] of [['Source', { Interval: 7 }], ['Station', { ProcessingTime: 3 }], ['End', { ProcessingTime: 3 }]] as const) {
      const node = new Object3D(); node.name = name;
      node.userData.realvirtual = { [name === 'End' ? 'Station' : name]: props }; scene.add(node);
    }
    const fx = runnerFixture(scene);
    const [source, station, end] = ['Source', 'Station', 'End'].map((n) => fx.components.find((c) => c.node.name === n)!);
    source.nextComponents = [station]; station.previousComponents = [source];
    station.nextComponents = [end]; end.previousComponents = [station];
    fx.manager.statResetTime = 0;
    // Closure-held self run state (FSM phase, statState de-dupe key) as a fresh bind has it.
    const selfRun = () => Object.fromEntries(fx.components.map((c) => [c.node.name, selfRunStateOf(c.self)?.capture()]));
    const freshSelfRun = selfRun();
    fx.runner.start([], { root: scene, host: fx.host });
    const runUntil = (time: number) => fx.manager.processUpTo(time, 100000);
    const horizon = 200;
    const capture = (): Record<string, Kpis> => Object.fromEntries(fx.components.map((c) => {
      const s = c.getStatistics();
      const states = Object.fromEntries(Object.entries(s.states).map(([k, v]) => [k, { duration: +v.duration.toFixed(6), entries: v.entries }]));
      return [c.node.name, { states, current: s.currentState, processed: s.totalProcessed, rawProcessed: c.totalProcessed }];
    }));

    runUntil(horizon);
    const first = capture();
    const firstEvents = fx.manager.totalEventsProcessed;
    expect(first.Station.current).toBe('Blocked');
    expect(first.Station.states.Empty?.duration ?? 0).toBeGreaterThan(0);

    for (let run = 1; run <= 2; run++) {
      fx.runner.reset();
      runUntil(horizon);
      expect(fx.manager.totalEventsProcessed, `run ${run} events`).toBe(firstEvents);
      expect(capture(), `run ${run} KPIs`).toEqual(first);
    }
    expect(selfRun().Station).not.toEqual(freshSelfRun.Station); // the run moved the FSM on
    fx.runner.clearMUs();
    expect(selfRun()).toEqual(freshSelfRun);
  });
});
