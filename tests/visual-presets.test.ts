// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Visual Presets — apply / match round-trip.
 *
 * Regression for the "always says Custom after switching presets" bug: a preset
 * file that omits a field present in VISUAL_PRESET_FIELDS (e.g. older files saved
 * before `envReflections*` was added) must still re-select on apply.
 *
 * The fix is label-only: matchPreset compares the fields a preset actually
 * defines (a subset match), so the dropdown re-selects the applied preset WITHOUT
 * applyVisualPreset having to reset omitted fields — which would change the
 * rendered look. The "does not change rendering" guarantee is asserted explicitly
 * below: a field a preset omits keeps its prior live value after the switch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureCurrentPreset, applyVisualPreset, matchPreset, seedInitialVisualPreset, listPresets,
  type VisualPreset,
} from '../src/core/hmi/visual-presets';
import { loadVisualSettings, saveVisualSettings } from '../src/core/hmi/visual-settings-store';
import { hasUserEnvironmentOverride } from '../src/core/hmi/environment-presets';
import { setAppConfig } from '../src/core/rv-app-config';
import type { RVViewer } from '../src/core/rv-viewer';

// Minimal stub — applyVisualPreset only calls viewer.applyVisualSettings().
const viewer = { applyVisualSettings() { /* no-op */ } } as unknown as RVViewer;

/** A full-look preset built from the current defaults, with optional overrides
 *  on the captured settings (and optional field deletions to simulate an older
 *  file that predates a later-added VISUAL_PRESET_FIELD). */
function makePreset(
  name: string,
  overrides: Record<string, unknown> = {},
  omit: string[] = [],
): VisualPreset {
  const p = captureCurrentPreset(name);
  Object.assign(p.settings as Record<string, unknown>, overrides);
  for (const k of omit) delete (p.settings as Record<string, unknown>)[k];
  return p;
}

/** Inject a preset into the local (localStorage) preset store so listPresets()
 *  returns it without needing the published-preset fetch. */
function putLocalPreset(p: VisualPreset): void {
  const raw = localStorage.getItem('rv-visual-presets');
  const arr: VisualPreset[] = raw ? JSON.parse(raw) : [];
  localStorage.setItem('rv-visual-presets', JSON.stringify([...arr.filter((x) => x.name !== p.name), p]));
}

