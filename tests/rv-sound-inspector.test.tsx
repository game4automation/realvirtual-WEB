// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.8 / C9 — the Sound inspector editors: the Type choice is filtered
 * by the effective kind, Auto shows its result ("Auto → Medium"), the volume is
 * bounded 0–100 %, and "Preview" reaches an actual voice of the audio engine —
 * with sound switched off globally.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVSound, type SoundKind } from '../src/core/engine/rv-sound';
import {
  SoundVariantRenderer, SoundVolumeRenderer, autoHintFor, findSoundAt, variantOptionsFor,
} from '../src/core/hmi/rv-sound-field-renderer';
import { fieldRendererRegistry } from '../src/core/hmi/rv-field-renderer-registry';
import { SoundSystemPlugin } from '../src/plugins/sound-system-plugin';
import { getSharedAudioContext, setAudioContextFactory } from '../src/core/audio/rv-audio-engine';
import { getSoundSettings } from '../src/core/hmi/sound-settings-store';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVViewer } from '../src/core/rv-viewer';
import { FakeAudioContext, fakeAudioFactory } from './helpers/fake-audio';

const sounds: RVSound[] = [];
const plugins: SoundSystemPlugin[] = [];

afterEach(() => {
  cleanup();
  for (const s of sounds) s.dispose();
  sounds.length = 0;
  for (const p of plugins) p.dispose();
  plugins.length = 0;
  setAudioContextFactory(null);
  FakeAudioContext.reset();
  clearAllProblems();
});

function makeSound(scene: Scene, kind: SoundKind, cylinder: boolean): { sound: RVSound; path: string } {
  const node = new Object3D();
  node.name = `Snd${sounds.length}`;
  scene.add(node);
  const registry = new NodeRegistry();
  const path = NodeRegistry.computeNodePath(node);
  registry.register('Drive', path, new RVDrive(node));
  if (cylinder) registry.register('Drive_Cylinder', path, { MinPos: 0, MaxPos: 100 });
  const sound = new RVSound(node);
  sound.Kind = kind;
  sound.init({ registry, scene, expectSceneReady: false } as unknown as ComponentContext);
  sounds.push(sound);
  return { sound, path };
}

/** A duck-typed viewer with its own SoundSystem and node registry. */
function viewerWith(scene: Scene): { viewer: RVViewer; plugin: SoundSystemPlugin; registry: NodeRegistry } {
  const plugin = new SoundSystemPlugin();
  plugins.push(plugin);
  const registry = new NodeRegistry();
  const viewer = {
    scene, camera: new PerspectiveCamera(), renderer: {}, isSimulationPaused: false, registry,
    on: () => () => {},
    getPlugin: (id: string) => (id === 'sound-system' ? plugin : undefined),
  } as unknown as RVViewer;
  plugin.init(viewer);
  return { viewer, plugin, registry };
}

function props(path: string, value: unknown, viewer: RVViewer | null = null, onEdit = vi.fn()) {
  return { value, fieldName: 'Variant', componentType: 'Sound', nodePath: path, viewer, signalStore: null, onEdit };
}

