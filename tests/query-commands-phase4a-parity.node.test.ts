// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { createMechanismCommandDescriptors, ensureMechanismCommandsRegistered, MECHANISM_UNAVAILABLE } from '../src/core/hmi/mechanism-command-descriptors';
import { ensureIkCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { MOVED_TOOLS } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { setMechanismUiBridge, type MechanismUiBridge } from '../src/core/engine/rv-kinematic-registry';
import { ERR_EDITOR_UNAVAILABLE, ERR_NOT_EDITOR } from '../src/core/editor/rv-editor-guard-core';
import { ikSolverRegistry } from '../src/core/engine/rv-ik-solver';

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({ getBackend: () => null, getProject: () => null }),
}));

const CASES: Array<[string, string[]]> = [
  ['mechanism.inspect', ["path","include"]],
  ['mechanism.forces', ["mechanismPath","channelId","series"]],
  ['mechanism.pathInspect', ["path"]],
  ['mechanism.snapList', ["x","y","maxCandidates"]],
  ['mechanism.trajectoryExport', ["path"]],
  ['mechanism.trajectoryInspect', ["path","maxPoints"]],
  ['mechanism.validate', ["path"]],
  ['ik.robot.list', []],
  ['ik.robot.chain', ["path"]],
  ['ik.robot.state', ["path"]],
  ['ik.robot.verifyFk', ["path","targetPath","anglesJson"]],
  ['ik.robot.rigDiagnose', ["path"]],
  ['ik.path.inspect', ["pathPath"]],
  ['editor.listKinematics', []],
  ['editor.materialPresets', []],
  ['editor.materialStats', []],
  ['editor.projectFiles', ["dir","glob"]],
  ['editor.projectInfo', []],
];
const viewer = { modes: { activeMode: 'hmi' } } as unknown as RVViewer;
const tools = new McpCommandTools(() => viewer);
const query = async (id: string, args = {}) => JSON.parse(await tools.webQuery(id, JSON.stringify(args)));

beforeAll(() => {
  ensureQueryCommandsRegistered();
  ensureIkCommandsRegistered();
  ensureMechanismCommandsRegistered();
});
afterEach(() => { setMechanismUiBridge(null); commandRegistry.attachViewer(undefined); });

describe('plan-2007 Phase 4A query parity', { timeout: 30_000 }, () => {
  it.each(CASES)('%s registers the old argument names, read class and one query tombstone', (id, keys) => {
    const d = commandRegistry.get(id)!;
    expect(d, id).toBeDefined();
    expect(d.readOnly).toBe(true);
    expect(d.macro).toBeUndefined();
    expect(d.undoLabel).toBeUndefined();
    expect(commandClassOf(d)).toBe('read');
    expect(Object.keys(d.argsSchema ?? {})).toEqual(keys);
    const moved = MOVED_TOOLS.filter((m) => m.movedTo.includes(id));
    expect(moved).toHaveLength(1);
    expect(moved[0].door).toBe('web_query');
    expect(moved[0].example).toContain(`web_query("${id}",`);
  });

  it.each(CASES)('%s runs through web_query and retains the old no-model refusal value', async (id) => {
    setMechanismUiBridge(null);
    const result = await query(id);
    // The node config resolves the private mechanism impls to the public stub, so a mechanism
    // query answers `unavailable` here even when the private repo is checked out.
    if (id.startsWith('mechanism.') && (!__RV_HAS_PRIVATE__ || result.kind === 'unavailable')) {
      expect(result).toMatchObject({ ok: false, error: ERR_EDITOR_UNAVAILABLE, kind: 'unavailable' });
      return;
    }
    const tier = {
      tier: ikSolverRegistry.tier, maxLiveSolvingRobots: ikSolverRegistry.maxRobots,
      canSolveCobot: ikSolverRegistry.canSolveCobot,
    };
    let expected: unknown;
    if (id === 'mechanism.snapList' || (id.startsWith('editor.') && id !== 'editor.projectFiles')) {
      expected = { error: ERR_NOT_EDITOR };
    } else if (id.startsWith('mechanism.')) {
      expected = { error: MECHANISM_UNAVAILABLE };
    } else if (id === 'editor.projectFiles') {
      expected = {
        projectOpen: false, projectName: null, projectKind: null, writable: false,
        files: [], count: 0, hint: 'No project is open — open one with web_project_open.',
      };
    } else if (id === 'ik.robot.list' || id === 'ik.robot.rigDiagnose') {
      expected = { error: 'No model is loaded.' };
    } else if (id === 'ik.path.inspect') {
      expected = { error: 'No IKPath in the loaded model. ik.path.create makes one under a rigged robot; '
        + 'web_query("ik.robot.list", {}) shows which robots are there.', ...tier };
    } else {
      expected = { error: 'No RobotIK in the loaded model. web_query("ik.robot.list", {}) shows what is there; '
        + 'ik.robot.rig builds a rig from a library robot.', ...tier };
    }
    // The command completed and returned the old error VALUE. The MCP envelope
    // classifies that value as failed, without promoting it to a thrown error.
    expect(result.ok).toBe(id === 'editor.projectFiles');
    expect(result.error).toBeUndefined();
    expect(result.recorded).toBe(false);
    expect(result.value).toEqual(expected);
  }, 30_000);

  it.skipIf(!__RV_HAS_PRIVATE__)('keeps empty mechanism listings and missing trajectory errors as values', async () => {
    setMechanismUiBridge({
      list: () => [], validate: () => [], forcesSnapshot: () => null,
    } as unknown as MechanismUiBridge);
    const first = await query('mechanism.inspect');
    if (first.kind === 'unavailable') return; // stubbed private impls (see above)
    expect(first.value).toEqual({ ok: true, mechanisms: [] });
    expect((await query('mechanism.validate')).value).toEqual({ ok: true, mechanisms: [] });
    expect((await query('mechanism.pathInspect')).value).toEqual({ ok: true, paths: [] });
    expect((await query('mechanism.trajectoryInspect')).value).toEqual({ ok: true, trajectories: [] });
    expect((await query('mechanism.trajectoryInspect', { path: 'missing' })).value)
      .toEqual({ error: 'No MechanismTrajectory at "missing"', availableTrajectories: [] });
    expect((await query('mechanism.trajectoryExport', { path: 'missing' })).value)
      .toEqual({ error: 'This build has no drive-sizing trajectories' });
    expect((await query('mechanism.forces')).value).toEqual({ error: 'mechanismPath is required' });
  });

  it('keeps the community descriptors unavailable without loading private code', async () => {
    const load = vi.fn(async () => ({ impls: {} }));
    const registry = new CommandRegistry();
    for (const d of createMechanismCommandDescriptors({ available: false, load })) registry.register(d);
    for (const [id] of CASES.filter(([id]) => id.startsWith('mechanism.'))) {
      expect(await registry.execute(id, {}, { viewer, origin: 'mcp' }))
        .toMatchObject({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
    }
    expect(load).not.toHaveBeenCalled();
  });
});
