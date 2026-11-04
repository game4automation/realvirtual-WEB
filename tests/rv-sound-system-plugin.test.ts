// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 C3 / C4 / C8 — the SoundSystem plugin: real RVSound instances
 * register with the viewer whose scene they belong to (store count for the
 * segment), dispose / model change / placement removal take them out; never
 * activated = no audio module and no context; switched on → engine + context;
 * off again → suspended, pool kept.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVSound, getRegisteredSounds } from '../src/core/engine/rv-sound';
import { SoundSystemPlugin } from '../src/plugins/sound-system-plugin';
import { setAudioContextFactory } from '../src/core/audio/rv-audio-engine';
import { __reloadSoundSettingsForTest, setSoundEnabled, setSoundVolume } from '../src/core/hmi/sound-settings-store';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { FakeAudioContext, fakeAudioFactory, flushMicrotasks } from './helpers/fake-audio';
import { getAudioContextRefCount, getSharedAudioContext } from '../src/core/rv-audio-context';

function fakeViewer(): { viewer: RVViewer; scene: Scene; emit(ev: string): void } {
  const scene = new Scene();
  const handlers = new Map<string, (() => void)[]>();
  const camera = new PerspectiveCamera();
  const viewer = {
    scene,
    camera,
    renderer: {},
    isSimulationPaused: false,
    on: (ev: string, cb: () => void) => {
      const list = handlers.get(ev) ?? [];
      list.push(cb);
      handlers.set(ev, list);
      return () => { handlers.set(ev, (handlers.get(ev) ?? []).filter((x) => x !== cb)); };
    },
  } as unknown as RVViewer;
  return { viewer, scene, emit: (ev) => { for (const cb of handlers.get(ev) ?? []) cb(); } };
}

function addSound(scene: Scene, name: string): RVSound {
  const node = new Object3D();
  node.name = name;
  scene.add(node);
  const registry = new NodeRegistry();
  registry.register('Drive', NodeRegistry.computeNodePath(node), new RVDrive(node));
  const s = new RVSound(node);
  s.init({ registry, scene, expectSceneReady: false } as unknown as ComponentContext);
  return s;
}

const plugins: SoundSystemPlugin[] = [];
const sounds: RVSound[] = [];

beforeEach(() => {
  localStorage.removeItem('rv-sound-enabled');
  localStorage.removeItem('rv-sound-volume');
  __reloadSoundSettingsForTest();
  FakeAudioContext.reset();
  setAudioContextFactory(fakeAudioFactory());
});

afterEach(() => {
  for (const s of sounds) s.dispose();
  sounds.length = 0;
  for (const p of plugins) p.dispose();
  plugins.length = 0;
  setSoundEnabled(false);
  setAudioContextFactory(null);
  clearAllProblems();
  localStorage.removeItem('rv-sound-enabled');
  localStorage.removeItem('rv-sound-volume');
});

/** A user gesture on the page (the plugin listens in the capture phase). */
function gesture(kind: 'pointerdown' | 'keydown' = 'pointerdown'): void {
  window.dispatchEvent(kind === 'keydown' ? new KeyboardEvent('keydown') : new Event('pointerdown'));
}

function plugin(viewer: RVViewer): SoundSystemPlugin {
  const p = new SoundSystemPlugin();
  p.init(viewer);
  plugins.push(p);
  return p;
}

describe('SoundSystem plugin (plan-2019 C3/C4)', () => {
  it('counts the Sound components of ITS scene; dispose removes them', () => {
    const a = fakeViewer(); const b = fakeViewer();
    const pa = plugin(a.viewer); const pb = plugin(b.viewer);
    expect(pa.sceneStore.getSnapshot().count).toBe(0);
    const s1 = addSound(a.scene, 'A1'); sounds.push(s1);
    const s2 = addSound(a.scene, 'A2'); sounds.push(s2);
    const s3 = addSound(b.scene, 'B1'); sounds.push(s3);
    expect(pa.sceneStore.getSnapshot().count).toBe(2);
    expect(pb.sceneStore.getSnapshot().count).toBe(1);
    expect(pa.sounds).toEqual([s1, s2]);
    // Editor remove / placement removal end in dispose() of the component.
    s1.dispose();
    expect(pa.sceneStore.getSnapshot().count).toBe(1);
    // A model change does NOT dispose components in the viewer: the plugin does it (fix-1 #1).
    pa.onModelCleared();
    expect(getRegisteredSounds().has(s2)).toBe(false);
    expect(s2.drive).toBeNull();
    expect(pa.sounds).toEqual([]);
    expect(pa.sceneStore.getSnapshot().count).toBe(0);
    expect(pb.sceneStore.getSnapshot().count).toBe(1);
    // The viewer's dispose takes its own Sounds out, too.
    pb.dispose();
    expect(getRegisteredSounds().has(s3)).toBe(false);
  });

  it('notifies subscribers (the segment re-renders event-driven)', () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    const cb = vi.fn();
    const off = p.sceneStore.subscribe(cb);
    const s = addSound(a.scene, 'S'); sounds.push(s);
    expect(cb).toHaveBeenCalled();
    off();
  });
});

