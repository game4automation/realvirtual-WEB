// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { executeDelegateValue } from './helpers/execute-value';
import { queryValue } from './helpers/query-value';

/**
 * robot-mcp-tools.test.ts — plan-773 Phases 1 and 2, end to end, on the BAKED
 * tree of the robot the library actually ships.
 *
 * ## Why this fixture and why baked
 *
 * `public/library/Robots/FanucCRX-10iA-L.glb` is committed and public, so this
 * suite runs in every checkout — unlike a test against `DemoRobotIK.glb`, which
 * is absent from the public repository and would be green by absence in exactly
 * the environment where it has to bite (plan-773 R3).
 *
 * It loads through {@link loadBakedGLB}, which passes a `BakeRegistry`, refuses
 * the authoring flags and proves from the RESULT that the destructive bake ran.
 * Without it this would assert against a tree production never shows: that is
 * how the robot's TCP node could be removed by the bake for weeks with the whole
 * IK suite green (plan-772 B2), and a rigging tool that found a TCP the viewer
 * does not have would be the same defect wearing a new hat.
 *
 * ## What it proves
 *
 * 1. The shipped robot really is riggable in ONE call: `web_robot_rig_from_library`
 *    turns a GLB with nine Drives and no `RobotIK` into a rig whose chain and TCP
 *    resolve, read back off the LIVE scene rather than echoed.
 * 2. It gets `WristType` right by measurement. The schema default is
 *    `'Spherical'`; this robot is a cobot, and a cobot solved with a spherical
 *    model is the silent wrong answer `robot-ik-wrist-type-missing` warns about.
 * 3. The OPW answer carries its provenance and says `seed-only` with the 150 mm
 *    it cannot represent — decision E5's whole point.
 * 4. The four read tools answer, and `web_robot_verify_fk` agrees with the scene.
 * 5. No `robot-ik-*` Problems entry is left behind.
 *
 * ## The fixture since 2026-10-25
 *
 * The library robot now SHIPS rigged (RobotIK + a demo IKPath, Thomas lifted
 * plan-773 E5 for it). This suite is about rigging and authoring a robot that
 * has none of that, so it loads the same file with the shipped definition
 * stripped again (`tests/helpers/unrigged-library-crx.ts`) — same geometry,
 * same drives, no RobotIK / IKPath / IKTarget.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { fetchUnriggedLibraryCrx } from './helpers/unrigged-library-crx';
import { type LoadResult } from '../src/core/engine/rv-scene-loader';
import { McpRobotTools } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import { getProblems, resetProblemsForTests, IK_PROBLEM_CODES } from '../src/core/hmi/problems-store';

/** The committed, public library robot — served by the vitest browser server from `public/`. */
const GLB_URL = '/library/Robots/FanucCRX-10iA-L.glb';
const ROBOT_ROOT = 'FanucCRX-10iA-L';

let baked: LoadResult | null = null;
let tools: McpRobotTools;
let scene: Scene;

/**
 * A viewer shaped exactly as `McpRobotTools` uses one.
 *
 * `loadBakedGLB` returns the registry, signal store and transport manager the
 * load built, which is everything the tools and `constructComponentOnNode`
 * need — and nothing more is stubbed, so a tool that started reaching for some
 * other part of the viewer fails here instead of being quietly accommodated.
 */
function viewerFor(result: LoadResult, sceneRef: Scene): RVViewer {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  return {
    registry: result.registry,
    signalStore: result.signalStore,
    transportManager: result.transportManager,
    scene: sceneRef,
    markRenderDirty(): void { /* nothing renders in this suite */ },
    markShadowsDirty(): void { /* idem */ },
    emit(event: string, payload: unknown): void {
      for (const l of listeners.get(event) ?? []) l(payload);
    },
    on(event: string, cb: (p: unknown) => void): void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(cb);
    },
    off(event: string, cb: (p: unknown) => void): void { listeners.get(event)?.delete(cb); },
  } as unknown as RVViewer;
}

beforeAll(async () => {
  resetProblemsForTests();
  const bytes = await fetchUnriggedLibraryCrx();
  scene = new Scene();
  // THE production load: destructive bake, no authoring flag (plan-772 F2).
  baked = await loadBakedGLB(GLB_URL, scene, { data: bytes });
  tools = new McpRobotTools(() => viewerFor(baked!, scene));
}, 120_000);

afterAll(() => { resetProblemsForTests(); });

/** Parse a tool answer, failing loudly on the `{error}` shape. */
function ok(json: string): Record<string, unknown> {
  const v = JSON.parse(json) as Record<string, unknown>;
  expect(v['error'], `tool answered with an error: ${String(v['error'])}`).toBeUndefined();
  return v;
}

