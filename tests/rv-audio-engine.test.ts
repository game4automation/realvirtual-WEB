// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.6 / C8 / C9 — audio engine lifecycle on the fake Web Audio:
 * no context while never activated, one page context for several viewers with
 * one master each, partial dispose keeps it, the last one closes it; 13 motors →
 * the 12 nearest get a voice; no oscillator is re-created on re-assignment;
 * switched off after activation = suspended with the pool kept; a hidden page
 * suspends.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera } from 'three';
import {
  RVSoundEngine, VOICE_COUNT, getAudioContextRefCount, getSharedAudioContext, setAudioContextFactory,
  type SoundSourceView,
} from '../src/core/audio/rv-audio-engine';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';
import { FakeAudioContext, fakeAudioFactory } from './helpers/fake-audio';

const engines: RVSoundEngine[] = [];
function engine(): RVSoundEngine { const e = new RVSoundEngine(); engines.push(e); return e; }

function motor(x: number, targetSpeed = 100): SoundSourceView & { drive: SoundDriveLike } {
  const node = new Object3D();
  node.position.set(x, 0, 0);
  node.updateMatrixWorld(true);
  const drive: SoundDriveLike = { node, name: `M${x}`, currentPosition: 0, TargetSpeed: targetSpeed, targetSpeed, targetPosition: 0 };
  return { node, drive, cylinder: null, kind: 'Drive', variant: 'Medium', volume: 1 };
}

function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera();
  c.position.set(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
}

/** Advance `seconds` of 60 Hz frames, moving every motor at its TargetSpeed. */
function run(e: RVSoundEngine, sources: readonly (SoundSourceView & { drive: SoundDriveLike })[], seconds: number, listener: Object3D | null = camera()): void {
  const ctx = getSharedAudioContext() as unknown as FakeAudioContext;
  for (let t = 0; t < seconds; t += 1 / 60) {
    for (const s of sources) s.drive.currentPosition += s.drive.TargetSpeed / 60;
    ctx.currentTime += 1 / 60;
    e.frame({ dt: 1 / 60, timeFactor: 1, paused: false, listener });
  }
}

beforeEach(() => {
  FakeAudioContext.reset();
  setAudioContextFactory(fakeAudioFactory());
});

afterEach(() => {
  for (const e of engines) e.dispose();
  engines.length = 0;
  setAudioContextFactory(null);
});

describe('audio engine (plan-2019 9.6)', () => {
  it('never activated → no context at all (C8)', () => {
    const e = engine();
    e.setSources([motor(1)]);
    e.setEnabled(false);
    e.frame({ dt: 1 / 60, timeFactor: 1, paused: false, listener: null });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(e.activated).toBe(false);
  });

  it('two viewers → one context, two masters; partial dispose keeps it, the last closes it (C9)', () => {
    const a = engine(); const b = engine();
    a.activate(); b.activate();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(getAudioContextRefCount()).toBe(2);
    expect(a.master).not.toBeNull();
    expect(b.master).not.toBe(a.master);
    const ctx = FakeAudioContext.instances[0];
    expect((a.master as unknown as { connections: unknown[] }).connections).toContain(ctx.destination);
    a.dispose();
    expect(ctx.counters.close).toBe(0);
    expect(getSharedAudioContext()).not.toBeNull();
    b.dispose();
    expect(ctx.counters.close).toBe(1);
    expect(getSharedAudioContext()).toBeNull();
  });

  it('13 moving motors → VOICE_COUNT (6) voices, the nearest to the camera', () => {
    const e = engine();
    e.activate();
    e.setEnabled(true);
    const sources = Array.from({ length: 13 }, (_, i) => motor((i + 1) * 10));
    e.setSources(sources);
    run(e, sources, 0.6);
    const assigned = e.voices.map((v) => v.source).filter((s) => s >= 0).sort((x, y) => x - y);
    expect(assigned).toHaveLength(VOICE_COUNT);
    expect(assigned).not.toContain(12); // the farthest (x = 130 m) has none
  });

  it('the voice limit is configurable per engine', () => {
    const e = new RVSoundEngine(3);
    engines.push(e);
    e.activate();
    e.setEnabled(true);
    const sources = Array.from({ length: 8 }, (_, i) => motor((i + 1) * 3));
    e.setSources(sources);
    run(e, sources, 0.6);
    expect(e.voices).toHaveLength(3);
    expect(e.voices.map((v) => v.source).filter((x) => x >= 0).sort((x, y) => x - y)).toEqual([0, 1, 2]);
  });

  it('re-assignment never re-creates oscillators', () => {
    const e = engine();
    e.activate();
    e.setEnabled(true);
    const ctx = FakeAudioContext.instances[0];
    const sources = Array.from({ length: 13 }, (_, i) => motor((i + 1) * 10));
    e.setSources(sources);
    run(e, sources, 0.5);
    const oscillators = ctx.counters.oscillators;
    // One-shot partials (the subtle motor start transients) stop by design - only voice oscillators must never stop.
    const stoppedBefore = ctx.oscillatorNodes.filter((o) => o.stopped).length;
    const listener = camera();
    // Move the listener to the far end → the set of the 12 nearest changes.
    listener.position.set(140, 0, 0);
    listener.updateMatrixWorld(true);
    run(e, sources, 1.5, listener);
    expect(e.voices.map((v) => v.source)).toContain(12);
    expect(ctx.counters.oscillators).toBe(oscillators);
    expect(ctx.oscillatorNodes.filter((o) => o.stopped).length).toBe(stoppedBefore);
  });

  it('switched off after activation → suspended, pool kept (C8)', () => {
    const e = engine();
    e.activate();
    e.setEnabled(true);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('running');
    e.setEnabled(false);
    expect(ctx.state).toBe('suspended');
    expect(e.voices).toHaveLength(VOICE_COUNT);
    expect(ctx.oscillatorNodes.some((o) => o.stopped)).toBe(false);
    e.setEnabled(true);
    expect(ctx.state).toBe('running');
  });

  it('one viewer off, another on → the shared context keeps running', () => {
    const a = engine(); const b = engine();
    a.activate(); b.activate();
    a.setEnabled(true); b.setEnabled(false);
    expect(FakeAudioContext.instances[0].state).toBe('running');
    a.setEnabled(false);
    expect(FakeAudioContext.instances[0].state).toBe('suspended');
  });

  it('visibilitychange → hidden suspends, visible resumes', () => {
    const e = engine();
    e.activate();
    e.setEnabled(true);
    const ctx = FakeAudioContext.instances[0];
    const desc = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    try {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(ctx.state).toBe('suspended');
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(ctx.state).toBe('running');
    } finally {
      if (desc) Object.defineProperty(document, 'visibilityState', desc);
      else delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});
