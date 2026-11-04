// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { executeValue } from './helpers/execute-value';
import { queryValue } from './helpers/query-value';

/**
 * plan-706 T1 / T1b / T2 — the READ half of the mechanism MCP surface, plus the
 * two things the write half must get right before anything else.
 *
 *  * **T1** — `web_editor_mechanism_inspect` hands the bridge views through
 *    VERBATIM. Before plan-706 an agent could read counters and findings and
 *    nothing else: no joint rows, no link masses, no world axes. Half a
 *    diagnosis.
 *  * **T1b** — `_mechCommit` finds the RIGHT mechanism to rebuild, in the right
 *    order of the three stages. The ancestor walk is stage 1 specifically
 *    because a freshly added body appears in no `links[]` yet, which would have
 *    made "rebuild everything" the normal path (Review F3).
 *  * **T2** — without the private bundle no mechanism tool writes ANYTHING.
 *    Four of the six original tools happily authored components into a build
 *    with no solver behind them; that is document rubbish which only surfaces
 *    once the asset reaches a Professional build.
 *  * **plan-504** — eleven write tools are views of the `mechanism.*`
 *    commands now. Nothing here registers them: loading the tool module does
 *    (cold start), and in the community build a bound tool answers
 *    `ERR_EDITOR_UNAVAILABLE` — never "Unknown command".
 *
 * Real `McpEditorTools` over a real `AssetDocument`, `NodeRegistry` and `Scene`
 * (the `mcp-editor-doc-mutations` fixture), with a RECORDING bridge double in
 * place of the private side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import {
  setMechanismUiBridge,
  type MechanismCogView,
  type MechanismFindingView,
  type MechanismJointView,
  type MechanismLinkView,
  type MechanismUiBridge,
  type MechanismView,
} from '../src/core/engine/rv-kinematic-registry';
import { movedToolOf } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';
import { allSchemas } from './helpers/mcp-schemas';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../src/core/editor/rv-editor-guard-core';
import { MECHANISM_COMMAND_IDS } from '../src/core/hmi/mechanism-command-descriptors';

/** The mechanism write tools that are command views since plan-504 (community: ERR_EDITOR_UNAVAILABLE). */
const BOUND = new Set([
  'web_editor_mechanism_create', 'web_editor_mechanism_add_joint', 'web_editor_mechanism_assign_drive',
  'web_editor_mechanism_jog', 'web_editor_mechanism_set_anchor_snap', 'web_editor_mechanism_set_axis',
  'web_editor_mechanism_add_body', 'web_editor_mechanism_set_mass', 'web_editor_mechanism_set_limits',
  'web_editor_mechanism_statics', 'web_editor_mechanism_fix',
]);

async function execute(command: string, args: Record<string, unknown>): Promise<string> {
  const r = JSON.parse(await new McpCommandTools(() => env.viewer).webExecute(command, JSON.stringify(args)));
  return JSON.stringify(r.value ?? r);
}

// ─── Bridge double ──────────────────────────────────────────────────────────

function joint(nodePath: string, name: string): MechanismJointView {
  return {
    nodePath, name, jointType: 'Revolute',
    bodyAName: 'Base', bodyBName: 'Arm',
    bodyAPath: 'Mech/Base', bodyBPath: 'Mech/Arm',
    worldAnchored: false, driveName: 'Drive1', currentValue: 12.5,
    joggable: true, lowerLimit: -90, upperLimit: 90, useLimits: true,
    originWorld: [1, 2, 3], axisWorld: [0, 0, 1],
  };
}

function link(nodePath: string, name: string): MechanismLinkView {
  return {
    nodePath, name, hasBody: true, hasMass: true,
    densityPreset: 'steel', densityKgM3: 7850,
    massKg: 4.25, comLocalMm: [0, 10, 0],
    massOverridden: false, comOverridden: false,
    massSource: 'mesh', massWarning: '',
  };
}

