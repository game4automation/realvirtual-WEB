// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.5b (SOL #5) — the rows a script publishes with `self.statValue`
 * are part of its snapshot state:
 *  - restore writes them back at once: the KPI rows show the snapshot values
 *    BEFORE the script's next event (rows published after the snapshot are gone,
 *    rows published before it are back, non-finite values survive the codec);
 *  - the archived run result (taken at `simulation-run-ending`) equals that of
 *    the same run without a snapshot.
 *
 * Plus the snapshot rule for scripts with undeclared closure state (Phase 3,
 * item 4): such a script runs on the DES clock with a lint WARNING, but a
 * snapshot that would silently lose its closure state is refused visibly
 * (`des-script-undeclared-state`, naming the script), capture and restore.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { getProblem, clearProblem } from '../../src/core/hmi/problems-store';

const PUBLISHER = `
function setup(self) {
  const st = self.persist({ n: 0 });
  self.statValue('Beats', st.n, 'n', 'Line');
  self.every(1, 'beat');
  return {
    des: { on(hook) {
      if (hook !== 'beat') return;
      st.n++;
      self.statValue('Beats', st.n, 'n', 'Line');
      self.statValue('Ratio', st.n < 15 ? 0 / 0 : st.n / 2);
      if (st.n > 15) self.statValue('Late', st.n);
    } },
    state() { return st; },
  };
}`;

/** Declared state + an `onRestore` that republishes a key the snapshot also carries. */
const REPUBLISHER = `
function setup(self) {
  const st = self.persist({ n: 0 });
  self.every(1, 'beat');
  return {
    des: { on(hook) { if (hook === 'beat') { st.n++; self.statValue('Beats', st.n); self.statValue('Kept', st.n * 10); } } },
    onSnapshot() { return { at: st.n }; },
    onRestore(s) { self.statValue('Beats', 'restored@' + s.at); },
    state() { return st; },
  };
}`;

/** Hidden closure state: `n` lives in a closure the snapshot cannot see. */
const CLOSURE_STATE = `
function setup(self) {
  function make(n=0) { return () => { ++n; self.statValue('Count', n); }; }
  self.every(1, 'beat');
  return { des: { on: make() } };
}`;

type World = Awaited<ReturnType<typeof makeWorld>>;
const rows = (w: World) => w.statRows().map(r => [r.owner, r.label, r.value]);

async function started(code: string, name = 'Publisher'): Promise<World> {
  const w = await makeWorld({ scripts: [{ name, code }], flow: true });
  w.start();
  w.manager.duration = 1e6;
  await whenDocumentHashesSettled();
  return w;
}

function archiveOnReset(w: World): Array<{ rows: unknown; simTime: number }> {
  const seen: Array<{ rows: unknown; simTime: number }> = [];
  w.viewer.on('simulation-run-ending', data => seen.push({ rows: rows(w), simTime: (data as { simTime: number }).simTime }));
  return seen;
}

describe('plan-2212 §9.5b — statValue rows across snapshot / restore', () => {
  it('restore shows the snapshot rows before the next event; the archived result equals a run without snapshot', async () => {
    const ref = await started(PUBLISHER);
    const refArchive = archiveOnReset(ref);
    await ref.runner.fastForwardUntil(30.5);
    ref.runner.reset();

    const w = await started(PUBLISHER);
    const archive = archiveOnReset(w);
    await w.runner.fastForwardUntil(10.5);
    const atSnapshot = rows(w);
    expect(atSnapshot).toEqual([
      ['Scripts/Publisher', 'Beats', 10], ['Scripts/Publisher', 'Ratio', NaN]]);
    const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));

    await w.runner.fastForwardUntil(20.5);   // changes Beats, Ratio, adds Late
    expect(rows(w)).toContainEqual(['Scripts/Publisher', 'Late', 20]);

    w.runner.restoreFull(saved);
    // No event has run since the restore: the rows ARE the snapshot's.
    expect(w.manager.currentTime).toBe(10.5);
    expect(rows(w)).toEqual(atSnapshot);
    expect(w.state('Publisher')).toEqual({ n: 10 });

    await w.runner.fastForwardUntil(30.5);
    w.runner.reset();
    expect(archive).toEqual(refArchive);
    expect(archive[0].rows).toContainEqual(['Scripts/Publisher', 'Beats', 30]);
  });

  it('a restore into a fresh world (registry rebuild) brings the rows with it', async () => {
    const w = await started(PUBLISHER);
    await w.runner.fastForwardUntil(18.5);
    const saved = JSON.stringify(w.runner.fullSnapshot());
    const expected = rows(w);

    const fresh = await started(PUBLISHER);
    expect(rows(fresh)).toEqual([['Scripts/Publisher', 'Beats', 0]]);
    fresh.runner.restoreFull(JSON.parse(saved));
    expect(rows(fresh)).toEqual(expected);
  });
});

