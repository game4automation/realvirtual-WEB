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

// ═══════════════════════════════════════════════════════════════════════
// plan-774 Phase 2 — the EDITOR load variant (authoring flags)
// ═══════════════════════════════════════════════════════════════════════
//
// The asset editor opens the same outer bytes as an AUTHORING document
// (`preserveHierarchy` + `preserveAuthoringHierarchy`). Since plan-774 F2 it
// defers its references exactly like the runtime main load, so the NESTED
// placement must be the same instance on both paths: same baked asset key,
// same chunk set, same surviving nodes, same pivot frame. The one ALLOW-LISTED
// difference is the open document's OWN content: unbaked in the editor
// (authorable, no chunk outside the reference), baked on the runtime path.

/** What a nested placement looks like, independent of the viewer it lives in. */
interface NestedPlacementSignature {
  assetUrlIsInner: boolean;
  chunkNames: string[];
  nodes: string[];
  childPositions: Record<string, number[]>;
}

function nestedSignature(viewer: ParityHost['viewer'], root: import('three').Object3D, refName: string, innerUrl: string): NestedPlacementSignature {
  const ref = root.getObjectByName(refName);
  expect(ref, `${refName} exists`).toBeDefined();
  const instance = viewer.bakeRegistry.instanceOf(ref!);
  expect(instance, `${refName} is a placement instance`).not.toBeNull();
  const nodes: string[] = [];
  const walk = (node: import('three').Object3D, path: string): void => {
    for (const child of node.children) {
      if (child.userData._rvGizmo || child.userData._highlightOverlay) continue;
      const p = `${path}/${child.name}`;
      nodes.push(`${p}:${child.type}`);
      walk(child, p);
    }
  };
  walk(ref!, '');
  const childPositions: Record<string, number[]> = {};
  for (const child of ref!.children) childPositions[child.name] = child.position.toArray().map((n) => Math.round(n * 1e6) / 1e6);
  return {
    assetUrlIsInner: instance!.baked.url === innerUrl || instance!.baked.assetId === innerUrl,
    chunkNames: instance!.chunks.map((m) => m.name).sort(),
    nodes: nodes.sort(),
    childPositions,
  };
}

/** Chunk meshes OUTSIDE every reference node of `root` — the own content's bake. */
function ownChunkCount(root: import('three').Object3D): number {
  let n = 0;
  const walk = (node: import('three').Object3D): void => {
    if (node !== root && node.userData?.realvirtual?.AssetReference && node.userData.realvirtual.AssetReference.embedded !== true) return;
    if (node.userData?._rvBakeChunk === true) n++;
    for (const c of node.children) walk(c);
  };
  walk(root);
  return n;
}

describe('plan-774 editor load variant — the nested placement equals the runtime one; own content unbaked (allow-listed)', () => {
  for (const id of ['n1', 'n2', 'n3'] as const) {
    it(`(${id}) editor load and runtime main load materialise the same nested instance`, async () => {
      const host = await createParityHost();
      const fixture = nestedParityFixture(id);
      const innerBytes = await fixtureBytes(fixture.buildInner());
      const innerUrl = URL.createObjectURL(new Blob([innerBytes], { type: 'model/gltf-binary' }));
      try {
        const outerBytes = await fixtureBytes(fixture.buildOuter(innerUrl));
        const { viewer } = host;

        const runtime = await viewer.loadModel(`parity-774-runtime-${id}.glb`, { data: outerBytes.slice(0) });
        await viewer.whenSceneReady();
        const runtimeSig = nestedSignature(viewer, runtime.root, fixture.referenceName, innerUrl);
        const runtimeOwnChunks = ownChunkCount(runtime.root);

        const editor = await viewer.loadModel(`parity-774-editor-${id}.glb`, {
          data: outerBytes.slice(0), preserveHierarchy: true, preserveAuthoringHierarchy: true,
        });
        await viewer.whenSceneReady();
        const editorSig = nestedSignature(viewer, editor.root, fixture.referenceName, innerUrl);

        expect(editorSig).toEqual(runtimeSig);
        expect(editorSig.chunkNames.length).toBeGreaterThan(0);
        // The allow-listed difference: own content baked at runtime, unbaked in the editor.
        expect(runtimeOwnChunks).toBeGreaterThan(0);
        expect(ownChunkCount(editor.root)).toBe(0);
        expect(editor.root.getObjectByName('Frame'), 'own CAD part stays addressable in the editor').toBeDefined();
      } finally {
        URL.revokeObjectURL(innerUrl);
        host.dispose();
      }
    }, 60_000);
  }
});
