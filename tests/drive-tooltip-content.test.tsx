// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for DriveTooltipContent.findDrive.
 *
 * Guards the "empty drive tooltip" bug: the tooltip's data resolver decides to
 * SHOW a drive tooltip using a by-node / registry (findInParent) lookup, so the
 * content component must resolve the drive the SAME way — otherwise the glass
 * bubble renders with no content. This happens for drives that live in the
 * NodeRegistry but not in viewer.drives (e.g. non-simulated CAD imports like
 * Toray.glb, where 363 drive nodes were registered but viewer.drives was empty).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { findDrive, wrapRotaryAngle } from '../src/core/hmi/tooltip/DriveTooltipContent';
import type { DriveTooltipData } from '../src/core/hmi/tooltip/DriveTooltipContent';

describe('wrapRotaryAngle (tooltip rotary position display)', () => {
  it('wraps accumulated jog angles into [0, 360)', () => {
    // Rotary drives accumulate position unbounded while jogging.
    expect(wrapRotaryAngle(2057.9)).toBeCloseTo(257.9, 5);
    expect(wrapRotaryAngle(4344.4)).toBeCloseTo(24.4, 5);
    expect(wrapRotaryAngle(720)).toBe(0);
    expect(wrapRotaryAngle(360)).toBe(0);
    expect(wrapRotaryAngle(359.9)).toBeCloseTo(359.9, 5);
  });

  it('normalizes negative angles into [0, 360)', () => {
    expect(wrapRotaryAngle(-30)).toBe(330);
    expect(wrapRotaryAngle(-400)).toBe(320);
  });

  it('leaves an in-range angle unchanged', () => {
    expect(wrapRotaryAngle(0)).toBe(0);
    expect(wrapRotaryAngle(180)).toBe(180);
  });
});

function makeViewer(opts: {
  drives?: any[];
  nodeForPath?: Object3D | null;
  findInParent?: any;
}): any {
  return {
    drives: opts.drives ?? [],
    registry: {
      getNode: (_p: string) => opts.nodeForPath ?? null,
      findInParent: () => opts.findInParent ?? null,
    },
  };
}

describe('DriveTooltipContent.findDrive', () => {
  it('resolves a registry-only drive by node when viewer.drives is empty (Toray regression)', () => {
    const node = new Object3D();
    const drive = { name: 'part_000_1', node } as any;
    const viewer = makeViewer({ drives: [], nodeForPath: node, findInParent: drive });
    const data: DriveTooltipData = { type: 'drive', driveName: 'part_000_1', nodePath: '/Scene/part_000_1' };

    // Before the fix this returned null (empty bubble); now it renders the drive.
    expect(findDrive(viewer, data)).toBe(drive);
  });

  it('prefers the exact drive by node identity over a same-named instance', () => {
    const nodeA = new Object3D();
    const nodeB = new Object3D();
    const driveA = { name: 'A1', node: nodeA } as any; // wrong: first by name
    const driveB = { name: 'A1', node: nodeB } as any; // right: the hovered one
    const viewer = makeViewer({ drives: [driveA, driveB], nodeForPath: nodeB });
    const data: DriveTooltipData = { type: 'drive', driveName: 'A1', nodePath: '/Scene/B' };

    expect(findDrive(viewer, data)).toBe(driveB);
  });

  it('falls back to by-name lookup when no nodePath is supplied', () => {
    const node = new Object3D();
    const drive = { name: 'Axis1', node } as any;
    const viewer = makeViewer({ drives: [drive] });
    const data: DriveTooltipData = { type: 'drive', driveName: 'Axis1' };

    expect(findDrive(viewer, data)).toBe(drive);
  });

  it('returns null when the drive cannot be resolved by node or name', () => {
    const viewer = makeViewer({ drives: [], nodeForPath: null });
    const data: DriveTooltipData = { type: 'drive', driveName: 'ghost', nodePath: '/Scene/ghost' };

    expect(findDrive(viewer, data)).toBeNull();
  });
});