describe('plan-2212 §9.5b — stat rows: legacy snapshots and onRestore', () => {
  it('an older snapshot without `stats` clears the rows published since (none were captured)', async () => {
    const w = await started(PUBLISHER);
    await w.runner.fastForwardUntil(10.5);
    const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
    const part = saved.parts.find((p: { key: string }) => p.key.endsWith('@WebComponent'));
    expect(part.state).toHaveProperty('stats');
    delete part.state.stats;                       // a pre-Phase-3 snapshot
    await w.runner.fastForwardUntil(20.5);
    expect(rows(w).length).toBeGreaterThan(0);

    w.runner.restoreFull(saved);
    expect(w.manager.currentTime).toBe(10.5);
    expect(rows(w)).toEqual([]);                   // no stale post-snapshot rows
    expect(w.state('Publisher')).toEqual({ n: 10 });
    await w.runner.fastForwardUntil(11.5);         // the next event publishes again
    expect(rows(w)).toContainEqual(['Scripts/Publisher', 'Beats', 11]);
  });

  it('an onRestore that republishes a captured key wins over the restored value; other keys keep theirs', async () => {
    const w = await started(REPUBLISHER, 'Republisher');
    await w.runner.fastForwardUntil(4.5);
    const saved = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
    await w.runner.fastForwardUntil(9.5);

    w.runner.restoreFull(saved);
    expect(rows(w)).toEqual([
      ['Scripts/Republisher', 'Beats', 'restored@4'], ['Scripts/Republisher', 'Kept', 40]]);
  });
});

describe('plan-2212 Phase 3 — undeclared closure state is a visible refusal, never silent loss', () => {
  it('a warn-policy script keeps running, but capture and restore refuse with des-script-undeclared-state', async () => {
    clearProblem('des-script-undeclared-state');
    const ok = await started(PUBLISHER);
    await ok.runner.fastForwardUntil(5.5);
    const foreign = JSON.parse(JSON.stringify(ok.runner.fullSnapshot()));

    const w = await started(CLOSURE_STATE, 'Closure');
    await w.runner.fastForwardUntil(5.5);
    expect(w.inst('Closure').adapter!.mode).toBe('des');
    expect(w.inst('Closure').adapter!.undeclaredState).toContain('des-script-undeclared-state');
    expect(rows(w)).toEqual([['Scripts/Closure', 'Count', 5]]);   // it runs on the DES clock

    expect(() => w.runner.fullSnapshot()).toThrow('des-script-undeclared-state');
    const problem = getProblem('des-script-undeclared-state');
    expect(problem?.detail).toContain('Scripts/Closure');
    expect(problem?.detail).toContain('self.persist');
    expect(() => w.runner.restoreFull(foreign)).toThrow('des-script-undeclared-state');
    // The refusal changed nothing: the script still runs.
    await w.runner.fastForwardUntil(8.5);
    expect(rows(w)).toEqual([['Scripts/Closure', 'Count', 8]]);
  });

  it('a DesSafe script with the same finding is disabled (Phase 1) and therefore not a snapshot participant', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Closure', code: CLOSURE_STATE, desSafe: true }], flow: true });
    w.start();
    await whenDocumentHashesSettled();
    expect(w.plugin.listScriptComponents()).toEqual([]);
    expect(() => w.runner.fullSnapshot()).not.toThrow();
  });
});
