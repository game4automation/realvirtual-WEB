// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import { robotRunHarness } from './helpers/robot-run-harness';
import { McpRobotTools } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { applyAnglesToDrives, currentDriveAngles } from '../src/core/engine/rv-ik-authoring';
import { ikSolverRegistry } from '../src/core/engine/rv-ik-solver';
import { chainFk } from '../src/core/engine/rv-robot-fk';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

let h: Awaited<ReturnType<typeof robotRunHarness>>;
const solver = new WasmIKSolver();
beforeAll(async () => { await solver.load(); });
afterEach(() => { setActiveEditTarget(null); h?.dispose(); });
async function setup() {
  h = await robotRunHarness(); ikSolverRegistry.register(solver); ikSolverRegistry.resetLiveSolveClaims();
  new McpRobotTools(() => h.viewer);
  applyAnglesToDrives(h.path.robot!, h.path.targets[0].AxisPos);
}
async function move(args: Record<string, unknown>) {
  const answer = JSON.parse(await new McpCommandTools(() => h.viewer).webExecute('ik.robot.moveTcp', JSON.stringify(args)));
  return answer.value ?? { error: answer.error, ...answer.details };
}
function world() {
  const fk = chainFk(h.path.robot!.getJointChain()!, currentDriveAngles(h.path.robot!)).tcp;
  return new Matrix4().compose(new Vector3(...fk.pos), new Quaternion(...fk.quat), new Vector3(1, 1, 1)).premultiply(h.path.robot!.node.matrixWorld);
}
describe('moveTcp with the real CRX solver', () => {
  it('applies absolute/world/tool poses and verifies FK below 0.5mm/deg', async () => {
    await setup();
    const start = world(), p = new Vector3(), q = new Quaternion(); start.decompose(p, q, new Vector3());
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    const absolute = await move({ positionJson: JSON.stringify(p.toArray()), rotationJson: JSON.stringify([e.x, e.y, e.z].map(x => x * 180 / Math.PI)) });
    expect(absolute.applied).toBe(true);
    for (const frame of ['world', 'tool']) {
      const before = world(), bp = new Vector3(), bq = new Quaternion(); before.decompose(bp, bq, new Vector3());
      const offset = new Vector3(0, 0, 0.005); if (frame === 'tool') offset.applyQuaternion(bq);
      const r = await move({ deltaJson: JSON.stringify({ position: [0, 0, 0.005], rotation: [0, 0, 0.1] }), frame });
      expect(r.applied).toBe(true); expect(r.verify.positionErrorMm).toBeLessThan(0.5); expect(r.verify.orientationErrorDeg).toBeLessThan(0.5);
      const actual = new Vector3(), aq = new Quaternion(); world().decompose(actual, aq, new Vector3());
      expect(actual.distanceTo(bp.add(offset))).toBeLessThan(0.0005);
      const dq = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.1 * Math.PI / 180);
      const expectedQ = frame === 'tool' ? bq.multiply(dq) : bq.premultiply(dq);
      expect(aq.angleTo(expectedQ) * 180 / Math.PI).toBeLessThan(0.5);
    }
  });
  it('refuses the asset-editor route without changing drives', async () => {
    await setup(); const before = currentDriveAngles(h.path.robot!);
    setActiveEditTarget({ available: true, persistsTo: 'asset' } as EditTarget);
    expect((await move({ deltaJson: '{"position":[0,0,0.01]}' })).error).toMatch(/asset editor/i);
    expect(currentDriveAngles(h.path.robot!)).toEqual(before);
  });
  it('refuses unreachable, running paths, invalid forms and missing solver without moving', async () => {
    await setup(); const before = currentDriveAngles(h.path.robot!);
    expect((await move({ positionJson: '[100,100,100]' })).applied).toBe(false);
    expect(currentDriveAngles(h.path.robot!)).toEqual(before);
    expect((await move({ positionJson: '[0,0,0]', deltaJson: '{}' })).applied).toBe(false);
    h.path.PathIsActive = true;
    expect((await move({ deltaJson: '{"position":[0,0,0.01]}' })).kind).toBe('path-running');
    h.path.cancel(); ikSolverRegistry.register(null);
    const r = await move({ deltaJson: '{"position":[0,0,0.01]}' });
    expect(r.applied).toBe(false); expect(r.tier).toBe('none'); expect(r.refusal).toMatch(/solver/i);
    expect(currentDriveAngles(h.path.robot!)).toEqual(before);
  });
});
