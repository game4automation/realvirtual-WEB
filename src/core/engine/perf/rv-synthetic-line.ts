// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Synthetic transport line builder (plan-465, F1).
 *
 * DEV-ONLY. Builds a deterministic, parameterised material-flow line out of the
 * PUBLIC engine components — `RVTransportSurface`, `RVDrive`, `RVSensor`,
 * `RVSource`, `RVSink` — without a GLB and without Unity, so a scaling matrix
 * can sweep MU count, sensor density and signal load without a CAD round-trip.
 *
 * Two things make this more than a loop that news up objects:
 *
 * 1. **The plan is computed before anything is built** ({@link SyntheticLinePlan}).
 *    A configuration whose target MU count the geometry cannot hold — or which the
 *    source could never spawn, because `RVSource.update()` emits at most one MU per
 *    60 Hz step (rv-source.ts) — is rejected as INVALID instead of quietly producing
 *    a run that never reaches steady state and a "measurement" of a half-empty line
 *    (SOL #3 / R2#4).
 *
 * 2. **The line carries named PLC signals.** `LINE/PLC<p>/Conv<i>/Run|Speed` drive
 *    the belts, `LINE/PLC<p>/Sensor<j>` report back. Without that binding the
 *    "several PLCs" half of the customer question would not be measured at all —
 *    signal load would just be store churn next to an unrelated line (SOL #4).
 *
 * Layout: each lane is an independent straight chain of abutting belt segments with
 * its own source at the head and sink at the tail. Lanes are stacked in Z and their
 * direction alternates, which folds the whole line into a compact serpentine block
 * while keeping every lane's transport path strictly one-dimensional — MUs never
 * have to negotiate a corner, so throughput is a property of the parameters and not
 * of a hand-off geometry.
 *
 * `dispose()` gives everything back: components, MUs, pools, drives, signals,
 * listeners, geometry and the `maxLiveMUs` override (SOL #8).
 */

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { BufferGeometry, Material, Scene } from 'three';
import { AABB } from '../rv-aabb';
import { RVDrive } from '../rv-drive';
import { DriveDirection } from '../rv-coordinate-utils';
import { RVSensor } from '../rv-sensor';
import { RVSink } from '../rv-sink';
import { RVSource } from '../rv-source';
import { RVTransportSurface } from '../rv-transport-surface';
import type { RVTransportManager } from '../rv-transport-manager';
import type { ComponentContext } from '../rv-component-registry';
import type { SignalStore, SignalWriter } from '../rv-signal-store';
import { createSignalWriter } from '../rv-signal-store';
import {
  LIBRARY_CONVEYOR_WIDTH_M, MU_LIBRARY_ASSETS, ROBOT_AXIS_COUNT, buildConveyorVisuals,
  buildLibraryMuTemplate, buildRobotFarm, cachedAsset, pieceForLength, preloadSyntheticAssets,
  tileSegment,
} from './rv-synthetic-assets';
import type { SyntheticMuAsset } from './rv-synthetic-assets';
export type { SyntheticMuAsset } from './rv-synthetic-assets';
import type { ConveyorPlacement, ConveyorVisualHandle, RobotFarmHandle } from './rv-synthetic-assets';

/** Signal-name prefix owned by the synthetic line. `dispose()` removes exactly this. */
export const SYNTHETIC_LINE_PREFIX = 'LINE/';

const MM_PER_M = 1000;

/**
 * Where the source and the sink sit relative to their lane's ends, in metres.
 *
 * They are inset rather than placed on the very edge (a source exactly on the
 * seam would not classify as standing on a surface). The plan MUST use the same
 * constants: the distance an MU actually travels is the lane length minus these
 * two, and deriving the source interval from the full lane length would
 * systematically under-fill the line — the steady-state occupancy criterion in
 * §1.3 would then fail for a correctly built line.
 */
const HEAD_INSET_M = 0.5;
const TAIL_INSET_M = 0.5;

export interface SyntheticLineConfig {
  /** Deterministic seed — identical seeds produce bit-identical geometry. */
  seed: number;
  /** Independent lanes; each owns one source, one sink and therefore one MU pool. */
  lanes: number;
  /** Lanes are distributed round-robin across this many simulated PLCs. */
  plcs: number;
  /** Belt segments per lane. */
  segments: number;
  segmentLengthM: number;
  sensorsPerSegment: number;
  /** Desired number of simultaneously live MUs across all lanes. */
  targetMUs: number;
  /** Distinct MU geometries (a draw-call axis). Pool count stays `lanes`. */
  muTemplates: number;
  muLengthMm: number;
  muGapMm: number;
  speedMmS: number;
  /** `none` = belts jog freely; otherwise Run/Speed come out of the SignalStore. */
  signalBinding: 'none' | 'browser' | 'connect';
  /**
   * World offset of the whole line, in metres.
   *
   * Not cosmetic: the viewer normally has a real model loaded, and the transport
   * manager picks an MU's driving surface from ALL overlapping surfaces. A
   * synthetic line built on top of the model's own belts would hand its MUs to
   * foreign surfaces and measure a topology nobody configured. Parking it far
   * away keeps the two scenes physically disjoint.
   */
  originX: number;
  originZ: number;
  /**
   * `primitive` (default, plan-465 behaviour): a belt is an invisible
   * `Object3D` plus an AABB — zero draw calls, zero triangles.
   * `library`: the same belts, with `RollConveyor-*.glb` from
   * `public/library/PalletHandling/` drawn on them as `InstancedMesh`es.
   *
   * The TRANSPORT topology is identical in both cases: the surface AABB, the
   * drive and the seam geometry come from the configuration, never from the
   * asset. Only the render cost changes, which is what makes the difference
   * between the two attributable.
   */
  geometry: 'primitive' | 'library';
  /**
   * `primitive` (default): the MU is a `BoxGeometry`, which `analyzeTemplate`
   * always instances. `cartonbox`: the MU template is `CartonBox.glb`.
   * `pallet`: a loaded Euro pallet (`EuropalletLoaded.glb`), which wants
   * `muLengthMm` ≈ 1200 — see `MU_ASSET_PITCH_MM`. Since 2026-09-25 the
   * template builder merges a multi-part asset into ONE multi-material mesh,
   * so every library MU instances; `muInstanced` in the plan is still read
   * back from the source after `init()`, never predicted.
   */
  muAsset: SyntheticMuAsset;
  /** Six-axis robots standing beside the lanes. They never touch the material flow. */
  robots: number;
  /** `erratic` re-targets every axis the moment it arrives — deliberately incoherent. */
  robotMotion: 'static' | 'erratic';
}

/**
 * Defaults sized for the customer question the plan is about: 2400 live MUs.
 *
 * 24 lanes x 9 x 5 m = 1080 m of belt; at a 300 mm pitch that is a geometric
 * capacity of 3600, so 2400 sits at 67 % — inside the 80 % headroom the plan
 * validator requires. Anything smaller is REJECTED rather than silently
 * measured half-empty, so these numbers are part of the contract, not taste.
 */
export const DEFAULT_SYNTHETIC_LINE: SyntheticLineConfig = {
  seed: 465,
  lanes: 24,
  plcs: 2,
  segments: 9,
  segmentLengthM: 5,
  sensorsPerSegment: 1,
  targetMUs: 2400,
  muTemplates: 1,
  muLengthMm: 200,
  muGapMm: 100,
  speedMmS: 1000,
  signalBinding: 'connect',
  originX: 1000,
  originZ: 1000,
  geometry: 'primitive',
  muAsset: 'primitive',
  robots: 0,
  robotMotion: 'static',
};

/**
 * The library assets a configuration needs, so the caller can preload them
 * before the SYNCHRONOUS build. Empty for the plan-465 defaults — a run that
 * does not ask for library geometry touches the network at all.
 */
export function requiredAssets(cfg: SyntheticLineConfig): string[] {
  const names: string[] = [];
  if (cfg.geometry === 'library') {
    for (const len of tileSegment(cfg.segmentLengthM)) {
      const piece = pieceForLength(len);
      if (piece && !names.includes(piece)) names.push(piece);
    }
  }
  if (cfg.muAsset !== 'primitive') {
    const asset = MU_LIBRARY_ASSETS[cfg.muAsset];
    if (!names.includes(asset)) names.push(asset);
  }
  return names;
}

export interface SyntheticLinePlan {
  /** Geometric capacity: how many MUs physically fit on all belts. */
  capacityMUs: number;
  /** Seconds for one MU to travel from its source to its sink. */
  fillTimeS: number;
  /** Source-to-sink distance in metres (lane length minus the two insets). */
  travelLengthM: number;
  /**
   * Interval CONFIGURED on the source to hold `targetMUs` in steady state.
   *
   * Smaller than the part-to-part period on purpose: `RVSource.update()` freezes
   * its interval timer while the spawn point is still occupied by the previous
   * part (rv-source.ts spawn gate), so the achieved period is this interval PLUS
   * {@link spawnGateS}. Configuring the raw period instead is what left an early
   * version of the line at 85 % occupancy and made the §1.3 steady-state
   * criterion unreachable for a correctly built line.
   */
  sourceIntervalS: number;
  /** Part-to-part period the configuration is aiming for (`fillTimeS / per-lane target`). */
  partPeriodS: number;
  /** Seconds the spawn point stays blocked after a spawn — the MU's own length at belt speed. */
  spawnGateS: number;
  /** Value written onto `RVTransportManager.maxLiveMUs` (1.2x target). */
  maxLiveMUs: number;
  /**
   * Upper bound on live MUs imposed by the spawner itself: a source emits at
   * most one MU per fixed step, so a lane cannot hold more than
   * `fillTimeS / fixedTimeStep` MUs no matter how short the interval is.
   */
  spawnCapMUs: number;
  valid: boolean;
  reason?: string;
  pools: number;
  surfaces: number;
  sensors: number;
  sources: number;
  sinks: number;
  signals: string[];
  /** Echo of the configuration the plan was computed from (report provenance). */
  config: SyntheticLineConfig;
  fixedTimeStep: number;
  /** What the realistic-scene options actually produced. Filled by the BUILDER
   *  (a plan computed without building cannot know an asset's mesh count), so
   *  it is null on `plan()` and populated on `build()`. */
  scene: SyntheticSceneInfo | null;
}

/** Measured facts about the built scene — the report quotes these verbatim. */
export interface SyntheticSceneInfo {
  geometry: 'primitive' | 'library';
  muAsset: SyntheticMuAsset;
  /** Draw calls the conveyor visuals add (one per InstancedMesh). */
  conveyorDraws: number;
  conveyorTriangles: number;
  conveyorPlacements: number;
  /** Plain meshes a `clone()` build would have produced instead. */
  conveyorClonesAvoided: number;
  /** Mesh count of ONE MU template — `analyzeTemplate` instances only at 1. */
  muMeshCount: number;
  muTriangles: number;
  /** Whether the sources really took the instanced path (read back from
   *  `RVSource.useInstancing` AFTER `init()`, not predicted). */
  muInstanced: boolean;
  robots: number;
  robotDrives: number;
  robotMeshes: number;
  robotTriangles: number;
  robotMotion: 'static' | 'erratic';
}

export interface SyntheticLineHandle {
  plan: SyntheticLinePlan;
  /** Root group; removed from the scene by `dispose()`. */
  root: Object3D;
  sources: RVSource[];
  sensors: RVSensor[];
  surfaces: RVTransportSurface[];
  drives: RVDrive[];
  dispose(): void;
}

/** Everything the builder needs from the viewer (structural, so tests can fake it). */
export interface SyntheticLineHost {
  scene: Scene | Object3D;
  transportManager: RVTransportManager;
  signalStore: SignalStore;
  /** `RVViewer.drives` — the array `CoreSubsystems.drives()` ticks. */
  drives: RVDrive[];
  /** Defaults to 1/60, matching `SimulationLoop.fixedTimeStep`. */
  fixedTimeStep?: number;
}

/** Deterministic 32-bit PRNG (mulberry32) — no `Math.random` anywhere in the builder. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Signal names the builder registers for a given configuration (also used by the plan). */
function signalNamesFor(cfg: SyntheticLineConfig): string[] {
  if (cfg.signalBinding === 'none') return [];
  const names: string[] = [];
  for (let lane = 0; lane < cfg.lanes; lane++) {
    const plc = lane % cfg.plcs;
    for (let seg = 0; seg < cfg.segments; seg++) {
      const conv = lane * cfg.segments + seg;
      names.push(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/Conv${conv}/Run`);
      names.push(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/Conv${conv}/Speed`);
      for (let s = 0; s < cfg.sensorsPerSegment; s++) {
        names.push(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/Sensor${conv * cfg.sensorsPerSegment + s}`);
      }
    }
  }
  for (let plc = 0; plc < cfg.plcs; plc++) {
    names.push(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/TS`);
    names.push(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/SEQ`);
  }
  return names;
}

/**
 * Compute (and validate) the plan for a configuration WITHOUT building anything.
 *
 * Both validity conditions use the same 0.8 headroom factor: a line asked to run
 * at more than 80 % of a hard ceiling spends the whole measurement window jammed
 * against that ceiling, which measures the ceiling and not the configuration.
 */
/** Clear space between two library conveyors of neighbouring lanes, in metres. */
const LIBRARY_LANE_CLEARANCE_M = 0.4;

/**
 * Centre-to-centre pitch of the lanes, in metres.
 *
 * A primitive belt is two MU lengths wide and lanes sit 1.5 widths apart (the
 * plan-465 geometry, unchanged). Library pieces are as wide as the ASSET —
 * `LIBRARY_CONVEYOR_WIDTH_M`, 1.12 m for `RollConveyor-*` — which is wider than
 * that 0.6 m pitch, so a library line spreads its lanes to the asset width plus
 * a clearance instead. Only the drawing moves: capacity, fill time and every
 * surface AABB depend on lane LENGTH, never on the pitch.
 */
export function laneSpacingFor(cfg: Pick<SyntheticLineConfig, 'muLengthMm' | 'geometry'>): number {
  const laneWidthM = (cfg.muLengthMm / MM_PER_M) * 2;
  const primitivePitch = laneWidthM * 1.5;
  if (cfg.geometry !== 'library') return primitivePitch;
  return Math.max(primitivePitch, LIBRARY_CONVEYOR_WIDTH_M + LIBRARY_LANE_CLEARANCE_M);
}

export function computeSyntheticLinePlan(
  cfg: SyntheticLineConfig,
  fixedTimeStep = 1 / 60,
): SyntheticLinePlan {
  const laneLengthM = cfg.segments * cfg.segmentLengthM;
  const pitchMm = cfg.muLengthMm + cfg.muGapMm;
  const capacityMUs = Math.floor((cfg.lanes * laneLengthM * MM_PER_M) / pitchMm);
  const speedMS = cfg.speedMmS / MM_PER_M;
  const travelLengthM = Math.max(0, laneLengthM - HEAD_INSET_M - TAIL_INSET_M);
  const fillTimeS = speedMS > 0 ? travelLengthM / speedMS : Number.POSITIVE_INFINITY;
  const perLaneTarget = cfg.targetMUs / Math.max(1, cfg.lanes);
  const partPeriodS = perLaneTarget > 0 ? fillTimeS / perLaneTarget : fillTimeS;
  // The spawn point is blocked until the previous part has moved its own length
  // clear of it, and the source's interval timer does not advance while blocked.
  const spawnGateS = speedMS > 0 ? (cfg.muLengthMm / MM_PER_M) / speedMS : Number.POSITIVE_INFINITY;
  const sourceIntervalS = Math.max(0, partPeriodS - spawnGateS);
  // Tightest achievable part spacing: whichever is larger of the one-MU-per-fixed-step
  // ceiling and the physical spawn-gate spacing.
  const minPitchM = Math.max(fixedTimeStep * speedMS, cfg.muLengthMm / MM_PER_M);
  const spawnCapMUs = minPitchM > 0 ? Math.floor((cfg.lanes * travelLengthM) / minPitchM) : 0;

  let valid = true;
  let reason: string | undefined;
  if (!(cfg.lanes > 0 && cfg.segments > 0 && cfg.segmentLengthM > 0 && cfg.speedMmS > 0)) {
    valid = false;
    reason = 'degenerate geometry: lanes, segments, segmentLengthM and speedMmS must all be > 0';
  } else if (travelLengthM <= 0) {
    valid = false;
    reason = `degenerate geometry: lane length ${laneLengthM} m leaves no travel distance `
      + `after the ${HEAD_INSET_M} m source and ${TAIL_INSET_M} m sink insets`;
  } else if (cfg.targetMUs > 0.8 * capacityMUs) {
    valid = false;
    reason = `capacity: targetMUs ${cfg.targetMUs} exceeds 80% of geometric capacity ${capacityMUs}`;
  } else if (partPeriodS <= spawnGateS * 1.25) {
    valid = false;
    reason = `source gate: the target needs a part every ${partPeriodS.toFixed(3)} s, but the spawn `
      + `point stays blocked for ${spawnGateS.toFixed(3)} s after each part `
      + `(MU length at belt speed) — parts would have to overlap`;
  } else if (cfg.targetMUs > 0.8 * spawnCapMUs) {
    valid = false;
    reason = `spawn cap: targetMUs ${cfg.targetMUs} exceeds 80% of spawn ceiling ${spawnCapMUs} `
      + `(one MU per source per fixed step over a ${fillTimeS.toFixed(2)} s lane transit)`;
  }

  return {
    capacityMUs,
    fillTimeS,
    travelLengthM,
    sourceIntervalS,
    partPeriodS,
    spawnGateS,
    maxLiveMUs: Math.ceil(1.2 * cfg.targetMUs),
    spawnCapMUs,
    valid,
    ...(reason !== undefined ? { reason } : {}),
    pools: cfg.lanes,
    surfaces: cfg.lanes * cfg.segments,
    sensors: cfg.lanes * cfg.segments * cfg.sensorsPerSegment,
    sources: cfg.lanes,
    sinks: cfg.lanes,
    signals: signalNamesFor(cfg),
    config: { ...cfg },
    fixedTimeStep,
    scene: null,
  };
}

/**
 * Build the line. Throws when the plan is invalid — a perf harness that silently
 * measures an impossible configuration is worse than one that refuses to run.
 */
export function buildSyntheticLine(
  host: SyntheticLineHost,
  partial: Partial<SyntheticLineConfig> = {},
): SyntheticLineHandle {
  const cfg: SyntheticLineConfig = { ...DEFAULT_SYNTHETIC_LINE, ...partial };
  const fixedTimeStep = host.fixedTimeStep ?? 1 / 60;
  const plan = computeSyntheticLinePlan(cfg, fixedTimeStep);
  if (!plan.valid) {
    throw new Error(`[synthetic-line] invalid configuration — ${plan.reason}`);
  }

  const random = makeRandom(cfg.seed);
  const tm = host.transportManager;
  const store = host.signalStore;
  const writer: SignalWriter = createSignalWriter(store, 'perf:synthetic-line', 'component');

  const root = new Group();
  root.name = '__rvSyntheticLine';
  root.position.set(cfg.originX, 0, cfg.originZ);
  host.scene.add(root);

  const laneWidthM = (cfg.muLengthMm / MM_PER_M) * 2;
  const laneSpacingM = laneSpacingFor(cfg);
  const beltHalf = new Vector3(cfg.segmentLengthM / 2, 0.05, laneWidthM / 2);
  // The MU's half-extents: a cube of `muLengthMm` for the primitive box, the
  // baked asset's real extents for a library MU (a loaded pallet is 1.2 m long
  // and 0.32 m tall; the cube assumption floated it half a metre above the
  // rollers). Probed once — the baked template is cached per (asset, length).
  const libraryMuAsset = cfg.muAsset === 'primitive' ? null : MU_LIBRARY_ASSETS[cfg.muAsset];
  const muHalf = new Vector3(
    cfg.muLengthMm / MM_PER_M / 2,
    cfg.muLengthMm / MM_PER_M / 2,
    cfg.muLengthMm / MM_PER_M / 2,
  );
  if (libraryMuAsset) {
    const probe = buildLibraryMuTemplate(libraryMuAsset, cfg.muLengthMm, '__rvMuProbe');
    if (!probe) {
      throw new Error(
        `[synthetic-line] muAsset=${cfg.muAsset} needs "${libraryMuAsset}" preloaded — `
        + 'call the preload() hook (or preloadSyntheticAssets) before build()',
      );
    }
    muHalf.copy(probe.halfExtents);
  }
  /** Everything that rides ON the belt sits with its underside on the belt top. */
  const rideY = beltHalf.y + muHalf.y;

  // Shared MU geometries/materials — `muTemplates` distinct ones, reused across
  // lanes. Each lane still gets its OWN template node (and therefore its own
  // pool, rv-source.ts:459); the geometry axis and the pool axis are separate on
  // purpose (SOL #7).
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  for (let i = 0; i < Math.max(1, cfg.muTemplates); i++) {
    const jitter = 0.9 + random() * 0.2;   // deterministic, seed-driven
    geometries.push(new BoxGeometry(
      (cfg.muLengthMm / MM_PER_M) * jitter,
      cfg.muLengthMm / MM_PER_M,
      cfg.muLengthMm / MM_PER_M,
    ));
    materials.push(new MeshStandardMaterial({ color: 0x3f88c5, roughness: 0.6 }));
  }

  const surfaces: RVTransportSurface[] = [];
  const sensors: RVSensor[] = [];
  const sources: RVSource[] = [];
  const sinks: RVSink[] = [];
  const drives: RVDrive[] = [];
  /** Where a library conveyor piece goes. Collected in the segment loop and
   *  turned into InstancedMeshes ONCE, after it, so the whole line is a handful
   *  of draw calls rather than one per belt. */
  const conveyorPlacements: ConveyorPlacement[] = [];
  const unsubs: (() => void)[] = [];
  const sensorListeners: { sensor: RVSensor; cb: () => void }[] = [];

  let muMeshCount = 1;
  let muTriangles = 12;
  const templates: Object3D[] = [];

  const prevMaxLiveMUs = tm.maxLiveMUs;
  tm.maxLiveMUs = plan.maxLiveMUs;

  const laneLengthM = cfg.segments * cfg.segmentLengthM;

  for (let lane = 0; lane < cfg.lanes; lane++) {
    const plc = lane % cfg.plcs;
    const forward = lane % 2 === 0 ? 1 : -1;   // serpentine fold
    const z = lane * laneSpacingM;
    const laneGroup = new Group();
    laneGroup.name = `Lane${lane}`;
    root.add(laneGroup);

    for (let seg = 0; seg < cfg.segments; seg++) {
      const conv = lane * cfg.segments + seg;
      // Segments abut along X; a small overlap at the seam is what lets the
      // transport manager hand an MU from one surface to the next.
      const centreX = forward > 0
        ? seg * cfg.segmentLengthM + cfg.segmentLengthM / 2
        : laneLengthM - (seg * cfg.segmentLengthM + cfg.segmentLengthM / 2);

      const beltNode = new Object3D();
      beltNode.name = `Conv${conv}`;
      beltNode.position.set(centreX, 0, z);
      laneGroup.add(beltNode);
      beltNode.updateWorldMatrix(true, false);

      if (cfg.geometry === 'library') {
        // Tile the segment with library pieces. The pieces are VISUAL ONLY: the
        // surface AABB below still comes from `segmentLengthM`, so a 5 m belt
        // drawn as 3 m + 2 m transports exactly like the primitive one.
        let pieceX = centreX - cfg.segmentLengthM / 2;
        for (const len of tileSegment(cfg.segmentLengthM)) {
          conveyorPlacements.push({
            x: pieceX + len / 2,
            y: beltHalf.y,
            z,
            lengthM: len,
            flipped: forward < 0,
          });
          pieceX += len;
        }
      }

      const drive = new RVDrive(beltNode);
      drive.Direction = DriveDirection.LinearX;
      drive.TargetSpeed = cfg.speedMmS;
      drive.UseAcceleration = false;
      drive.JogForward = true;
      // ORDER MATTERS: `initDrive()` captures the node's authored pose as
      // `basePosition`, and the `isTransportSurface` setter restores exactly that
      // pose (Unity parity — a belt frame must not be moved by its own drive).
      // Flipping the flag first would make the setter restore a basePosition of
      // (0,0,0) and teleport every belt onto the line's origin.
      drive.initDrive();
      drive.isTransportSurface = true;
      drives.push(drive);
      host.drives.push(drive);

      const surface = new RVTransportSurface(beltNode, AABB.fromHalfSize(beltNode, beltHalf));
      surface.TransportDirection.set(forward, 0, 0);
      surface.Radial = false;
      surface.TextureScale = 1;
      surface.HeightOffsetOverride = 0;
      // `init()` is the loader's entry point and needs a registry/gizmo context we
      // do not have. `reapplyConfig()` is the public re-derivation of exactly the
      // two things that matter here — the local transport axis and its world
      // projection — so a reversed lane really transports backwards.
      surface.reapplyConfig();
      surface.initTransport();
      surface.drive = drive;
      surface.accumulationProvider = tm;
      surfaces.push(surface);
      tm.surfaces.push(surface);

      if (cfg.signalBinding !== 'none') {
        const runName = `${SYNTHETIC_LINE_PREFIX}PLC${plc}/Conv${conv}/Run`;
        const speedName = `${SYNTHETIC_LINE_PREFIX}PLC${plc}/Conv${conv}/Speed`;
        store.register(runName, `__perf__/${runName}`, true, 'BOOL');
        store.register(speedName, `__perf__/${speedName}`, cfg.speedMmS, 'REAL');
        unsubs.push(store.subscribe(runName, (v) => { drive.jogForward = v === true || v === 1; }));
        unsubs.push(store.subscribe(speedName, (v) => { drive.targetSpeed = Number(v); }));
      }

      for (let s = 0; s < cfg.sensorsPerSegment; s++) {
        const idx = conv * cfg.sensorsPerSegment + s;
        // Sensors sit evenly along the segment, biased towards its discharge end
        // so a stopped belt backs an MU into one quickly.
        const frac = (s + 1) / (cfg.sensorsPerSegment + 1);
        const sensorNode = new Object3D();
        sensorNode.name = `Sensor${idx}`;
        sensorNode.position.set(
          centreX + forward * (frac - 0.5) * cfg.segmentLengthM,
          rideY,
          z,
        );
        laneGroup.add(sensorNode);
        sensorNode.updateWorldMatrix(true, false);

        const sensor = new RVSensor(sensorNode, AABB.fromHalfSize(sensorNode, muHalf));
        sensor.UseRaycast = false;
        sensor.invertSignal = false;
        sensors.push(sensor);
        tm.sensors.push(sensor);

        if (cfg.signalBinding !== 'none') {
          const sensorName = `${SYNTHETIC_LINE_PREFIX}PLC${plc}/Sensor${idx}`;
          store.register(sensorName, `__perf__/${sensorName}`, false, 'BOOL');
          const cb = () => { writer.set(sensorName, sensor.occupied); };
          sensor.addFeedbackListener(cb);
          sensorListeners.push({ sensor, cb });
        }
      }
    }

    // ── MU template + source at the lane head ──
    const templateName = `MU_L${lane}`;
    let template: Object3D;
    if (libraryMuAsset) {
      const built = buildLibraryMuTemplate(libraryMuAsset, cfg.muLengthMm, templateName);
      if (!built) {
        throw new Error(
          `[synthetic-line] muAsset=${cfg.muAsset} needs "${libraryMuAsset}" preloaded — `
          + 'call the preload() hook (or preloadSyntheticAssets) before build()',
        );
      }
      template = built.node;
      muMeshCount = built.meshCount;
      muTriangles = built.triangles;
    } else {
      const mesh = new Mesh(
        geometries[lane % geometries.length],
        materials[lane % materials.length],
      );
      mesh.position.set(0, 0, 0);
      template = mesh;
      muMeshCount = 1;
      muTriangles = 12;
    }
    template.name = templateName;
    laneGroup.add(template);
    templates.push(template);

    const headX = forward > 0 ? HEAD_INSET_M : laneLengthM - HEAD_INSET_M;
    const sourceNode = new Object3D();
    sourceNode.name = `Source_L${lane}`;
    sourceNode.position.set(headX, rideY, z);
    laneGroup.add(sourceNode);
    laneGroup.updateWorldMatrix(true, true);

    const source = new RVSource(sourceNode);
    source.AutomaticGeneration = true;
    source.Interval = plan.sourceIntervalS;
    source.GenerateIfDistance = 0;
    source.ThisObjectAsMU = template.name;
    source.rawExtras = {};
    // `init()` (rather than pushing by hand) is deliberate: it is what wires the
    // source's private transport-manager reference, and without that the source
    // falls back to the permissive "always spawn" path and stops honouring the
    // occupancy gate — the very behaviour a jam measurement depends on.
    source.init({
      root: laneGroup,
      registry: { getNode: () => null } as unknown as ComponentContext['registry'],
      signalStore: store,
      scene: host.scene as Scene,
      transportManager: tm,
    } as unknown as ComponentContext);
    sources.push(source);

    // ── Sink at the lane tail ──
    const tailX = forward > 0 ? laneLengthM - TAIL_INSET_M : TAIL_INSET_M;
    const sinkNode = new Object3D();
    sinkNode.name = `Sink_L${lane}`;
    sinkNode.position.set(tailX, rideY, z);
    laneGroup.add(sinkNode);
    sinkNode.updateWorldMatrix(true, false);
    const sink = new RVSink(sinkNode, AABB.fromHalfSize(sinkNode, muHalf));
    sinks.push(sink);
    tm.sinks.push(sink);
  }

  // ── Hide the authoring decoration (plan-465 fix 2026-09-06) ──
  //
  // `RVSource.init()` builds a source-marker ring plus a ghost / ghost-fill /
  // preview mesh for every source, and the MU template itself stays in the
  // scene. That is FIVE extra non-instanced draw calls per lane — 120 of the
  // 141 draw calls a 24-lane line was reporting, entirely independent of the MU
  // count the matrix sweeps. The MUs themselves cost 24 (one InstancedMesh per
  // pool), so without this the `draws` column measured the number of LANES.
  //
  // Only non-instanced meshes are hidden: the pools are `InstancedMesh` and are
  // exactly what the line is supposed to be drawing. Hiding rather than
  // removing keeps `dispose()` symmetric — the nodes are still the source's own
  // and go away with the group.
  // The TEMPLATE is only hidden when its source really went the instanced route:
  // on the clone path `_buildRealClone` copies the template node, and a clone of
  // an invisible mesh is an invisible MU.
  const decoration = /_ghost$|_ghostFill$|_preview$|_sourceMarkerRing$/;
  for (let lane = 0; lane < sources.length; lane++) {
    const laneGroup = sources[lane].node.parent;
    // Hide the decoration ROOTS, not individual meshes: three.js cascades
    // `visible`, and a library MU template's ghost clone is a whole subtree
    // whose children carry the ASSET's names, not `_ghost`. Matching on mesh
    // names only (the plan-465 form) left 24 full-detail cartons in the frame.
    laneGroup?.traverse((o) => { if (decoration.test(o.name)) o.visible = false; });
    // The TEMPLATE is only hidden when its source really went the instanced
    // route: on the clone path `_buildRealClone` copies the template node, and a
    // clone of an invisible node is an invisible MU.
    if (sources[lane].useInstancing) templates[lane].visible = false;
  }

  root.updateWorldMatrix(true, true);
  for (const s of surfaces) s.updateAABB();
  for (const s of sensors) s.updateAABB();
  for (const s of sinks) s.updateAABB();

  if (cfg.signalBinding !== 'none') {
    for (let plc = 0; plc < cfg.plcs; plc++) {
      store.register(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/TS`, `__perf__/PLC${plc}/TS`, 0, 'REAL');
      store.register(`${SYNTHETIC_LINE_PREFIX}PLC${plc}/SEQ`, `__perf__/PLC${plc}/SEQ`, 0, 'DINT');
    }
  }
  // ── Realistic-scene extras (plan-469 Phase 0d) ──
  //
  // Built AFTER the transport topology, and touching none of it: the conveyor
  // visuals are InstancedMeshes with no components on them, and the robots are
  // drives on nodes that own no surface, no sensor and no sink. Whatever they
  // cost lands in the render pass and in the DRIVE stage, never in transport.
  let conveyors: ConveyorVisualHandle | null = null;
  if (cfg.geometry === 'library') {
    if (conveyorPlacements.length > 0 && !cachedAsset(pieceForLength(conveyorPlacements[0].lengthM) ?? '')) {
      throw new Error(
        '[synthetic-line] geometry=library needs the RollConveyor assets preloaded — '
        + 'call the preload() hook (or preloadSyntheticAssets) before build()',
      );
    }
    conveyors = buildConveyorVisuals(root, conveyorPlacements);
  }

  let robotFarm: RobotFarmHandle | null = null;
  if (cfg.robots > 0) {
    // Two rows, one on each side of the lane block, 1.5 m clear of the outermost
    // lane so a 1.5 m-reach arm can never intersect a belt or an MU.
    const zNear = -1.5;
    const zFar = (cfg.lanes - 1) * laneSpacingM + 1.5;
    const spanX = Math.max(1, cfg.segments * cfg.segmentLengthM);
    robotFarm = buildRobotFarm({
      parent: root,
      count: cfg.robots,
      motion: cfg.robotMotion,
      seed: cfg.seed,
      registerDrive: (d) => { drives.push(d); host.drives.push(d); },
      place: (i, out) => {
        const perRow = Math.ceil(cfg.robots / 2);
        const row = i % 2;
        const col = Math.floor(i / 2);
        return out.set(((col + 0.5) / perRow) * spanX, 0, row === 0 ? zNear : zFar);
      },
    });
  }

  plan.scene = {
    geometry: cfg.geometry,
    muAsset: cfg.muAsset,
    conveyorDraws: conveyors?.draws ?? 0,
    conveyorTriangles: conveyors?.triangles ?? 0,
    conveyorPlacements: conveyors?.placements ?? 0,
    conveyorClonesAvoided: conveyors?.clonedMeshesAvoided ?? 0,
    muMeshCount,
    muTriangles,
    // Read BACK off the source rather than predicted: `analyzeTemplate` is the
    // authority, and whether CartonBox.glb instances is the finding, not an input.
    muInstanced: sources.length > 0 && sources.every((src) => src.useInstancing),
    robots: cfg.robots,
    robotDrives: robotFarm?.drives.length ?? 0,
    robotMeshes: robotFarm?.meshes ?? 0,
    robotTriangles: robotFarm?.triangles ?? 0,
    robotMotion: cfg.robotMotion,
  };

  tm.notifyTopologyChanged();

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;

    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    for (const { sensor, cb } of sensorListeners) sensor.removeFeedbackListener(cb);
    sensorListeners.length = 0;

    // Live MUs first — every one of them holds a pool slot and, for the clone
    // path, a scene node. `removeMU` is the manager's own dispose chokepoint
    // (physics hook, grips, grid), so nothing is orphaned.
    const ourSources = new Set(sources.map((s) => s.node.name));
    for (let i = tm.mus.length - 1; i >= 0; i--) {
      const mu = tm.mus[i];
      if (ourSources.has(mu.sourceName)) tm.removeMU(mu);
    }

    const surfaceSet = new Set<RVTransportSurface>(surfaces);
    const sensorSet = new Set<RVSensor>(sensors);
    const sourceSet = new Set<RVSource>(sources);
    const sinkSet = new Set<RVSink>(sinks);
    tm.surfaces = tm.surfaces.filter((s) => !surfaceSet.has(s));
    tm.sensors = tm.sensors.filter((s) => !sensorSet.has(s));
    tm.sources = tm.sources.filter((s) => !sourceSet.has(s));
    tm.sinks = tm.sinks.filter((s) => !sinkSet.has(s));

    for (const source of sources) {
      source.pool?.dispose();
      source.pool = null;
      source.dispose();
    }
    for (const sensor of sensors) sensor.dispose();
    for (const surface of surfaces) surface.dispose();

    // Robots BEFORE the shared drive teardown: the farm has to release its
    // after-update callbacks while its drives are still live, and it owns its own
    // link geometry/material.
    robotFarm?.dispose();
    robotFarm = null;
    // Library conveyors: the InstancedMeshes are ours; the geometry behind them
    // belongs to the module-level asset cache and is deliberately kept, so the
    // next build reuses it instead of re-parsing megabytes of GLB.
    conveyors?.dispose();
    conveyors = null;

    const driveSet = new Set<RVDrive>(drives);
    for (let i = host.drives.length - 1; i >= 0; i--) {
      if (driveSet.has(host.drives[i])) host.drives.splice(i, 1);
    }
    for (const drive of drives) drive.dispose();

    // Only OUR signals — foreign signals, their listeners, alias paths and force
    // pins survive untouched (that is the whole point of `unregisterByPrefix`).
    store.unregisterByPrefix(SYNTHETIC_LINE_PREFIX);

    root.parent?.remove(root);
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();

    tm.maxLiveMUs = prevMaxLiveMUs;
    tm.notifyTopologyChanged();
  };

  return { plan, root, sources, sensors, surfaces, drives, dispose };
}

// ── Dev-only window hook ─────────────────────────────────────────────────

/** Shape exposed as `window.__rvSyntheticLine` (see `doc-web-debugging.md`). */
export interface SyntheticLineHook {
  /** Fetch and parse the library GLBs a configuration needs. MUST be awaited
   *  before `build()` whenever `geometry: 'library'` or `muAsset: 'cartonbox'`
   *  is used — the builder itself stays synchronous on purpose. */
  preload(cfg?: Partial<SyntheticLineConfig>): Promise<string[]>;
  build(cfg?: Partial<SyntheticLineConfig>): SyntheticLinePlan;
  plan(cfg?: Partial<SyntheticLineConfig>): SyntheticLinePlan;
  dispose(): void;
  current(): SyntheticLinePlan | null;
}

/**
 * Install `window.__rvSyntheticLine`. Same shape as `__rvMuComputeBench`: a
 * dev-only global the Node runners drive through `page.evaluate`.
 */
export function installSyntheticLineHook(host: SyntheticLineHost): SyntheticLineHook {
  let handle: SyntheticLineHandle | null = null;
  const hook: SyntheticLineHook = {
    plan: (cfg) => computeSyntheticLinePlan(
      { ...DEFAULT_SYNTHETIC_LINE, ...cfg },
      host.fixedTimeStep ?? 1 / 60,
    ),
    async preload(cfg) {
      const names = requiredAssets({ ...DEFAULT_SYNTHETIC_LINE, ...cfg });
      await preloadSyntheticAssets(names);
      return names;
    },
    build(cfg) {
      handle?.dispose();
      handle = buildSyntheticLine(host, cfg);
      return handle.plan;
    },
    dispose() {
      handle?.dispose();
      handle = null;
    },
    current: () => handle?.plan ?? null,
  };
  (globalThis as { __rvSyntheticLine?: SyntheticLineHook }).__rvSyntheticLine = hook;
  return hook;
}
