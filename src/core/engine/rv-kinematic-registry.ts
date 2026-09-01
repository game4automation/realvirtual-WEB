// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-kinematic-registry.ts — Public interface + registry for the rigid-body
 * mechanism solver ("Mechanism", plan-404).
 *
 * NOTE ON NAMING (plan-404 R6): this is the RIGID-BODY mechanism system
 * (`KinematicMechanism` / `KinematicJoint` / `KinematicTarget` in Unity) — a
 * constraint solve over a joint graph with loop closure and free bodies. It is
 * NOT the older `Kinematic` axis-group system that the "Kinematics" quick-edit
 * panel drives. Everything belonging to this feature is spelled *Mechanism*
 * (files under `mechanism/`, ops `web_editor_mechanism_*`, UI section
 * "Mechanism (Rigid-Body)").
 *
 * LICENSE CUT (plan-404 §2.6): this file carries only the narrow structural
 * interfaces and a settable registry slot — pure plumbing, no solver, no
 * topology, no state-blob math. The implementation (WASM provider, topology
 * port, state-blob export, manager, findings) lives in
 * `realvirtual-WebViewer-Private~/src/kinematic-*`, registers itself here from
 * `private-plugins.ts` (CUSTOMER tier), and is physically absent from a public
 * build. With no manager registered, `getKinematicManager()` returns null,
 * `ComponentContext.kinematicManager` stays undefined, and no mechanism
 * component factory is registered at all — GLB mechanism extras are simply
 * ignored, exactly like any other unknown component.
 *
 * Why a module singleton instead of threading the manager through every
 * `loadGLB`/`processExtras` option bag like `energyChainManager` does: the
 * manager type is private, so public code can never construct it and the viewer
 * has nothing to thread. Reading the slot inside each `ComponentContext`
 * construction site also makes it structurally impossible to miss one of the
 * paths (plan-404 §2.3 lifecycle matrix, SOL finding 3) — a threaded optional
 * is exactly what gets forgotten on the runtime-create / asset-placement paths.
 */

import type { Object3D } from 'three';

/** What the manager needs to know about a registered mechanism component. */
export interface KinematicMechanismHandle {
  /** The mechanism's own node — identity + logging context. */
  readonly node: Object3D;
}

/**
 * The narrow slice of the private mechanism manager that public code (the
 * `ComponentContext` slot, the quick-edit panel shell) is allowed to see.
 * Deliberately structural: no solver types, no blob types, no findings types
 * cross into the open repo.
 */
export interface KinematicManagerLike {
  /** Register a mechanism for the per-tick Prepare→Solve→WriteBack pass. */
  register(mechanism: KinematicMechanismHandle): void;
  /** Unregister and release the mechanism's solver handle + wasm buffers. */
  unregister(mechanism: KinematicMechanismHandle): void;
  /**
   * A registered mechanism finished (re)building its topology and is ready for
   * a solver handle. Separate from `register()` because the two happen at
   * different moments on the scene-load path — a component registers in
   * `init()` but can only build in `onSceneReady()`, after the kinematic
   * re-parenting pass. Optional so a future manager may ignore it.
   */
  notifyBuilt?(mechanism: KinematicMechanismHandle): void;
  /** Number of currently registered mechanisms (diagnostics / tests). */
  readonly size: number;
}

let _manager: KinematicManagerLike | null = null;

/**
 * Install the private mechanism manager. Called once per viewer instance from
 * the private feature registration; pass `null` on viewer dispose to return to
 * the public "no mechanism support" state.
 */
export function setKinematicManager(manager: KinematicManagerLike | null): void {
  _manager = manager;
}

/** The installed manager, or null in a public/unlicensed build. */
export function getKinematicManager(): KinematicManagerLike | null {
  return _manager;
}

/**
 * True when rigid-body mechanisms are supported in this build. The quick-edit
 * "Mechanism (Rigid-Body)" section uses this to decide whether to render at all
 * (the panel shell is public, its logic is not).
 */
export function isMechanismSupported(): boolean {
  return _manager !== null;
}

// ─── Panel bridge ───────────────────────────────────────────────────────────
//
// The quick-edit "Mechanism" section is a public UI SHELL: it lays out rows and
// buttons and issues the generic authoring composites, but every fact it shows
// (findings, convergence, joint state) and the jog itself come from the private
// side through this bridge. Only PLAIN DATA crosses — strings, numbers, enums —
// so no solver, topology or findings type leaks into the open repo.

/** One finding row as the panel renders it. */
export interface MechanismFindingView {
  code: string;
  severity: 'Error' | 'Warning';
  message: string;
  /** Node path of the joint this finding concerns, or null. */
  jointPath: string | null;
  /** True when a one-click fix exists (anchor snap, secondary axis, drive axis). */
  fixable: boolean;
}