const FINDING: MechanismFindingView = {
  code: 'AnchorsApart', severity: 'Warning',
  message: 'Anchors are 4.2 mm apart', jointPath: 'Mech/Arm/Joint1', fixable: true,
};

/** The plan-472 centre-of-gravity block, as the private bridge produces it. */
function cogView(nodePath: string, over: Partial<MechanismCogView> = {}): MechanismCogView {
  return {
    totalMassKg: 12.75,
    cogWorldMm: [12.4, 630.1, -3.8],
    contributingLinks: 3,
    totalLinks: 3,
    skippedLinks: [],
    estimated: false,
    ambiguousOwnership: false,
    warnings: [],
    contributions: [
      { nodePath: `${nodePath}/Base`, comWorldMm: [0, 0, 0], massKg: 4.25, comSource: 'mesh', ambiguous: false },
      { nodePath: `${nodePath}/Arm`, comWorldMm: [0, 900, 0], massKg: 4.25, comSource: 'mesh', ambiguous: false },
      { nodePath: `${nodePath}/Tool`, comWorldMm: [37, 990, -11], massKg: 4.25, comSource: 'mesh', ambiguous: false },
    ],
    unityToMm: 1000,
    ...over,
  };
}

function mechanismView(nodePath: string, over: Partial<MechanismView> = {}): MechanismView {
  return {
    nodePath, name: nodePath.split('/').pop() ?? nodePath,
    active: true, converged: true, residualError: 1e-6, solveTimeMs: 0.42,
    disabledReason: '', jointCount: 2, linkCount: 3, loopCount: 1, dof: 1,
    joints: [joint(`${nodePath}/Arm/Joint1`, 'Joint1'), joint(`${nodePath}/Arm/Joint2`, 'Joint2')],
    links: [link(`${nodePath}/Base`, 'Base'), link(`${nodePath}/Arm`, 'Arm'), link(`${nodePath}/Tool`, 'Tool')],
    cog: cogView(nodePath),
    findings: [FINDING],
    ...over,
  };
}

/** Records every `rebuild(path)` so the stage order can be asserted. */
class FakeBridge implements MechanismUiBridge {
  rebuilt: string[] = [];
  /** Ops seen by the document at the moment of each rebuild — the ordering proof. */
  opCountAtRebuild: number[] = [];
  opCounter: () => number = () => 0;

  constructor(private _views: MechanismView[]) {}

  /** Stand in for a state change on the private side (a mass edit, a jog, …). */
  setViews(views: MechanismView[]): void { this._views = views; }

  list(): MechanismView[] { return this._views; }
  validate(): MechanismFindingView[] { return [FINDING]; }
  jog(): { converged: boolean; residualError: number } | null { return { converged: true, residualError: 0 }; }
  solve(): { converged: boolean; residualError: number } | null { return { converged: true, residualError: 0 }; }
  rebuild(mechanismPath: string): void {
    this.rebuilt.push(mechanismPath);
    this.opCountAtRebuild.push(this.opCounter());
  }
  suggestFix(): Record<string, unknown> | null { return { AnchorB: { x: 1, y: 2, z: 3 } }; }
  setForceAnalysis(): void {}
  forcesSnapshot(): null { return null; }
  solveStatics(): null { return null; }
  resetForces(): void {}
  linkNodes(): { path: string; node: Object3D }[] { return []; }
}

// ─── Scene fixture ──────────────────────────────────────────────────────────

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  tools: McpEditorTools;
}

/**
 * `Mech` carries a `KinematicMechanism`; `Mech/Arm/Joint1` sits under it, and
 * `Outside` deliberately does NOT — that is the node that must fall through to
 * the later stages.
 */
