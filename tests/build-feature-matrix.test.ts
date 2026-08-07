// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import type { ModeDescriptor } from '../src/core/rv-mode-manager';
import {
  buildFeatureMatrix,
  groupFeatureMatrix,
  ORIGIN_RANK,
} from '../../realvirtual-WebViewer-Private~/src/plugins/feature-matrix/build-feature-matrix';

const MODES: ModeDescriptor[] = [
  { id: 'hmi', label: 'HMI' },
  { id: 'planner', label: 'Planner' },
];
const enabled = () => false;

function build(
  plugins: RVViewerPlugin[],
  modes = MODES,
  activeMode: string | null = 'hmi',
  disabled: ReadonlySet<string> = new Set(),
) {
  return buildFeatureMatrix(
    plugins,
    modes,
    activeMode,
    new Map([['tagged', 'internal']]),
    (id) => disabled.has(id),
  );
}

describe('buildFeatureMatrix', () => {
  it('marks core plugins as participating in every mode', () => {
    const [row] = build([{ id: 'core-plugin', core: true, modes: [] }]);
    expect(row.modes).toEqual({ hmi: true, planner: true });
  });

  it('treats modes:undefined as shared across all registered modes', () => {
    const [row] = build([{ id: 'shared' }]);
    expect(row.shared).toBe(true);
    expect(row.modes).toEqual({ hmi: true, planner: true });
  });

  it('maps modes:["planner"] to exactly the planner column', () => {
    const [row] = build([{ id: 'planner-only', modes: ['planner'] }]);
    expect(row.modes).toEqual({ hmi: false, planner: true });
  });

  it('derives columns dynamically from the mode registry', () => {
    const customModes = [...MODES, { id: 'commissioning', label: 'Commissioning' }];
    const [row] = build([{ id: 'custom', modes: ['commissioning'] }], customModes);
    expect(row.modes.commissioning).toBe(true);
  });

  it('uses unknown origin and no tier when neither input contains the plugin', () => {
    const [row] = build([{ id: 'untagged' }]);
    expect(row.origin).toBe('unknown');
    expect(row.tier).toBeUndefined();
  });

  it('handles modes:[] and mode ids absent from the registry', () => {
    const rows = build([
      { id: 'none', modes: [] },
      { id: 'absent', modes: ['missing-mode'] },
    ]);
    expect(rows.every((row) => Object.values(row.modes).every((value) => value === false))).toBe(true);
  });

  it('returns no rows for an empty plugin list', () => {
    expect(buildFeatureMatrix([], MODES, 'hmi', () => 'unknown', enabled)).toEqual([]);
  });

  it('keeps plugin rows with an empty modes record when the registry is empty', () => {
    const [row] = build([{ id: 'still-visible' }], []);
    expect(row.id).toBe('still-visible');
    expect(row.modes).toEqual({});
  });

  it('marks a disabled core plugin as activeNow=false', () => {
    const [row] = build([{ id: 'disabled-core', core: true }], MODES, 'hmi', new Set(['disabled-core']));
    expect(row.activeNow).toBe(false);
  });
});

describe('groupFeatureMatrix', () => {
  const rows = buildFeatureMatrix(
    [
      { id: 'z-project' },
      { id: 'a-project' },
      { id: 'internal' },
      { id: 'commercial' },
      { id: 'core' },
      { id: 'unknown' },
    ],
    MODES,
    'hmi',
    new Map([
      ['z-project', 'project'],
      ['a-project', 'project'],
      ['internal', 'internal'],
      ['commercial', 'commercial'],
      ['core', 'core'],
    ]),
    (id) => id === 'commercial',
  );

  it('orders origins by rank and rows alphabetically', () => {
    const groups = groupFeatureMatrix(rows);
    expect(Object.entries(ORIGIN_RANK).sort((a, b) => a[1] - b[1]).map(([origin]) => origin)).toEqual([
      'project', 'internal', 'commercial', 'core', 'unknown',
    ]);
    expect(groups.map((group) => group.origin)).toEqual(['project', 'internal', 'commercial', 'core', 'unknown']);
    expect(groups[0].rows.map((row) => row.id)).toEqual(['a-project', 'z-project']);
  });

  it('filters before grouping, removes empty groups and counts visible rows', () => {
    const groups = groupFeatureMatrix(rows, { origin: 'project', activeOnly: true });
    expect(groups).toHaveLength(1);
    expect(groups[0].origin).toBe('project');
    expect(groups[0].rows).toHaveLength(2);

    const activeGroups = groupFeatureMatrix(rows, { origin: 'commercial', activeOnly: true });
    expect(activeGroups).toEqual([]);
  });

  it('is stable for already sorted input', () => {
    const once = groupFeatureMatrix(rows);
    const twice = groupFeatureMatrix(once.flatMap((group) => group.rows));
    expect(twice).toEqual(once);
  });
});
