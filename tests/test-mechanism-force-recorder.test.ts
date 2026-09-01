// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Force recorder — sampling, the sizing figures, and the lifecycle rules
 * (plan-412 §2.3.2 / §2.6, test 9.5).
 *
 * ── What is actually at stake here ──────────────────────────────────────────
 * Peak and RMS are the numbers an engineer orders a motor against. A naive mean
 * of squares agrees with the time-weighted one whenever sampling is uniform,
 * which is precisely why an error there survives every well-behaved test and
 * only shows up on the run with a dropped frame or a mid-run validity gap. So
 * the central case here is deliberately NON-uniform, with a sign change, and
 * the expected value is arithmetic written out in the comment rather than a
 * number copied from the implementation.
 *
 * Runs unconditionally: no wasm, no viewer, no DOM — the recorder is fed
 * hand-built snapshots through the same `supply` callback the plugin uses.
 */

import { describe, it, expect } from 'vitest';
import { MechanismForceRecorder } from '../src/plugins/mechanism-force-recorder-plugin';
import type {
  MechanismForceChannelView,
  MechanismForcesSnapshot,
} from '../src/core/engine/rv-kinematic-registry';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function channel(
  id: string, value: number, unit: 'N' | 'N·m' = 'N·m',
  kind: MechanismForceChannelView['kind'] = 'drive',
): MechanismForceChannelView {
  return { id, label: id, kind, unit, value, linkPath: null };
}

function snapshot(
  mechanismPath: string,
  channels: MechanismForceChannelView[],
  dynamicsValid = true,
): MechanismForcesSnapshot {
  return {
    mechanismPath,
    status: dynamicsValid ? 0 : 3,
    statusText: dynamicsValid ? 'ok' : 'waiting for enough motion samples',
    dynamicsValid,
    redundant: false,
    channels,
    joints: [],
  };
}

/**
 * A recorder whose divider is far finer than the steps fed to it, so every
 * `sample()` call takes exactly one sample and the test controls Δt directly.
 */
function directRecorder(): MechanismForceRecorder {
  return new MechanismForceRecorder(100, 1000);
}

/** Feed one step with one drive channel on one mechanism. */
function feed(rec: MechanismForceRecorder, dt: number, value: number, valid = true): void {
  rec.sample(dt, () => [snapshot('Mech', [channel('Mech|dof0', value)], valid)]);
}

// ─── Sampling ───────────────────────────────────────────────────────────────

describe('sampling', () => {
  it('takes samples on the divider and stamps them with SIMULATION time', () => {
    const rec = new MechanismForceRecorder(3000, 10);
    rec.start();
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) feed(rec, dt, 1);

    // One second at 10 Hz. A sample lands on the first tick that CROSSES the
    // interval, so each stamp is up to one fixed step late and the count is 9
    // or 10 — pinning a fencepost here would pin a rounding artefact. What must
    // hold is that the stamps are simulation time and that the divider does not
    // drift: the remainder is carried, so the spacing stays 0.1 ± one step
    // instead of accumulating an error over a long run.
    const times = rec.timeBuffer.toArray();
    expect(times.length).toBeGreaterThanOrEqual(9);
    expect(times.length).toBeLessThanOrEqual(10);
    expect(times[0]).toBeGreaterThanOrEqual(0.1);
    expect(times[0]).toBeLessThan(0.1 + dt);
    for (let i = 1; i < times.length; i++) {
      expect(Math.abs(times[i] - times[i - 1] - 0.1)).toBeLessThanOrEqual(dt + 1e-9);
    }
    // No drift: the last stamp is still within one step of its nominal slot.
    expect(Math.abs(times[times.length - 1] - times.length / 10))
      .toBeLessThanOrEqual(dt + 1e-9);
    expect(rec.elapsed).toBeCloseTo(1, 6);
  });

  it('does not sample before start() and keeps the buffer after stop()', () => {
    const rec = directRecorder();
    feed(rec, 0.5, 7);
    expect(rec.timeBuffer.count).toBe(0);

    rec.start();
    feed(rec, 0.5, 7);
    rec.stop();
    feed(rec, 0.5, 9);

    // The last cycle stays on screen — that is what recording it was for.
    expect(rec.timeBuffer.count).toBe(1);
    expect(rec.getSeries('Mech|dof0')?.values.toArray()).toEqual([7]);
  });

  it('the ring buffer keeps the newest samples once it is full', () => {
    const rec = new MechanismForceRecorder(3, 1000);
    rec.start();
    for (const v of [1, 2, 3, 4, 5]) feed(rec, 0.5, v);
    expect(rec.getSeries('Mech|dof0')?.values.toArray()).toEqual([3, 4, 5]);
    expect(rec.timeBuffer.count).toBe(3);
  });
});