function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Mech';
  scene.add(root);
  root.userData.realvirtual = { KinematicMechanism: { SolverIterations: 4 } };

  const arm = new Object3D();
  arm.name = 'Arm';
  root.add(arm);
  const j1 = new Object3D();
  j1.name = 'Joint1';
  j1.userData.realvirtual = { KinematicJoint: { JointType: 'Revolute' } };
  arm.add(j1);
  const body = new Object3D();
  body.name = 'FreshBody';
  arm.add(body);

  const outside = new Object3D();
  outside.name = 'Outside';
  scene.add(outside);

  const registry = new NodeRegistry();
  for (const top of [root, outside]) {
    top.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  }

  let activeMode = 'editor';
  // plan-504: statics runs through the force recorder plugin (ensureForceRecorder).
  const plugins = new Map<string, unknown>();
  const viewer: RVViewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    modes: {
      get activeMode() { return activeMode; },
      has: () => true,
      setMode: (m: string) => { activeMode = m; },
      list: () => [{ id: 'editor' }],
      subscribe: () => () => {},
    },
    selectionManager: {
      select() {}, selectPaths() {}, clear() {},
      getSnapshot: () => ({ selectedPaths: [] as string[] }),
    },
    getPlugin<T>(id: string): T | undefined { return plugins.get(id) as T | undefined; },
    use(plugin: { id: string; init?: (v: RVViewer) => void }): void {
      plugins.set(plugin.id, plugin);
      plugin.init?.(viewer);
    },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });
  return { viewer, doc, tools: new McpEditorTools(() => viewer) };
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  env = makeEnv();
});

afterEach(() => {
  setMechanismUiBridge(null);
  setActiveAssetContext(null);
  env.doc.dispose();
});

const parse = (json: string): Record<string, any> => JSON.parse(json) as Record<string, any>;

// ─── T1 — inspect ───────────────────────────────────────────────────────────

