// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.2 — kind / variant resolution, Problems entries and the legacy
 * Unity mapping, on a REAL RVSound instance (C1) next to a real Drive.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  RVSound, SOUND_VARIANT_MISMATCH_CODE, SOUND_WITHOUT_DRIVE_CODE, getRegisteredSounds, resolveSound,
  type LegacySoundType, type SoundKind, type SoundVariant,
} from '../src/core/engine/rv-sound';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

interface Opts {
  kind?: SoundKind; variant?: SoundVariant; drive?: boolean; cylinder?: boolean;
  soundType?: LegacySoundType; mode?: string; authored?: boolean;
}

const made: RVSound[] = [];

function build(o: Opts = {}): RVSound {
  const scene = new Scene();
  const node = new Object3D();
  node.name = `Axis${made.length}`;
  scene.add(node);
  const registry = new NodeRegistry();
  const path = NodeRegistry.computeNodePath(node);
  if (o.drive !== false) registry.register('Drive', path, new RVDrive(node));
  if (o.cylinder) registry.register('Drive_Cylinder', path, { MinPos: 0, MaxPos: 50 });
  const s = new RVSound(node);
  s.Kind = o.kind ?? 'Auto';
  s.Variant = o.variant ?? 'Auto';
  s.SoundType = o.soundType ?? null;
  s.Mode = o.mode ?? null;
  s.authoredKind = o.authored ?? o.kind !== undefined;
  s.authoredVariant = o.authored ?? o.variant !== undefined;
  s.init({ registry, scene, expectSceneReady: false } as unknown as ComponentContext);
  made.push(s);
  return s;
}

afterEach(() => {
  for (const s of made) s.dispose();
  made.length = 0;
  clearAllProblems();
});

describe('Sound resolution (plan-2019 9.2)', () => {
  it('Kind Auto → Drive without Drive_Cylinder, Cylinder with one; Variant Auto → Medium / Cushioned', () => {
    const a = build();
    expect([a.kind, a.variant]).toEqual(['Drive', 'Medium']);
    const b = build({ cylinder: true });
    expect([b.kind, b.variant]).toEqual(['Cylinder', 'Cushioned']);
    expect(b.cylinder).toEqual({ MinPos: 0, MaxPos: 50 });
  });

  it('a variant that does not fit the kind → Auto + sound-variant-mismatch (both directions)', () => {
    const a = build({ kind: 'Drive', variant: 'Hard' });
    expect(a.variant).toBe('Medium');
    const b = build({ kind: 'Cylinder', variant: 'Large' });
    expect(b.variant).toBe('Cushioned');
    const codes = getProblems().filter((p) => p.code === SOUND_VARIANT_MISMATCH_CODE);
    expect(codes).toHaveLength(2);
    // Fixing the variant clears the entry.
    a.Variant = 'Small';
    a.reapplyConfig();
    expect(a.variant).toBe('Small');
    expect(getProblems().filter((p) => p.code === SOUND_VARIANT_MISMATCH_CODE)).toHaveLength(1);
  });

  it('without a Drive → inactive + sound-without-drive', () => {
    const s = build({ drive: false });
    expect(s.active).toBe(false);
    expect(getProblems().some((p) => p.code === SOUND_WITHOUT_DRIVE_CODE)).toBe(true);
    s.dispose();
    expect(getProblems().some((p) => p.code === SOUND_WITHOUT_DRIVE_CODE)).toBe(false);
  });

  it('maps the legacy Unity SoundType when Kind and Variant are absent', () => {
    const cases: [LegacySoundType, string, string][] = [
      ['Robot1', 'Drive', 'Medium'], ['Robot2', 'Drive', 'Medium'],
      ['SmallElectric1', 'Drive', 'Small'], ['SmallElectric2', 'Drive', 'Small'],
      ['AirPressure', 'Cylinder', 'Cushioned'],
    ];
    for (const [t, k, v] of cases) {
      const s = build({ soundType: t, authored: false });
      expect([t, s.kind, s.variant]).toEqual([t, k, v]);
    }
  });

  it('Kind / Variant beat the legacy fields; Mode=Pick is ignored', () => {
    const s = build({ kind: 'Drive', variant: 'Large', soundType: 'AirPressure', mode: 'Pick' });
    expect([s.kind, s.variant]).toEqual(['Drive', 'Large']);
    const r = resolveSound({
      kind: 'Auto', variant: 'Auto', hasCylinder: false, authoredKind: false, authoredVariant: false, soundType: 'Robot1', mode: 'Pick',
    });
    expect([r.kind, r.variant, r.legacy]).toEqual(['Drive', 'Medium', true]);
  });

  it('Hydraulic is never derived and only offers Auto', () => {
    const s = build({ kind: 'Hydraulic', cylinder: true });
    expect([s.kind, s.variant]).toEqual(['Hydraulic', 'Auto']);
    const m = build({ kind: 'Hydraulic', variant: 'Hard' });
    expect(m.variant).toBe('Auto');
  });

  it('registers with the sound hub on resolve and leaves it on dispose', () => {
    const s = build();
    expect(getRegisteredSounds().has(s)).toBe(true);
    s.dispose();
    expect(getRegisteredSounds().has(s)).toBe(false);
  });
it('an explicit Auto beats the legacy mapping of a Unity component (fix-1 #5)', () => {
    const s = build({ soundType: 'AirPressure', authored: false });
    s.node.userData.realvirtual = { Sound: { SoundType: 'AirPressure' } };
    expect([s.kind, s.variant]).toEqual(['Cylinder', 'Cushioned']); // legacy
    // A Volume-only edit keeps the legacy mapping.
    s.node.userData.realvirtual = { Sound: { SoundType: 'AirPressure', Volume: 0.5 } };
    s.Volume = 0.5;
    s.reapplyConfig();
    expect([s.kind, s.variant]).toEqual(['Cylinder', 'Cushioned']);
    // The inspector / MCP writes Kind = Auto explicitly: authored, the node decides (plain Drive).
    s.node.userData.realvirtual = { Sound: { SoundType: 'AirPressure', Volume: 0.5, Kind: 'Auto' } };
    s.Kind = 'Auto';
    s.reapplyConfig();
    expect(s.authoredKind).toBe(true);
    expect([s.kind, s.variant]).toEqual(['Drive', 'Medium']);
    // Resetting the field (removed from the extras) gives the legacy mapping back.
    s.node.userData.realvirtual = { Sound: { SoundType: 'AirPressure', Volume: 0.5 } };
    s.reapplyConfig();
    expect([s.kind, s.variant]).toEqual(['Cylinder', 'Cushioned']);
    // The same for an explicit Variant = Auto.
    s.node.userData.realvirtual = { Sound: { SoundType: 'AirPressure', Variant: 'Auto' } };
    s.reapplyConfig();
    expect(s.authoredVariant).toBe(true);
    expect([s.kind, s.variant]).toEqual(['Drive', 'Medium']);
  });
});
