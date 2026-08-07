// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVIKPath / RVIKTarget — replay engine unit tests (plan-215 Phase 1).
 *
 * Verifies the path state machine, signal contract (SignalStart/IsStarted/Ended,
 * per-target SetSignal/WaitForSignal/WaitForSeconds), LoopPath / StartNextPath,
 * AxisPos replay onto axis drives, and the RVIKPathStep LogicStep wrapper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import { RVIKPathStep } from '../src/core/engine/rv-ik-path-step';
import { StepState } from '../src/core/engine/rv-logic-step';
import { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import { ikSolverRegistry, type IKSolution, type IKSolverProvider } from '../src/core/engine/rv-ik-solver';

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });
const targetRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.IKTarget' });
const pathRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.IKPath' });

function makeDrive(path: string, direction: DriveDirection = DriveDirection.LinearX): RVDrive {
  const node = new Object3D();
  node.name = path.split('/').pop()!;
  const drive = new RVDrive(node);
  drive.Direction = direction;
  drive.StartPosition = 0;
  drive.TargetSpeed = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.initDrive();
  return drive;
}

interface SceneOpts {
  axisCount?: number;
  targets?: Array<{ axisPos: number[]; setSignal?: string; waitForSignal?: string; waitSeconds?: number; setDuration?: number }>;
  loop?: boolean;
  startPath?: boolean;
  signalStart?: string;
  withStartSignals?: boolean; // register IsStarted/Ended
  startNextPath?: string;     // path id of a chained RVIKPath
  direction?: DriveDirection; // axis drive direction (default LinearX)
}

interface Scene {
  ikPath: RVIKPath;
  drives: RVDrive[];
  store: SignalStore;
  registry: NodeRegistry;
  context: ComponentContext;
  tick: (dt: number) => void;
  runUntil: (pred: () => boolean, maxFrames?: number, dt?: number) => number;
}

function buildScene(opts: SceneOpts = {}): Scene {
  const axisCount = opts.axisCount ?? 1;
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const transportManager = new RVTransportManager();

  // Signals
  store.register('sigStart', 'sigStart', false, 'PLCOutputBool');
  store.register('sigIsStarted', 'sigIsStarted', false, 'PLCInputBool');
  store.register('sigEnded', 'sigEnded', false, 'PLCInputBool');
  store.register('sigSet', 'sigSet', false, 'PLCInputBool');
  store.register('sigWait', 'sigWait', false, 'PLCOutputBool');

  // Axis drives
  const drives: RVDrive[] = [];
  const axisRefs: ComponentRef[] = [];
  for (let i = 0; i < axisCount; i++) {
    const p = `Robot/a${i}`;
    const d = makeDrive(p, opts.direction);
    registry.register('Drive', p, d);
    drives.push(d);
    axisRefs.push(driveRef(p));
  }

  // Robot node carrying serialized RobotIK.Axis + IKPath child node
  const robotNode = new Object3D();
  robotNode.name = 'Robot';
  robotNode.userData.realvirtual = { RobotIK: { Axis: axisRefs } };
  const ikPathNode = new Object3D();
  ikPathNode.name = 'Path';
  robotNode.add(ikPathNode);

  // Targets
  const targetSpecs = opts.targets ?? [{ axisPos: [90] }];
  const targetRefs: ComponentRef[] = [];
  targetSpecs.forEach((spec, idx) => {
    const tp = `Robot/Path/T${idx}`;
    const tnode = new Object3D();
    tnode.name = `T${idx}`;
    const t = new RVIKTarget(tnode);
    t.AxisPos = spec.axisPos;
    t.SpeedToTarget = 1;
    t.SetSignal = spec.setSignal ?? null;
    t.WaitForSignal = spec.waitForSignal ?? null;
    t.WaitForSeconds = spec.waitSeconds ?? 0;
    if (spec.setDuration !== undefined) t.SetSignalDuration = spec.setDuration;
    t.init({ registry, signalStore: store } as unknown as ComponentContext);
    registry.register('IKTarget', tp, t);
    targetRefs.push(targetRef(tp));
  });

  // IKPath — raw refs live on node extras (init reads them from there).
  ikPathNode.userData.realvirtual = {
    IKPath: {
      Path: targetRefs,
      ...(opts.startNextPath ? { StartNextPath: pathRef(opts.startNextPath) } : {}),
    },
  };
  const ikPath = new RVIKPath(ikPathNode);
  ikPath.LoopPath = opts.loop ?? false;
  ikPath.StartPath = opts.startPath ?? false;
  // Simulate post-resolveComponentRefs: signal refs become address strings.
  ikPath.SignalStart = opts.signalStart ?? null;
  if (opts.withStartSignals) {
    ikPath.SignalIsStarted = 'sigIsStarted';
    ikPath.SignalEnded = 'sigEnded';
  }

  const context: ComponentContext = {
    registry, signalStore: store, scene: new Object3D() as never, transportManager,
    root: robotNode,
  } as ComponentContext;
  ikPath.init(context);
  registry.register('IKPath', 'Robot/Path', ikPath);

  const tick = (dt: number) => {
    ikPath.fixedUpdate(dt);
    for (const d of drives) d.update(dt);
  };
  const runUntil = (pred: () => boolean, maxFrames = 2000, dt = 0.05): number => {
    let n = 0;
    while (n < maxFrames && !pred()) { tick(dt); n++; }
    return n;
  };

  return { ikPath, drives, store, registry, context, tick, runUntil };
}

