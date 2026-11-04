// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-645 L6 / S7 (part of 9.5) — signal ownership over the bind lifetime:
// every signal a scene instance declares gets an owner path of the bind; the
// end of the bind (reset / suspend / dispose) releases exactly those, so an
// unscoped name nobody else owns does not stay behind (c3/c7). A model path
// stays the preferred path through bind AND release; a forced name is kept.
// Owner granularity since plan-2006 Phase 6 #27 (4664254e): ONE fixed path per runner and
// name (`__des-owner__/<runnerId>/<name>`) — no generation, no node UUID — so a forced signal
// does not grow an owner path per reset (des-forced-signal-owner 9.25). Two instances sharing
// an unscoped name therefore share that one path; a reset reclaims the same path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { line, lineDefs, newRunner, resetWorld } from './des-lifecycle-line';

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

const desOwners = (store: { registeredPaths(n: string): readonly string[] }, name: string): string[] =>
  store.registeredPaths(name).filter((p) => p.startsWith('__des-owner__/'));

function allDesOwnerPaths(store: unknown): string[] {
  const m = (store as { pathToName: Map<string, string> }).pathToName;
  return [...m.keys()].filter((p) => p.startsWith('__des-owner__/'));
}

describe('plan-645 L6 — DES signal ownership', () => {
  it('unscoped names leave the store when the bind ends (suspend), and come back with the next bind', () => {
    const l = line(['Conveyor_2']);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(l.store.get('Flow.Run'), 'the unstamped conveyor writes unscoped Flow.*').toBeDefined();
    expect(desOwners(l.store, 'Flow.Run').length).toBe(1);

    runner.clearMUs();
    runner.suspend();
    expect(l.store.get('Flow.Run'), 'no unscoped rest after DES → continuous').toBeUndefined();
    expect(l.store.get('Flow.Occupied')).toBeUndefined();
    expect(allDesOwnerPaths(l.store)).toEqual([]);

    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(l.store.get('Flow.Run'), 'back with the next bind').toBeDefined();
    expect(desOwners(l.store, 'Flow.Run').length).toBe(1);
    runner.dispose();
    expect(allDesOwnerPaths(l.store), 'nothing owned after dispose').toEqual([]);
    expect(l.store.get('Flow.Run')).toBeUndefined();
  });

  it('reset releases and reclaims the one fixed owner path per runner and name (no growth)', () => {
    const l = line(['Conveyor_2']);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    const before = desOwners(l.store, 'Flow.Run');
    expect(before.length).toBe(1);
    runner.reset();
    const after = desOwners(l.store, 'Flow.Run');
    expect(after, 'exactly one owner after the reset, the same fixed path').toEqual(before);
    expect(allDesOwnerPaths(l.store).filter((p) => p.endsWith('/Flow.Run'))).toHaveLength(1);
    runner.dispose();
  });

  it('a model path stays the preferred path through bind and release', () => {
    const l = line();
    const name = 'Conveyor_1.Flow.Run';
    l.store.register(name, 'Model/Conveyor_1/Signals/Flow.Run', true);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(desOwners(l.store, name).length, 'DES owns it too').toBe(1);
    expect(l.store.getPath(name), 'preferred path unchanged while bound').toBe('Model/Conveyor_1/Signals/Flow.Run');
    runner.dispose();
    expect(l.store.get(name), 'a model-owned name stays').toBeDefined();
    expect(l.store.getPath(name), 'preferred path unchanged after release').toBe('Model/Conveyor_1/Signals/Flow.Run');
  });

  it('two instances sharing an unscoped name share the runner owner path; the name goes with the release', () => {
    const l = line(['Conveyor_1', 'Conveyor_2']);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(desOwners(l.store, 'Flow.Run').length, 'one owner path per runner and name').toBe(1);
    expect(desOwners(l.store, 'Flow.Occupied').length).toBe(1);
    runner.clearMUs();
    expect(l.store.get('Flow.Run')).toBeUndefined();
    runner.dispose();
  });

  it('a forced name is kept by the release', () => {
    const l = line(['Conveyor_2']);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    l.store.forceSignal('Flow.Run', false);
    runner.clearMUs();
    expect(l.store.get('Flow.Run'), 'forced → kept').toBeDefined();
    expect(l.store.isForced('Flow.Run')).toBe(true);
    expect(l.store.get('Flow.Occupied'), 'the unforced neighbour goes').toBeUndefined();
    runner.dispose();
  });

  it('restored keeps the owners (no re-bind, nothing released)', () => {
    const l = line(['Conveyor_2']);
    const runner = newRunner();
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    runner.getManager().processUpTo(10, 4000);
    const snap = runner.fullSnapshot();
    const owners = desOwners(l.store, 'Flow.Run');
    runner.restoreFull(snap);
    expect(desOwners(l.store, 'Flow.Run')).toEqual(owners);
    runner.dispose();
  });
});