describe('Sound inspector (plan-2019 9.8)', () => {
  it('registers renderers for Variant and Volume (not for Kind)', () => {
    expect(fieldRendererRegistry.getRenderer('Sound', 'Variant')).toBe(SoundVariantRenderer);
    expect(fieldRendererRegistry.getRenderer('Sound', 'Volume')).toBe(SoundVolumeRenderer);
    expect(fieldRendererRegistry.getRenderer('Sound', 'Kind')).toBeNull();
  });

  it('filters the Type options by the effective kind', () => {
    expect(variantOptionsFor('Auto', false)).toEqual(['Auto', 'Large', 'Medium', 'Small']);
    expect(variantOptionsFor('Auto', true)).toEqual(['Auto', 'Hard', 'Cushioned']);
    expect(variantOptionsFor('Drive', true)).toEqual(['Auto', 'Large', 'Medium', 'Small']);
    expect(variantOptionsFor('Hydraulic', true)).toEqual(['Auto']);
    expect(autoHintFor('Auto', false)).toBe('Auto → Medium');
    expect(autoHintFor('Auto', true)).toBe('Auto → Cushioned');
  });

  it('renders the filtered choice, the Auto hint and the Preview button', () => {
    const scene = new Scene();
    const { viewer } = viewerWith(scene);
    const { path } = makeSound(scene, 'Auto', true);
    const onEdit = vi.fn();
    render(<SoundVariantRenderer {...props(path, 'Auto', viewer, onEdit)} />);
    expect(screen.getByTestId('rv-sound-auto-hint').textContent).toBe('Auto → Cushioned');
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Auto', 'Hard', 'Cushioned']);
    fireEvent.click(screen.getByRole('option', { name: 'Hard' }));
    expect(onEdit).toHaveBeenCalledWith('Hard');
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
  });

  it('bounds the volume at 0–100 % and writes 0..1', () => {
    const onEdit = vi.fn();
    render(<SoundVolumeRenderer {...props('x', 0.5, null, onEdit)} fieldName="Volume" />);
    const input = screen.getByLabelText('Sound volume') as HTMLInputElement;
    expect(screen.getByTestId('rv-number-range').textContent).toBe('0…100');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenLastCalledWith(1);
  });

  it('Preview reaches a voice of the engine — with sound globally off (C9)', async () => {
    FakeAudioContext.reset();
    setAudioContextFactory(fakeAudioFactory());
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const viewer = {
      scene, camera, renderer: {}, isSimulationPaused: false,
      on: () => () => {},
      getPlugin: (id: string) => (id === 'sound-system' ? plugin : undefined),
    } as unknown as RVViewer;
    const plugin = new SoundSystemPlugin();
    plugins.push(plugin);
    plugin.init(viewer);
    const { sound, path } = makeSound(scene, 'Drive', false);
    expect(getSoundSettings().enabled).toBe(false);
    render(<SoundVariantRenderer {...props(path, 'Auto', viewer)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await vi.waitFor(() => expect(plugin.engine?.previewing).toBe(true));
    const ctx = getSharedAudioContext() as unknown as FakeAudioContext;
    expect(ctx.state).toBe('running');
    // Render frames: the preview source (a run-up of this Sound) gets a voice.
    for (let i = 0; i < 40; i++) { ctx.currentTime += 1 / 60; plugin.onRender(1 / 60); }
    const voice = plugin.engine!.voices.find((v) => v.source >= 0);
    expect(voice).toBeDefined();
    expect(plugin.engine!.sources[voice!.source].node).toBe(sound.node);
    // After the preview the context is suspended again (sound is still off).
    for (let i = 0; i < 120; i++) { ctx.currentTime += 1 / 60; plugin.onRender(1 / 60); }
    expect(plugin.engine!.previewing).toBe(false);
    expect(ctx.state).toBe('suspended');
  });
  it('two viewers with the same paths: the inspector edits and previews only the Sound of its own viewer (fix-1 #9)', async () => {
    FakeAudioContext.reset();
    setAudioContextFactory(fakeAudioFactory());
    const sceneA = new Scene(); const sceneB = new Scene();
    const a = viewerWith(sceneA); const b = viewerWith(sceneB);
    // Same node name → the same computed path in both viewers.
    const sa = makeSound(sceneA, 'Auto', false);
    const sb = makeSound(sceneB, 'Auto', true);
    sb.sound.node.name = sa.sound.node.name;
    expect(NodeRegistry.computeNodePath(sb.sound.node)).toBe(sa.path);
    expect(findSoundAt(a.viewer, sa.path)).toBe(sa.sound);
    expect(findSoundAt(b.viewer, sa.path)).toBe(sb.sound);
    expect(findSoundAt(null, sa.path)).toBeNull();
    // Placed content: the registry path is authoritative, not the computed one.
    b.registry.registerNode('Layout/Machine_1/' + sa.path, sb.sound.node);
    expect(findSoundAt(b.viewer, 'Layout/Machine_1/' + sa.path)).toBe(sb.sound);
    expect(findSoundAt(b.viewer, sa.path)).toBeNull();
    // Viewer B's inspector shows B's kind (Cylinder) and previews B's Sound only.
    render(<SoundVariantRenderer {...props('Layout/Machine_1/' + sa.path, 'Auto', b.viewer)} />);
    expect(screen.getByTestId('rv-sound-auto-hint').textContent).toBe('Auto → Cushioned');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await vi.waitFor(() => expect(b.plugin.engine?.previewing).toBe(true));
    expect(a.plugin.engine).toBeNull();
    // The preview source is a stroke of B's node (Cylinder), A's Sound is not involved.
    const nodes = b.plugin.engine!.sources.map((v) => v.node);
    expect(nodes).toContain(sb.sound.node);
    expect(nodes).not.toContain(sa.sound.node);
    expect(b.plugin.engine!.sources.find((v) => v.node === sb.sound.node)!.kind).toBe('Cylinder');
  });
});
