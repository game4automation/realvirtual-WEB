// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * pipeline-parity — plan-757 Phase 0 (F11).
 *
 * The same GLB bytes as the MAIN MODEL and as ONE PLACEMENT must produce the
 * same asset: structure (every dimension of `snapshot()`), behaviour after n
 * fixed steps (`snapshotAfter()`) and picking (`pickAt()`). Any difference
 * outside `tests/parity-allow-list.ts` is a defect.
 *
 * Where the two paths differ the dimension is committed as `it.todo` with the
 * gap named in its title — never `it.fails` (vitest 4 reports that as
 * `passed`). `tests/parity-open-gaps.node.test.ts` counts the todos of every
 * fixture block against the expected table. Phase 0 (2026-09-22) committed 44
 * gaps; Phase 1a (one recipe `prepareAndBake`, whole-template instances, one
 * init context, home-stamp re-take + pivot shift, aliases on the asset, the
 * static freeze on placements) closed every one of them — the counter is 0.
 *
 * One real WebGL viewer per fixture block; both loads run on it in sequence
 * (`loadModel` clears the previous document). `beforeAll` does the work,
 * the `it`s only assert, so a per-dimension gap is a per-dimension todo.
 *
 * GENERATED SHAPE, HAND-OWNED CONTENT: the literal it()/it.todo() lines are
 * what the gap counter reads. A gap that opens again is committed as a todo
 * with its reason (`— GAP: 1b: …` for one that belongs to Phase 1b).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARITY_FIXTURES, parityFixture, type ParityFixtureId } from './fixtures/parity-fixtures';
import {
  createParityHost, fixtureBytes, loadAsMainModel, loadAsSinglePlacement,
  snapshot, snapshotAfter, pickAt, diffSnapshots, diffBehaviour, diffsOf, describeDiffs,
  measureDedupEffect,
  type ParityHost, type ParitySnapshot, type BehaviourSnapshot, type ParityDiff,
} from './helpers/parity-harness';
import {
  PARITY_ALLOW_LIST, applyAllowList, assertAllowListWellFormed, unusedEntries, FORBIDDEN_DIMENSIONS,
} from './parity-allow-list';

/** Allow-list entries that explained a diff anywhere in this file (self-test at the end). */
const suiteUsed = new Set<string>();

interface FixtureRun {
  main: ParitySnapshot;
  placement: ParitySnapshot;
  behaviourMain: BehaviourSnapshot;
  behaviourPlacement: BehaviourSnapshot;
  pickMain: string | null;
  pickPlacement: string | null;
  diffs: ParityDiff[];
}

/** Load the fixture both ways on one host and take every picture. */
async function runFixture(host: ParityHost, id: ParityFixtureId): Promise<FixtureRun> {
  const fixture = parityFixture(id);
  const bytes = await fixtureBytes(fixture.build());
  const main = await loadAsMainModel(host, bytes, { claims: fixture.claims });
  const mainSnap = snapshot(main);
  const pickMain = pickAt(main, fixture.pick);
  const behaviourMain = snapshotAfter(main, fixture.steps);
  main.release();
  const placement = await loadAsSinglePlacement(host, bytes, fixture.rootName, { claims: fixture.claims });
  const placementSnap = snapshot(placement);
  const pickPlacement = pickAt(placement, fixture.pick);
  const behaviourPlacement = snapshotAfter(placement, fixture.steps);
  placement.release();
  const diffs = diffSnapshots(mainSnap, placementSnap);
  // The whole picture once per fixture — what a todo's gap description is written from.
  console.log(`[parity] (${id}) diffs=${diffs.length} pick main=${pickMain} placement=${pickPlacement}\n${describeDiffs(diffs)}`);
  const bdiffs = diffBehaviour(behaviourMain, behaviourPlacement);
  if (bdiffs.length) console.log(`[parity] (${id}) behaviour diffs=${bdiffs.length}\n${describeDiffs(bdiffs)}`);
  return { main: mainSnap, placement: placementSnap, behaviourMain, behaviourPlacement, pickMain, pickPlacement, diffs };
}

/** Assert one structure dimension: every diff must be explained by the allow-list. */
function expectStructure(run: FixtureRun, dimension: ParityDiff['dimension']): void {
  const { unexplained, used } = applyAllowList(diffsOf(run.diffs, dimension));
  for (const id of used) suiteUsed.add(id);
  expect(unexplained, describeDiffs(unexplained)).toEqual([]);
}

/** Assert behaviour: no allow-list, ever. */
function expectBehaviour(run: FixtureRun): void {
  const diffs = diffBehaviour(run.behaviourMain, run.behaviourPlacement);
  expect(diffs, describeDiffs(diffs)).toEqual([]);
}

