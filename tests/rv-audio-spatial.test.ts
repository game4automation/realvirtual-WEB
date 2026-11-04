// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.12 — space: every voice is an HRTF panner (fallback
 * equalpower, inverse, refDistance 2 m) at the world position of its drive
 * node; the listener follows the desktop camera, and while an XR session
 * presents it follows `renderer.xr.getCamera()` instead; a camera switch
 * (perspective → orthographic) glides instead of jumping.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, OrthographicCamera, PerspectiveCamera } from 'three';
import {
  PARAM_RATE_HZ, REF_DISTANCE, RVSoundEngine, audioStats, getSharedAudioContext, listenerCameraOf, setAudioContextFactory, type SoundSourceView,
} from '../src/core/audio/rv-audio-engine';
import type { SoundDriveLike } from '../src/core/engine/rv-sound';
import { FakeAudioContext, fakeAudioFactory, type FakePanner } from './helpers/fake-audio';

const DT = 1 / 60;
const engines: RVSoundEngine[] = [];

afterEach(() => { for (const e of engines) e.dispose(); engines.length = 0; setAudioContextFactory(null); FakeAudioContext.reset(); });

function setup(hrtf = true): { e: RVSoundEngine; ctx: FakeAudioContext; view: SoundSourceView; drive: SoundDriveLike } {
  FakeAudioContext.reset();
  FakeAudioContext.hrtf = hrtf;
  setAudioContextFactory(fakeAudioFactory());
  const e = new RVSoundEngine(); engines.push(e);
  e.activate(); e.setEnabled(true);
  const parent = new Object3D(); parent.position.set(2, 0, 0);
  const node = new Object3D(); node.position.set(3, 1, -4);
  parent.add(node);
  parent.updateMatrixWorld(true);
  const drive: SoundDriveLike = { node, name: 'M', currentPosition: 0, TargetSpeed: 100, targetSpeed: 100, targetPosition: 0 };
  const view: SoundSourceView = { node, drive, cylinder: null, kind: 'Drive', variant: 'Medium', volume: 1 };
  e.setSources([view]);
  return { e, ctx: getSharedAudioContext() as unknown as FakeAudioContext, view, drive };
}

function run(e: RVSoundEngine, ctx: FakeAudioContext, drive: SoundDriveLike, listener: Object3D, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) {
    drive.currentPosition += 100 * DT;
    ctx.currentTime += DT;
    e.frame({ dt: DT, timeFactor: 1, paused: false, listener });
  }
}

describe('spatial audio (plan-2019 9.12)', () => {
  it('voice panner: HRTF, inverse, refDistance 2 m, at the world position of the drive node', () => {
    const { e, ctx, drive } = setup();
    const cam = new PerspectiveCamera(); cam.updateMatrixWorld(true);
    run(e, ctx, drive, cam, 0.6);
    const voice = e.voices.find((v) => v.source === 0)!;
    const p = voice.panner as unknown as FakePanner;
    expect(p.panningModel).toBe('HRTF');
    expect(p.distanceModel).toBe('inverse');
    expect(p.refDistance).toBe(REF_DISTANCE);
    expect(p.positionX.value).toBeCloseTo(5);
    expect(p.positionY.value).toBeCloseTo(1);
    expect(p.positionZ.value).toBeCloseTo(-4);
  });

  it('falls back to equalpower without HRTF', () => {
    const { e } = setup(false);
    expect((e.voices[0].panner as unknown as FakePanner).panningModel).toBe('equalpower');
  });

  it('the listener follows the desktop camera (position + forward)', () => {
    const { e, ctx, drive } = setup();
    const cam = new PerspectiveCamera();
    cam.position.set(1, 2, 3);
    cam.lookAt(1, 2, -10);
    cam.updateMatrixWorld(true);
    run(e, ctx, drive, cam, 0.1);
    expect(ctx.listener.positionX.value).toBeCloseTo(1);
    expect(ctx.listener.positionY.value).toBeCloseTo(2);
    expect(ctx.listener.positionZ.value).toBeCloseTo(3);
    expect(ctx.listener.forwardZ.value).toBeCloseTo(-1);
  });

  it('with an XR session presenting, the listener is the XR head pose, not the desktop camera', () => {
    const desktop = new PerspectiveCamera(); desktop.position.set(10, 0, 0); desktop.updateMatrixWorld(true);
    const head = new PerspectiveCamera(); head.position.set(0, 1.6, 0); head.updateMatrixWorld(true);
    const viewer = { camera: desktop, renderer: { xr: { isPresenting: false, getCamera: () => head } } };
    expect(listenerCameraOf(viewer)).toBe(desktop);
    viewer.renderer.xr.isPresenting = true;
    expect(listenerCameraOf(viewer)).toBe(head);

    const { e, ctx, drive } = setup();
    run(e, ctx, drive, listenerCameraOf(viewer), 0.1);
    expect(ctx.listener.positionX.value).toBeCloseTo(0);
    expect(ctx.listener.positionY.value).toBeCloseTo(1.6);
  });

  it('a camera switch (perspective → orthographic) glides instead of jumping', () => {
    const { e, ctx, drive } = setup();
    const persp = new PerspectiveCamera(); persp.position.set(0, 0, 5); persp.updateMatrixWorld(true);
    const ortho = new OrthographicCamera(); ortho.position.set(0, 0, 50); ortho.updateMatrixWorld(true);
    run(e, ctx, drive, persp, 0.1);
    run(e, ctx, drive, ortho, DT);
    const call = ctx.listener.positionZ.last('setTargetAtTime')!;
    expect(call.value).toBeCloseTo(50);
    expect(call.arg).toBeGreaterThanOrEqual(0.1); // smoothed, not a jump
    expect(ctx.listener.positionZ.calls.filter((c) => c.method === 'setValueAtTime')).toHaveLength(0);
  });
it('panner and listener are scheduled only on a relevant change, at most 30 Hz (fix-1 #6)', () => {
    const { e, ctx, drive } = setup();
    const cam = new PerspectiveCamera(); cam.position.set(0, 0, 5); cam.updateMatrixWorld(true);
    run(e, ctx, drive, cam, 0.6); // voice bound, everything settled
    // A still camera and a still drive node: one second of frames schedules nothing.
    const listenerCalls = (): number => ctx.listener.positionX.calls.length + ctx.listener.forwardX.calls.length;
    const before = audioStats.poseUpdates;
    const lBefore = listenerCalls();
    run(e, ctx, drive, cam, 1);
    expect(audioStats.poseUpdates - before).toBe(0);
    expect(listenerCalls() - lBefore).toBe(0);
    // A moving camera (every frame): at most PARAM_RATE_HZ listener updates per second.
    const pBefore = ctx.listener.positionX.calls.length;
    for (let i = 0; i < 60; i++) {
      cam.position.x += 0.05; cam.updateMatrixWorld(true);
      ctx.currentTime += DT;
      e.frame({ dt: DT, timeFactor: 1, paused: false, listener: cam });
    }
    const n = ctx.listener.positionX.calls.length - pBefore;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(PARAM_RATE_HZ + 1);
  });
});