// ─── Sizing figures (§2.3.2) ────────────────────────────────────────────────

describe('peak and time-weighted RMS', () => {
  it('matches the hand-computed value for uneven Δt with a sign change', () => {
    const rec = directRecorder();
    rec.start();
    // t:   0.5   1.0   2.0   4.0
    // τ:   +2    −4    +3    −1
    feed(rec, 0.5, 2);
    feed(rec, 0.5, -4);
    feed(rec, 1.0, 3);
    feed(rec, 2.0, -1);

    const m = rec.metrics('Mech|dof0');
    expect(m.sampleCount).toBe(4);
    // Peak is on the magnitude, so the negative swing counts.
    expect(m.peak).toBe(4);
    // Σ τ²·Δt = 16·0.5 + 9·1.0 + 1·2.0 = 19 ; Σ Δt = 0.5 + 1.0 + 2.0 = 3.5
    // rms = sqrt(19 / 3.5) = 2.329929...
    expect(m.rms).toBeCloseTo(Math.sqrt(19 / 3.5), 10);
    // The naive mean of squares would be sqrt((4+16+9+1)/4) = 2.7386 — a 17 %
    // over-estimate here, and the whole reason the weighting exists.
    expect(m.rms).not.toBeCloseTo(Math.sqrt(30 / 4), 3);
  });

  it('reports the magnitude as the RMS when there is only one sample', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 0.5, -6);
    const m = rec.metrics('Mech|dof0');
    // Zero would read as "this axis is unloaded", which is the opposite of true.
    expect(m.rms).toBe(6);
    expect(m.peak).toBe(6);
  });

  it('treats an invalid snapshot as a gap, not as zero', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 1.0, 10);
    feed(rec, 1.0, 0, false); // dynamics not valid — no number to publish
    feed(rec, 1.0, 10);

    const m = rec.metrics('Mech|dof0');
    expect(m.sampleCount).toBe(2);
    expect(m.peak).toBe(10);
    // Both surviving intervals carry 10²; a zero-filled gap would have pulled
    // the RMS down to roughly 8.16.
    expect(m.rms).toBeCloseTo(10, 10);
    expect(rec.getSeries('Mech|dof0')?.values.toArray()[1]).toBeNaN();
  });

  it('reports nothing for a series that was never recorded', () => {
    const rec = directRecorder();
    const m = rec.metrics('nope');
    expect(m).toMatchObject({ peak: 0, peakTime: null, rms: 0, holding: null, sampleCount: 0 });
  });

  it('dates the peak — the panel jumps the zoom window to this moment', () => {
    const rec = directRecorder();
    rec.start();
    // t:   0.5   1.0   2.0   4.0 — the magnitude peak (−4) is at t = 1.0.
    feed(rec, 0.5, 2);
    feed(rec, 0.5, -4);
    feed(rec, 1.0, 3);
    feed(rec, 2.0, -1);
    expect(rec.metrics('Mech|dof0').peakTime).toBe(1.0);
  });

  it('dates an all-zero recording to its first sample, never to null', () => {
    // A valid run whose channel is genuinely unloaded still has a peak OF ZERO
    // at a real moment; null is reserved for "no finite sample at all".
    const rec = directRecorder();
    rec.start();
    feed(rec, 0.5, 0);
    feed(rec, 0.5, 0);
    const m = rec.metrics('Mech|dof0');
    expect(m.peak).toBe(0);
    expect(m.peakTime).toBe(0.5);
  });
});

