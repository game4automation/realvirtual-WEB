// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-mcp-surface.node.test.ts — plan-773 Phase 0, in its post-opening form.
 *
 * ## What happened to the baseline test the plan asked for
 *
 * §8 T0 described a test that pins the CLOSED state: no `web_robot_*` tools,
 * `RobotIK` / `IKPath` / `IKTarget` not authorable, `RobotIK.WristType`
 * readonly — and it said in the same breath that Phases 1 and 2 would rewrite
 * it, "so the opening is a visible change and not a side effect". Phases 1 and
 * 2 arrive together with this file, so writing the closed state first and
 * deleting it in the same commit would have recorded nothing. What is pinned
 * here instead is the half that must NOT move, plus the shape of the opening:
 *
 * - the `web_robot_*` tools exist and the reading ones are read-only (six after
 *   Phases 1 and 2, thirteen with the path half of Phase 3, fourteen with the
 *   program export of Phase 5);
 * - `RobotIK`, `IKPath` and `IKTarget` are still **not** `authorable`, and
 *   `WristType` / `ElbowInUnityX` are still schema-readonly (decision E6);
 * - the family is announced through the ONE delegate list, so it cannot be
 *   reachable in tests and absent in `discover` (the plan-713 drift class).
 *
 * The second point is the one that would otherwise rot: `authorable: true` on
 * the three components is the shortcut someone will reach for, and it brings
 * back "Add Component ▸ RobotIK" producing an empty shell — the half-rigged
 * robot the five `robot-ik-*` Problems entries exist to complain about. A rig
 * is a transaction; the way in is `web_robot_rig_from_library`.
 */

import { describe, expect, it } from 'vitest';
import { allSchemas, delegateCensus } from './helpers/mcp-schemas';
import { getTypesWithCapability, getFieldDescriptor } from '../src/core/engine/rv-component-registry';
import { resolveToolClass } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { IK_PROBLEM_CODES } from '../src/core/hmi/problems-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureIkCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { MOVED_TOOLS } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';

ensureIkCommandsRegistered();
const READ_COMMANDS = ['ik.robot.list', 'ik.robot.chain', 'ik.robot.state', 'ik.robot.verifyFk', 'ik.robot.rigDiagnose', 'ik.path.inspect'];

/** The family, as plan-773 Phases 1 to 3 define it. */
const READ_TOOLS = [
  // Phase 5: the export. READ-ONLY and that is not a technicality — it re-solves
  // every waypoint to build the program but writes nothing back (no drive move,
  // no extras, no document op), which is what lets it run on a model nobody
  // wants changed. It is the family's only bound read tool (`ik.program.export`,
  // shared with the IKPath inspector's Export button).
  'web_robot_program_export',
] as const;
const WRITE_TOOLS = [
  'web_robot_rig_from_library',
  // Phase 3 — authoring a robot program: the path, its waypoints, their order
  // and the solve that moves the robot onto one.
  'web_robot_path_create',
  'web_robot_target_add',
  'web_robot_target_set',
  'web_robot_target_remove',
  'web_robot_target_reorder',
  'web_robot_solve_target',
] as const;

