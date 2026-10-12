// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D } from 'three';
// Production capability registrations (side effects): Drive, Sensor, TransportSurface.
import '../src/core/engine/rv-drive';
import '../src/core/engine/rv-sensor';
import '../src/core/engine/rv-transport-surface';
import {



  computeAncestors,


  flattenTree,
  flattenVisibleTree,
  matchesFilter,
  migrateLegacyFilter,
  parseFilterId,
  sortSignalNodes,

  splitTypes,
  isSignalType,
  isBoolSignal,
  isLogicStepType,
  shortStepType,
  badgeLabel,
  badgeColor,
  signalBadgeColor,
  formatSignalValue,
  formatContainerProgress,
  snapLabel,
  signalOwnerLabel,
  type TreeNode,
} from '../src/core/hmi/hierarchy-utils';
import { SIGNAL_VALUE_COLOR, SIGNAL_VALUE_NEUTRAL } from '../src/core/hmi/signal-colors';
import { StepState } from '../src/core/engine/rv-logic-step';
import { STEP_STATE_COLORS } from '../src/core/hmi/rv-logic-step-colors';
import type { EditableNodeInfo } from '../src/core/hmi/rv-extras-editor';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';
import type { SignalStore } from '../src/core/engine/rv-signal-store';
import type { StepStateInfo } from '../src/core/engine/rv-logic-engine';

function info(path: string, types: string[] = []): EditableNodeInfo {
  return { path, types } as EditableNodeInfo;
}

describe('snapLabel (plan-200 A2)', () => {
  it('maps the sign letter to flow and keeps axis + typeId', () => {
    expect(snapLabel('Snap-ZN-convroll')).toBe('Snap in (Z) · convroll');
    expect(snapLabel('Snap-ZP-convroll')).toBe('Snap out (Z) · convroll');
    expect(snapLabel('Snap-XB-flange-1')).toBe('Snap bidi (X) · flange-1');
  });

  it('returns null for a non-snap node name', () => {
    expect(snapLabel('Transport-Z')).toBeNull();
    expect(snapLabel('')).toBeNull();
  });
});

// ── signalOwnerLabel ───────────────────────────────────────────────────────

describe('signalOwnerLabel (plan-200 §9.2 / B1)', () => {
  it('builds the dot-symbol Owner.Leaf from a scoped signal node path', () => {
    expect(signalOwnerLabel('RollConveyor-1m/Signals/Flow.Occupied')).toBe('RollConveyor-1m.Flow.Occupied');
    expect(signalOwnerLabel('Turntable_2/Signals/Flow.Run')).toBe('Turntable_2.Flow.Run');
  });

  it('falls back to the bare leaf for a non-Signals path', () => {
    expect(signalOwnerLabel('Robot/Arm/Joint1')).toBe('Joint1');
    expect(signalOwnerLabel('Standalone')).toBe('Standalone');
  });
});

// ── flattenTree ────────────────────────────────────────────────────────────