describe('holding figure', () => {
  it('comes only from an explicit statics capture', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 1.0, 0);   // a dynamic zero crossing …
    feed(rec, 1.0, 12);
    expect(rec.metrics('Mech|dof0').holding).toBeNull(); // … is NOT a holding torque

    rec.setHolding('Mech|dof0', -9.8);
    expect(rec.metrics('Mech|dof0').holding).toBe(9.8);

    rec.clearHolding();
    expect(rec.metrics('Mech|dof0').holding).toBeNull();
  });
});

// ─── Pause (§2.3.2) ─────────────────────────────────────────────────────────

describe('pause', () => {
  it('freezes both the samples and the clock', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 1.0, 5);

    rec.setPaused(true);
    for (let i = 0; i < 10; i++) feed(rec, 1.0, 99);
    expect(rec.timeBuffer.count).toBe(1);
    expect(rec.elapsed).toBeCloseTo(1.0, 10);

    rec.setPaused(false);
    feed(rec, 1.0, 5);
    // The resumed sample sits 1 s after the first, not 11 s: a paused break
    // must not become an eleven-second Δt that outvotes the entire run.
    expect(rec.timeBuffer.toArray()).toEqual([1, 2]);
    expect(rec.metrics('Mech|dof0').rms).toBeCloseTo(5, 10);
  });
});

// ─── Lifecycle and namespaces (§2.6) ────────────────────────────────────────

describe('lifecycle', () => {
  it('clear() drops buffers, series and holding figures', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 1.0, 5);
    rec.setHolding('Mech|dof0', 3);

    rec.clear();
    expect(rec.timeBuffer.count).toBe(0);
    expect(rec.series).toHaveLength(0);
    expect(rec.getSeries('Mech|dof0')).toBeUndefined();
    expect(rec.metrics('Mech|dof0').holding).toBeNull();
    expect(rec.elapsed).toBe(0);
  });

  it('start() begins a fresh window rather than appending to the previous one', () => {
    const rec = directRecorder();
    rec.start();
    feed(rec, 1.0, 5);
    rec.start();
    feed(rec, 1.0, 8);
    expect(rec.timeBuffer.toArray()).toEqual([1]);
    expect(rec.getSeries('Mech|dof0')?.values.toArray()).toEqual([8]);
  });

  it('keeps two mechanisms in separate namespaces', () => {
    const rec = directRecorder();
    rec.start();
    rec.sample(1.0, () => [
      snapshot('A', [channel('A|dof0', 3)]),
      snapshot('B', [channel('B|dof0', 7), channel('B|joint0|F', 100, 'N', 'joint-force')]),
    ]);

    expect(rec.seriesFor('A').map((s) => s.id)).toEqual(['A|dof0']);
    expect(rec.seriesFor('B').map((s) => s.id)).toEqual(['B|dof0', 'B|joint0|F']);
    expect(rec.metrics('A|dof0').peak).toBe(3);
    expect(rec.metrics('B|joint0|F').unit).toBe('N');
  });

  it('pads a series discovered mid-run so index i still means time[i]', () => {
    const rec = directRecorder();
    rec.start();
    rec.sample(1.0, () => [snapshot('A', [channel('A|dof0', 1)])]);
    rec.sample(1.0, () => [snapshot('A', [channel('A|dof0', 2)])]);
    // A second mechanism appears only now.
    rec.sample(1.0, () => [
      snapshot('A', [channel('A|dof0', 3)]),
      snapshot('B', [channel('B|dof0', 50)])]);

    const b = rec.getSeries('B|dof0')!;
    expect(b.values.count).toBe(rec.timeBuffer.count);
    const values = b.values.toArray();
    expect(values[0]).toBeNaN();
    expect(values[1]).toBeNaN();
    expect(values[2]).toBe(50);
    // Its single sample must be dated t = 3, not t = 1.
    expect(rec.timeBuffer.toArray()[2]).toBe(3);
  });

  it('a series whose mechanism disappears keeps its alignment', () => {
    const rec = directRecorder();
    rec.start();
    rec.sample(1.0, () => [snapshot('A', [channel('A|dof0', 1)]),
      snapshot('B', [channel('B|dof0', 2)])]);
    rec.sample(1.0, () => [snapshot('A', [channel('A|dof0', 3)])]);

    const b = rec.getSeries('B|dof0')!;
    expect(b.values.count).toBe(2);
    expect(b.values.toArray()[1]).toBeNaN();
  });
});