/** One joint row as the panel renders it. */
export interface MechanismJointView {
  nodePath: string;
  name: string;
  jointType: string;
  bodyAName: string | null;
  bodyBName: string | null;
  /**
   * Registry paths of the resolved bodies, or null. The 3D authoring
   * interaction needs these and not just the names: committing a clicked world
   * point as an anchor means expressing it in the BODY's local frame, which
   * takes the body's node. A null `bodyAPath` with `worldAnchored` true is the
   * authored world anchor; a null one WITHOUT it is an unresolved reference.
   */
  bodyAPath: string | null;
  bodyBPath: string | null;
  /** True when Body A is deliberately the world/static frame. */
  worldAnchored: boolean;
  driveName: string | null;
  currentValue: number;
  /** True when this joint can be jogged (driven Revolute/Prismatic). */
  joggable: boolean;
  lowerLimit: number;
  upperLimit: number;
  useLimits: boolean;
  /**
   * Joint origin in WORLD space — where the axis gizmo and the beacons sit.
   *
   * Sent as world space, already converted, rather than as the raw Unity field:
   * the read-side frame conversion (`jointAxisToGltf` and the schema's
   * `unityCoords` mirror) is the private side's single site and stays there.
   * The panel only ever performs the WRITE conversion, so the two directions
   * cannot drift into two different conventions.
   */
  originWorld: [number, number, number];
  /** Joint axis in WORLD space, unit length — the gizmo's current direction. */
  axisWorld: [number, number, number];
}

/**
 * One LINK as the Body row renders it (plan-412).
 *
 * Carries the COMPUTED mass properties alongside the authored settings, because the computed
 * values are deliberately not stored in the document — the panel is where the user sees what the
 * geometry actually adds up to, and a row that showed only the authored density would leave "how
 * heavy is this part?" unanswerable without opening the solver.
 */
export interface MechanismLinkView {
  nodePath: string;
  name: string;
  /** False when the link has no `MechanismBody` component at all. */
  hasBody: boolean;
  /**
   * False when the SOLVER counts this link as massless — no body, mass 0, or a
   * degraded estimate (`massWarning` non-empty). This is the predicate the
   * force analysis actually runs on; `hasBody` is mere component presence. UI
   * that decides "is the analysis off?" must read THIS field, never `hasBody`.
   */
  hasMass: boolean;
  densityPreset: string;
  densityKgM3: number;
  /** Effective mass in kg (computed, or the override). 0 when unknown. */
  massKg: number;
  /** Effective centre of mass in the link's local frame, millimetres. */
  comLocalMm: [number, number, number];
  /** True when the user pinned the mass rather than taking the computed one. */
  massOverridden: boolean;
  /** True when the user pinned the centre of mass. */
  comOverridden: boolean;
  /** `mesh` | `convex-hull` | `bounds` | `override` | `none` — how the value was obtained. */
  massSource: string;
  /** Non-empty when the value is a degraded estimate; shown next to it, never hidden. */
  massWarning: string;
}

/** One mechanism as the panel renders it. */
export interface MechanismView {
  nodePath: string;
  name: string;
  active: boolean;
  converged: boolean;
  residualError: number;
  solveTimeMs: number;
  disabledReason: string;
  jointCount: number;
  linkCount: number;
  loopCount: number;
  dof: number;
  joints: MechanismJointView[];
  /** Links in blob index order, with their mass properties (plan-412). */
  links: MechanismLinkView[];
  findings: MechanismFindingView[];
}

// ─── Force analysis (plan-412 phase 4) ──────────────────────────────────────
//
// The SERIES do not travel through this bridge — that was Alternative 5 and it
// was rejected: the panel polls `list()` twice a second, which would turn a
// 10 Hz recording into a lossy one. What crosses here is (a) the CURRENT tick's
// values, which the recorder samples on its own clock, and (b) the two
// non-continuous actions (statics, reset). The ring buffers themselves live in
// `MechanismForceRecorderPlugin` on the public side (§2.6).

/**
 * One scalar force series, addressed by a stable id.
 *
 * Drive channels keep their SIGN — reversing direction is exactly what an RMS
 * figure has to survive, and a rectified series would quietly halve the peak of
 * an oscillating axis. Joint channels are MAGNITUDES: a bearing load is sized by
 * how hard it is pulled, not by which way, and three signed components per joint
 * would put eight series in a picker that has to stay readable. The world
 * vectors are still available on {@link MechanismJointForceView} for the arrows.
 */
export interface MechanismForceChannelView {
  /** Unique across mechanisms — `<mechanismPath>|dof<i>` or `<mechanismPath>|joint<i>|F`. */
  id: string;
  /** Short label for the legend and the series picker. */
  label: string;
  /** `drive` = actuator sizing figure, `joint-force`/`joint-torque` = bearing load. */
  kind: 'drive' | 'joint-force' | 'joint-torque';
  /** `N` for a force or a prismatic drive, `N·m` for a moment or a revolute drive. */
  unit: 'N' | 'N·m';
  /** This tick's value. Meaningless unless the snapshot's `dynamicsValid` is true. */
  value: number;
  /**
   * Node path of the link this channel physically belongs to — the link a
   * drive dof moves, or the (child-side) link a bearing sits on. The panel's
   * chart↔3D hover link keys on this; null when the topology has no link for
   * the channel.
   */
  linkPath: string | null;
}

