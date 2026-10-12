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
  /**
   * Topology generation, bumped by every `build()` (plan-467 F7, SOL R1 #9).
   *
   * A rebuild after an authoring edit REORDERS the link table, so a cached
   * `linkIndex` from before the rebuild points at a DIFFERENT link — the
   * external load would silently land on the wrong body. Consumers store the
   * version alongside the index and drop entries whose version has moved on.
   *
   * Optional: a future manager may have no topology at all.
   */
  readonly topologyVersion?: number;
  /**
   * Every node this mechanism's links OWN, with the link index that owns it.
   *
   * "Owns" is wider than "is a descendant of": a link may stand for a whole
   * kinematic GROUP whose members live elsewhere in the scene and are moved by
   * the write-back as followers (SOL R1 #8). A consumer that only walked link
   * subtrees would miss exactly those, and a gripper jaw registered as a group
   * member would be invisible to physics.
   *
   * Enumeration order is link order, then subtree pre-order, then followers.
   * Optional so a manager without link topology stays valid.
   */
  forEachOwnedNode?(cb: (node: Object3D, linkIndex: number) => void): void;
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

  /**
   * External contact load on ONE link, for the inverse dynamics (plan-467 F7).
   *
   * PLAIN DATA ONLY, on purpose: this is the physics → mechanism direction
   * across the AGPL boundary (the mirror of `MechanismForcesSnapshot` going the
   * other way), so no Rapier and no solver type may appear in the signature.
   *
   * `fx…fz` is the force in N; `mx…mz` is the moment in N·m about the **world
   * origin** — the same reference point the RNEA's `inward_pass` already
   * accumulates about (SOL R1 #3). Passing a moment about the link would be
   * position-dependent and silently wrong for a translated mechanism.
   *
   * The caller sets the CURRENT total per link every tick (it does not
   * accumulate); a link with no contact is set to zero. Optional — a manager
   * without inverse dynamics simply does not implement it.
   */
  setExternalLinkLoad?(
    mechanism: KinematicMechanismHandle,
    linkIndex: number,
    fx: number, fy: number, fz: number,
    mx: number, my: number, mz: number,
  ): void;

  /**
   * Subscribe to topology changes — fired after `notifyBuilt()` and on
   * `unregister()` (plan-467 F7). Returns an unsubscribe function.
   *
   * The physics side uses it to drop its node→link mapping the moment the link
   * table can have been reordered, instead of discovering the staleness later
   * as a load on the wrong link. Optional.
   */
  onTopologyChanged?(cb: (mechanism: KinematicMechanismHandle) => void): () => void;
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
  /**
   * The concrete joint component key on the node (`KinematicJoint`,
   * `KinematicJoint_1`, … — the per-node ordinal, plan-504). Two joints on one
   * node are two rows, and every authoring command addresses its row by this
   * key. Optional only for hand-built views (tests); absent means the first
   * joint on the node, `KinematicJoint`.
   */
  componentType?: string;
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
  /** plan-501 F1 — true while an inertia override is authored (valid or not). */
  inertiaOverridden?: boolean;
  /** plan-501 F1 — the effective tensor `[Ixx,Iyy,Izz,Ixy,Ixz,Iyz]` about the COM, kg·mm². */
  inertiaLocalKgMm2?: number[];
  /** plan-501 F1 — non-empty when the authored override is unusable (hard finding, no fallback). */
  inertiaFinding?: string;
}

/**
 * One link's centre of mass, in the WORLD frame — the input of one small marker (plan-472).
 *
 * World and not local: `MechanismLinkView.comLocalMm` is the authored truth, but a millimetre
 * triple in the local frame of a link that is itself rotated and nested is not something anyone
 * can check by looking. The projection into world space happens once, on the private side, where
 * the link's matrix lives.
 */
export interface MechanismCogContributionView {
  /** Registry path of the link — the marker's key and the panel's cross-reference. */
  nodePath: string;
  /** Centre of mass in the world frame, millimetres. */
  comWorldMm: [number, number, number];
  massKg: number;
  /** `mesh` | `estimated` | `override` | `unknown` — drives the marker's style, never hidden. */
  comSource: string;
  /** True when the link belongs to more than one mechanism; the marker is drawn dashed. */
  ambiguous: boolean;
}

