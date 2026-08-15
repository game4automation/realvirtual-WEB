// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

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
 *
 * Real `McpEditorTools` over a real `AssetDocument`, `NodeRegistry` and `Scene`
 * (the `mcp-editor-doc-mutations` fixture), with a RECORDING bridge double in
 * place of the private side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import {
  setMechanismUiBridge,
  type MechanismFindingView,
  type MechanismJointView,
  type MechanismLinkView,
  type MechanismUiBridge,
  type MechanismView,
} from '../src/core/engine/rv-kinematic-registry';
import { allSchemas } from './helpers/mcp-schemas';

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
    nodePath, name, hasBody: true,
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

function mechanismView(nodePath: string, over: Partial<MechanismView> = {}): MechanismView {
  return {
    nodePath, name: nodePath.split('/').pop() ?? nodePath,
    active: true, converged: true, residualError: 1e-6, solveTimeMs: 0.42,
    disabledReason: '', jointCount: 2, linkCount: 3, loopCount: 1, dof: 1,
    joints: [joint(`${nodePath}/Arm/Joint1`, 'Joint1'), joint(`${nodePath}/Arm/Joint2`, 'Joint2')],
    links: [link(`${nodePath}/Base`, 'Base'), link(`${nodePath}/Arm`, 'Arm'), link(`${nodePath}/Tool`, 'Tool')],
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

  constructor(private readonly _views: MechanismView[]) {}

  list(): MechanismView[] { return this._views; }
  validate(): MechanismFindingView[] { return [FINDING]; }
  jog(): { converged: boolean; residualError: number } | null { return { converged: true, residualError: 0 }; }
  rebuild(mechanismPath: string): void {
    this.rebuilt.push(mechanismPath);
    this.opCountAtRebuild.push(this.opCounter());
  }
  suggestFix(): Record<string, unknown> | null { return { AnchorB: { x: 1, y: 2, z: 3 } }; }
  setForceAnalysis(): void {}
  forcesSnapshot(): null { return null; }
  solveStatics(): null { return null; }
  resetForces(): void {}
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
  const viewer = {
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
    markRenderDirty() {}, markShadowsDirty() {}, emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = AssetDocument.newUntitled(viewer);
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

describe('T1 — web_editor_mechanism_inspect passes the bridge views through', () => {
  beforeEach(() => { setMechanismUiBridge(new FakeBridge([mechanismView('Mech')])); });

  it('returns joints, links and findings in full', async () => {
    const r = parse(await env.tools.webEditorMechanismInspect('', ''));
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

    expect(m.findings).toHaveLength(1);
    expect(m.findings[0].fixable).toBe(true);
  });

  it('include=findings drops joints and links from the answer', async () => {
    const r = parse(await env.tools.webEditorMechanismInspect('', 'findings'));
    const m = r.mechanisms[0];
    expect(m.joints).toBeUndefined();
    expect(m.links).toBeUndefined();
    expect(m.findings).toHaveLength(1);
    // The counters stay regardless — they are what makes the filter usable.
    expect(m.jointCount).toBe(2);
    expect(m.linkCount).toBe(3);
  });

  it('an unknown path refuses and names the ones that exist', async () => {
    const r = parse(await env.tools.webEditorMechanismInspect('Nope', ''));
    expect(r.error).toContain('Nope');
    expect(r.availablePaths).toEqual(['Mech']);
  });
});

// ─── T1b — the three-stage path derivation ──────────────────────────────────

describe('T1b — _mechCommit rebuilds the RIGHT mechanism', () => {
  it('(a) ancestor hit: a joint under Mech rebuilds exactly Mech, once', async () => {
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    const r = parse(await env.tools.webEditorMechanismSetLimits(
      'Mech/Arm/Joint1', 'KinematicJoint', true, -45, 45,
    ));
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('(a) the rebuild happens AFTER the transaction, never before', async () => {
    const bridge = new FakeBridge([mechanismView('Mech')]);
    bridge.opCounter = () => env.doc.getSnapshot().opCount;
    setMechanismUiBridge(bridge);
    const before = env.doc.getSnapshot().opCount;
    await env.tools.webEditorMechanismSetLimits('Mech/Arm/Joint1', 'KinematicJoint', true, -45, 45);
    expect(bridge.opCountAtRebuild).toHaveLength(1);
    // Rebuilding a half-applied composite would hand the solver a joint whose
    // body is not assigned yet.
    expect(bridge.opCountAtRebuild[0]).toBeGreaterThan(before);
  });

  it('(b) a body in NO links[] still rebuilds Mech — not the fallback branch', async () => {
    // The `add_body` reality: `planAddBody` only puts a MechanismBody on a node,
    // so until a joint references it the node appears in no links[]. Stage 2
    // alone would miss it and stage 3 would rebuild the world.
    const view = mechanismView('Mech', { joints: [], links: [] });
    const bridge = new FakeBridge([view, mechanismView('Other')]);
    setMechanismUiBridge(bridge);
    const r = parse(await env.tools.webEditorMechanismAddBody('Mech/Arm/FreshBody', 'aluminum'));
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('(c) genuine fallback: no mechanism ancestor and no reference rebuilds all, in list order', async () => {
    const bridge = new FakeBridge([
      mechanismView('Mech', { joints: [], links: [] }),
      mechanismView('Other', { joints: [], links: [] }),
    ]);
    setMechanismUiBridge(bridge);
    const r = parse(await env.tools.webEditorMechanismAddBody('Outside', 'steel'));
    expect(r.error).toBeUndefined();
    expect(bridge.rebuilt).toEqual(['Mech', 'Other']);
  });

  it('(b2) stage 2 catches a body linked from OUTSIDE the mechanism subtree', async () => {
    const bridge = new FakeBridge([
      mechanismView('Mech', { joints: [], links: [link('Outside', 'Outside')] }),
      mechanismView('Other', { joints: [], links: [] }),
    ]);
    setMechanismUiBridge(bridge);
    await env.tools.webEditorMechanismAddBody('Outside', 'steel');
    expect(bridge.rebuilt).toEqual(['Mech']);
  });

  it('every legacy write tool rebuilds too — the plan-706 F2 defect', async () => {
    const bridge = new FakeBridge([mechanismView('Mech')]);
    setMechanismUiBridge(bridge);
    await env.tools.webEditorMechanismSetAnchor(
      'Mech/Arm/Joint1', 'KinematicJoint', '{"x":1,"y":0,"z":0}', '',
    );
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
  const mechanismTools = allSchemas()
    .map((s) => s.name)
    .filter((n) => n.includes('mechanism'));

  it('the roster carries all 16 mechanism tools', () => {
    expect(mechanismTools.length).toBe(16);
  });

  it('each returns an error, names the alternative, and appends NO op', async () => {
    setMechanismUiBridge(null);
    const calls: Record<string, () => Promise<string>> = {
      web_editor_mechanism_create: () => env.tools.webEditorMechanismCreate('Mech/Arm'),
      web_editor_mechanism_add_joint: () => env.tools.webEditorMechanismAddJoint('Mech/Arm/Joint1', 'Revolute', 'Mech/Arm', '', '', '', ''),
      web_editor_mechanism_set_anchor: () => env.tools.webEditorMechanismSetAnchor('Mech/Arm/Joint1', 'KinematicJoint', '{"x":1,"y":0,"z":0}', ''),
      web_editor_mechanism_assign_drive: () => env.tools.webEditorMechanismAssignDrive('Mech/Arm/Joint1', 'KinematicJoint', ''),
      web_editor_mechanism_validate: () => env.tools.webEditorMechanismValidate(''),
      web_editor_mechanism_jog: () => env.tools.webEditorMechanismJog('Mech/Arm/Joint1', 10, ''),
      web_editor_mechanism_inspect: () => env.tools.webEditorMechanismInspect('', ''),
      web_editor_mechanism_snap_list: () => env.tools.webEditorMechanismSnapList(0.5, 0.5, 12),
      web_editor_mechanism_set_anchor_snap: () => env.tools.webEditorMechanismSetAnchorSnap('Mech/Arm/Joint1', 'KinematicJoint', 'B', 'snap0', true),
      web_editor_mechanism_set_axis: () => env.tools.webEditorMechanismSetAxis('Mech/Arm/Joint1', 'KinematicJoint', '', '{"x":0,"y":0,"z":1}', '', false),
      web_editor_mechanism_add_body: () => env.tools.webEditorMechanismAddBody('Mech/Arm/FreshBody', 'steel'),
      web_editor_mechanism_set_mass: () => env.tools.webEditorMechanismSetMass('Mech/Arm/FreshBody', 'steel', 0, '', ''),
      web_editor_mechanism_set_limits: () => env.tools.webEditorMechanismSetLimits('Mech/Arm/Joint1', 'KinematicJoint', true, -1, 1),
      web_editor_mechanism_forces: () => env.tools.webEditorMechanismForces('Mech', '', false),
      web_editor_mechanism_statics: () => env.tools.webEditorMechanismStatics('Mech'),
      web_editor_mechanism_fix: () => env.tools.webEditorMechanismFix('Mech/Arm/Joint1', 'AnchorsApart'),
    };
    // Every roster entry must be exercised — a tool missing from this map would
    // otherwise be "covered" by not being called.
    expect(Object.keys(calls).sort()).toEqual([...mechanismTools].sort());

    const opsBefore = env.doc.getSnapshot().opCount;
    for (const [name, call] of Object.entries(calls)) {
      const r = parse(await call());
      expect(r.error, `${name} must refuse without the bridge`).toBeTruthy();
      expect(String(r.error), `${name} must name the alternative`)
        .toContain('web_editor_create_kinematic');
    }
    expect(env.doc.getSnapshot().opCount, 'no mechanism tool may write without a solver')
      .toBe(opsBefore);
  });
});