describe('visual presets — apply / match', () => {
  beforeEach(() => {
    localStorage.clear();
    setAppConfig({});
  });

  it('re-selects a preset immediately after applying it', () => {
    const def = makePreset('Default');
    const presets = [def];
    applyVisualPreset(viewer, def);
    expect(matchPreset(presets)).toBe('Default');
  });

  it('re-selects a preset that OMITS a later-added field, even after another preset set it', () => {
    // "Default" predates envReflections*, so it omits them (loads as default).
    const def = makePreset('Default', {}, ['envReflectionsEnabled', 'envReflectionsIntensity']);
    // "Fast" sets envReflections on (and is otherwise distinct).
    const fast = makePreset('Fast', {
      renderMode: 'simple',
      envReflectionsEnabled: true,
      envReflectionsIntensity: 1,
    });
    const presets = [def, fast];

    // Switch Fast -> Default. The lingering envReflections from Fast must not
    // leave the dropdown stuck on "Custom".
    applyVisualPreset(viewer, fast);
    expect(matchPreset(presets)).toBe('Fast');
    expect(loadVisualSettings().envReflectionsEnabled).toBe(true);

    applyVisualPreset(viewer, def);
    expect(matchPreset(presets)).toBe('Default'); // was null (→ "Custom") before the fix
    // Rendering-safety guarantee: applying a preset that OMITS env reflections
    // must NOT reset them — the live value carries over from Fast unchanged.
    expect(loadVisualSettings().envReflectionsEnabled).toBe(true);
  });

  it('round-trips across every switch order between three presets', () => {
    const presets = [
      makePreset('Default', {}, ['envReflectionsEnabled', 'envReflectionsIntensity']),
      makePreset('Fast', { renderMode: 'simple', antialias: false, envReflectionsEnabled: true, envReflectionsIntensity: 1 }),
      makePreset('Sketch', { renderMode: 'toon', checkerContrast: 0.3 }, ['envReflectionsEnabled', 'envReflectionsIntensity']),
    ];
    for (const first of presets) {
      for (const second of presets) {
        applyVisualPreset(viewer, first);
        applyVisualPreset(viewer, second);
        expect(matchPreset(presets)).toBe(second.name);
      }
    }
  });

  it('tolerates a preset with partial per-mode settings', () => {
    const partial = makePreset('Partial');
    // Drop one per-mode field — older / hand-edited file.
    const modes = partial.settings.modeSettings as unknown as Record<string, Record<string, unknown>>;
    delete modes.default.shadowIntensity;
    const presets = [partial, makePreset('Fast', { renderMode: 'simple', envReflectionsEnabled: true })];

    applyVisualPreset(viewer, presets[1]);
    applyVisualPreset(viewer, partial);
    expect(matchPreset(presets)).toBe('Partial');
  });

  it('a three-mode preset file (predates raytraced) still yields full settings for all four modes (plan-762)', () => {
    const old = makePreset('Old');
    const modes = old.settings.modeSettings as unknown as Record<string, Record<string, unknown>>;
    delete modes.raytraced;
    modes.toon.lightIntensity = 0.33;
    let applied: { modeSettings: Record<string, Record<string, unknown>> } | null = null;
    const recorder = {
      applyVisualSettings(s: typeof applied) { applied = s; },
    } as unknown as RVViewer;
    applyVisualPreset(recorder, old);
    expect(applied).not.toBeNull();
    expect(Object.keys(applied!.modeSettings).sort()).toEqual(['default', 'raytraced', 'simple', 'toon']);
    expect(applied!.modeSettings.toon.lightIntensity).toBe(0.33);
    expect(applied!.modeSettings.raytraced.shadowEnabled).toBe(false);
    expect(loadVisualSettings().modeSettings.raytraced.shadowEnabled).toBe(false);
  });

  it('a preset that carries raytraced per-mode values applies them (plan-762)', () => {
    const p = makePreset('RT');
    const modes = p.settings.modeSettings as unknown as Record<string, Record<string, unknown>>;
    modes.raytraced = { ...modes.raytraced, dirLightIntensity: 3.5 };
    applyVisualPreset(viewer, p);
    expect(loadVisualSettings().modeSettings.raytraced.dirLightIntensity).toBe(3.5);
  });

  it('marks an environment override so model-load env presets do not clobber it on reload', () => {
    // Regression: applying a visual preset must set the env-user-modified flag,
    // else rv-model-plugin-manager re-applies the model default environment preset
    // on the next model load/reload, overwriting the preset's ground/floor/bg
    // fields → the preset stops matching and the dropdown shows "Custom".
    expect(hasUserEnvironmentOverride()).toBe(false);
    applyVisualPreset(viewer, makePreset('Default'));
    expect(hasUserEnvironmentOverride()).toBe(true);
  });

  it('reports Custom (null) when the user changes a captured field', () => {
    const def = makePreset('Default');
    const presets = [def];
    applyVisualPreset(viewer, def);
    const s = loadVisualSettings();
    s.fov = s.fov + 7; // a genuine user edit of a captured field
    saveVisualSettings(s);
    expect(matchPreset(presets)).toBeNull();
  });
});

describe('seedInitialVisualPreset — fresh install', () => {
  beforeEach(() => {
    localStorage.clear();
    setAppConfig({});
  });

  it('seeds the Default preset on a fresh install and reports it as active', () => {
    // A Default preset that differs from the built-in code defaults.
    putLocalPreset(makePreset('Default', { fov: 60, checkerContrast: 0.7, envReflectionsEnabled: true }));

    expect(hasUserEnvironmentOverride()).toBe(false);
    const seeded = seedInitialVisualPreset('Default');

    expect(seeded).toBe(true);
    expect(loadVisualSettings().fov).toBe(60);            // Default preset's value, not the code default (45)
    expect(hasUserEnvironmentOverride()).toBe(true);      // so the model-load env preset won't clobber it
    expect(matchPreset(listPresets())).toBe('Default');   // dropdown shows "Default", not "Custom"
  });

  it('does not overwrite existing settings (no-op when not a fresh install)', () => {
    putLocalPreset(makePreset('Default', { fov: 60 }));
    saveVisualSettings({ ...loadVisualSettings(), fov: 33 }); // user already has settings

    const seeded = seedInitialVisualPreset('Default');

    expect(seeded).toBe(false);
    expect(loadVisualSettings().fov).toBe(33);            // left untouched
  });

  it('is a no-op (keeps code defaults) when the named preset is unavailable', () => {
    expect(seedInitialVisualPreset('Default')).toBe(false);
    expect(hasUserEnvironmentOverride()).toBe(false);
  });
});