/**
 * The centre of gravity of a whole mechanism in its CURRENT pose (plan-472).
 *
 * Derived, never stored: it depends on where the machine stands, so a value written into the
 * document would be a value for a pose nobody is looking at. Computed per request on the private
 * side from cached local mass properties and fresh world matrices.
 *
 * Everything except the number itself is here so the number can be JUDGED. A centre of gravity
 * that quietly omits three links is not a slightly worse answer — it is a correct answer for a
 * different machine. Hence `contributingLinks`/`totalLinks`/`skippedLinks`, `estimated` for a
 * value resting on bounding boxes, and `ambiguousOwnership` for one whose inputs may have been
 * computed for a neighbouring mechanism.
 */
export interface MechanismCogView {
  totalMassKg: number;
  /** World-frame centre of gravity in millimetres, or `null` when NOTHING contributed. */
  cogWorldMm: [number, number, number] | null;
  contributingLinks: number;
  totalLinks: number;
  /** Every link left out, with a reason a user can act on ("no body", "no mass", …). */
  skippedLinks: { nodePath: string; reason: string }[];
  /** True as soon as one contribution came from a bounding box or a hull, not the mesh. */
  estimated: boolean;
  /** True when a contributing link is a link of more than one mechanism. */
  ambiguousOwnership: boolean;
  /** Link warnings, verbatim and prefixed with the link, plus the ownership note. */
  warnings: string[];
  /** Per contributing link — what the small link-COM markers are drawn from. */
  contributions: MechanismCogContributionView[];
  /** Millimetres per scene unit, so a consumer can place a marker without assuming 1000. */
  unityToMm: number;
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
  /**
   * The mechanism's centre of gravity in its current pose (plan-472), or `null` when the private
   * side cannot produce one (an unbuilt mechanism). Recomputed on every `list()`, which is what
   * makes "this is a request" true for the panel poll and for MCP alike.
   */
  cog: MechanismCogView | null;
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
  /**
   * Magnitude of the external contact load carried by each link, in newtons,
   * in blob link order — the same order as {@link MechanismView.links}, so the
   * panel indexes both with one loop (plan-467 F11).
   *
   * This is the payload the physics side measured on the machine in the tick
   * that fed the LAST inverse-dynamics evaluation: `|F|` of the world wrench
   * the registry summed per link (`setExternalLinkLoad`), not a stored
   * authoring value. All zeros whenever physics is off, which is every public
   * deployment — the panel then shows nothing rather than a column of "0.0 N".
   *
   * Only the force magnitude crosses: the moment travels with it into the
   * solver, where it already shows up in the drive and bearing channels, and a
   * second moment column in the table would report the same physics twice.
   */
  externalLoadN: number[];
}

// ─── Mechanism paths (plan-729) ─────────────────────────────────────────────

/** One waypoint of a {@link MechanismPathView}, in path order. */
export interface MechanismWaypointView {
  /** Node path as authored in the path's `Path` list. */
  nodePath: string;
  name: string;
  /** False when the reference does not resolve to a MechanismTarget (yet). */
  resolved: boolean;
  interpolation: 'Linear' | 'PointToPoint' | null;
  /** mm/s (Linear) or speed factor (PointToPoint); null = path default. */
  speedToTarget: number | null;
  waitForSeconds: number;
  /** The waypoint's world position in millimetres, null when unresolved. */
  worldPositionMm: [number, number, number] | null;
}

/** One MechanismPath as the panel and MCP render it. */
export interface MechanismPathView {
  nodePath: string;
  name: string;
  /** Node path of the driven KinematicMechanism, null when unresolved. */
  mechanismPath: string | null;
  /** Node path of the link whose origin follows the path, null when unresolved. */
  targetLinkPath: string | null;
  loopPath: boolean;
  speedOverride: number;
  /** mm/s */
  linearSpeedToTarget: number;
  /** mm/s² */
  linearAcceleration: number;
  waypoints: MechanismWaypointView[];
  /** plan-511 — the path is always drawn in the viewer (not only while selected). */
  showPath: boolean;
  // Runtime status
  active: boolean;
  finished: boolean;
  /** True after a hard stop (unreachable waypoint, branch flip, solver lost). */
  failed: boolean;
  reachable: boolean;
  /** Index of the next waypoint to reach. */
  numTarget: number;
  /** Reason of the last hard stop, '' when none. */
  lastError: string;
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

