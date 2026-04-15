// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestAxesPlugin Tests — minimal mocks, same pattern as transport-stats-plugin.
 */
import { describe, it, expect } from 'vitest';
import { TestAxesPlugin } from '../src/plugins/demo/test-axes-plugin';

// ── Helpers ──

function makeDrive(name: string) {
  return { name, currentPosition: 0, positionOverwrite: false, config: { direction: 'RotationY' } };
}

function makeRobotDrives() {
  return ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map(makeDrive);
}

function makeViewer(drives: ReturnType<typeof makeDrive>[]) {
  return {
    drives,
    playback: { isPlaying: true, activeOnly: 'Always' },
  } as any;
}

// ── Tests ──

describe('TestAxesPlugin', () => {
  it('registers button-group slot', () => {
    const plugin = new TestAxesPlugin();
    expect(plugin.id).toBe('test-axes');
    expect(plugin.slots[0].slot).toBe('button-group');
    expect(plugin.slots[0].order).toBe(60);
  });

  it('finds A1-A6 on model load', () => {
    const plugin = new TestAxesPlugin();
    const drives = makeRobotDrives();
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);
    expect(plugin.axes).toHaveLength(6);
  });

  it('open: deactivates recorder and locks drives', () => {
    const plugin = new TestAxesPlugin();
    const drives = makeRobotDrives();
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);

    plugin.open();
    expect(plugin.isOpen).toBe(true);
    expect(viewer.playback.activeOnly).toBe('Never');
    expect(drives.every(d => d.positionOverwrite)).toBe(true);
  });

  it('close: restores recorder and positions', () => {
    const plugin = new TestAxesPlugin();
    const drives = makeRobotDrives();
    drives.forEach((d, i) => { d.currentPosition = (i + 1) * 10; });
    const saved = drives.map(d => d.currentPosition);
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);

    plugin.open();
    plugin.setAxisPosition(0, 45);
    expect(drives[0].currentPosition).toBe(45);

    plugin.close();
    expect(plugin.isOpen).toBe(false);
    expect(viewer.playback.activeOnly).toBe('Always');
    drives.forEach((d, i) => {
      expect(d.currentPosition).toBe(saved[i]);
      expect(d.positionOverwrite).toBe(false);
    });
  });

  it('setAxisPosition moves individual axis', () => {
    const plugin = new TestAxesPlugin();
    const drives = makeRobotDrives();
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);

    plugin.open();
    plugin.setAxisPosition(2, -30);
    expect(drives[2].currentPosition).toBe(-30);
  });

  it('does nothing when no axes found', () => {
    const plugin = new TestAxesPlugin();
    const drives = [makeDrive('Linear1')];
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);

    plugin.open();
    expect(plugin.isOpen).toBe(false);
  });

  it('onModelCleared restores state', () => {
    const plugin = new TestAxesPlugin();
    const drives = makeRobotDrives();
    const viewer = makeViewer(drives);
    plugin.onModelLoaded({ drives } as any, viewer);

    plugin.open();
    plugin.onModelCleared!();
    expect(plugin.isOpen).toBe(false);
    expect(viewer.playback.activeOnly).toBe('Always');
  });
});