describe('flattenTree', () => {
  it('returns empty array for empty tree', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('preserves DFS order with correct depths', () => {
    const t: TreeNode[] = [
      {
        name: 'A', path: 'A', types: [], hasOverrides: false,
        children: [
          { name: 'A1', path: 'A/A1', types: [], hasOverrides: false, children: [
            { name: 'A1a', path: 'A/A1/A1a', types: [], hasOverrides: false, children: [] },
          ] },
          { name: 'A2', path: 'A/A2', types: [], hasOverrides: false, children: [] },
        ],
      },
      { name: 'B', path: 'B', types: [], hasOverrides: false, children: [] },
    ];
    const flat = flattenTree(t);
    expect(flat.map(x => x.node.name)).toEqual(['A', 'A1', 'A1a', 'A2', 'B']);
    expect(flat.map(x => x.depth)).toEqual([0, 1, 2, 1, 0]);
  });
});

describe('flattenVisibleTree', () => {
  const tree: TreeNode[] = [
    {
      name: 'A', path: 'A', types: [], hasOverrides: false,
      children: [
        {
          name: 'A1', path: 'A/A1', types: [], hasOverrides: false,
          children: [
            { name: 'A1a', path: 'A/A1/A1a', types: [], hasOverrides: false, children: [] },
          ],
        },
        { name: 'A2', path: 'A/A2', types: [], hasOverrides: false, children: [] },
      ],
    },
    { name: 'B', path: 'B', types: [], hasOverrides: false, children: [] },
  ];

  it('returns only rows whose ancestors are all expanded', () => {
    expect(flattenVisibleTree(tree, new Set(['A'])).map((row) => row.node.name))
      .toEqual(['A', 'A1', 'A2', 'B']);
  });

  it('reports depth relative to the visible root', () => {
    expect(flattenVisibleTree(tree, new Set(['A', 'A/A1'])).map((row) => row.depth))
      .toEqual([0, 1, 2, 1, 0]);
  });

  it('renders path-less group rows and derives unique rowKeys for duplicate names', () => {
    const groups: TreeNode[] = [
      { name: 'Group', path: null, types: [], hasOverrides: false, children: [] },
      { name: 'Group', path: null, types: [], hasOverrides: false, children: [] },
    ];
    const rows = flattenVisibleTree(groups, new Set());
    expect(rows.map((row) => row.node.name)).toEqual(['Group', 'Group']);
    expect(new Set(rows.map((row) => row.rowKey)).size).toBe(2);
  });

  it('computes posInSet/setSize per sibling group', () => {
    const rows = flattenVisibleTree(tree, new Set(['A']));
    expect(rows.map(({ node, posInSet, setSize }) => [node.name, posInSet, setSize]))
      .toEqual([
        ['A', 1, 2],
        ['A1', 1, 2],
        ['A2', 2, 2],
        ['B', 2, 2],
      ]);
  });

  it('honours an explicit expandKey and hasChildren (plan-754 scene rows)', () => {
    // The scene hierarchy keys expansion on `Object3D.uuid` and reports
    // `hasChildren` explicitly, because a collapsed row's children array is
    // empty by design — the walk never entered it.
    const scene: TreeNode[] = [
      {
        name: 'Robot', path: 'Robot', types: [], hasOverrides: false,
        children: [{ name: 'A1', path: 'Robot/A1', types: ['Drive'], hasOverrides: false, children: [] }],
        expandKey: 'uuid-robot', hasChildren: true,
      },
    ];
    expect(flattenVisibleTree(scene, new Set(['Robot'])).map((r) => r.node.name)).toEqual(['Robot']);
    expect(flattenVisibleTree(scene, new Set(['uuid-robot'])).map((r) => r.node.name)).toEqual(['Robot', 'A1']);
  });
});

// ── Category filter id (plan-597 §9.3) ─────────────────────────────────────

describe('migrateLegacyFilter', () => {
  it('migrates the pre-597 ids to their category', () => {
    expect(migrateLegacyFilter('drives')).toBe('cat:drives');
    expect(migrateLegacyFilter('sensors')).toBe('cat:sensors');
    expect(migrateLegacyFilter('signals')).toBe('cat:signals');
    expect(migrateLegacyFilter('logic')).toBe('cat:logic');
  });

  it('turns null, garbage and unknown categories into all', () => {
    expect(migrateLegacyFilter(null)).toBe('all');
    expect(migrateLegacyFilter('')).toBe('all');
    expect(migrateLegacyFilter('garbage')).toBe('all');
    expect(migrateLegacyFilter('cat:')).toBe('all');
    expect(migrateLegacyFilter('cat:custom')).toBe('all');
  });

  it('keeps a valid category and category/label id', () => {
    expect(migrateLegacyFilter('all')).toBe('all');
    expect(migrateLegacyFilter('cat:transport')).toBe('cat:transport');
    expect(migrateLegacyFilter('cat:transport/Conveyors')).toBe('cat:transport/Conveyors');
  });
});

describe('parseFilterId', () => {
  it('splits category and a label with spaces', () => {
    expect(parseFilterId('cat:transport/Web handling')).toEqual({ category: 'transport', label: 'Web handling' });
  });
  it('keeps a slash inside the label', () => {
    expect(parseFilterId('cat:other/A/B')).toEqual({ category: 'other', label: 'A/B' });
  });
  it('answers null/null for all and a category without label', () => {
    expect(parseFilterId('all')).toEqual({ category: null, label: null });
    expect(parseFilterId('cat:drives')).toEqual({ category: 'drives', label: null });
  });
});

describe('matchesFilter', () => {
  it('"all" matches everything', () => {
    expect(matchesFilter([], 'all')).toBe(true);
    expect(matchesFilter(['Anything'], 'all')).toBe(true);
  });

  it('matches by category and by label', () => {
    expect(matchesFilter(['TransportSurface'], 'cat:transport')).toBe(true);
    expect(matchesFilter(['TransportSurface'], 'cat:transport/Conveyors')).toBe(true);
    expect(matchesFilter(['TransportSurface'], 'cat:transport/Chains')).toBe(false);
  });

  it('does not match an unregistered _Special variant', () => {
    expect(matchesFilter(['Sensor_Special'], 'cat:sensors')).toBe(false);
  });

  it('matches when ANY type of the node is in the category', () => {
    expect(matchesFilter(['Drive', 'Sensor'], 'cat:sensors')).toBe(true);
    expect(matchesFilter(['Drive_Linear'], 'cat:drives')).toBe(true);
    expect(matchesFilter(['PLCInputBool'], 'cat:signals/PLCInputBool')).toBe(true);
    expect(matchesFilter(['LogicStep_Delay'], 'cat:logic')).toBe(true);
    expect(matchesFilter(['LogicSteppy'], 'cat:logic')).toBe(false);
  });

  it('an empty types array matches no category', () => {
    expect(matchesFilter([], 'cat:drives')).toBe(false);
  });
});

// ── sortSignalNodes ────────────────────────────────────────────────────────

describe('sortSignalNodes', () => {
  it('"name" sorts alphabetically (case-insensitive) by leaf name', () => {
    const nodes = [
      info('R/zebra', ['PLCInputBool']),
      info('R/Alpha', ['PLCOutputBool']),
      info('R/middle', ['PLCInputBool']),
    ];
    const sorted = sortSignalNodes(nodes, 'name');
    expect(sorted.map(n => n.path.split('/').pop())).toEqual(['Alpha', 'middle', 'zebra']);
  });

  it('"type" groups outputs before inputs, then alphabetical', () => {
    const nodes = [
      info('R/inA', ['PLCInputBool']),
      info('R/outZ', ['PLCOutputFloat']),
      info('R/inZ', ['PLCInputBool']),
      info('R/outA', ['PLCOutputFloat']),
    ];
    const sorted = sortSignalNodes(nodes, 'type');
    const names = sorted.map(n => n.path.split('/').pop());
    // Outputs first (sorted), then inputs (sorted)
    expect(names).toEqual(['outA', 'outZ', 'inA', 'inZ']);
  });

  it('does not mutate the input array', () => {
    const nodes = [info('Z'), info('A'), info('M')];
    const before = nodes.map(n => n.path);
    sortSignalNodes(nodes, 'name');
    expect(nodes.map(n => n.path)).toEqual(before);
  });

  it('handles empty array', () => {
    expect(sortSignalNodes([], 'name')).toEqual([]);
    expect(sortSignalNodes([], 'type')).toEqual([]);
  });
});
// ── computeAncestors ───────────────────────────────────────────────────────

describe('computeAncestors', () => {
  it('returns prefixes for A/B/C/D', () => {
    expect(computeAncestors('A/B/C/D')).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('returns empty for top-level path', () => {
    expect(computeAncestors('Root')).toEqual([]);
  });

  it('returns single ancestor for two-segment path', () => {
    expect(computeAncestors('A/B')).toEqual(['A']);
  });
});

// ── splitTypes ─────────────────────────────────────────────────────────────

describe('splitTypes', () => {
  it('separates signals from non-signals', () => {
    const [nonSignals, signals] = splitTypes(['Drive', 'PLCInputBool', 'Sensor', 'PLCOutputFloat']);
    expect(nonSignals).toEqual(['Drive', 'Sensor']);
    expect(signals).toEqual(['PLCInputBool', 'PLCOutputFloat']);
  });

  it('handles empty array', () => {
    const [n, s] = splitTypes([]);
    expect(n).toEqual([]);
    expect(s).toEqual([]);
  });

  it('handles only-signals input', () => {
    const [n, s] = splitTypes(['PLCInputBool', 'PLCOutputBool']);
    expect(n).toEqual([]);
    expect(s).toEqual(['PLCInputBool', 'PLCOutputBool']);
  });

  it('drops ambient metadata types, including numbered duplicates', () => {
    const [n, s] = splitTypes(['Kinematic', 'NodeKnowledge', 'MechanismBody', 'MechanismBody_2', 'PLCInputBool']);
    expect(n).toEqual(['Kinematic']);
    expect(s).toEqual(['PLCInputBool']);
  });
});

// ── signal type predicates ────────────────────────────────────────────────

describe('signal predicates', () => {
  it('isSignalType', () => {
    expect(isSignalType('PLCInputBool')).toBe(true);
    expect(isSignalType('PLCOutputFloat')).toBe(true);
    expect(isSignalType('Drive')).toBe(false);
    expect(isSignalType('Sensor')).toBe(false);
  });

  it('isBoolSignal', () => {
    expect(isBoolSignal('PLCInputBool')).toBe(true);
    expect(isBoolSignal('PLCOutputBool')).toBe(true);
    expect(isBoolSignal('PLCInputFloat')).toBe(false);
  });

  it('isLogicStepType', () => {
    expect(isLogicStepType('LogicStep_Delay')).toBe(true);
    expect(isLogicStepType('LogicStep_SerialContainer')).toBe(true);
    expect(isLogicStepType('Drive')).toBe(false);
    expect(isLogicStepType('LogicSteppy')).toBe(false);
  });
});

// ── shortStepType ──────────────────────────────────────────────────────────

describe('shortStepType', () => {
  it('shortens known container types', () => {
    expect(shortStepType('LogicStep_SerialContainer')).toBe('Serial');
    expect(shortStepType('LogicStep_ParallelContainer')).toBe('Parallel');
  });

  it('shortens known leaf types', () => {
    expect(shortStepType('LogicStep_SetSignalBool')).toBe('SetBool');
    expect(shortStepType('LogicStep_WaitForSignalBool')).toBe('WaitBool');
    expect(shortStepType('LogicStep_WaitForSensor')).toBe('WaitSens');
    expect(shortStepType('LogicStep_DriveTo')).toBe('DriveTo');
    expect(shortStepType('LogicStep_DriveToPosition')).toBe('DriveTo');
    expect(shortStepType('LogicStep_SetDriveSpeed')).toBe('SetSpd');
    expect(shortStepType('LogicStep_Enable')).toBe('Enable');
    expect(shortStepType('LogicStep_Delay')).toBe('Delay');
    expect(shortStepType('LogicStep_Pause')).toBe('Pause');
  });

  it('falls back to stripped raw type for unknown LogicStep', () => {
    expect(shortStepType('LogicStep_CustomNew')).toBe('CustomNew');
  });
});

// ── badgeLabel ─────────────────────────────────────────────────────────────

describe('badgeLabel', () => {
  it('formats PLC signal types compactly', () => {
    expect(badgeLabel('PLCInputBool')).toBe('InBool');
    expect(badgeLabel('PLCOutputBool')).toBe('OutBool');
    expect(badgeLabel('PLCInputFloat')).toBe('InFloat');
    expect(badgeLabel('PLCOutputInt')).toBe('OutInt');
  });

  it('handles unknown PLC suffixes via prefix', () => {
    expect(badgeLabel('PLCInputCustom')).toBe('In:Custom');
    expect(badgeLabel('PLCOutputWeird')).toBe('Out:Weird');
  });

  it('handles Drive_* subtypes', () => {
    expect(badgeLabel('Drive_Linear')).toBe('D:Linear');
  });

  it('shortens long drive behaviors and the mechanism root', () => {
    expect(badgeLabel('Drive_ErraticPosition')).toBe('D:Erratic');
    expect(badgeLabel('Drive_DestinationMotor')).toBe('D:DestMotor');
    expect(badgeLabel('Drive_FollowPosition')).toBe('D:Follow');
    expect(badgeLabel('KinematicMechanism')).toBe('Mechanism');
  });

  it('shows step state suffix for Active/Waiting', () => {
    // STEP_STATE_LABELS uses short labels: RUN / WAIT (max 4 chars)
    expect(badgeLabel('LogicStep_Delay', StepState.Active)).toContain('Delay');
    expect(badgeLabel('LogicStep_Delay', StepState.Active)).toContain('RUN');
    expect(badgeLabel('LogicStep_Delay', StepState.Waiting)).toContain('WAIT');
  });

  it('does not append state suffix for Idle/Finished', () => {
    expect(badgeLabel('LogicStep_Delay', StepState.Idle)).toBe('Delay');
    expect(badgeLabel('LogicStep_Delay', StepState.Finished)).toBe('Delay');
  });

  it('handles named special components', () => {
    expect(badgeLabel('RuntimeMetadata')).toBe('Metadata');
    expect(badgeLabel('ConnectSignal')).toBe('Conn');
    expect(badgeLabel('TransportSurface')).toBe('TS');
    expect(badgeLabel('DrivesRecorder')).toBe('Rec');
    expect(badgeLabel('ReplayRecording')).toBe('Replay');
  });
});

// ── badgeColor ─────────────────────────────────────────────────────────────

describe('badgeColor', () => {
  it('uses step state color for Active LogicStep', () => {
    expect(badgeColor('LogicStep_Delay', StepState.Active)).toBe(STEP_STATE_COLORS[StepState.Active]);
    expect(badgeColor('LogicStep_Delay', StepState.Waiting)).toBe(STEP_STATE_COLORS[StepState.Waiting]);
  });

  it('uses componentColor for non-Active/Waiting LogicStep', () => {
    // Color comes from componentColor() — we only verify it does NOT equal the active-state color
    const idleColor = badgeColor('LogicStep_Delay', StepState.Idle);
    expect(idleColor).not.toBe(STEP_STATE_COLORS[StepState.Active]);
    expect(idleColor).not.toBe(STEP_STATE_COLORS[StepState.Waiting]);
  });

  it('uses componentColor for non-LogicStep types regardless of stepState', () => {
    const a = badgeColor('Drive', StepState.Active);
    const b = badgeColor('Drive');
    expect(a).toBe(b);
  });
});

// ── formatSignalValue ──────────────────────────────────────────────────────

describe('formatSignalValue', () => {
  function mockStore(values: Record<string, boolean | number | undefined>): SignalStore {
    // Includes get() for the value resolver's path→name fallback.
    return {
      getByPath: (p: string) => values[p],
      get: (n: string) => values[n],
    } as unknown as SignalStore;
  }

  it('returns em-dash when no store or no path', () => {
    expect(formatSignalValue('PLCInputBool', null, 'X')).toBe('—');
    expect(formatSignalValue('PLCInputBool', mockStore({}), null)).toBe('—');
  });

  it('returns em-dash when value undefined', () => {
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': undefined }), 'X')).toBe('—');
  });

  it('renders bool as filled/hollow circle glyph', () => {
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': true }), 'X')).toBe('●');
    expect(formatSignalValue('PLCInputBool', mockStore({ 'X': false }), 'X')).toBe('○');
  });

  it('truncates Int numeric values', () => {
    expect(formatSignalValue('PLCInputInt', mockStore({ 'X': 3.7 }), 'X')).toBe('3');
    expect(formatSignalValue('PLCInputInt', mockStore({ 'X': -2.9 }), 'X')).toBe('-2');
  });

  it('formats Float numeric values to one decimal', () => {
    expect(formatSignalValue('PLCInputFloat', mockStore({ 'X': 1.234 }), 'X')).toBe('1.2');
    expect(formatSignalValue('PLCInputFloat', mockStore({ 'X': 0 }), 'X')).toBe('0.0');
  });
});

// ── signalBadgeColor ───────────────────────────────────────────────────────

describe('signalBadgeColor', () => {
  function mockStore(values: Record<string, boolean | number | undefined>): SignalStore {
    return { getByPath: (p: string) => values[p] } as unknown as SignalStore;
  }

  // plan-341 Phase 0: hue carries the direction, intensity the state. A TRUE
  // bool is the `strong` step of its direction, a FALSE bool the `weak` step
  // of the SAME direction (it used to collapse to one grey for both), and a
  // missing reading is the neutral step (it used to show the direction hue at
  // full strength, claiming a state nobody had measured).

  it('strong step of the direction for a true bool', () => {
    expect(signalBadgeColor('PLCOutputBool', mockStore({ 'X': true }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.strong);
    expect(signalBadgeColor('PLCInputBool', mockStore({ 'X': true }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.input.strong);
  });

  it('weak step of the SAME direction for a false bool', () => {
    expect(signalBadgeColor('PLCOutputBool', mockStore({ 'X': false }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.output.weak);
    expect(signalBadgeColor('PLCInputBool', mockStore({ 'X': false }), 'X'))
      .toBe(SIGNAL_VALUE_COLOR.input.weak);
  });

  it('neutral step when there is no reading at all', () => {
    const c1 = signalBadgeColor('PLCInputBool', mockStore({}), 'X');
    const c2 = signalBadgeColor('PLCInputBool', null, 'X');
    expect(c1).toBe(c2);
    expect(c1).toBe(SIGNAL_VALUE_NEUTRAL);
  });
});

// ── formatContainerProgress ────────────────────────────────────────────────

describe('formatContainerProgress', () => {
  it('formats Delay progress when Active with elapsed+duration', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'd',
      type: 'Delay',
      progress: 50,
      elapsed: 1.234,
      duration: 3,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBe('1.2s/3.0s');
  });

  it('returns null for non-Delay types', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'c',
      type: 'SerialContainer',
      progress: 50,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });

  it('returns null when Delay but not Active', () => {
    const info: StepStateInfo = {
      state: StepState.Idle,
      name: 'd',
      type: 'Delay',
      progress: 0,
      elapsed: 1,
      duration: 3,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });

  it('returns null when elapsed or duration missing', () => {
    const info: StepStateInfo = {
      state: StepState.Active,
      name: 'd',
      type: 'Delay',
      progress: 50,
    } as StepStateInfo;
    expect(formatContainerProgress(info)).toBeNull();
  });
});