  /**
   * Every registered MechanismPath with its waypoints and runtime status
   * (plan-729). Optional so an older / fake bridge stays a valid implementation;
   * consumers treat a missing method as "no paths".
   */
  listPaths?(): MechanismPathView[];

  // ── Drive sizing (plan-501). All optional, like listPaths: an older / fake bridge stays valid.

  /** Every MechanismTrajectory with its configuration, findings and last / running sizing run. */
  listTrajectories?(): MechanismTrajectoryView[];
  /** Parse a sampled-path CSV (time, X, Y, Z) — pure, no document change. */
  parseTrajectoryCsv?(text: string): MechanismTrajectoryCsvView;
  /**
   * Start the sizing run of one trajectory; resolves when it ended. One run per mechanism at a
   * time — a second start answers with `run-in-progress`. TRANSIENT: no document op.
   */
  runTrajectory?(trajectoryPath: string): Promise<MechanismTrajectoryView | { error: string }>;
  /** Cancel a running sizing run. Returns false when none was running. */
  cancelTrajectoryRun?(trajectoryPath: string): boolean;
  /** Downsampled series of the last run (null when there is none). */
  trajectorySeries?(trajectoryPath: string, maxPoints: number): MechanismTrajectorySeriesView | null;
  /** SERVOsoft axis texts of the last run, or the export gate's findings. */
  exportTrajectory?(trajectoryPath: string):
    { ok: true; files: MechanismTrajectoryExportFile[] } | { ok: false; findings: MechanismTrajectoryFindingView[] };
}

// ─── Drive-sizing trajectories (plan-501) ───────────────────────────────────

/** A reason a trajectory cannot be run, played or exported. */
export interface MechanismTrajectoryFindingView {
  code: string;
  message: string;
}

/** Key figures of one driven axis of a sizing run. */
export interface MechanismTrajectoryAxisView {
  jointPath: string;
  jointName: string;
  kind: 'revolute' | 'prismatic';
  /** 'N·m' (revolute) or 'N' (prismatic). */
  torqueUnit: string;
  peakTau: number;
  peakTauTimeS: number;
  rmsTau: number;
  /** rad/s | m/s */
  peakQd: number;
  /** rad/s² | m/s² */
  peakQdd: number;
}

/** State of the current or last sizing run of one trajectory. */
export interface MechanismTrajectoryRunView {
  state: 'running' | 'done' | 'invalid' | 'aborted' | 'refused';
  /** 0..1 while running. */
  progress: number;
  sampleCount: number;
  completedSampleCount: number;
  failureSampleIndex: number | null;
  failureReason: string | null;
  runtimeMs: number;
  maxBlockMs: number;
  maxAnchorErrorMm: number;
  axes: MechanismTrajectoryAxisView[];
  /** True when the trajectory or the mechanism changed since the run — export is refused. */
  stale: boolean;
  /** The export gate's findings; empty = exportable. */
  exportFindings: MechanismTrajectoryFindingView[];
}

/** One MechanismTrajectory as the panel and MCP render it. */
export interface MechanismTrajectoryView {
  nodePath: string;
  name: string;
  mechanismPath: string | null;
  targetLinkPath: string | null;
  sampleCount: number;
  intervalMs: number;
  outputIntervalMs: number;
  durationS: number;
  frame: 'z-up' | 'y-up';
  tcpOffsetMm: [number, number, number];
  payloadMassKg: number;
  payloadOffsetMm: [number, number, number];
  findings: MechanismTrajectoryFindingView[];
  run: MechanismTrajectoryRunView | null;
  /** plan-511 — the trajectory is always drawn in the viewer (not only while selected). */
  showPath: boolean;
}

/** Downsampled series of a finished run (≤ maxPoints per series) for MCP / charts. */
export interface MechanismTrajectorySeriesView {
  timeS: number[];
  axes: { jointName: string; q: number[]; qd: number[]; qdd: number[]; tau: number[] }[];
  /** Every k-th sample was taken. */
  stride: number;
}

/** Result of parsing a trajectory CSV (no document change). */
export type MechanismTrajectoryCsvView =
  | { ok: true; samples: number[]; sampleCount: number; intervalMs: number; warnings: string[] }
  | { ok: false; error: string };

/** One exported SERVOsoft axis file. */
export interface MechanismTrajectoryExportFile {
  fileName: string;
  jointPath: string;
  text: string;
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