describe.skipIf(!__RV_HAS_PRIVATE__)('T1 — mechanism.inspect passes the bridge views through', () => {
  beforeEach(() => { setMechanismUiBridge(new FakeBridge([mechanismView('Mech')])); });

  it('returns joints, links and findings in full', async () => {
    const r = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' }));
    expect(r.error).toBeUndefined();
    expect(r.mechanisms).toHaveLength(1);

    const m = r.mechanisms[0];
    expect(m.path).toBe('Mech');
    expect(m.converged).toBe(true);
    expect(m.residualError).toBeCloseTo(1e-6, 12);
    expect(m.dof).toBe(1);
    expect(m.loopCount).toBe(1);

    // The joint rows the panel renders — the half an agent never saw.
    expect(m.joints).toHaveLength(2);
    expect(m.joints[0].originWorld).toEqual([1, 2, 3]);
    expect(m.joints[0].axisWorld).toEqual([0, 0, 1]);
    expect(m.joints[0].joggable).toBe(true);
    expect(m.joints[0].useLimits).toBe(true);

    // Mass properties: without these "wiegen" cannot be verified at all.
    expect(m.links).toHaveLength(3);
    expect(m.links[0].massSource).toBe('mesh');
    expect(m.links[0].massWarning).toBe('');
    expect(m.links[0].massKg).toBeCloseTo(4.25, 6);

    // plan-472 — `comLocalMm` was always serialised but never DOCUMENTED; the tool description
    // now names it, and this pins that it keeps travelling.
    expect(m.links[0].comLocalMm).toEqual([0, 10, 0]);

    expect(m.findings).toHaveLength(1);
    expect(m.findings[0].fixable).toBe(true);
  });

  it('include=findings drops joints and links from the answer', async () => {
    const r = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: 'findings' }));
    const m = r.mechanisms[0];
    expect(m.joints).toBeUndefined();
    expect(m.links).toBeUndefined();
    expect(m.findings).toHaveLength(1);
    // The counters stay regardless — they are what makes the filter usable.
    expect(m.jointCount).toBe(2);
    expect(m.linkCount).toBe(3);
  });

  // ── plan-472 — the centre of gravity ──────────────────────────────────────

  it('carries the cog block verbatim, including the counting half', async () => {
    const r = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' }));
    const cog = r.mechanisms[0].cog;
    expect(cog).toBeDefined();
    expect(cog.cogWorldMm).toEqual([12.4, 630.1, -3.8]);
    expect(cog.totalMassKg).toBeCloseTo(12.75, 6);
    expect(cog.contributingLinks).toBe(3);
    expect(cog.totalLinks).toBe(3);
    expect(cog.estimated).toBe(false);
    expect(cog.ambiguousOwnership).toBe(false);
    expect(cog.unityToMm).toBe(1000);
    expect(cog.contributions).toHaveLength(3);
    expect(cog.contributions[1].comWorldMm).toEqual([0, 900, 0]);
  });

  it('survives include= narrowing — an agent saving context must not lose it silently', async () => {
    const r = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: 'findings' }));
    const m = r.mechanisms[0];
    expect(m.links).toBeUndefined();
    expect(m.cog.cogWorldMm).toEqual([12.4, 630.1, -3.8]);
  });

  it('a null cog serialises as null, never as an invented origin', async () => {
    setMechanismUiBridge(new FakeBridge([mechanismView('Mech', { cog: null })]));
    const raw = await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' });
    expect(raw).toContain('"cog":null');
    expect(parse(raw).mechanisms[0].cog).toBeNull();
  });

  it('a cog with no contribution reports null coordinates and says how many links it had', async () => {
    setMechanismUiBridge(new FakeBridge([mechanismView('Mech', {
      cog: cogView('Mech', {
        cogWorldMm: null, totalMassKg: 0, contributingLinks: 0, contributions: [],
        skippedLinks: [{ nodePath: 'Mech/Base', reason: 'no body' }],
      }),
    })]));
    const cog = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' })).mechanisms[0].cog;
    expect(cog.cogWorldMm).toBeNull();
    expect(cog.contributingLinks).toBe(0);
    expect(cog.totalLinks).toBe(3);
    expect(cog.skippedLinks).toEqual([{ nodePath: 'Mech/Base', reason: 'no body' }]);
  });

  it('is answered with the 3D marker OFF, and follows a mass change', async () => {
    // The tool never asks whether the marker is on — the snapshot is computed per request. Here
    // that is the bridge's second answer differing from its first, which is what a mass edit
    // produces on the private side.
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    const before = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' })).mechanisms[0].cog;
    expect(before.totalMassKg).toBeCloseTo(12.75, 6);

    bridge.setViews([mechanismView('Mech', {
      cog: cogView('Mech', { totalMassKg: 52.75, cogWorldMm: [12.4, 320.5, -3.8] }),
    })]);
    const after = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' })).mechanisms[0].cog;
    expect(after.totalMassKg).toBeCloseTo(52.75, 6);
    expect(after.cogWorldMm[1]).toBeCloseTo(320.5, 6);
  });

  it('an unknown path refuses and names the ones that exist', async () => {
    const r = parse(await queryValue(env.viewer, 'mechanism.inspect', { path: 'Nope', include: '' }));
    expect(r.error).toContain('Nope');
    expect(r.availablePaths).toEqual(['Mech']);
  });
});

// ─── T1b — the three-stage path derivation ──────────────────────────────────

