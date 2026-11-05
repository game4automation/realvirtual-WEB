// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.4 / 9.8b — the start baseline (F6/F7) and its interactions.
 *
 *  - a pair that overlaps at its first evaluation raises no card and is listed
 *    once in Problems (`collision-start-overlap`); once it has been apart it is
 *    armed, and the next contact latches;
 *  - two STILL bodies that overlap (`authoredStill`) never alarm and are listed
 *    as `collision-authored-overlap`; when one of them moves while they still
 *    overlap, the pair becomes a start contact;
 *  - `simulation-reset` takes the baseline again — applied at the next tick head
 *    (F18);
 *  - `ResetCollisions`, `acknowledge` and `ignoreType` never touch a baseline pair;
 *  - the signals stay 0 while a pair is only in baseline;
 *  - the viewer events are subscribed per model and dropped by `clear()`
 *    (contract plugins 4).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  SIGNAL_COLLISION_ACTIVE, SIGNAL_COLLISION_COUNT, type CollisionViewerEvent,
} from '../src/core/engine/rv-collision-manager';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { clearAllProblems, getProblem } from '../src/core/hmi/problems-store';
import { bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';

const DT = 1 / 60;

/** Asset { Rail(Machine) static, Slide(Robot) mover overlapping the rail at start, Wall(Environment) far away } */
async function slideScene() {
  const s = await bakeCollisionScene(plainGroup('Asset',
    bodyNode('Rail', { role: 'Machine', size: [4, 0.4, 0.4] }),
    bodyNode('Slide', { role: 'Robot', mover: true, at: [0.5, 0.25, 0.05], size: [0.6, 0.3, 0.3] }),
    bodyNode('Wall', { role: 'Environment', at: [10, 0, 0], size: [0.5, 2, 2] }),
  ));
  const rail = s.node('Rail');
  const slide = s.node('Slide');
  const wall = s.node('Wall');
  s.manager.register(rail, 'Machine');
  s.manager.register(slide, 'Robot');
  s.manager.register(wall, 'Environment');
  const key = (n: string) => s.manager.bodies.find((b) => b.label === n)!.key;
  return { ...s, rail, slide, wall, key };
}

function reported(s: { manager: import('../src/core/engine/rv-collision-manager').RVCollisionManager }): string[] {
  return s.manager.activePairs.map((p) => [p.aPath, p.bPath].sort().join('|')).sort();
}

beforeEach(() => {
  __resetCollisionAlertStore();
  clearAllProblems();
});

describe('start baseline (plan-781 F7)', () => {
  it('a pair overlapping at the first tick raises no card, is listed once in Problems, and alarms after separating', async () => {
    const s = await slideScene();
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))).toEqual({ state: 'baseline', authoredStill: false });
    const entry = getProblem('collision-start-overlap');
    expect(entry?.severity).toBe('info');
    expect(entry?.quiet).toBe(true);
    expect(entry?.detail).toContain('Slide (Robot)');
    expect(entry?.detail).toContain('Rail (Machine)');

    // Still overlapping while it moves: stays quiet.
    s.slide.position.x = 0.6;
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);

    s.slide.position.y = 1;                       // apart → armed
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');
    s.slide.position.y = 0.25;                    // back in → card
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Rail|Slide']);
  });

  it('keeps the signals at 0 while a pair is only in baseline', async () => {
    const s = await slideScene();
    const store = new SignalStore();
    s.manager.attachSignals(store);
    s.manager.update(DT);
    s.slide.position.x = 0.7;
    s.manager.update(DT);
    expect(store.get(SIGNAL_COLLISION_ACTIVE)).toBe(false);
    expect(store.get(SIGNAL_COLLISION_COUNT)).toBe(0);
  });

  it('simulation-reset takes the baseline again — applied at the next tick head (F18)', async () => {
    const s = await slideScene();
    s.manager.update(DT);
    s.slide.position.y = 1;
    s.manager.update(DT);                         // armed
    s.slide.position.y = 0.25;
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Rail|Slide']);

    s.manager.reset();                            // what the PLC reset edge does …
    s.manager.resetBaseline();                    // … and what `simulation-reset` does
    // Not applied yet — only a flag until the tick head.
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');
    s.manager.update(DT);
    expect(reported(s)).toEqual([]);              // overlapping at the reset: a start contact
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('baseline');
    expect(getProblem('collision-start-overlap')).toBeTruthy();
  });

  it('a resetBaseline() arriving INSIDE a tick changes nothing in that tick', async () => {
    const s = await slideScene();
    s.manager.update(DT);
    s.slide.position.y = 1;
    s.manager.update(DT);                         // armed
    let calledInside = false;
    s.manager.setHighlightHost({
      showCollision: () => { calledInside = true; s.manager.resetBaseline(); },
      hideCollision: () => {},
    });
    s.slide.position.y = 0.25;
    s.manager.update(DT);                         // latches; the host resets the baseline mid-tick
    expect(calledInside).toBe(true);
    expect(reported(s)).toEqual(['Rail|Slide']);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');
    s.manager.update(DT);                         // applied at this head
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('unknown');
  });
});

