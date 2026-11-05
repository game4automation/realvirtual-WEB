// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-681 F5: the `__des-owner__/<runnerId>/<name>` owner paths of the DES runner
// stay bounded over many binds — reset, rebindScene (what a structural planning
// change triggers) and DES <-> continuous (suspend + start) — and the end of the
// last bind releases every one of them.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { line, lineDefs, newRunner, resetWorld } from './des-lifecycle-line';

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

const ownerPaths = (store: unknown): string[] =>
  [...(store as { pathToName: Map<string, string> }).pathToName.keys()].filter((p) => p.startsWith('__des-owner__/')).sort();

it('F5: owner paths stay constant over reset / rebind / mode switch cycles and go with the bind', () => {
  const l = line(['Conveyor_1', 'Conveyor_2']);
  const runner = newRunner();
  runner.start(lineDefs(), { root: l.scene, host: l.host });
  const baseline = ownerPaths(l.store);
  expect(baseline.length).toBeGreaterThan(0);
  for (let i = 0; i < 8; i++) {
    runner.getManager().processUpTo(5, 500);
    runner.reset();
    expect(ownerPaths(l.store), `reset ${i}`).toEqual(baseline);
    runner.rebindScene();
    expect(ownerPaths(l.store), `rebind ${i}`).toEqual(baseline);
    runner.suspend();
    expect(ownerPaths(l.store), `DES -> continuous ${i}: released`).toEqual([]);
    runner.start(lineDefs(), { root: l.scene, host: l.host });
    expect(ownerPaths(l.store), `continuous -> DES ${i}`).toEqual(baseline);
  }
  runner.dispose();
  expect(ownerPaths(l.store), 'nothing owned after the bind ends').toEqual([]);
});