describe('T1b — _mechCommit rebuilds the RIGHT mechanism', () => {
  it('(a) ancestor hit: a joint under Mech rebuilds exactly Mech, once', async () => {
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    const r = parse(await executeValue(env.viewer, 'mechanism.setLimits', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', useLimits: true, lower: -45, upper: 45 }));
    if (!__RV_HAS_PRIVATE__) {
      // A command view without its private implementation: refused up front.
      expect(r).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      expect(bridge.rebuilt).toEqual([]);
      return;
    }
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('(a) the rebuild happens AFTER the transaction, never before', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: the command refuses before any write
    const bridge = new FakeBridge([mechanismView('Mech')]);
    bridge.opCounter = () => env.doc.getSnapshot().opCount;
    setMechanismUiBridge(bridge);
    const before = env.doc.getSnapshot().opCount;
    await executeValue(env.viewer, 'mechanism.setLimits', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', useLimits: true, lower: -45, upper: 45 });
    expect(bridge.opCountAtRebuild).toHaveLength(1);
    // Rebuilding a half-applied composite would hand the solver a joint whose
    // body is not assigned yet.
    expect(bridge.opCountAtRebuild[0]).toBeGreaterThan(before);
  });

  it('(b) a body in NO links[] still rebuilds Mech — not the fallback branch', async () => {
    // The `add_body` reality: `planAddBody` only puts a MechanismBody on a node,
    // so until a joint references it the node appears in no links[]. Stage 2
    // alone would miss it and stage 3 would rebuild the world.
    if (!__RV_HAS_PRIVATE__) return; // community: the command refuses before any write
    const view = mechanismView('Mech', { joints: [], links: [] });
    const bridge = new FakeBridge([view, mechanismView('Other')]);
    setMechanismUiBridge(bridge);
    const r = parse(await executeValue(env.viewer, 'mechanism.addBody', { path: 'Mech/Arm/FreshBody', densityPreset: 'aluminum' }));
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('(c) genuine fallback: no mechanism ancestor and no reference rebuilds all, in list order', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: the command refuses before any write
    const bridge = new FakeBridge([
      mechanismView('Mech', { joints: [], links: [] }),
      mechanismView('Other', { joints: [], links: [] }),
    ]);
    setMechanismUiBridge(bridge);
    const r = parse(await executeValue(env.viewer, 'mechanism.addBody', { path: 'Outside', densityPreset: 'steel' }));
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech', 'Other']);
  });

  it('(b2) stage 2 catches a body linked from OUTSIDE the mechanism subtree', async () => {
    if (!__RV_HAS_PRIVATE__) return; // community: the command refuses before any write
    const bridge = new FakeBridge([
      mechanismView('Mech', { joints: [], links: [link('Outside', 'Outside')] }),
      mechanismView('Other', { joints: [], links: [] }),
    ]);
    setMechanismUiBridge(bridge);
    await executeValue(env.viewer, 'mechanism.addBody', { path: 'Outside', densityPreset: 'steel' });
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('every legacy write tool rebuilds too — the plan-706 F2 defect', async () => {
    // The direct tool commits through the private `commitMechanismPlan` (plan-504);
    // the community stub commits nothing, and no community build has a bridge.
    if (!__RV_HAS_PRIVATE__) return;
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    await execute('mechanism.setAnchor', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', anchorAJson: '{"x":1,"y":0,"z":0}', anchorBJson: '' });
    // Before plan-706 this array was empty for every MCP write, and an anchor an
    // agent set only took effect when a human next touched the panel.
    expect(bridge.rebuilt).toEqual(['Mech']);
  });
});

// ─── T2 — no bridge, no writes ──────────────────────────────────────────────

describe('T2 — without the private bundle every mechanism tool refuses', () => {
  /**
   * Derived from the SCHEMA ROSTER rather than hand-listed, so a 17th mechanism
   * tool cannot slip past this guarantee by simply not being written down here.
   */
  const mechanismTools = [...BOUND];

  // 16 -> 22 with plan-729 (Cartesian mechanism paths: add_target, path_create,
  // path_add_waypoint, path_remove_waypoint, path_move_waypoint, path_inspect).
  // 22 -> 26 with plan-501 (drive sizing: trajectory_import, _run, _inspect, _export).
  it('all 11 former mechanism bindings are commands, with no decorated mechanism tools', () => {
    expect(mechanismTools.length).toBe(11);
    expect(allSchemas().filter((s) => s.name.includes('mechanism'))).toEqual([]);
    for (const name of mechanismTools) expect(movedToolOf(name)?.movedTo).toHaveLength(1);
  });

  it('each returns an error, names the alternative, and appends NO op', async () => {
    setMechanismUiBridge(null);
    const calls: Record<string, () => Promise<string>> = {
      web_editor_mechanism_create: () => executeValue(env.viewer, 'mechanism.create', { path: 'Mech/Arm' }),
      web_editor_mechanism_add_joint: () => executeValue(env.viewer, 'mechanism.addJoint', { path: 'Mech/Arm/Joint1', jointType: 'Revolute', bodyBPath: 'Mech/Arm', bodyAPath: '', anchorAJson: '', anchorBJson: '', axisAJson: '' }),
      web_editor_mechanism_assign_drive: () => executeValue(env.viewer, 'mechanism.assignDrive', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', drivePath: '' }),
      web_editor_mechanism_validate: () => queryValue(env.viewer, 'mechanism.validate', { path: '' }),
      web_editor_mechanism_jog: () => executeValue(env.viewer, 'mechanism.jog', { path: 'Mech/Arm/Joint1', value: 10, componentType: '' }),
      web_editor_mechanism_inspect: () => queryValue(env.viewer, 'mechanism.inspect', { path: '', include: '' }),
      web_editor_mechanism_snap_list: () => queryValue(env.viewer, 'mechanism.snapList', { x: 0.5, y: 0.5, maxCandidates: 12 }),
      web_editor_mechanism_set_anchor_snap: () => executeValue(env.viewer, 'mechanism.setAnchorSnap', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', side: 'B', candidateId: 'snap0', assignBody: true, pickJson: '' }),
      web_editor_mechanism_set_axis: () => executeValue(env.viewer, 'mechanism.setAxis', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', candidateId: '', axisWorldJson: '{"x":0,"y":0,"z":1}', secondaryAxisWorldJson: '', snapToPrincipal: false }),
      web_editor_mechanism_add_body: () => executeValue(env.viewer, 'mechanism.addBody', { path: 'Mech/Arm/FreshBody', densityPreset: 'steel' }),
      web_editor_mechanism_set_mass: () => executeValue(env.viewer, 'mechanism.setMass', { path: 'Mech/Arm/FreshBody', densityPreset: 'steel', densityKgM3: 0, massKg: '', comJson: '' }),
      web_editor_mechanism_set_limits: () => executeValue(env.viewer, 'mechanism.setLimits', { path: 'Mech/Arm/Joint1', componentType: 'KinematicJoint', useLimits: true, lower: -1, upper: 1 }),
      web_editor_mechanism_forces: () => queryValue(env.viewer, 'mechanism.forces', { mechanismPath: 'Mech', channelId: '', series: false }),
      web_editor_mechanism_statics: () => executeValue(env.viewer, 'mechanism.statics', { mechanismPath: 'Mech' }),
      web_editor_mechanism_fix: () => executeValue(env.viewer, 'mechanism.fix', { path: 'Mech/Arm/Joint1', code: 'AnchorsApart' }),
      web_editor_mechanism_path_inspect: () => queryValue(env.viewer, 'mechanism.pathInspect', { path: '' }),
      web_editor_mechanism_trajectory_inspect: () => queryValue(env.viewer, 'mechanism.trajectoryInspect', { path: '', maxPoints: 0 }),
      web_editor_mechanism_trajectory_export: () => queryValue(env.viewer, 'mechanism.trajectoryExport', { path: 'Mech/Arm' }),
    };
    // Every roster entry must be exercised — a tool missing from this map would
    // otherwise be "covered" by not being called.
    expect(Object.keys(calls).sort()).toEqual([...mechanismTools, 'web_editor_mechanism_inspect', 'web_editor_mechanism_forces', 'web_editor_mechanism_path_inspect', 'web_editor_mechanism_snap_list', 'web_editor_mechanism_trajectory_export', 'web_editor_mechanism_trajectory_inspect', 'web_editor_mechanism_validate'].sort());

    const opsBefore = env.doc.getSnapshot().opCount;
    for (const [name, call] of Object.entries(calls)) {
      const r = parse(await call());
      expect(r.error, `${name} must refuse without the bridge`).toBeTruthy();
      if (!__RV_HAS_PRIVATE__ && (BOUND.has(name) || !mechanismTools.includes(name))) {
        // plan-504: a command view in the community build refuses at the
        // descriptor's capability — the edition text, never "Unknown command".
        expect(r.error, name).toBe(ERR_EDITOR_UNAVAILABLE);
        continue;
      }
      expect(String(r.error), `${name} must name the alternative`)
        .toContain('editor.createKinematic');
    }
    expect(env.doc.getSnapshot().opCount, 'no mechanism tool may write without a solver')
      .toBe(opsBefore);
  });
});

// ─── plan-729 — Cartesian mechanism path tools ─────────────────────────────

describe('plan-729 9.4 — mechanism path tools write one composite each and rebuild nothing', () => {
  const rv = (path: string): Record<string, any> =>
    (env.viewer.registry!.getNode(path)!.userData.realvirtual ?? {}) as Record<string, any>;
  const list = (path: string): string[] =>
    ((rv(path).MechanismPath?.Path ?? []) as { path: string }[]).map((e) => e.path);

  it('target → path → add / move / remove waypoint round-trip through the document', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);

    let r = parse(await execute('mechanism.targetCreate', { path: 'Mech/Arm/FreshBody', interpolation: 'PointToPoint', speedToTarget: 0, waitForSeconds: 0.3, mechanismPath: '' }));
    expect(r.ok).toBe(true);
    expect(rv('Mech/Arm/FreshBody').MechanismTarget).toMatchObject({
      InterpolationToTarget: 'PointToPoint', WaitForSeconds: 0.3,
    });
    expect(rv('Mech/Arm/FreshBody').MechanismTarget.SpeedToTarget).toBeUndefined();

    r = parse(await execute('mechanism.pathCreate', { path: 'Mech/Arm', mechanismPath: 'Mech', targetLinkPath: 'Mech/Arm/Joint1', waypointPaths: 'Mech/Arm/FreshBody', loopPath: true, linearSpeed: 300, linearAcceleration: 0 }));
    expect(r.ok).toBe(true);
    expect(rv('Mech/Arm').MechanismPath).toMatchObject({ LoopPath: true, LinearSpeedToTarget: 300 });
    expect(list('Mech/Arm')).toEqual(['Mech/Arm/FreshBody']);

    const before = env.doc.getSnapshot().opCount;
    r = parse(await execute('mechanism.pathAddWaypoint', { path: 'Mech/Arm', waypointPath: 'Mech/Arm/FreshBody', index: 0 }));
    expect(r.waypoints).toEqual(['Mech/Arm/FreshBody', 'Mech/Arm/FreshBody']);
    // ONE op per list edit — one undo step.
    expect(env.doc.getSnapshot().opCount).toBe(before + 1);

    r = parse(await execute('mechanism.pathMoveWaypoint', { path: 'Mech/Arm', from: 0, to: 1 }));
    expect(r.ok).toBe(true);
    r = parse(await execute('mechanism.pathRemoveWaypoint', { path: 'Mech/Arm', index: 1 }));
    expect(r.removed).toBe('Mech/Arm/FreshBody');
    expect(list('Mech/Arm')).toEqual(['Mech/Arm/FreshBody']);

    // A path/waypoint edit changes no joint topology — no mechanism rebuild.
    expect(bridge.rebuilt).toEqual([]);
  });

  it('refuses a waypoint that is not a MechanismTarget, and an out-of-range index', async () => {
    if (!__RV_HAS_PRIVATE__) return;
    setMechanismUiBridge(new FakeBridge([mechanismView('Mech')]));
    await execute('mechanism.pathCreate', { path: 'Mech/Arm', mechanismPath: 'Mech', targetLinkPath: 'Mech/Arm/Joint1', waypointPaths: '', loopPath: false, linearSpeed: 0, linearAcceleration: 0 });
    const before = env.doc.getSnapshot().opCount;
    let r = parse(await execute('mechanism.pathAddWaypoint', { path: 'Mech/Arm', waypointPath: 'Mech/Arm/Joint1', index: 0 }));
    expect(String(r.error)).toContain('mechanism.targetCreate');
    r = parse(await execute('mechanism.pathRemoveWaypoint', { path: 'Mech/Arm', index: 3 }));
    expect(r.error).toBeTruthy();
    r = parse(await execute('mechanism.pathCreate', { path: 'Mech/Arm/Joint1', mechanismPath: 'Outside', targetLinkPath: 'Mech/Arm', waypointPaths: '', loopPath: false, linearSpeed: 0, linearAcceleration: 0 }));
    expect(String(r.error)).toContain('not a KinematicMechanism');
    expect(env.doc.getSnapshot().opCount).toBe(before);
  });

  it.skipIf(!__RV_HAS_PRIVATE__)('path_inspect hands the bridge path views through, and reads [] from a bridge without listPaths', async () => {
    const view = {
      nodePath: 'Mech/Arm', name: 'Arm', mechanismPath: 'Mech', targetLinkPath: 'Mech/Arm',
      loopPath: true, speedOverride: 1, linearSpeedToTarget: 500, linearAcceleration: 1000,
      waypoints: [{
        nodePath: 'Mech/Arm/FreshBody', name: 'FreshBody', resolved: true, interpolation: 'Linear' as const,
        speedToTarget: null, waitForSeconds: 0, worldPositionMm: [1, 2, 3] as [number, number, number],
      }],
      showPath: false, // plan-511
      active: false, finished: false, failed: true, reachable: false, numTarget: 0,
      lastError: "waypoint 'FreshBody' is not reachable",
    };
    const withPaths = new FakeBridge([mechanismView('Mech')]) as FakeBridge & { listPaths(): typeof view[] };
    withPaths.listPaths = () => [view];
    setMechanismUiBridge(withPaths);
    let r = parse(await queryValue(env.viewer, 'mechanism.pathInspect', { path: '' }));
    expect(r.paths).toEqual([view]);
    r = parse(await queryValue(env.viewer, 'mechanism.pathInspect', { path: 'Nope' }));
    expect(r.availablePaths).toEqual(['Mech/Arm']);

    setMechanismUiBridge(new FakeBridge([mechanismView('Mech')]));
    r = parse(await queryValue(env.viewer, 'mechanism.pathInspect', { path: '' }));
    expect(r.paths).toEqual([]);
  });
});

// ─── plan-504 — the command views ────────────────────────────────────────────

describe('plan-504 — mechanism tools are command views', () => {
  it('cold start: loading the tool module registered all twenty-seven descriptors (no setup registration)', () => {
    // Nothing in this file registers commands: the import of McpEditorTools did.
    for (const id of MECHANISM_COMMAND_IDS) expect(commandRegistry.get(id), id).toBeDefined();
    expect(MECHANISM_COMMAND_IDS).toHaveLength(27);
  });

  it('statics without a solvable snapshot answers the reason (no force recorder figures invented)', async () => {
    setMechanismUiBridge(new FakeBridge([mechanismView('Mech')]));
    const r = parse(await executeValue(env.viewer, 'mechanism.statics', { mechanismPath: 'Mech' }));
    if (!__RV_HAS_PRIVATE__) {
      expect(r).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    expect(r.error).toContain('web_editor_mechanism_add_body');
    expect(r.availablePaths).toEqual(['Mech']);
  });

  it('a refusal answers the rule text with its details (unknown preset → availablePresets)', async () => {
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    const opsBefore = env.doc.getSnapshot().opCount;
    const r = parse(await executeValue(env.viewer, 'mechanism.addBody', { path: 'Mech/Arm/FreshBody', densityPreset: 'unobtainium' }));
    if (!__RV_HAS_PRIVATE__) {
      expect(r).toEqual({ error: ERR_EDITOR_UNAVAILABLE });
      return;
    }
    expect(r.error).toBe('Unknown densityPreset "unobtainium"');
    expect(r.availablePresets).toContain('steel');
    expect(env.doc.getSnapshot().opCount).toBe(opsBefore);
    expect(bridge.rebuilt).toEqual([]);
  });
});
