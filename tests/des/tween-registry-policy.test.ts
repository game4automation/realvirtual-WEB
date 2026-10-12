// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { TweenRegistry, type DriveTweenTarget } from '../../src/core/material-flow/tween-registry';

function target(): DriveTweenTarget & { values: number[] } {
  return { values: [], setPosition(value) { this.values.push(value); } };
}

describe('TweenRegistry onRender reports writes (on-demand render loop)', () => {
  // The DES runner marks the frame dirty from this return value. Without it a
  // DES animation (AGVs, MUs) froze on screen until the user touched the view.
  it('returns true while a tween writes, false once nothing is left', () => {
    const registry = new TweenRegistry(4);
    const drive = target();
    registry.addDrive(drive, 0, 100, 0, 10);
    expect(registry.onRender(5, 'animated', false)).toBe(true);
    expect(registry.onRender(10, 'animated', false)).toBe(true); // final write
    expect(registry.onRender(11, 'animated', false)).toBe(false);
  });

  it('returns false for a running tween FastForward does not write', () => {
    const registry = new TweenRegistry(4);
    registry.addDrive(target(), 0, 100, 0, 10);
    expect(registry.onRender(5, 'fastforward', true)).toBe(false);
  });
});

describe('TweenRegistry writePolicy + ease + settle reasons', () => {
  it('finalOnly suppresses intermediate writes in FF drain slices and writes at the end', () => {
    const registry = new TweenRegistry(4);
    const drive = target();
    registry.addDrive(drive, 0, 100, 0, 10, { writePolicy: 'finalOnly' });
    registry.onRender(5, 'hybrid', true);
    expect(drive.values).toEqual([]);
    registry.onRender(10, 'hybrid', true);
    expect(drive.values).toEqual([100]);
    expect(registry.activeCount).toBe(0);
  });

  it('event settle suppresses running finalOnly records while FF is active', () => {
    const registry = new TweenRegistry(4);
    const drive = target();
    registry.addDrive(drive, 0, 100, 0, 10, { writePolicy: 'finalOnly' });
    registry.settle(5, 'event', true);
    expect(drive.values).toEqual([]);
    expect(registry.activeCount).toBe(1);
  });

  it('ffExit settle writes the defined final pose and reaps finalOnly records', () => {
    const registry = new TweenRegistry(4);
    const drive = target();
    registry.addDrive(drive, 10, 90, 0, 10, { writePolicy: 'finalOnly' });
    registry.settle(2, 'ffExit', true);
    expect(drive.values).toEqual([90]);
    expect(registry.activeCount).toBe(0);
  });

  it('default always/linear behavior is byte-identical to explicit legacy options', () => {
    const implicit = new TweenRegistry(4);
    const explicit = new TweenRegistry(4);
    const a = target();
    const b = target();
    implicit.addDrive(a, -10, 30, 1, 4);
    explicit.addDrive(b, -10, 30, 1, 4, { writePolicy: 'always', ease: 'linear' });
    for (const t of [0, 1, 2, 4, 5]) {
      implicit.onRender(t, 'animated');
      explicit.onRender(t, 'animated');
    }
    expect(a.values).toEqual(b.values);
  });

  it('scurve uses smoothstep endpoints while linear remains unchanged', () => {
    const registry = new TweenRegistry(4);
    const linear = target();
    const scurve = target();
    registry.addDrive(linear, 0, 1, 0, 1, { ease: 'linear' });
    registry.addDrive(scurve, 0, 1, 0, 1, { ease: 'scurve' });
    registry.onRender(0, 'animated');
    registry.onRender(0.01, 'animated');
    expect(linear.values[0]).toBe(0);
    expect(scurve.values[0]).toBe(0);
    expect(scurve.values[1]).toBeLessThan(linear.values[1]);
    registry.onRender(1, 'animated');
    expect(linear.values.at(-1)).toBe(1);
    expect(scurve.values.at(-1)).toBe(1);
  });
});