describe('SoundSystem plugin — the two off states (plan-2019 C8)', () => {
  it('never activated → audio module not loaded, no context, render is a no-op', () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    p.onRender(1 / 60);
    expect(p.loaded).toBe(false);
    expect(p.engine).toBeNull();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('switched on → engine + context with the sources; off again → suspended, pool kept', async () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    const s = addSound(a.scene, 'S'); sounds.push(s);
    setSoundVolume(0.5);
    setSoundEnabled(true); // e.g. MCP — no gesture: no context yet, the gesture is awaited
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(p.gestureArmed).toBe(true);
    gesture();
    // The context is created INSIDE the gesture, before the lazy engine arrives (fix-1 #2).
    expect(FakeAudioContext.instances).toHaveLength(1);
    await vi.waitFor(() => expect(p.engine?.activated).toBe(true));
    expect(p.gestureArmed).toBe(false);
    const ctx = FakeAudioContext.instances[0];
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(p.engine!.sources).toEqual([s]);
    expect(ctx.state).toBe('running');
    const voices = p.engine!.voices.length;
    setSoundEnabled(false);
    expect(ctx.state).toBe('suspended');
    expect(p.engine!.voices).toHaveLength(voices);
    expect(ctx.counters.close).toBe(0);
    // The plugin's dispose releases the last reference → close().
    p.dispose();
    expect(ctx.counters.close).toBe(1);
  });

  it('a simulation reset reaches the sampler', async () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    setSoundEnabled(true);
    gesture();
    await vi.waitFor(() => expect(p.engine?.activated).toBe(true));
    const spy = vi.spyOn(p.engine!.sampler, 'notifyReset');
    a.emit('simulation-reset');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('the render path reuses ONE frame input — no allocation per frame (fix-1 #7)', async () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    setSoundEnabled(true);
    gesture();
    await vi.waitFor(() => expect(p.engine?.activated).toBe(true));
    const spy = vi.spyOn(p.engine!, 'frame');
    p.onRender(1 / 60);
    p.onRender(1 / 30);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toBe(spy.mock.calls[0][0]);
    expect(spy.mock.calls[1][0].dt).toBeCloseTo(1 / 30, 9);
  });
});

describe('SoundSystem plugin — activation state machine (fix-1 #2 / #3)', () => {
  it('a refused resume keeps the gesture armed; the next gesture starts audio and disarms', async () => {
    FakeAudioContext.initialState = 'suspended';
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    setSoundEnabled(true);
    FakeAudioContext.refuseResume = 1;
    gesture();
    await vi.waitFor(() => expect(p.engine?.activated).toBe(true));
    await flushMicrotasks();
    const ctx = getSharedAudioContext() as unknown as FakeAudioContext;
    expect(ctx.state).toBe('suspended');
    expect(p.gestureArmed).toBe(true); // re-armed, not consumed
    gesture('keydown');
    await vi.waitFor(() => expect(ctx.state).toBe('running'));
    await vi.waitFor(() => expect(p.gestureArmed).toBe(false));
    // A third gesture does nothing any more.
    const resumes = ctx.counters.resume;
    gesture();
    await flushMicrotasks();
    expect(ctx.counters.resume).toBe(resumes);
  });

  it('switching off disarms; dispose removes armed handlers and releases the context', async () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    setSoundEnabled(true);
    expect(p.gestureArmed).toBe(true);
    setSoundEnabled(false);
    expect(p.gestureArmed).toBe(false);
    setSoundEnabled(true);
    expect(p.gestureArmed).toBe(true);
    const remove = vi.spyOn(window, 'removeEventListener');
    p.dispose();
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual(['keydown', 'pointerdown']);
    remove.mockRestore();
    gesture();
    await flushMicrotasks();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getAudioContextRefCount()).toBe(0);
  });

  it('fast on / off / on / off through the settings on a DELAYED context ends suspended', async () => {
    const a = fakeViewer();
    const p = plugin(a.viewer);
    sounds.push(addSound(a.scene, 'S'));
    setSoundEnabled(true);
    gesture();
    await vi.waitFor(() => expect(p.engine?.activated).toBe(true));
    const ctx = getSharedAudioContext() as unknown as FakeAudioContext;
    expect(ctx.state).toBe('running');
    FakeAudioContext.delayed = true;
    setSoundEnabled(false);
    setSoundEnabled(true);
    setSoundEnabled(false);
    await ctx.settleAll();
    expect(ctx.state).toBe('suspended');
    setSoundEnabled(true);
    gesture();
    await ctx.settleAll();
    expect(ctx.state).toBe('running');
    setSoundEnabled(false);
    await ctx.settleAll();
    expect(ctx.state).toBe('suspended');
  });
});