describe('still-still overlaps (plan-781 F6)', () => {
  async function stillScene() {
    const s = await bakeCollisionScene(plainGroup('Asset',
      bodyNode('Floor', { role: 'Machine', size: [4, 0.4, 4] }),
      bodyNode('Fence', { role: 'Environment', at: [1, 0.3, 0.2], size: [0.2, 1, 2] }),
    ));
    s.manager.register(s.node('Floor'), 'Machine');
    s.manager.register(s.node('Fence'), 'Environment');
    const key = (n: string) => s.manager.bodies.find((b) => b.label === n)!.key;
    return { ...s, key };
  }

  it('never alarms, lists the pair once as an authored overlap', async () => {
    const s = await stillScene();
    for (let i = 0; i < 5; i++) s.manager.update(DT);
    expect(reported(s)).toEqual([]);
    expect(s.manager.pairStateOf(s.key('Floor'), s.key('Fence'))).toEqual({ state: 'baseline', authoredStill: true });
    expect(getProblem('collision-authored-overlap')?.detail).toContain('Fence (Environment)');
    expect(getProblem('collision-start-overlap')).toBeUndefined();
  });

  it('becomes a start contact once a body moves while they still overlap', async () => {
    const s = await stillScene();
    s.manager.update(DT);
    s.template.position.x = 0.1;                   // drag the whole placement: both bodies move
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Floor'), s.key('Fence'))).toEqual({ state: 'baseline', authoredStill: false });
    expect(getProblem('collision-authored-overlap')).toBeUndefined();
    expect(getProblem('collision-start-overlap')?.detail).toContain('Fence (Environment)');
    expect(reported(s)).toEqual([]);
  });
});

describe('interactions with reset / acknowledge / ignoreType (plan-781 §2.8)', () => {
  it('none of them touches a baseline pair; ignoreType re-publishes Problems without that type', async () => {
    const s = await slideScene();
    // A second, ARMED pair that latches: Slide ↔ Wall.
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('baseline');

    s.manager.reset();
    s.manager.acknowledge(s.key('Rail'), s.key('Slide'));
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('baseline');
    expect(reported(s)).toEqual([]);

    // The armed pair latches, acknowledge drops ONE latch and it re-latches.
    s.wall.position.set(0.9, 0, 0);                // static node: its chunk does not follow …
    s.slide.position.set(9.9, 0.25, 0.05);         // … so drive the slide into the wall
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Slide|Wall']);
    s.manager.acknowledge(s.key('Slide'), s.key('Wall'));
    expect(reported(s)).toEqual([]);
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Slide|Wall']);   // still intersecting → re-latched

    // Ignoring Machine|Robot drops the baseline pair and its Problems entry.
    expect(getProblem('collision-start-overlap')).toBeTruthy();
    s.manager.ignoreType('Machine', 'Robot');
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))).toBeNull();
    expect(getProblem('collision-start-overlap')).toBeUndefined();
    expect(reported(s)).toEqual(['Slide|Wall']);
  });

  it('a re-parent invalidate() during a contact keeps the pair armed and latched (F17)', async () => {
    const s = await slideScene();
    s.manager.update(DT);
    s.slide.position.y = 1;
    s.manager.update(DT);
    s.slide.position.y = 0.25;
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Rail|Slide']);
    s.manager.invalidate();
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Rail|Slide']);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');
  });
});

describe('viewer events (contract plugins 4)', () => {
  it('follows simulation-reset / visibility / placement events and drops them on clear()', async () => {
    const s = await slideScene();
    const listeners = new Map<CollisionViewerEvent, Set<() => void>>();
    const subscribe = (ev: CollisionViewerEvent, cb: () => void): (() => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => { listeners.get(ev)!.delete(cb); };
    };
    const emit = (ev: CollisionViewerEvent): void => { for (const cb of [...(listeners.get(ev) ?? [])]) cb(); };
    s.manager.attachEvents(subscribe);
    // Four viewer events plus the registry's release listener.
    expect([...listeners.values()].reduce((n, set) => n + set.size, 0)).toBe(4);

    s.manager.update(DT);
    s.slide.position.y = 1;
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');
    emit('simulation-reset');
    s.manager.update(DT);
    expect(s.manager.pairStateOf(s.key('Rail'), s.key('Slide'))?.state).toBe('armed');   // re-evaluated apart
    emit('layout-content-added');
    expect(s.manager.isDirty).toBe(true);
    s.manager.update(DT);
    emit('node-visibility-changed');
    expect(s.manager.isDirty).toBe(true);

    s.manager.clear();
    expect([...listeners.values()].reduce((n, set) => n + set.size, 0)).toBe(0);
  });
});
