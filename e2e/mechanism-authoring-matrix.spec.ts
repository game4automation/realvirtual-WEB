// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-404 §9 T10 — the Quick-Edit AUTHORING MATRIX for rigid-body mechanisms.
 *
 * ── WHAT THIS PROVES (acceptance 2: full authoring + generality) ─────────────
 * For every row of the matrix, in ONE real browser page against ONE real
 * `AssetDocument`, with the REAL private wasm solver doing the arithmetic:
 *
 *   author  →  jog (assert the solver CONVERGED)  →  persist to GLB  →
 *   reload that GLB into the viewer  →  jog again (assert it STILL converges)
 *
 * The rows are the ones §9 T10 names:
 *
 *   | row              | joint kinds exercised        | structural feature      |
 *   |------------------|------------------------------|-------------------------|
 *   | revolute         | Revolute                     | open chain + limits     |
 *   | prismatic        | Prismatic                    | open chain, linear drive|
 *   | spherical        | Revolute ×2 + Spherical      | passive tree dof + free |
 *   |                  |                              | body                    |
 *   | universal        | Revolute + Universal         | cardan, secondary axis  |
 *   | world-anchor     | Revolute                      | BodyA key ABSENT       |
 *   | four-bar         | Revolute ×4                  | LOOP CLOSURE            |
 *   | delta            | Revolute + Spherical         | FREE BODY (Unity        |
 *   |                  |                              | KinematicTemplates rig) |
 *
 * Every assertion is a real fact read back out of the running viewer:
 *   * `MechanismUiBridge.jog()` returns the solver's OWN `{converged,
 *     residualError}` — no proxy, no "did not throw" stand-in;
 *   * a probe body's world matrix must actually MOVE between the two jog
 *     values, so a mechanism that reports convergence without solving anything
 *     cannot pass;
 *   * `active === true` means the manager really created a wasm handle for it;
 *   * after the reload the joints are re-found through `bridge.list()`, so the
 *     Body A / Body B / DrivenBy references must have survived the GLB round
 *     trip and resolved again — a dangling reference shows up as a null body
 *     name and as an `UnresolvedBody` error finding that disables the mechanism.
 *
 * ── THE DELIBERATE CUT: OPS LAYER, NOT SYNTHETIC MOUSE GESTURES ─────────────
 * plan-404 §9 permits this matrix to drive the AUTHORING COMPOSITES rather than
 * synthesising mouse picks, provided the new 3D-interaction building blocks are
 * unit-tested on their own. They are: `tests/mechanism-interaction.test.ts`
 * covers the snap maths, the frame conversions and the plan builders in
 * isolation. Real headless picking would add a raycast/BVH readiness race and a
 * camera-framing dependency to every one of the seven rows without proving one
 * additional thing about authoring or about the solver.
 *
 * So this spec calls the SAME public composites the panel and the
 * `web_editor_mechanism_*` MCP tools call — `planCreateMechanism`,
 * `planAddJoint`, `planPickAnchor`, `planSetAxis`, `planSetLimits`,
 * `planAssignDrive`, executed through `runMechanismPlan` inside
 * `AssetDocument.withTransaction()` — and nothing else. No mouse event is
 * synthesised and no panel DOM is touched anywhere in this file. What is NOT
 * covered here, stated plainly: the hover-highlight / anchor-snap / axis-gizmo
 * *gestures* (plan §3.2), and the React rendering of `MechanismSection.tsx`.
 *
 * ── TWO DEFECTS THIS SPEC UNCOVERED, AND WHAT IT DOES ABOUT THEM ────────────
 * Both are in EXISTING app code that plan-404 leans on, both are outside this
 * plan's `scope_paths`, and neither was fixed here — the harness compensates in
 * TEST code only, and says so at each site, so the matrix measures the solver
 * and the authoring composites rather than these two gaps:
 *
 *   D1 — `addComponent(path, 'Drive', …)` creates NO live drive. `Drive` has no
 *        entry in `getRegisteredFactories()` (the loader builds drives through
 *        the separate `constructDrive()` branch), so the editor's
 *        `constructComponentOnNode` path writes the extras and returns null. A
 *        joint's `DrivenBy` then resolves to the bare NODE. Harness: materialise
 *        the authored drive through `processExtras`, the production runtime path
 *        for extras on a subtree added at runtime.
 *
 *   D2 — a reference written through `setField` is never re-resolved.
 *        `reapplySchemaForComponent` runs `applySchema` + `reapplyConfig` but
 *        not `resolveComponentRefs`, so after `planAssignDrive` (and after
 *        `planPickAnchor` when it reassigns a body) the LIVE component holds the
 *        raw `ComponentReference` object. `describeDrive` then reads `.node` off
 *        it and throws a TypeError out of `build()` — a crash, not a finding.
 *        Harness: call the idempotent `resolveComponentRefs` on the joint after
 *        its composites.
 *
 * Neither compensation touches authored data, so the saved GLB is exactly what
 * the composites produced, and the whole post-reload half of every row runs
 * through the ordinary loader with no scaffolding at all.
 *
 * ── READINESS, GATED ON REAL PRECONDITIONS ONLY ─────────────────────────────
 * Never a bare timeout. The two things this spec actually needs are:
 *   1. a viewer with a loaded model AND a registry AND a transportManager —
 *      `AssetExecutorContext._runtimeDeps()` returns null without the last one,
 *      and then `addComponent` silently constructs nothing;
 *   2. `getMechanismUiBridge()` non-null AND the wasm artifact loaded past its
 *      ABI gate. The bridge appears at viewer construction (the private feature
 *      registers synchronously), the artifact lands later — so the gate is
 *      "the model's OWN imported mechanism reports `active: true`", which is
 *      only true once a real `rvk_create` handle exists.
 *
 * The base model is `models/mechanism-scissor.glb` — the smallest Phase-0
 * reference export. Its own imported mechanism doubles as the readiness probe
 * above and as a bystander: every row authors a fresh, uniquely named subtree
 * as a SIBLING of it, so nothing this spec builds is nested inside another
 * mechanism (which would be a `NestedMechanism` error finding).
 *
 * ── FRAMES ──────────────────────────────────────────────────────────────────
 * Anchors and axes are authored in the WIRE frame (Unity millimetres) because
 * that is what the composites write into the extras. The schema's
 * `unityCoords: true` mirrors X on read, so a body node placed to match an
 * authored anchor must be placed at the X-MIRRORED three-space position — which
 * is exactly what the Phase-0 GLBs contain (`Rocker` at three `[-0.6, 0.3, 0]`
 * for Unity `(600, 300, 0)`). `unityMmToThree()` below encodes that one rule so
 * every rig can be written in one consistent frame.
 */

import { expect, test, type Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';

// ─── Matrix definition ──────────────────────────────────────────────────────

interface BodySpec {
  name: string;
  /** Parent body name; omitted = directly under the mechanism node. */
  parent?: string;
  /** Position in Unity millimetres (mirrored into three space on creation). */
  unityMm: [number, number, number];
  /** Drive to author on this node, if any. */
  drive?: { direction: string };
}

interface JointSpec {
  name: string;
  jointType: 'Revolute' | 'Prismatic' | 'Spherical' | 'Universal';
  /** Body A name, or null for a WORLD ANCHOR (BodyA key never written). */
  bodyA: string | null;
  bodyB: string;
  /** Anchors in Unity millimetres, in the respective body local frame. */
  anchorA: [number, number, number];
  anchorB: [number, number, number];
  axisA?: [number, number, number];
  /** Universal only — written through `planSetAxis` after creation. */
  secondaryAxisB?: [number, number, number];
  /** Body name carrying the Drive that controls this joint. */
  driveOn?: string;
  /** Written through `planSetLimits`. */
  limits?: { lower: number; upper: number };
  /**
   * Author the anchors through `planPickAnchor` (the composite the 3D anchor
   * pick commits) instead of inline in `planAddJoint`.
   */
  viaPick?: boolean;
}

interface CaseSpec {
  id: string;
  title: string;
  bodies: BodySpec[];
  joints: JointSpec[];
  /** Joint jogged before and after the round trip. */
  jogJoint: string;
  jogBefore: number;
  jogAfter: number;
  /** Body whose world position must change when the mechanism is jogged. */
  probe: string;
  /** Distinct links the mechanism must discover (world is not a link). */
  linkCount: number;
  /** Joint names that must report `worldAnchored: true`. */
  worldAnchored?: string[];
  /** Joint names whose extras must carry NO `BodyA` key in the saved GLB. */
  bodyAAbsent?: string[];
  minLoopCount?: number;
}

/** Node name prefix per row — globally unique, so suffix resolution is exact. */
const MATRIX: CaseSpec[] = [
  {
    id: 'T10Rev',
    title: 'revolute — open chain, driven, with joint limits',
    bodies: [
      { name: 'T10Rev_Base', unityMm: [0, 0, 0] },
      { name: 'T10Rev_Pivot', unityMm: [0, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Rev_Arm', parent: 'T10Rev_Pivot', unityMm: [500, 0, 0] },
    ],
    joints: [{
      name: 'T10Rev_JHinge',
      jointType: 'Revolute',
      bodyA: 'T10Rev_Base',
      bodyB: 'T10Rev_Arm',
      anchorA: [0, 0, 0],
      anchorB: [-500, 0, 0],
      axisA: [0, 0, 1],
      driveOn: 'T10Rev_Pivot',
      limits: { lower: -90, upper: 90 },
    }],
    jogJoint: 'T10Rev_JHinge',
    jogBefore: 30,
    jogAfter: 55,
    probe: 'T10Rev_Arm',
    linkCount: 2,
  },
  {
    id: 'T10Pri',
    title: 'prismatic — open chain, linear drive',
    bodies: [
      { name: 'T10Pri_Base', unityMm: [0, 0, 0] },
      { name: 'T10Pri_Pivot', unityMm: [0, 0, 0], drive: { direction: 'LinearX' } },
      { name: 'T10Pri_Slider', parent: 'T10Pri_Pivot', unityMm: [300, 0, 0] },
    ],
    joints: [{
      name: 'T10Pri_JSlide',
      jointType: 'Prismatic',
      bodyA: 'T10Pri_Base',
      bodyB: 'T10Pri_Slider',
      anchorA: [0, 0, 0],
      anchorB: [-300, 0, 0],
      axisA: [1, 0, 0],
      driveOn: 'T10Pri_Pivot',
    }],
    jogJoint: 'T10Pri_JSlide',
    jogBefore: 100,
    jogAfter: 175,
    probe: 'T10Pri_Slider',
    linkCount: 2,
  },
  {
    id: 'T10Sph',
    title: 'spherical — passive tree dof plus a free body',
    bodies: [
      { name: 'T10Sph_Base', unityMm: [0, 0, 0] },
      { name: 'T10Sph_Arm1', unityMm: [300, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Sph_Arm2', unityMm: [600, 0, 0] },
      { name: 'T10Sph_Ball', unityMm: [900, 0, 0] },
    ],
    joints: [
      {
        name: 'T10Sph_J1', jointType: 'Revolute',
        bodyA: 'T10Sph_Base', bodyB: 'T10Sph_Arm1',
        anchorA: [0, 0, 0], anchorB: [-300, 0, 0], axisA: [0, 0, 1],
        driveOn: 'T10Sph_Arm1',
      },
      {
        name: 'T10Sph_J2', jointType: 'Revolute',
        bodyA: 'T10Sph_Arm1', bodyB: 'T10Sph_Arm2',
        anchorA: [300, 0, 0], anchorB: [0, 0, 0], axisA: [0, 0, 1],
      },
      {
        name: 'T10Sph_J3', jointType: 'Spherical',
        bodyA: 'T10Sph_Arm2', bodyB: 'T10Sph_Ball',
        anchorA: [300, 0, 0], anchorB: [0, 0, 0],
      },
    ],
    jogJoint: 'T10Sph_J1',
    jogBefore: 20,
    jogAfter: 35,
    probe: 'T10Sph_Arm2',
    linkCount: 4,
  },
  {
    id: 'T10Uni',
    title: 'universal — cardan joint with an authored secondary axis',
    bodies: [
      { name: 'T10Uni_Base', unityMm: [0, 0, 0] },
      { name: 'T10Uni_Arm', unityMm: [200, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Uni_Fork', unityMm: [500, -300, 0] },
    ],
    joints: [
      {
        name: 'T10Uni_J1', jointType: 'Revolute',
        bodyA: 'T10Uni_Base', bodyB: 'T10Uni_Arm',
        anchorA: [0, 0, 0], anchorB: [-200, 0, 0], axisA: [0, 0, 1],
        driveOn: 'T10Uni_Arm',
      },
      {
        name: 'T10Uni_J2', jointType: 'Universal',
        bodyA: 'T10Uni_Arm', bodyB: 'T10Uni_Fork',
        anchorA: [100, 0, 0], anchorB: [-200, 300, 0],
        axisA: [0, 0, 1], secondaryAxisB: [0, 1, 0],
      },
    ],
    jogJoint: 'T10Uni_J1',
    jogBefore: 15,
    jogAfter: 25,
    // The Fork, not the Arm: the Arm carries its own RotationZ drive, so it
    // spins about its OWN origin and its world POSITION never changes. The
    // Fork is the body the solver has to carry along through the cardan.
    probe: 'T10Uni_Fork',
    linkCount: 3,
  },
  {
    id: 'T10Wld',
    title: 'world anchor — Body A key ABSENT, anchors committed through a pick',
    bodies: [
      { name: 'T10Wld_Pivot', unityMm: [0, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Wld_Arm', parent: 'T10Wld_Pivot', unityMm: [500, 0, 0] },
    ],
    joints: [{
      name: 'T10Wld_JWorld',
      jointType: 'Revolute',
      bodyA: null,
      bodyB: 'T10Wld_Arm',
      anchorA: [0, 0, 0],
      anchorB: [-500, 0, 0],
      axisA: [0, 0, 1],
      driveOn: 'T10Wld_Pivot',
      viaPick: true,
    }],
    jogJoint: 'T10Wld_JWorld',
    jogBefore: 25,
    jogAfter: 40,
    probe: 'T10Wld_Arm',
    linkCount: 1,
    worldAnchored: ['T10Wld_JWorld'],
    bodyAAbsent: ['T10Wld_JWorld'],
  },
  {
    id: 'T10Bar',
    title: 'four-bar — loop closure with two world-anchored joints',
    bodies: [
      { name: 'T10Bar_Crank', unityMm: [0, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Bar_Coupler', unityMm: [200, 0, 0] },
      { name: 'T10Bar_Rocker', unityMm: [600, 300, 0] },
    ],
    joints: [
      {
        name: 'T10Bar_JA', jointType: 'Revolute',
        bodyA: null, bodyB: 'T10Bar_Crank',
        anchorA: [0, 0, 0], anchorB: [0, 0, 0], axisA: [0, 0, 1],
        driveOn: 'T10Bar_Crank',
      },
      {
        name: 'T10Bar_JB', jointType: 'Revolute',
        bodyA: 'T10Bar_Crank', bodyB: 'T10Bar_Coupler',
        anchorA: [200, 0, 0], anchorB: [0, 0, 0], axisA: [0, 0, 1],
      },
      {
        name: 'T10Bar_JC', jointType: 'Revolute',
        bodyA: 'T10Bar_Coupler', bodyB: 'T10Bar_Rocker',
        anchorA: [400, 300, 0], anchorB: [0, 0, 0], axisA: [0, 0, 1],
      },
      {
        name: 'T10Bar_JD', jointType: 'Revolute',
        bodyA: null, bodyB: 'T10Bar_Rocker',
        anchorA: [600, 0, 0], anchorB: [0, -300, 0], axisA: [0, 0, 1],
      },
    ],
    jogJoint: 'T10Bar_JA',
    jogBefore: 8,
    jogAfter: 14,
    probe: 'T10Bar_Rocker',
    linkCount: 3,
    worldAnchored: ['T10Bar_JA', 'T10Bar_JD'],
    bodyAAbsent: ['T10Bar_JA', 'T10Bar_JD'],
    minLoopCount: 1,
  },
  {
    id: 'T10Dlt',
    title: 'delta — free body reached only through a Spherical joint',
    bodies: [
      { name: 'T10Dlt_Base', unityMm: [0, 0, 0] },
      { name: 'T10Dlt_Pivot', unityMm: [0, 0, 0], drive: { direction: 'RotationZ' } },
      { name: 'T10Dlt_UpperArm', parent: 'T10Dlt_Pivot', unityMm: [200, 0, 0] },
      { name: 'T10Dlt_Platform', unityMm: [500, -300, 0] },
    ],
    joints: [
      {
        name: 'T10Dlt_JShoulder', jointType: 'Revolute',
        bodyA: 'T10Dlt_Base', bodyB: 'T10Dlt_UpperArm',
        anchorA: [0, 0, 0], anchorB: [-200, 0, 0], axisA: [0, 0, 1],
        driveOn: 'T10Dlt_Pivot',
      },
      {
        name: 'T10Dlt_JBall', jointType: 'Spherical',
        bodyA: 'T10Dlt_UpperArm', bodyB: 'T10Dlt_Platform',
        anchorA: [100, 0, 0], anchorB: [-200, 300, 0],
      },
    ],
    jogJoint: 'T10Dlt_JShoulder',
    jogBefore: 20,
    jogAfter: 30,
    // The free body — the whole point of this row is that the Platform, which
    // no spanning-tree edge reaches, still follows the driven arm.
    probe: 'T10Dlt_Platform',
    linkCount: 3,
  },
];

const BASE_MODEL = DEV_GLB.mechanismScissor;

// ─── In-page harness ────────────────────────────────────────────────────────
//
// Installed ONCE per page as `window.__rvT10`. It is test-only scaffolding
// living entirely in the spec; no hook was added to app code (plan-404 forbids
// it), which is possible because everything it needs is already public:
// `window.viewer`, the AssetDocument module, the authoring composites and the
// mechanism UI bridge.

/** Paths the harness dynamically imports (kept in variables so TS does not try
 *  to resolve them at compile time — the same trick signal-link-mode.spec uses). */
const MODULE_PATHS = {
  doc: '/src/core/editor/rv-asset-document.ts',
  authoring: '/src/plugins/asset-editor/mechanism/mechanism-authoring.ts',
  registry: '/src/core/engine/rv-kinematic-registry.ts',
  glbExport: '/src/core/editor/rv-asset-glb-export.ts',
  loader: '/src/core/engine/rv-scene-loader.ts',
  components: '/src/core/engine/rv-component-registry.ts',
};

async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Record<string, any>;
    const [docMod, authoring, kinRegistry, glbExport, loader, components] = await Promise.all([
      import(/* @vite-ignore */ paths.doc),
      import(/* @vite-ignore */ paths.authoring),
      import(/* @vite-ignore */ paths.registry),
      import(/* @vite-ignore */ paths.glbExport),
      import(/* @vite-ignore */ paths.loader),
      import(/* @vite-ignore */ paths.components),
    ]);

    const IDENTITY = () => ({
      position: [0, 0, 0] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    });

    /** Unity millimetres → three-space metres. The schema mirrors X on read
     *  (`unityCoords: true`), so a node matching an authored anchor sits at −x. */
    const unityMmToThree = (v: number[]): [number, number, number] =>
      [-v[0] / 1000, v[1] / 1000, v[2] / 1000];

    const vec = (v: number[]) => ({ x: v[0], y: v[1], z: v[2] });

    const rvOf = (node: any): Record<string, any> =>
      (node?.userData?.realvirtual ?? {}) as Record<string, any>;

    // `updateWorldMatrix(true, false)` — refresh the ANCESTORS first. A driven
    // link is moved by its Drive writing the drive node's local transform, so
    // reading the child's `matrixWorld` without refreshing the chain above it
    // returns the pre-jog world pose and the "it moved" assertion would be
    // measuring stale data.
    const worldPos = (node: any): [number, number, number] => {
      node.updateWorldMatrix(true, false);
      const e = node.matrixWorld.elements;
      return [e[12], e[13], e[14]];
    };

    w.__rvT10 = {
      /** Load the base model fresh — every row starts from a clean scene. */
      async loadBase(url: string) {
        await w.viewer.loadModel(url);
        return { root: w.viewer.currentModelRoot?.name ?? null };
      },

      /** True once a real wasm handle exists for at least one mechanism. */
      solverReady(): boolean {
        const bridge = kinRegistry.getMechanismUiBridge?.();
        if (!bridge) return false;
        return bridge.list().some((m: any) => m.active === true);
      },

      /**
       * Author one matrix row through the PUBLIC composites only.
       * Returns the paths and the deduped component keys so the test can assert
       * on them without re-deriving anything.
       */
      async author(spec: any) {
        const viewer = w.viewer;
        const doc = docMod.AssetDocument.newUntitled(viewer);
        w.__rvT10._doc = doc;

        const readField = (nodePath: string, componentType: string, fieldName: string) => {
          const node = viewer.registry?.getNode(nodePath);
          if (!node) return undefined;
          return rvOf(node)[componentType]?.[fieldName];
        };
        const docLike = {
          withTransaction: (label: string, fn: () => Promise<void>) => doc.withTransaction(label, fn),
          addComponent: (nodePath: string, baseType: string, fields: Record<string, unknown>) =>
            doc.addComponent(nodePath, baseType, fields),
          setField: (nodePath: string, componentType: string, fieldName: string, v: unknown, prev: unknown) =>
            doc.setField(nodePath, componentType, fieldName, v, prev),
          unsetField: (nodePath: string, componentType: string, fieldName: string, prev: unknown) =>
            doc.unsetField(nodePath, componentType, fieldName, prev),
        };
        const run = (plan: any) => authoring.runMechanismPlan(docLike, plan, readField);

        // 1 — the mechanism node, a sibling of anything already in the model.
        const mechPath: string = await doc.createEmptyNode(null, spec.id, { transform: IDENTITY() });

        // 2 — body nodes, placed so the authored anchors coincide in world space.
        const bodyPaths: Record<string, string> = {};
        for (const b of spec.bodies) {
          const parent = b.parent ? bodyPaths[b.parent] : mechPath;
          bodyPaths[b.name] = await doc.createEmptyNode(parent, b.name, {
            transform: { ...IDENTITY(), position: unityMmToThree(b.unityMm) },
          });
        }

        // 3 — drives. Authored as a normal undoable `addComponent` op (that is
        //     what writes the extras the GLB will carry), and then MATERIALISED
        //     through `processExtras`.
        //
        //     Why the second step is needed and is not a cheat: `Drive` has no
        //     entry in `getRegisteredFactories()` — the loader builds drives
        //     through `constructDrive()`, a separate branch — so the editor's
        //     `addComponent` path (`constructComponentOnNode`) creates the
        //     extras but NO live `RVDrive`. A joint's `DrivenBy` then resolves
        //     to the bare node instead of a drive. `processExtras` is the
        //     production runtime path for extras on a subtree added at runtime
        //     (it is what a Layout-Planner placement runs), so this constructs
        //     the drive exactly the way the app does, on a node that carries
        //     nothing but the Drive. After the GLB round trip the drives come
        //     from the ordinary loader, with no scaffolding at all.
        const driveKeys: Record<string, string> = {};
        for (const b of spec.bodies) {
          if (!b.drive) continue;
          driveKeys[b.name] = doc.addComponent(bodyPaths[b.name], 'Drive', {
            Direction: b.drive.direction,
            TargetSpeed: 90,
            UseLimits: false,
          });
        }
        await doc.whenIdle();
        for (const b of spec.bodies) {
          if (!b.drive) continue;
          const driveNode = viewer.registry.getNode(bodyPaths[b.name]);
          loader.processExtras(
            driveNode, viewer.registry, viewer.signalStore, viewer.transportManager,
            viewer.scene, viewer.gizmoManager, undefined, viewer.errorStore,
            viewer.instructionStore, undefined, viewer.outlineManager,
            viewer.lampManager, viewer.energyChainManager,
          );
          if (!viewer.registry.getByPath('Drive', bodyPaths[b.name])) {
            throw new Error(`no live Drive constructed on ${bodyPaths[b.name]}`);
          }
        }

        // 4 — the joint nodes (children of the mechanism node — the mechanism
        //     collects joints from its own subtree).
        const jointPaths: Record<string, string> = {};
        for (const j of spec.joints) {
          jointPaths[j.name] = await doc.createEmptyNode(mechPath, j.name, { transform: IDENTITY() });
        }

        // 5 — the mechanism component itself.
        await run(authoring.planCreateMechanism(mechPath));

        // 6 — the joints, plus the per-joint follow-up composites.
        const jointKeys: Record<string, string> = {};
        for (const j of spec.joints) {
          const opts: any = {
            nodePath: jointPaths[j.name],
            jointType: j.jointType,
            // NULL, never '' — a world anchor is an ABSENT key (plan-404 §2.4).
            bodyAPath: j.bodyA === null ? null : bodyPaths[j.bodyA],
            bodyBPath: bodyPaths[j.bodyB],
          };
          if (!j.viaPick) {
            opts.anchorA = vec(j.anchorA);
            opts.anchorB = vec(j.anchorB);
          }
          if (j.axisA) opts.axisA = vec(j.axisA);
          await run(authoring.planAddJoint(opts));

          const node = viewer.registry?.getNode(jointPaths[j.name]);
          const key = Object.keys(rvOf(node)).find((k) => /^KinematicJoint(_\d+)?$/.test(k));
          if (!key) throw new Error(`no KinematicJoint component landed on ${jointPaths[j.name]}`);
          jointKeys[j.name] = key;

          if (j.viaPick) {
            // The composite a 3D anchor pick commits. `bodyPath: null` on the A
            // side writes the world anchor as an ABSENT key (unsetField).
            await run(authoring.planPickAnchor({
              jointPath: jointPaths[j.name], componentType: key,
              side: 'A', anchor: vec(j.anchorA),
              bodyPath: j.bodyA === null ? null : bodyPaths[j.bodyA],
            }));
            await run(authoring.planPickAnchor({
              jointPath: jointPaths[j.name], componentType: key,
              side: 'B', anchor: vec(j.anchorB), bodyPath: bodyPaths[j.bodyB],
            }));
          }
          if (j.secondaryAxisB) {
            await run(authoring.planSetAxis(
              jointPaths[j.name], key, vec(j.axisA ?? [0, 0, 1]), vec(j.secondaryAxisB)));
          }
          if (j.limits) {
            await run(authoring.planSetLimits(jointPaths[j.name], key,
              { useLimits: true, lower: j.limits.lower, upper: j.limits.upper }));
          }
          if (j.driveOn) {
            await run(authoring.planAssignDrive(jointPaths[j.name], key, bodyPaths[j.driveOn]));
          }

          // Re-resolve this joint's reference fields.
          //
          // Every composite that writes a reference through `setField`
          // (`planAssignDrive`, and `planPickAnchor` when it (re)assigns a
          // body) lands in `reapplySchemaForComponent`, which runs
          // `applySchema` + `reapplyConfig` but NOT `resolveComponentRefs`.
          // The live component is therefore left holding the RAW
          // `ComponentReference` object, and the mechanism's next `build()`
          // dereferences it as if it were a Drive — see the "known defect"
          // note in this file's header. `resolveComponentRefs` is idempotent
          // and skips already-resolved fields, so calling it here restores
          // exactly the state the app is missing and changes no authored data.
          const jointInst = viewer.registry.getByPath(key, jointPaths[j.name]);
          if (jointInst) components.resolveComponentRefs(jointInst, viewer.registry);
        }

        await doc.whenIdle();

        // 7 — the structural rebuild the panel issues after an authoring edit.
        const bridge = kinRegistry.getMechanismUiBridge();
        bridge.rebuild(mechPath);

        return {
          mechPath, bodyPaths, jointPaths, jointKeys, driveKeys,
          dirty: doc.dirty,
          opCount: doc.toDraft().ops.length,
        };
      },

      /** The mechanism's current view, found by NAME so it survives a reload. */
      view(name: string) {
        const bridge = kinRegistry.getMechanismUiBridge();
        if (!bridge) return null;
        return bridge.list().find((m: any) => m.name === name) ?? null;
      },

      /** The solver's own verdict for one jog. */
      jog(jointPath: string, value: number) {
        const bridge = kinRegistry.getMechanismUiBridge();
        return bridge.jog(jointPath, value);
      },

      /** World position of a node, for the "it actually moved" assertion. */
      probe(nodePath: string) {
        const node = w.viewer.registry?.getNode(nodePath);
        return node ? worldPos(node) : null;
      },

      /**
       * The real persistence half: export the live asset root to a binary GLB
       * through the SAME `exportAssetGlb` the Save flow uses, then load those
       * exact bytes back through `viewer.loadModel`. Nothing is stubbed and no
       * state is carried over — `loadModel` clears the model first, which frees
       * every solver handle, so the reloaded mechanism is rebuilt from the file.
       */
      async persistAndReload() {
        const viewer = w.viewer;
        const root = viewer.currentModelRoot;
        if (!root) throw new Error('no current model root to export');
        // What the save flow emits so live-preview holders (drive jog) can
        // restore ephemeral state before the export clone is taken.
        viewer.emit('asset-editor-pre-export', { source: 'e2e-t10' });

        const assetName: string = root.name;
        const buf: ArrayBuffer = await glbExport.exportAssetGlb(root, assetName);

        // Read the JSON chunk back so the test can assert on the FILE, not just
        // on what the viewer chose to reconstruct from it.
        const dv = new DataView(buf);
        const jsonLen = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
        const extrasByNodeName: Record<string, any> = {};
        for (const n of json.nodes ?? []) {
          if (n.name && n.extras?.realvirtual) extrasByNodeName[n.name] = n.extras.realvirtual;
        }

        const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
        w.__rvT10._doc?.dispose?.();
        w.__rvT10._doc = null;
        await viewer.loadModel(url);
        URL.revokeObjectURL(url);

        return {
          bytes: buf.byteLength,
          assetName,
          nodeCount: (json.nodes ?? []).length,
          extrasByNodeName,
          reloadedRoot: viewer.currentModelRoot?.name ?? null,
        };
      },
    };
  }, MODULE_PATHS);
}

/** Euclidean distance between two probe samples, in scene units. */
function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ─── Suite ──────────────────────────────────────────────────────────────────
//
// Serial with ONE shared page: the app boot (Vite transform of the whole entry
// graph plus the wasm artifact) costs far more than a model swap, and each row
// starts by loading the base model fresh, so the rows are still independent in
// everything that matters.

test.describe.configure({ mode: 'serial' });

test.describe('plan-404 T10 — mechanism authoring matrix (Quick Edit)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    // The config's 60 s default also applies to hooks, and this hook boots the
    // whole app once for the entire matrix (Vite transform graph + wasm).
    test.setTimeout(600_000);
    page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 120_000 });

    // Precondition 1 — a viewer that can execute asset ops at all.
    await page.waitForFunction(() => {
      const v = (window as unknown as { viewer?: any }).viewer;
      return !!v?.registry && !!v?.transportManager && !!v?.currentModelRoot;
    }, undefined, { timeout: 240_000 });

    await installHarness(page);
    await page.evaluate((url) => (window as any).__rvT10.loadBase(url), BASE_MODEL);

    // Precondition 2 — the private wasm solver really loaded and produced a
    // handle for the base model's own imported mechanism.
    await page.waitForFunction(
      () => (window as any).__rvT10.solverReady(),
      undefined,
      { timeout: 180_000 },
    );
  });

  test.afterAll(async () => {
    await page?.close();
  });

  for (const spec of MATRIX) {
    test(`${spec.id}: ${spec.title}`, async () => {
      test.setTimeout(240_000);

      // Fresh base scene for this row.
      await page.evaluate((url) => (window as any).__rvT10.loadBase(url), BASE_MODEL);
      await page.waitForFunction(() => (window as any).__rvT10.solverReady(),
        undefined, { timeout: 120_000 });

      // ── AUTHOR ──────────────────────────────────────────────────────────
      const authored = await page.evaluate(
        (s) => (window as any).__rvT10.author(s), spec as unknown as Record<string, unknown>);
      expect(authored.mechPath).toContain(spec.id);
      // The composites really went through the document as undoable ops.
      expect(authored.dirty).toBe(true);
      expect(authored.opCount).toBeGreaterThan(spec.joints.length);
      for (const j of spec.joints) {
        expect(authored.jointKeys[j.name]).toMatch(/^KinematicJoint(_\d+)?$/);
      }

      const built = await page.evaluate((id) => (window as any).__rvT10.view(id), spec.id);
      expect(built, `mechanism "${spec.id}" not registered after authoring`).not.toBeNull();
      expect(built.disabledReason).toBe('');
      expect(built.active, 'no wasm solver handle was created for the authored mechanism').toBe(true);
      expect(built.jointCount).toBe(spec.joints.length);
      expect(built.linkCount).toBe(spec.linkCount);
      if (spec.minLoopCount !== undefined) {
        expect(built.loopCount).toBeGreaterThanOrEqual(spec.minLoopCount);
      }
      // No BLOCKING finding — errors disable the mechanism, warnings are allowed
      // (an underdetermined rig legitimately reports NegativeDof / IdleSpinRod).
      expect(built.findings.filter((f: any) => f.severity === 'Error')).toEqual([]);
      for (const name of spec.worldAnchored ?? []) {
        const jv = built.joints.find((j: any) => j.name === name);
        expect(jv, `joint ${name} missing from the view`).toBeTruthy();
        expect(jv.worldAnchored, `${name} must be an authored world anchor`).toBe(true);
        expect(jv.bodyAPath).toBeNull();
      }

      // ── JOG (before) ────────────────────────────────────────────────────
      const jogPath = authored.jointPaths[spec.jogJoint];
      const probePath = authored.bodyPaths[spec.probe];
      const before = await page.evaluate((p) => (window as any).__rvT10.probe(p), probePath);

      const jog1 = await page.evaluate(
        ([p, v]) => (window as any).__rvT10.jog(p as string, v as number),
        [jogPath, spec.jogBefore] as [string, number]);
      expect(jog1, `jog returned null — joint "${spec.jogJoint}" is not joggable`).not.toBeNull();
      expect(jog1.converged, `solver did not converge (residual ${jog1?.residualError})`).toBe(true);
      expect(jog1.residualError).toBeLessThanOrEqual(0.001);

      const after1 = await page.evaluate((p) => (window as any).__rvT10.probe(p), probePath);
      expect(dist(before, after1),
        'the probe body did not move — the mechanism reported convergence without solving')
        .toBeGreaterThan(1e-4);

      // ── PERSIST → RELOAD ────────────────────────────────────────────────
      const saved = await page.evaluate(() => (window as any).__rvT10.persistAndReload());
      expect(saved.bytes).toBeGreaterThan(0);
      // The authored nodes are in the FILE, with their component extras.
      for (const j of spec.joints) {
        const ext = saved.extrasByNodeName[j.name];
        expect(ext, `joint node "${j.name}" missing from the saved GLB`).toBeTruthy();
        const jointExt = ext.KinematicJoint ?? ext[Object.keys(ext)
          .find((k) => /^KinematicJoint(_\d+)?$/.test(k)) ?? ''];
        expect(jointExt, `no KinematicJoint extras on "${j.name}"`).toBeTruthy();
        expect(jointExt.JointType).toBe(j.jointType);
      }
      // World anchor = the key is ABSENT. Not '', not a dangling reference.
      for (const name of spec.bodyAAbsent ?? []) {
        const ext = saved.extrasByNodeName[name];
        const key = Object.keys(ext).find((k) => /^KinematicJoint(_\d+)?$/.test(k))!;
        expect(Object.prototype.hasOwnProperty.call(ext[key], 'BodyA'),
          `${name} must have NO BodyA key in the saved GLB (world anchor)`).toBe(false);
      }
      expect(saved.extrasByNodeName[spec.id]?.KinematicMechanism,
        'the mechanism component is missing from the saved GLB').toBeTruthy();
      // The authored Drives are in the file too — that is what lets the ordinary
      // loader rebuild them on the way back in, with no harness involved.
      for (const b of spec.bodies) {
        if (!b.drive) continue;
        expect(saved.extrasByNodeName[b.name]?.Drive?.Direction,
          `Drive on "${b.name}" is missing from the saved GLB`).toBe(b.drive.direction);
      }

      // ── JOG (after reload) ──────────────────────────────────────────────
      await page.waitForFunction((id) => {
        const v = (window as any).__rvT10.view(id);
        return !!v && v.active === true;
      }, spec.id, { timeout: 120_000 });

      const reloaded = await page.evaluate((id) => (window as any).__rvT10.view(id), spec.id);
      expect(reloaded.disabledReason).toBe('');
      expect(reloaded.jointCount).toBe(spec.joints.length);
      expect(reloaded.linkCount, 'a body reference did not survive the GLB round trip')
        .toBe(spec.linkCount);
      expect(reloaded.findings.filter((f: any) => f.severity === 'Error')).toEqual([]);
      for (const name of spec.worldAnchored ?? []) {
        const jv = reloaded.joints.find((j: any) => j.name === name);
        expect(jv.worldAnchored, `${name} lost its world-anchor semantics on reload`).toBe(true);
      }
      // Every joint kept its Body B; the driven one kept its Drive.
      for (const j of spec.joints) {
        const jv = reloaded.joints.find((x: any) => x.name === j.name);
        expect(jv, `joint ${j.name} missing after reload`).toBeTruthy();
        expect(jv.jointType).toBe(j.jointType);
        expect(jv.bodyBName, `${j.name} lost its Body B on reload`).not.toBeNull();
        if (j.driveOn) expect(jv.driveName, `${j.name} lost its Drive on reload`).not.toBeNull();
      }
      const reloadedJoint = reloaded.joints.find((j: any) => j.name === spec.jogJoint);
      expect(reloadedJoint.joggable).toBe(true);
      if (spec.joints.find((j) => j.name === spec.jogJoint)?.limits) {
        expect(reloadedJoint.useLimits, 'joint limits did not survive the round trip').toBe(true);
      }

      const beforeR = await page.evaluate((p) => (window as any).__rvT10.probe(p), probePath);
      const jog2 = await page.evaluate(
        ([p, v]) => (window as any).__rvT10.jog(p as string, v as number),
        [reloadedJoint.nodePath, spec.jogAfter] as [string, number]);
      expect(jog2, 'jog after reload returned null').not.toBeNull();
      expect(jog2.converged,
        `solver did not converge after reload (residual ${jog2?.residualError})`).toBe(true);
      expect(jog2.residualError).toBeLessThanOrEqual(0.001);

      const afterR = await page.evaluate((p) => (window as any).__rvT10.probe(p), probePath);
      expect(dist(beforeR, afterR), 'the reloaded mechanism did not move on jog')
        .toBeGreaterThan(1e-4);
    });
  }
});