describe('plan-773 — the web_robot_* family is announced', () => {
  const schemas = allSchemas();
  const byName = new Map(schemas.map((s) => [s.name, s]));

  it('keeps all fourteen former tools as tombstones backed by commands', () => {
    for (const id of READ_COMMANDS) {
      expect(commandRegistry.get(id)?.readOnly, id).toBe(true);
      const moved = MOVED_TOOLS.find((m) => m.movedTo.includes(id))!;
      expect(moved.door).toBe('web_query');
      expect(byName.has(moved.tool)).toBe(false);
    }
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(byName.has(name), `${name} is retired`).toBe(false);
      expect(MOVED_TOOLS.find((m) => m.tool === name)).toBeDefined();
    }
  });

  it('comes from its own delegate in the shared instance list', () => {
    const census = delegateCensus();
    expect(census['McpRobotTools']).toBe(0);
  });

  it('marks every reading tool read-only and the rigging tool not', () => {
    for (const name of READ_TOOLS) {
      expect(commandRegistry.get(MOVED_TOOLS.find((m) => m.tool === name)!.movedTo[0])!.readOnly, `${name} must be readOnly`).toBe(true);
    }
    for (const name of WRITE_TOOLS) {
      // plan-2007 Phase 6: the rigging/authoring tools are commands now; their command writes.
      expect(commandRegistry.get(MOVED_TOOLS.find((m) => m.tool === name)!.movedTo[0])!.readOnly, `${name} writes a component`).toBe(false);
    }
  });

  it('resolves to the tool classes the call policy needs', () => {
    for (const name of READ_TOOLS) {
      expect(resolveToolClass({ name, readOnly: true })).toBe('read');
    }
    // A rig and a waypoint are model edits — the class the chat policy runs
    // without asking. None of them is `destructive`: each names what it touches.
    for (const name of WRITE_TOOLS) {
      expect(resolveToolClass({ name, readOnly: false }), name).toBe('edit');
    }
  });


  it('takes the index-bearing tools\' arguments in the order a caller types them', () => {
    // `fromIndex` / `toIndex` are REQUIRED and the path is not: a model with one
    // IK path is the normal case, and the two indices are what the call is about.
    const reorder = { required: commandRegistry.get('ik.target.reorder')!.mcp!.params.filter((p) => p.required).map((p) => p.name) };
    expect(reorder.required ?? []).toEqual(expect.arrayContaining(['fromIndex', 'toIndex']));
    expect(reorder.required ?? []).not.toContain('pathPath');
    // A target is always named explicitly — there is no "the only waypoint".
    for (const name of ['web_robot_target_set', 'web_robot_solve_target']) {
      expect(commandRegistry.get(MOVED_TOOLS.find((m) => m.tool === name)!.movedTo[0])!.mcp!.params.filter((p) => p.required).map((p) => p.name), name).toContain('targetPath');
    }
    // plan-2214: a delete names the waypoint either by {targetPath} or by the raw
    // reference {pathPath, index} (the inspector's delete of a broken reference) —
    // both explicit; the command refuses a call that gives neither or both.
    const remove = commandRegistry.get(MOVED_TOOLS.find((m) => m.tool === 'web_robot_target_remove')!.movedTo[0])!.mcp!.params.map((p) => p.name);
    expect(remove).toEqual(expect.arrayContaining(['targetPath', 'pathPath', 'index']));
  });

  it('takes the robot by PATH, never by bare name only', () => {
    // Unity's `ik_*` tools fall back to `FindFirstObjectByType` when the name
    // misses, which silently answers about a different robot. The web pendants
    // take a path and say which robot they answered about; a model with two
    // robots and no path is a refusal, not a guess (asserted end-to-end in
    // robot-mcp-tools.test.ts).
    for (const id of ['ik.robot.chain', 'ik.robot.state', 'ik.robot.verifyFk']) {
      expect(Object.keys(commandRegistry.get(id)!.argsSchema ?? {})).toContain('path');
    }
    // Rigging, by contrast, REQUIRES the path: there is no robot to find yet.
    expect(commandRegistry.get('ik.robot.rig')!.mcp!.params.filter((p) => p.required).map((p) => p.name)).toContain('path');
    expect(commandRegistry.get('ik.robot.rigDiagnose')!.argsSchema).toEqual({ path: 'string' });
  });

});

describe('plan-773 E6 — the three robotics components stay un-authorable', () => {
  it('keeps RobotIK, IKPath and IKTarget out of the authorable list', () => {
    const authorable = new Set(getTypesWithCapability('authorable'));
    for (const type of ['RobotIK', 'IKPath', 'IKTarget']) {
      expect(
        authorable.has(type),
        `${type} must NOT be authorable: web_editor_add_component would create a half-rigged robot. `
        + 'Rigging goes through web_robot_rig_from_library.',
      ).toBe(false);
    }
  });

  it('keeps WristType and ElbowInUnityX display-readonly in the schema', () => {
    // They are readonly so nobody hand-types them in the inspector, and
    // `updateOverlayField` refuses them for that reason. `web_robot_rig_from_library`
    // sets them because it MEASURED them — which is why it writes through the
    // edit target directly rather than through that guard.
    for (const field of ['WristType', 'ElbowInUnityX']) {
      expect(getFieldDescriptor('RobotIK', field)?.readonly, `${field} must stay readonly`).toBe(true);
    }
  });

  it('still has no OPW parameter in the RobotIK schema', () => {
    // `a1..c4` and `ToolOffset` live in the RAW extras only (`getOpwParams()`
    // reads them from `userData.realvirtual.RobotIK`). The rig tool writes them
    // there; nothing turns them into typed, hand-editable fields.
    for (const field of ['a1', 'a2', 'b', 'c1', 'c2', 'c3', 'c4', 'ToolOffset']) {
      expect(getFieldDescriptor('RobotIK', field), `${field} must not be a schema field`).toBeUndefined();
    }
  });
});

describe('plan-773 — the family reuses the robotics problem codes (plan-772)', () => {
  it('invents no new code for a state that already has one', () => {
    // The six codes plan-772 wired up ARE the vocabulary; a tool that answered
    // with a seventh spelling for "no chain" would make the panel and the agent
    // describe the same defect differently.
    expect(Object.values(IK_PROBLEM_CODES)).toEqual([
      'robot-ik-axes-unresolved',
      'robot-ik-chain-unresolved',
      'robot-ik-tcp-unresolved',
      'robot-ik-opw-unusable',
      'robot-ik-wrist-type-missing',
      'robot-ik-target-no-angles',
    ]);
  });
});