/** Assert picking: the same asset-space ray resolves to the same node, and to the expected one. */
function expectPick(run: FixtureRun, id: ParityFixtureId): void {
  const fixture = parityFixture(id);
  expect(run.pickMain, 'main model pick').toBe(fixture.pick.expect);
  expect(run.pickPlacement, 'placement pick').toBe(run.pickMain);
}

const HOOK_TIMEOUT = 120_000;

// ─── fixture (a) ─────────────────────────────────────────────────────────

describe('fixture (a) — kinematic group + Drive + LogicStep_DriveTo + PLCOutputFloat (Arburg shape)', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'a');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'a'));
});

// ─── fixture (b) ─────────────────────────────────────────────────────────

describe('fixture (b) — KinematicParentEnable chain', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'b');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'b'));
});

// ─── fixture (c) ─────────────────────────────────────────────────────────

describe('fixture (c) — convention Sensor without Ray', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'c');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'c'));
});

// ─── fixture (d) ─────────────────────────────────────────────────────────

describe('fixture (d) — Group partitions', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'd');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'd'));
});

// ─── fixture (e) ─────────────────────────────────────────────────────────

describe('fixture (e) — plain conveyor', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'e');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'e'));
});

// ─── fixture (f) ─────────────────────────────────────────────────────────

describe('fixture (f) — duplicate sibling names', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'f');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'f'));
});

// ─── fixture (g) ─────────────────────────────────────────────────────────

describe('fixture (g) — unsigned asset with a LogicStep', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'g');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'g'));
});

// ─── fixture (h) ─────────────────────────────────────────────────────────

describe('fixture (h) — asymmetric asset with a top-level drive (pivot offset != 0)', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'h');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'h'));
});

// ─── fixture (i) ─────────────────────────────────────────────────────────

describe('fixture (i) — child named like the root', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'i');
  }, HOOK_TIMEOUT);
  afterAll(() => { host?.dispose(); });
  it('structure: root', () => expectStructure(run, 'root'));
  it('structure: rootChildren', () => expectStructure(run, 'rootChildren'));
  it('structure: nodes', () => expectStructure(run, 'nodes'));
  it('structure: aliases', () => expectStructure(run, 'aliases'));
  it('structure: counts', () => expectStructure(run, 'counts'));
  it('structure: driveHome', () => expectStructure(run, 'driveHome'));
  it('structure: movers', () => expectStructure(run, 'movers'));
  it('structure: groups', () => expectStructure(run, 'groups'));
  it('structure: sensors', () => expectStructure(run, 'sensors'));
  it('structure: transports', () => expectStructure(run, 'transports'));
  it('structure: snapPorts', () => expectStructure(run, 'snapPorts'));
  it('structure: webComponents', () => expectStructure(run, 'webComponents'));
  it('structure: logic', () => expectStructure(run, 'logic'));
  it('structure: signals', () => expectStructure(run, 'signals'));
  it('structure: gated', () => expectStructure(run, 'gated'));
  it('behaviour after n fixed steps', () => expectBehaviour(run));
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'i'));
});

// ─── allow-list self-test ────────────────────────────────────────────────────

describe('parity allow-list', () => {
  it('is well-formed: no entry can explain a forbidden dimension', () => {
    expect(() => assertAllowListWellFormed()).not.toThrow();
    expect([...FORBIDDEN_DIMENSIONS].sort()).toEqual(['behaviour', 'counts', 'movers']);
    // A hypothetical entry that would explain a chunk-count difference is rejected.
    expect(() => assertAllowListWellFormed([
      ...PARITY_ALLOW_LIST,
      { id: 'bad', decision: '-', reason: '-', matches: (d) => d.dimension === 'counts' },
    ])).toThrow(/forbidden/);
  });

  it('an entry no fixture triggers fails as unused (unit)', () => {
    expect(unusedEntries(new Set(['instance-root-name']))).toEqual(['plugin-claims', 'uniform-pivot-offset', 'placement-world-matrix-live']);
    expect(unusedEntries(new Set(PARITY_ALLOW_LIST.map((e) => e.id)))).toEqual([]);
  });

  it('every entry was used by at least one fixture of this file', () => {
    expect(unusedEntries(suiteUsed)).toEqual([]);
  });
});

// ─── D6 — deduplicateMaterials effect on the chunk count ────────────────────

describe('D6 — chunk count with vs without deduplicateMaterials', () => {
  for (const fixture of PARITY_FIXTURES) {
    it(`(${fixture.id}) measured`, async () => {
      const m = await measureDedupEffect(await fixtureBytes(fixture.build()));
      console.log(`[D6] (${fixture.id}) chunks with dedup=${m.withDedup.chunks} (materials ${m.withDedup.materialsBefore}→${m.withDedup.materialsAfter}) without dedup=${m.withoutDedup.chunks} (materials ${m.withoutDedup.materials})`);
      expect(m.withDedup.chunks).toBeGreaterThan(0);
      expect(m.withoutDedup.chunks).toBeGreaterThan(0);
    }, 30_000);
  }
});
