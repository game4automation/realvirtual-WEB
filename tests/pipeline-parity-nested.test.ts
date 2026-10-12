// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * pipeline-parity-nested — plan-757 Phase 2 (spike S2 scaffold, Phase 2a fixtures).
 *
 * An asset INSIDE an asset, two levels (`tests/fixtures/parity-nested-fixtures.ts`):
 * the same outer bytes as the MAIN MODEL (`loadGLB` — since Phase 2b a runtime
 * load defers EVERY non-embedded reference, planner or hand-authored, and the
 * viewer's instancer materialises it; nothing is grafted at runtime) and as ONE
 * PLACEMENT (`ModelCache` recipe + the instancer's nested materialisation).
 * Same harness, same 17 dimensions as `pipeline-parity.test.ts` plus "nested
 * drive moves"; every difference outside the allow-list is committed as
 * `it.todo` with the gap named, counted by `tests/parity-open-gaps.node.test.ts`
 * (`EXPECTED_OPEN_GAPS_NESTED`, 0 since Phase 2b).
 *
 * GENERATED SHAPE, HAND-OWNED CONTENT: the literal it()/it.todo() lines are
 * what the gap counter reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NESTED_PARITY_FIXTURES, nestedParityFixture, type NestedFixtureId } from './fixtures/parity-nested-fixtures';
import {
  createParityHost, fixtureBytes, loadAsMainModel, loadAsSinglePlacement,
  snapshot, snapshotAfter, pickAt, diffSnapshots, diffBehaviour, diffsOf, describeDiffs,
  type ParityHost, type ParitySnapshot, type BehaviourSnapshot, type ParityDiff,
} from './helpers/parity-harness';
import { applyAllowList } from './parity-allow-list';

interface FixtureRun {
  main: ParitySnapshot;
  placement: ParitySnapshot;
  behaviourMain: BehaviourSnapshot;
  behaviourPlacement: BehaviourSnapshot;
  pickMain: string | null;
  pickPlacement: string | null;
  diffs: ParityDiff[];
  innerUrl: string;
}

/** Inner bytes → blob url → outer bytes; then both loads on one host. */
async function runFixture(host: ParityHost, id: NestedFixtureId): Promise<FixtureRun> {
  const fixture = nestedParityFixture(id);
  const innerBytes = await fixtureBytes(fixture.buildInner());
  const innerUrl = URL.createObjectURL(new Blob([innerBytes], { type: 'model/gltf-binary' }));
  const outerBytes = await fixtureBytes(fixture.buildOuter(innerUrl));
  const main = await loadAsMainModel(host, outerBytes);
  const mainSnap = snapshot(main);
  const pickMain = pickAt(main, fixture.pick);
  const behaviourMain = snapshotAfter(main, fixture.steps);
  main.release();
  const placement = await loadAsSinglePlacement(host, outerBytes, fixture.rootName);
  const placementSnap = snapshot(placement);
  const pickPlacement = pickAt(placement, fixture.pick);
  const behaviourPlacement = snapshotAfter(placement, fixture.steps);
  placement.release();
  const diffs = diffSnapshots(mainSnap, placementSnap);
  console.log(`[parity-nested] (${id}) diffs=${diffs.length} pick main=${pickMain} placement=${pickPlacement}\n${describeDiffs(diffs)}`);
  const bdiffs = diffBehaviour(behaviourMain, behaviourPlacement);
  if (bdiffs.length) console.log(`[parity-nested] (${id}) behaviour diffs=${bdiffs.length}\n${describeDiffs(bdiffs)}`);
  return { main: mainSnap, placement: placementSnap, behaviourMain, behaviourPlacement, pickMain, pickPlacement, diffs, innerUrl };
}

function expectStructure(run: FixtureRun, dimension: ParityDiff['dimension']): void {
  const { unexplained } = applyAllowList(diffsOf(run.diffs, dimension));
  expect(unexplained, describeDiffs(unexplained)).toEqual([]);
}

function expectBehaviour(run: FixtureRun): void {
  const diffs = diffBehaviour(run.behaviourMain, run.behaviourPlacement);
  expect(diffs, describeDiffs(diffs)).toEqual([]);
}

function expectPick(run: FixtureRun, id: NestedFixtureId): void {
  const fixture = nestedParityFixture(id);
  expect(run.pickPlacement).toBe(fixture.pick.expect);
  expect(run.pickMain).toBe(run.pickPlacement);
}

/**
 * The nested Slide moved on BOTH paths — the original bug, one level down.
 * Path-tolerant on purpose: while `loadGLB` still grafts a hand-authored
 * reference the main path spells it `CellRef/Cell/Slide` (see the (n2) GAP
 * todos); THIS check is about motion, the path form is the `behaviour` todo.
 */
function expectNestedDriveMoves(run: FixtureRun, id: NestedFixtureId): void {
  const ref = nestedParityFixture(id).referenceName;
  for (const [label, b] of [['main', run.behaviourMain], ['placement', run.behaviourPlacement]] as const) {
    // `${ref}/Slide` for a reference at the asset root, `Mount/${ref}/Slide` under an intermediate ancestor (n3).
    const key = Object.keys(b.drives).find((k) => (k.startsWith(`${ref}/`) || k.includes(`/${ref}/`)) && k.endsWith('/Slide'));
    expect(key, `${label}: a drive under ${ref} exists after ${nestedParityFixture(id).steps} steps`).toBeDefined();
    expect(Math.abs(b.drives[key!]), `${label}: ${key} moved (mm)`).toBeGreaterThan(100);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Fixture blocks — literal it()/it.todo() lines (read by the gap counter)
// ═══════════════════════════════════════════════════════════════════════

describe('nested fixture (n1) — planner reference (PlacementMeta) inside an asset', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'n1');
  }, 60_000);
  afterAll(() => { URL.revokeObjectURL(run?.innerUrl ?? ''); host?.dispose(); });

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
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'n1'));
  it('nested drive moves on both paths', () => expectNestedDriveMoves(run, 'n1'));
});

describe('nested fixture (n2) — hand-authored reference (no PlacementMeta) inside an asset', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'n2');
  }, 60_000);
  afterAll(() => { URL.revokeObjectURL(run?.innerUrl ?? ''); host?.dispose(); });

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
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'n2'));
  it('nested drive moves on both paths', () => expectNestedDriveMoves(run, 'n2'));
});

describe('nested fixture (n3) — planner reference under a STATIC intermediate ancestor (Machine/Mount/Cell_1)', () => {
  let host: ParityHost;
  let run: FixtureRun;
  beforeAll(async () => {
    host = await createParityHost();
    run = await runFixture(host, 'n3');
  }, 60_000);
  afterAll(() => { URL.revokeObjectURL(run?.innerUrl ?? ''); host?.dispose(); });

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
  it('pick: the same asset-space ray resolves to the same node', () => expectPick(run, 'n3'));
  it('nested drive moves on both paths', () => expectNestedDriveMoves(run, 'n3'));
});

describe('nested parity fixtures — table', () => {
  it('has the three nested fixtures', () => {
    expect(NESTED_PARITY_FIXTURES.map((f) => f.id)).toEqual(['n1', 'n2', 'n3']);
  });
});