describe('RVIKPath — startPath signal contract', () => {
  it('startPath sets SignalIsStarted=true and SignalEnded=false immediately', () => {
    const s = buildScene({ withStartSignals: true });
    s.store.set('sigEnded', true); // pre-set to verify it gets cleared
    s.ikPath.startPath();
    expect(s.store.getBool('sigIsStarted')).toBe(true);
    expect(s.store.getBool('sigEnded')).toBe(false);
    expect(s.ikPath.PathIsActive).toBe(true);
  });

  it('path end sets SignalEnded=true and SignalIsStarted=false', () => {
    const s = buildScene({ withStartSignals: true, targets: [{ axisPos: [90] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.store.getBool('sigEnded')).toBe(true);
    expect(s.store.getBool('sigIsStarted')).toBe(false);
  });
});

describe('RVIKPath — AxisPos replay', () => {
  it('drives all axes to the target AxisPos and finishes', () => {
    const s = buildScene({ axisCount: 3, targets: [{ axisPos: [90, -45, 30] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(90, 1);
    expect(s.drives[1].currentPosition).toBeCloseTo(-45, 1);
    expect(s.drives[2].currentPosition).toBeCloseTo(30, 1);
  });

  it('runs through multiple targets in order', () => {
    const s = buildScene({ targets: [{ axisPos: [50] }, { axisPos: [120] }] });
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(120, 1);
  });

  it('synced PTP: all axes reach their targets together (longest axis paces)', () => {
    const s = buildScene({ axisCount: 2, targets: [{ axisPos: [100, 10] }] });
    s.ikPath.startPath();
    // After the first axis (delta 100) is ~half done, the short axis (delta 10)
    // must not yet be finished — proves synced timing, not independent speeds.
    let frames = 0;
    while (frames < 4) { s.tick(0.05); frames++; }
    const longProgress = s.drives[0].currentPosition / 100;
    const shortProgress = s.drives[1].currentPosition / 10;
    expect(Math.abs(longProgress - shortProgress)).toBeLessThan(0.2);
  });

  it('rotary PTP takes the shortest way: +170° → −170° travels 20°, not 340° (RobotIK.cs:556 unwrap parity)', () => {
    const s = buildScene({
      direction: DriveDirection.RotationZ,
      targets: [{ axisPos: [170] }, { axisPos: [-170] }],
    });
    s.ikPath.startPath();
    // On the arrival tick the path already starts segment 2 (same fixedUpdate),
    // so the drive sits at 170 + one frame of the new move here.
    s.runUntil(() => s.ikPath.NumTarget >= 1);
    expect(s.drives[0].currentPosition).toBeGreaterThan(169);
    // Second segment: baked −170 must be driven as +190 (20° forward). The
    // 340° detour would dive back down through 0.
    let minPos = Infinity;
    for (let i = 0; i < 2000 && !s.ikPath.PathIsFinished; i++) {
      s.tick(0.05);
      minPos = Math.min(minPos, s.drives[0].currentPosition);
    }
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.drives[0].currentPosition).toBeCloseTo(190, 1); // same orientation as −170
    expect(minPos).toBeGreaterThan(169); // never turned back toward 0
  });

  it('linear axes are never wrapped mod 360 (gantry travel > 360 mm)', () => {
    const s = buildScene({ targets: [{ axisPos: [500] }] }); // LinearX drive, 500 mm
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(500, 1); // NOT 140 (= 500-360)
  });
});

describe('RVIKPath — LoopPath and StartNextPath', () => {
  it('LoopPath restarts after finishing', () => {
    const s = buildScene({ loop: true, targets: [{ axisPos: [90] }] });
    s.ikPath.startPath();
    // Run a while; with loop it should never settle into Finished+inactive.
    s.runUntil(() => s.ikPath.NumTarget >= 1); // first target reached at least once
    let sawRestart = false;
    for (let i = 0; i < 400; i++) {
      s.tick(0.05);
      if (s.ikPath.PathIsActive && s.ikPath.NumTarget === 0) { sawRestart = true; break; }
    }
    expect(sawRestart).toBe(true);
  });

  it('StartNextPath takes precedence over LoopPath', () => {
    const next = buildScene({ targets: [{ axisPos: [10] }] });
    // Build the main path that chains to `next`.
    const s = buildScene({ loop: true, targets: [{ axisPos: [90] }], startNextPath: 'Robot/Path' });
    // Wire the chained path into the main path's registry resolution by injecting it.
    (s.ikPath as unknown as { _startNextPath: RVIKPath })._startNextPath = next.ikPath;
    s.ikPath.startPath();
    s.runUntil(() => next.ikPath.PathIsActive, 2000);
    expect(next.ikPath.PathIsActive).toBe(true);
  });
});

describe('RVIKPath — per-target signals', () => {
  it('WaitForSignal blocks advancing until the signal is true', () => {
    const s = buildScene({ targets: [
      { axisPos: [30], waitForSignal: 'sigWait' },
      { axisPos: [60] },
    ] });
    s.ikPath.startPath();
    // Reach target 0 and start waiting.
    s.runUntil(() => s.ikPath.WaitForSignal, 2000);
    expect(s.ikPath.WaitForSignal).toBe(true);
    // It must NOT progress to target 1 while the signal is false.
    for (let i = 0; i < 50; i++) s.tick(0.05);
    expect(s.drives[0].currentPosition).toBeCloseTo(30, 1);
    expect(s.ikPath.PathIsFinished).toBe(false);
    // Release the signal → path completes.
    s.store.set('sigWait', true);
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(60, 1);
  });

  it('SetSignal is raised on arrival and reset after SetSignalDuration', () => {
    const s = buildScene({ targets: [
      { axisPos: [40], setSignal: 'sigSet', setDuration: 0.5, waitSeconds: 2 },
      { axisPos: [80] },
    ] });
    s.ikPath.startPath();
    s.runUntil(() => s.store.getBool('sigSet'), 2000);
    expect(s.store.getBool('sigSet')).toBe(true);
    // After SetSignalDuration elapses (within the 2s dwell) it resets to false.
    s.runUntil(() => !s.store.getBool('sigSet'), 200);
    expect(s.store.getBool('sigSet')).toBe(false);
  });

  it('WaitForSeconds delays advancing to the next target', () => {
    const s = buildScene({ targets: [
      { axisPos: [20], waitSeconds: 1 },
      { axisPos: [50] },
    ] });
    s.ikPath.startPath();
    // Reach + register arrival at target 0 (NumTarget advances to 1 in atTarget()).
    s.runUntil(() => s.ikPath.NumTarget >= 1, 2000);
    expect(s.drives[0].currentPosition).toBeCloseTo(20, 1);
    // During the 1s dwell the drive must NOT start moving toward target 1 (50).
    for (let i = 0; i < 10; i++) s.tick(0.05); // 0.5s < 1s dwell
    expect(s.drives[0].currentPosition).toBeCloseTo(20, 1);
    expect(s.ikPath.PathIsFinished).toBe(false);
    // After the dwell elapses the path completes at target 1.
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.drives[0].currentPosition).toBeCloseTo(50, 1);
  });
});

describe('RVIKPath — start triggers', () => {
  it('StartPath=true auto-starts on first tick', () => {
    const s = buildScene({ startPath: true, withStartSignals: true });
    expect(s.ikPath.PathIsActive).toBe(false);
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(true);
    expect(s.store.getBool('sigIsStarted')).toBe(true);
  });

  it('SignalStart rising edge triggers startPath', () => {
    const s = buildScene({ signalStart: 'sigStart' });
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(false);
    s.store.set('sigStart', true); // subscription updates internal value
    s.tick(0.05);
    expect(s.ikPath.PathIsActive).toBe(true);
  });
});

describe('RVIKPath — degenerate', () => {
  it('empty path finishes immediately on start', () => {
    const s = buildScene({ targets: [] });
    s.ikPath.startPath();
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.ikPath.PathIsActive).toBe(false);
  });
});

// ── LIN guard rail: a sabotaged live solve must NEVER degrade the replay ────
//
// Fixture: a synthetic 6-axis robot (registered RVRobotIK + OPW extras so the
// LIN live-solve path engages) with T0 (PTP, AxisPos 10°) → T1 (Linear,
// AxisPos 20°). The solver is a mock provider — no WASM needed.

interface LinScene {
  ikPath: RVIKPath;
  drives: RVDrive[];
  tick: (dt: number) => void;
}

function buildLinScene(opts: { axisPosT2?: number[] } = {}): LinScene {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const transportManager = new RVTransportManager();

  const robotNode = new Object3D();
  robotNode.name = 'Robot';

  const drives: RVDrive[] = [];
  const axisRefs: ComponentRef[] = [];
  for (let i = 0; i < 6; i++) {
    const p = `Robot/a${i}`;
    const d = makeDrive(p, DriveDirection.RotationZ); // robot axes are revolute
    registry.register('Drive', p, d);
    drives.push(d);
    axisRefs.push(driveRef(p));
  }
  robotNode.userData.realvirtual = {
    RobotIK: {
      Axis: axisRefs,
      // Minimal OPW params so getOpwParams() is non-null — the mock provider
      // ignores them entirely.
      a1: 0.1, a2: -0.1, b: 0, c1: 0.5, c2: 0.7, c3: 0.7, c4: 0.1,
      ElbowInUnityX: false,
      ToolOffset: { x: 0, y: 0, z: 0.1 },
    },
  };

  const ikPathNode = new Object3D();
  ikPathNode.name = 'Path';
  robotNode.add(ikPathNode);

  const mkTarget = (idx: number, axisPos: number[], interp: 'PointToPoint' | 'Linear', x: number): ComponentRef => {
    const tp = `Robot/Path/T${idx}`;
    const tnode = new Object3D();
    tnode.name = `T${idx}`;
    tnode.position.set(x, 0, 0.8);
    robotNode.add(tnode);
    const t = new RVIKTarget(tnode);
    t.AxisPos = axisPos;
    t.InterpolationToTarget = interp;
    t.LinearSpeedToTarget = 500;      // 0.5 m/s
    t.LinearAcceleration = 10000;     // ramp within one step — deterministic step count
    t.init({ registry, signalStore: store } as unknown as ComponentContext);
    registry.register('IKTarget', tp, t);
    return targetRef(tp);
  };
  const targetRefs = [
    mkTarget(0, [10, 10, 10, 10, 10, 10], 'PointToPoint', 0.5),
    mkTarget(1, [20, 20, 20, 20, 20, 20], 'Linear', 1.1), // 0.6 m segment
  ];
  if (opts.axisPosT2) targetRefs.push(mkTarget(2, opts.axisPosT2, 'PointToPoint', 1.3));
  robotNode.updateMatrixWorld(true);

  ikPathNode.userData.realvirtual = { IKPath: { Path: targetRefs } };

  const context: ComponentContext = {
    registry, signalStore: store, scene: new Object3D() as never, transportManager,
    root: robotNode,
  } as ComponentContext;

  // Registered RVRobotIK so RVIKPath.init resolves this._robot via findInParent.
  registry.registerNode('Robot', robotNode);
  const robotIk = new RVRobotIK(robotNode);
  robotIk.init(context);
  registry.register('RobotIK', 'Robot', robotIk);

  const ikPath = new RVIKPath(ikPathNode);
  ikPath.init(context);
  registry.register('IKPath', 'Robot/Path', ikPath);

  const tick = (dt: number) => {
    ikPath.fixedUpdate(dt);
    for (const d of drives) d.update(dt);
  };
  return { ikPath, drives, tick };
}

function makeProvider(solve: () => IKSolution[]): IKSolverProvider {
  return { tier: 'free', maxRobots: 8, canBlend: false, solvePieper: () => solve() };
}

describe('RVIKPath — LIN guard rail (sabotaged solver never degrades replay)', () => {
  afterEach(() => {
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
  });

  const runScene = (): { frames: number[][]; ikPath: RVIKPath; drives: RVDrive[] } => {
    const s = buildLinScene();
    const frames: number[][] = [];
    s.ikPath.startPath();
    for (let i = 0; i < 600 && !s.ikPath.PathIsFinished; i++) {
      s.tick(0.05);
      frames.push(s.drives.map((d) => d.currentPosition));
    }
    return { frames, ikPath: s.ikPath, drives: s.drives };
  };

  it('configuration-jumping solutions at segment start ⇒ motion is frame-identical to plain joint-space replay', () => {
    // Reference: no solver registered → pure AxisPos replay.
    ikSolverRegistry.register(null);
    ikSolverRegistry.resetLiveSolveClaims();
    const ref = runScene();
    expect(ref.ikPath.PathIsFinished).toBe(true);

    // Sabotage: the solver always answers with a far-away configuration
    // (reachable=true, so only the jump guard can reject it).
    ikSolverRegistry.register(makeProvider(() => [
      { angles: [170, 170, 170, 170, 170, 170], reachable: true },
    ]));
    ikSolverRegistry.resetLiveSolveClaims();
    const sab = runScene();
    expect(sab.ikPath.PathIsFinished).toBe(true);

    // Frame-by-frame identical trajectory — the sabotaged live solve must be
    // rejected BEFORE anything renders, leaving exactly the replay motion.
    expect(sab.frames.length).toBe(ref.frames.length);
    let maxDiff = 0;
    for (let f = 0; f < ref.frames.length; f++) {
      for (let a = 0; a < 6; a++) {
        maxDiff = Math.max(maxDiff, Math.abs(sab.frames[f][a] - ref.frames[f][a]));
      }
    }
    expect(maxDiff).toBe(0);
    for (const d of sab.drives) expect(d.currentPosition).toBeCloseTo(20, 3);
  });

  it('mid-segment configuration jump ⇒ whole remaining segment falls back to PTP replay, seamlessly', () => {
    // Calls 1..2 = tryStartLinear start/end checks (echo the parked pose),
    // calls 3..12 = plausible gentle drift (LIN steps), call 13+ = hard flip.
    let calls = 0;
    ikSolverRegistry.register(makeProvider(() => {
      calls++;
      const good = calls <= 2 ? 10 : Math.min(10 + (calls - 2) * 0.2, 12);
      const a = calls >= 13 ? 170 : good;
      return [{ angles: [a, a, a, a, a, a], reachable: true }];
    }));

    const s = buildLinScene();
    s.ikPath.startPath();
    const overwriteFrames: boolean[] = [];
    let maxFrameDelta = 0;
    let prev = s.drives.map((d) => d.currentPosition);
    for (let i = 0; i < 600 && !s.ikPath.PathIsFinished; i++) {
      s.tick(0.05);
      const cur = s.drives.map((d) => d.currentPosition);
      for (let a = 0; a < 6; a++) maxFrameDelta = Math.max(maxFrameDelta, Math.abs(cur[a] - prev[a]));
      prev = cur;
      overwriteFrames.push(s.drives.some((d) => d.positionOverwrite));
    }
    expect(s.ikPath.PathIsFinished).toBe(true);

    // The LIN phase actually ran (10 live steps), then stopped solving for good:
    // 2 segment checks + 10 good steps + 1 rejected jump = 13 solver calls total.
    expect(calls).toBe(13);

    // The 158° flip never rendered: no frame moves any axis further than the
    // drive physics allow (TargetSpeed 100 °/s × 0.05 s = 5°/frame + margin).
    expect(maxFrameDelta).toBeLessThan(5.5);

    // No per-step ping-pong: LIN (positionOverwrite) frames form ONE contiguous
    // block — after the fallback the segment stays in joint-space replay.
    const firstLin = overwriteFrames.indexOf(true);
    const lastLin = overwriteFrames.lastIndexOf(true);
    expect(firstLin).toBeGreaterThanOrEqual(0);
    for (let f = firstLin; f <= lastLin; f++) expect(overwriteFrames[f]).toBe(true);

    // And the fallback arrives exactly at the baked AxisPos.
    for (const d of s.drives) expect(d.currentPosition).toBeCloseTo(20, 3);
  });

  it('LIN→PTP seam: solver 360° branch + far baked representation never cause a full-turn detour', () => {
    // The mock solver answers in a DIFFERENT 360° branch (value − 360, same
    // orientation) — like the Cobot solver, whose solutions can sit a full turn
    // away from the baked export values. The following PTP target T2 is baked
    // as +372° (≡ +12°). Without unwrap (RobotIK.cs:478-483 + :556 parity) the
    // axes would spin a full turn during LIN and drive +360° during PTP.
    let calls = 0;
    ikSolverRegistry.register(makeProvider(() => {
      calls++;
      const good = calls <= 2 ? 10 : Math.min(10 + (calls - 2) * 0.2, 12);
      const a = good - 360; // flipped representation, identical orientation
      return [{ angles: [a, a, a, a, a, a], reachable: true }];
    }));

    const s = buildLinScene({ axisPosT2: [372, 372, 372, 372, 372, 372] });
    s.ikPath.startPath();
    let maxFrameDelta = 0;
    let sawLin = false;
    let prev = s.drives.map((d) => d.currentPosition);
    for (let i = 0; i < 600 && !s.ikPath.PathIsFinished; i++) {
      s.tick(0.05);
      const cur = s.drives.map((d) => d.currentPosition);
      for (let a = 0; a < 6; a++) maxFrameDelta = Math.max(maxFrameDelta, Math.abs(cur[a] - prev[a]));
      prev = cur;
      sawLin ||= s.drives.some((d) => d.positionOverwrite);
    }
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(sawLin, 'LIN segment actually ran live').toBe(true);

    // No representation jump ever rendered (a naive apply would show a −360°
    // frame delta during LIN and a +360° travel during the PTP to T2).
    expect(maxFrameDelta).toBeLessThan(5.5);

    // Seam result: the axes end at +12° — the representation continuous with
    // the motion — while still matching the baked +372° orientation exactly.
    for (const d of s.drives) expect(d.currentPosition).toBeCloseTo(12, 2);
  });
});

describe('RVIKPathStep — LogicStep wrapper', () => {
  it('starts the path and finishes when the path finishes', () => {
    const s = buildScene({ targets: [{ axisPos: [70] }] });
    const step = new RVIKPathStep(s.ikPath);
    step.start();
    expect(step.state).toBe(StepState.Active);
    expect(s.ikPath.PathIsActive).toBe(true);
    // Drive the path; the step observes PathIsFinished.
    for (let i = 0; i < 2000 && step.state !== StepState.Finished; i++) {
      s.tick(0.05);
      step.fixedUpdate(0.05);
    }
    expect(step.state).toBe(StepState.Finished);
    expect(s.drives[0].currentPosition).toBeCloseTo(70, 1);
  });

  it('null path finishes immediately (no crash)', () => {
    const step = new RVIKPathStep(null);
    step.start();
    expect(step.state).toBe(StepState.Finished);
  });

  it('reset() returns the path to idle', () => {
    const s = buildScene({ targets: [{ axisPos: [70] }] });
    const step = new RVIKPathStep(s.ikPath);
    step.start();
    step.reset();
    expect(step.state).toBe(StepState.Idle);
    expect(s.ikPath.PathIsActive).toBe(false);
    expect(s.ikPath.NumTarget).toBe(0);
  });
});