/** One joint's reaction wrench in world space — the input of the 3D arrows. */
export interface MechanismJointForceView {
  jointPath: string;
  name: string;
  /** Reaction force, world axes, newtons. */
  forceWorld: [number, number, number];
  /** Reaction moment, world axes, newton-metres. */
  torqueWorld: [number, number, number];
  /** Where the arrow is anchored — same projection the axis gizmo uses. */
  originWorld: [number, number, number];
  /** Joint axis in world space, unit length — the moment double-arrow's axis. */
  axisWorld: [number, number, number];
}

/** Everything one evaluation of the inverse dynamics produced. */
export interface MechanismForcesSnapshot {
  mechanismPath: string;
  /**
   * The crate's `DynamicsStatus`. Only `0` means the numbers are real; every
   * other value is a reason to show nothing rather than something plausible
   * (`1` off, `2` a link without mass, `3` waiting for samples, `4` rank
   * deficient, `5` non-finite).
   */
  status: number;
  /** The same thing in words, for the panel. */
  statusText: string;
  /** Convenience mirror of `status === 0`. */
  dynamicsValid: boolean;
  /** True when the split between actuators is a pseudo-inverse choice, not a fact. */
  redundant: boolean;
  channels: MechanismForceChannelView[];
  joints: MechanismJointForceView[];
}

/** The private side's panel API. Transient calls make no document ops. */
export interface MechanismUiBridge {
  /** Every registered mechanism, newest state. */
  list(): MechanismView[];
  /** Re-run validation for one mechanism — TRANSIENT, no undo entry. */
  validate(mechanismPath: string): MechanismFindingView[];
  /**
   * Jog one joint's drive to an absolute value — TRANSIENT, no undo entry.
   *
   * `componentType` disambiguates when several KinematicJoint components sit
   * on the same node: its `_N` suffix is the per-node joint ordinal (bare
   * `KinematicJoint` = 0). Omit it for the one-joint-per-node authoring shape.
   */
  jog(jointPath: string, value: number, componentType?: string): { converged: boolean; residualError: number } | null;
  /**
   * Re-solve one mechanism against the drives' CURRENT positions — TRANSIENT,
   * no undo entry, no drive write.
   *
   * This is `jog()` without the drive half. A caller that already moved the axis
   * node itself — the editor's drive-gizmo drag preview, which mutates the node
   * against a pinned home pose — must not go through `jog()`: that would also run
   * `applyToNode()` and re-derive the node transform from the drive's own base,
   * fighting the pinned pose. Such a caller writes the position, then asks the
   * dependent links to follow through here.
   *
   * Returns null when the mechanism is unknown or cannot solve.
   */
  solve(mechanismPath: string): { converged: boolean; residualError: number } | null;
  /** Rebuild a mechanism's topology after a structural authoring edit. */
  rebuild(mechanismPath: string): void;
  /** Apply a fixable finding's auto-fix; returns the field edits to persist. */
  suggestFix(jointPath: string, code: string): Record<string, unknown> | null;

  // ── Force analysis (plan-412 §2.6) ────────────────────────────────────────

  /**
   * Arm or disarm the inverse dynamics for one mechanism.
   *
   * Not in the plan's two-method sketch but unavoidable: the crate ships the
   * force analysis OFF, so without a way to switch it on the snapshot would
   * forever report `Disabled`. Keeping it explicit is also the cheap half of the
   * NFR — a mechanism nobody is analysing must not pay for the RNEA every tick.
   * Arming resets the pose history, so the first valid sample is always the
   * first sample of THIS recording.
   */
  setForceAnalysis(mechanismPath: string, enabled: boolean): void;

  /** The CURRENT tick's forces. Cheap: it reads the last solve, it does not run one. */
  forcesSnapshot(mechanismPath: string): MechanismForcesSnapshot | null;

  /**
   * Holding forces in the current pose with q̇ = q̈ = 0 (plan-412 F8). Runs a
   * solve on the spot and needs no history, which is what makes "what does it
   * take to hold this?" answerable without starting the machine.
   *
   * TRANSIENT: no document op, no undo entry, no pose change.
   */
  solveStatics(mechanismPath: string): MechanismForcesSnapshot | null;

  /**
   * Drop the pose history (plan-412 §2.4.3). Rebuild and model switch reset
   * themselves — the handle is destroyed and re-created — so this exists for the
   * two triggers that leave the handle alive: play start and play stop.
   */
  resetForces(mechanismPath: string): void;

  /**
   * The live scene node behind each link — for the forces panel's chart↔3D
   * hover link (raycast targets + emphasis roots). Direct references, no
   * scene traversal: the bridge already holds the links.
   */
  linkNodes(mechanismPath: string): { path: string; node: Object3D }[];
}

let _uiBridge: MechanismUiBridge | null = null;

/** Install the private panel bridge (called from the private feature register). */
export function setMechanismUiBridge(bridge: MechanismUiBridge | null): void {
  _uiBridge = bridge;
}

/** The installed panel bridge, or null in a public build. */
export function getMechanismUiBridge(): MechanismUiBridge | null {
  return _uiBridge;
}