describe('the library robot, its shipped rig stripped, arrives UNRIGGED (plan-773 §C / E5)', () => {
  it('carries no RobotIK at all, so web_robot_list is empty', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.list', {}));
    expect(r['count']).toBe(0);
    expect(r['robots']).toEqual([]);
    // Reading works without a solver — the tier is REPORTED, not a refusal (F7).
    expect(typeof r['tier']).toBe('string');
  });

  it('survives the bake with its six axes AND its TCP addressable', () => {
    // The TCP node carries no component of its own; it survives as the ANCESTOR
    // of the gripper's drives. If that ever stops being true, rigging this robot
    // stops being possible and this is where it shows.
    const registry = baked!.registry;
    for (const p of ['A1', 'A1/A2', 'A1/A2/A3', 'A1/A2/A3/A4', 'A1/A2/A3/A4/A5', 'A1/A2/A3/A4/A5/A6']) {
      expect(registry.getNode(`${ROBOT_ROOT}/${p}`), `${p} must survive the bake`).toBeTruthy();
    }
    expect(registry.getNode(`${ROBOT_ROOT}/A1/A2/A3/A4/A5/A6/TCP`)).toBeTruthy();
  });
});

describe('web_robot_rig_diagnose reads a rig that does not exist yet (F6)', () => {
  let d: Record<string, unknown>;

  beforeAll(async () => { d = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.rigDiagnose', { path: ROBOT_ROOT })); });

  it('finds the six rotary axes and skips the three gripper drives', () => {
    expect(d['alreadyRigged']).toBe(false);
    expect(d['chainDerivable']).toBe(true);
    const der = d['derivation'] as Record<string, unknown>;
    expect(der['failure']).toBeNull();
    const axes = der['axes'] as Array<{ name: string; kind: string }>;
    expect(axes.map((a) => a.name)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(axes.every((a) => a.kind === 'rotary')).toBe(true);
    // The three the derivation must NOT count as axes.
    expect(der['otherDrives']).toEqual(
      expect.arrayContaining(['SchunkEGH80Gripper', 'LeftFinger', 'RightFinger']),
    );
  });

  it('names the TCP and how it was identified', () => {
    const tcp = (d['derivation'] as Record<string, unknown>)['tcp'] as Record<string, unknown>;
    expect(tcp['name']).toBe('TCP');
    expect(tcp['identifiedBy']).toBe('named-tcp');
  });

  it('MEASURES the non-spherical wrist instead of taking the Spherical default', () => {
    const w = d['wristMeasurement'] as Record<string, unknown>;
    expect(w['verdict']).toBe('NonSpherical');
    // 150 mm is this robot's authored A6 offset — see robot-rig-derive.node.test.ts.
    expect(w['offsetMm'] as number).toBeCloseTo(150, 0);
    expect(String(w['evidence'])).toContain('150');
  });

  it('reports the OPW parameters as a SEED with the offset they cannot carry (E5)', () => {
    const opw = d['opw'] as Record<string, unknown>;
    expect(opw['confidence']).toBe('seed-only');
    expect(opw['unrepresentableOffsetMm'] as number).toBeCloseTo(150, 0);
    // Measured, not guessed: the arm lengths are this robot's authored geometry
    // (A2 0.245 up, A3 0.71 along the arm, A4+A5 0.15+0.39 forearm).
    const params = opw['params'] as Record<string, number>;
    expect(params['c1']).toBeCloseTo(0.245, 3);
    expect(params['c2']).toBeCloseTo(0.71, 3);
    expect(params['c3']).toBeCloseTo(0.54, 3);
    const sources = opw['sources'] as Record<string, string>;
    expect(sources['c1']).toBe('measured');
    expect(sources['c2']).toBe('measured');
    // …and the one value that is NOT measured says so.
    expect(sources['ElbowInUnityX']).toBe('inferred');
  });

  it('changes nothing — it is read-only', () => {
    expect(baked!.registry.getAll<RVRobotIK>('RobotIK').length).toBe(0);
  });

  it('tells a free-tier user that this robot needs Pro, in a sentence (R7)', () => {
    expect(String(d['tierVerdict'])).toMatch(/replay|solve/i);
  });
});

describe('web_robot_rig_from_library rigs the robot in ONE call (F5)', () => {
  let r: Record<string, unknown>;

  beforeAll(async () => { r = ok(await executeDelegateValue(tools, 'ik.robot.rig', { path: ROBOT_ROOT })); });

  it('reports ok only after reading the rig back off the live scene', () => {
    expect(r['ok']).toBe(true);
    expect(r['verified']).toBe(true);
    const back = r['liveReadback'] as Record<string, unknown>;
    expect(back['componentPresent']).toBe(true);
    expect(back['axesResolved']).toBe(6);
    expect(back['chainDerived']).toBe(true);
    expect(back['tcpResolved']).toBe(true);
    expect(back['opwUsable']).toBe(true);
  });

  it('wires all seven things a rig consists of', () => {
    const rig = r['rig'] as Record<string, unknown>;
    expect((rig['axes'] as unknown[]).length).toBe(6);
    expect((rig['tcp'] as Record<string, unknown>)['name']).toBe('TCP');
    expect(rig['wristType']).toBe('NonSpherical');
    expect(rig['wristOverridden']).toBe(false);
    // The tool offset is the TCP's own 60 mm along the flange axis.
    const t = rig['toolOffset'] as number[];
    expect(Math.hypot(t[0], t[1], t[2])).toBeCloseTo(0.06, 3);
  });

  it('leaves the live component in a state the chain derivation accepts', () => {
    const robots = baked!.registry.getAll<RVRobotIK>('RobotIK');
    expect(robots.length).toBe(1);
    const robot = robots[0].instance;
    expect(robot.WristType).toBe('NonSpherical');
    expect(robot.getAxisDrives().length).toBe(6);
    expect(robot.getTcpNode()?.name).toBe('TCP');
    expect(robot.getJointChain()).not.toBeNull();
    expect(robot.getOpwParams()).not.toBeNull();
  });

  it('raises no robot-ik-* problem — a rig this tool builds must not warn', () => {
    const codes = new Set<string>(Object.values(IK_PROBLEM_CODES));
    const left = getProblems().filter((p) => codes.has(p.code));
    expect(left.map((p) => `${p.code}: ${p.detail}`)).toEqual([]);
  });

  it('carries the disclaimer and the next step instead of implying certainty', () => {
    expect(String(r['disclaimer'])).toContain('ik.robot.verifyFk');
    expect(String(r['nextStep'])).toContain('web_query("ik.robot.verifyFk", {path})');
    // An unsaved rig is lost on a scene change — the answer has to say so.
    expect(String(r['nextStep'])).toMatch(/save/i);
  });

  it('refuses a wristType that is not one of the two', async () => {
    const bad = JSON.parse(await executeDelegateValue(tools, 'ik.robot.rig', { path: ROBOT_ROOT, wristType: 'Round' })) as Record<string, unknown>;
    expect(String(bad['error'])).toContain('wristType');
  });

  it('refuses a node that is not a robot, and says what it found', async () => {
    const bad = JSON.parse(await executeDelegateValue(tools, 'ik.robot.rig', { path: `${ROBOT_ROOT}/A1/A2/A3/A4/A5/A6` })) as Record<string, unknown>;
    expect(String(bad['error'])).toContain('rotary drive');
    expect(bad['code']).toBe(IK_PROBLEM_CODES.chainUnresolved);
  });
});

describe('the four read tools answer about the rigged robot (F1-F4)', () => {
  it('web_robot_list finds it with its chain, TCP and tier verdict', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.list', {}));
    expect(r['count']).toBe(1);
    const robot = (r['robots'] as Array<Record<string, unknown>>)[0];
    expect(robot['name']).toBe(ROBOT_ROOT);
    expect(robot['axisCount']).toBe(6);
    expect(robot['wristType']).toBe('NonSpherical');
    expect(robot['chainDerived']).toBe(true);
    expect(robot['tcpResolved']).toBe(true);
    expect(robot['opwUsable']).toBe(true);
    expect(robot['problems']).toEqual([]);
    // The frame is REPORTED, never implied — there are two of them.
    expect(['chain', 'unity']).toContain(robot['solveFrame']);
  });

  it('web_robot_get_chain prints the six axes with their segment lengths', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.chain', { path: ROBOT_ROOT }));
    const axes = r['axes'] as Array<Record<string, unknown>>;
    expect(axes.map((a) => a['name'])).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
    expect(axes.map((a) => a['direction'])).toEqual([
      'RotationY', 'RotationZ', 'RotationZ', 'RotationX', 'RotationZ', 'RotationX',
    ]);
    // A2 sits 245 mm above A1, A3 710 mm above A2 — the authored geometry.
    expect(axes[1]['segmentMm'] as number).toBeCloseTo(245, 0);
    expect(axes[2]['segmentMm'] as number).toBeCloseTo(710, 0);
    const tcp = r['tcp'] as Record<string, unknown>;
    expect(tcp['name']).toBe('TCP');
    expect(r['opwParams']).not.toBeNull();
  });

  it('web_robot_get_state reads the joint angles and the TCP from both sides', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.state', { path: ROBOT_ROOT }));
    expect((r['jointAnglesDeg'] as number[]).length).toBe(6);
    expect(r['chainDerived']).toBe(true);
    // The chain's FK and the TCP node's real pose are the same point: that
    // agreement IS the tool-length check, and it is the number plan-772 measured
    // 239.90 mm of error in before the bake claim and the frames were fixed.
    expect(r['tcpAgreementMm'] as number).toBeLessThan(1);
  });

  it('web_robot_verify_fk agrees with the scene at the current pose', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.verifyFk', { path: ROBOT_ROOT }));
    expect(r['anglesSource']).toBe('current-drive-positions');
    expect(r['frame']).toBe('chain');
    const ref = r['reference'] as Record<string, unknown>;
    expect(ref['kind']).toBe('TCP node');
    expect(r['positionErrorMm'] as number).toBeLessThan(1);
    expect(r['orientationErrorDeg'] as number).toBeLessThan(0.1);
    // The tool length it measured is the TCP's 60 mm, not 0 (a collapsed TCP)
    // and not 120 mm (the doubling the removed scale division produced).
    expect(r['toolLengthM'] as number).toBeCloseTo(0.06, 3);
  });

  it('web_robot_verify_fk takes an explicit joint vector and moves nothing', async () => {
    const before = (ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.state', { path: ROBOT_ROOT }))['jointAnglesDeg'] as number[]).slice();
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.verifyFk', { path: ROBOT_ROOT, targetPath: undefined, anglesJson: '[30,-20,10,0,45,0]' }));
    expect(r['anglesSource']).toBe('anglesJson');
    expect(r['anglesDeg']).toEqual([30, -20, 10, 0, 45, 0]);
    // A pose far from the current one must NOT agree with the scene — otherwise
    // the comparison is not comparing anything.
    expect(r['positionErrorMm'] as number).toBeGreaterThan(1);
    expect((ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.state', { path: ROBOT_ROOT }))['jointAnglesDeg'] as number[])).toEqual(before);
  });

  it('refuses a malformed joint vector instead of solving zeros', async () => {
    for (const bad of ['[1,2,3]', 'not json', '[1,2,3,4,5,"x"]']) {
      const r = JSON.parse(await queryValue(viewerFor(baked!, scene), 'ik.robot.verifyFk', { path: ROBOT_ROOT, targetPath: undefined, anglesJson: bad })) as Record<string, unknown>;
      expect(String(r['error']), bad).toContain('anglesJson');
    }
  });

  it('names the FULL path it answered about, and refuses an unknown robot', async () => {
    // The robot's registry path is prefixed by the document root, so a caller
    // handing in the bare node NAME gets an answer that states the full path it
    // actually resolved — resolving by name is a convenience, and the answer has
    // to say which robot the convenience landed on.
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.chain', { path: ROBOT_ROOT }));
    expect(String(r['path']).endsWith(`/${ROBOT_ROOT}`) || r['path'] === ROBOT_ROOT).toBe(true);
    expect(r['name']).toBe(ROBOT_ROOT);
    const bad = JSON.parse(await queryValue(viewerFor(baked!, scene), 'ik.robot.chain', { path: 'NoSuchRobot' })) as Record<string, unknown>;
    expect(String(bad['error'])).toContain('NoSuchRobot');
    expect(String(bad['error'])).toContain(ROBOT_ROOT);
  });

  it('reports that this robot has no IK path yet rather than inventing one', async () => {
    const r = ok(await queryValue(viewerFor(baked!, scene), 'ik.robot.state', { path: ROBOT_ROOT }));
    expect(r['ikPaths']).toEqual([]);
    const fk = JSON.parse(await queryValue(viewerFor(baked!, scene), 'ik.robot.verifyFk', { path: ROBOT_ROOT, targetPath: 'SomeTarget' })) as Record<string, unknown>;
    expect(String(fk['error'])).toContain('no IK path with targets');
  });
});

describe('an explicit override is taken, and the measurement is still reported', () => {
  it('accepts wristType=Spherical but keeps saying what it measured', async () => {
    const r = ok(await executeDelegateValue(tools, 'ik.robot.rig', { path: ROBOT_ROOT, wristType: 'Spherical' }));
    const rig = r['rig'] as Record<string, unknown>;
    expect(rig['wristType']).toBe('Spherical');
    expect(rig['wristOverridden']).toBe(true);
    const w = r['wristMeasurement'] as Record<string, unknown>;
    // The override does NOT erase the measurement: the answer carries both, so
    // a reader can see the robot disagrees with the caller.
    expect(w['verdict']).toBe('NonSpherical');
    expect(String(w['evidence'])).toContain('Caller override');
    expect(String(w['evidence'])).toContain('150');
  });
});
