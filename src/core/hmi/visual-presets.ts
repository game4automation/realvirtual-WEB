// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * Visual presets — named snapshots of the full visual look: render mode +
 * per-mode lighting/shadows, ground/background/reflection, tone mapping,
 * AO/bloom/toon, projection/FOV, and antialias. A superset of the legacy
 * environment presets (which only captured floor/background).
 *
 * Three tiers, all merged by {@link listPresets} (later tier wins on name clash):
 *  - **builtin**   — code constants in this file → always shipped in the JS bundle.
 *  - **published** — `public/presets/<stem>.preset.json`, enumerated by
 *                    `public/presets/index.json`, fetched at boot. Authored via
 *                    "Save settings as preset" in DEV (written to disk by the
 *                    `rv-preset-save` Vite plugin) → committed to git → part of
 *                    the published source.
 *  - **local**     — `localStorage['rv-visual-presets']` → production fallback /
 *                    pre-commit session storage (a static deploy cannot write git).
 */

import type { RVViewer } from '../rv-viewer';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings,
  hasStoredVisualSettings,
  type VisualSettings,
} from './visual-settings-store';
import { markEnvironmentUserModified } from './environment-presets';
import { deepCloneJSON } from '../ops/rv-op-utils';
import { RENDER_MODE_IDS } from '../rv-render-modes';

/** VisualSettings keys a preset captures — the "full visual look + antialias".
 *  Deliberately excludes camera bookmarks, FPV/orbit navigation, and UI zoom. */
export const VISUAL_PRESET_FIELDS = [
  'renderMode', 'modeSettings', 'projection', 'fov', 'antialias',
  'shadowMapSize', 'shadowRadius', 'maxDpr',
  'aoMode', 'ssaoIntensity', 'ssaoRadius',
  'bloomEnabled', 'bloomIntensity', 'bloomThreshold', 'bloomRadius',
  'toonBands', 'toonMetallic', 'toonMetallicColor',
  'toonAlbedoMinBrightness', 'toonAlbedoMaxBrightness', 'toonAlbedoSaturation',
  'toonOutlineAmount', 'toonOutlineThickness', 'toonOutlineThreshold',
  'toonOutlineDistance', 'toonOutlineSupersample', 'toonOutlineColor',
  'toonCoolShadows',
  'groundEnabled', 'groundBrightness', 'groundColor',
  'backgroundBrightness', 'checkerContrast',
  'reflectionEnabled', 'reflectionStrength', 'reflectionBlur',
  'envReflectionsEnabled', 'envReflectionsIntensity',
  // UI compositor cost (plan-344 Phase 2). The ONLY UI field a preset captures —
  // it belongs here because it is a quality/performance dial like the render
  // fields, not a layout preference. See the explicit normalisation in
  // `applyVisualPreset` for why it does not follow the generic preserve rule.
  'uiBlurScale',
] as const;

export type VisualPresetField = typeof VISUAL_PRESET_FIELDS[number];
export type VisualPresetSettings = Pick<VisualSettings, VisualPresetField>;

export interface VisualPreset {
  name: string;
  schemaVersion: 1;
  settings: VisualPresetSettings;
}

/** What an apply did (plan-591). `antialias` is a renderer CONSTRUCTOR
 *  parameter, so a preset that flips it only takes effect after a reload —
 *  `antialiasNeedsReload` is the one signal the reload hint is derived from, and
 *  it is produced HERE so every view (menu row, Visual tab, MCP tool) gets the
 *  same answer instead of recomputing it. */
export interface ApplyPresetResult {
  /** Name of the preset that was applied. */
  name: string;
  /** Which tier it was resolved from: a shipped `public/presets` file, or a
   *  browser-local one. */
  source: 'shipped' | 'local';
  /** True when the applied `antialias` now differs from the renderer's actual
   *  `antialiasActive` — i.e. a reload would change the picture. */
  antialiasNeedsReload: boolean;
}

/** Where a preset NAME may be resolved from (plan-591 F12). `'shipped'` means
 *  only `public/presets` — a browser-local preset of the same name must not
 *  hijack it; `'any'` is the generic tier order of {@link listPresets}. */
export type PresetSource = 'shipped' | 'any';

const LOCAL_KEY = 'rv-visual-presets';

/**
 * How many preset applies have happened in this session (plan-591).
 *
 * The reload hint is DERIVED (`settings.antialias !== viewer.antialiasActive`),
 * so a plain boolean could not tell "dismissed" from "shown again": after a
 * dismiss the very same apply would never bring it back. This counter is the
 * second half of the snapshot — the hint is visible while
 * `mismatch && epoch !== dismissedEpoch`, so EVERY apply shows it again, the
 * identical one included. Session state only, nothing persisted.
 *
 * Incremented BEFORE the apply persists, so a listener woken by
 * `saveVisualSettings` already reads the new value.
 */
let _applyEpoch = 0;

/** Current apply epoch — see {@link _applyEpoch}. */
export function getVisualPresetApplyEpoch(): number { return _applyEpoch; }

/** Pick the preset-relevant subset of a full settings object, in canonical
 *  field order, deep-cloned so a preset never aliases live state. The stable
 *  key order also makes JSON.stringify usable for equality (see matchPreset). */
function pickPresetFields(s: VisualSettings): VisualPresetSettings {
  const out: Record<string, unknown> = {};
  for (const k of VISUAL_PRESET_FIELDS) out[k] = s[k];
  return deepCloneJSON(out) as VisualPresetSettings;
}

/** True when every field the preset *explicitly defines* (deeply, including the
 *  per-render-mode lighting blocks) equals the corresponding value in the current
 *  preset-field snapshot `cur`.
 *
 *  applyVisualPreset overlays a preset on the live settings, so a field the preset
 *  omits is left at whatever it already was. The live state therefore "is" preset
 *  P exactly when the fields P actually sets all agree — fields P omits are
 *  unconstrained. Matching on this subset (rather than a defaults-filled
 *  normalization) keeps the dropdown label correct WITHOUT forcing apply to reset
 *  omitted fields, which would change the rendered look. Omissions are common: a
 *  preset file predates a field added later to {@link VISUAL_PRESET_FIELDS} (e.g.
 *  the `envReflections*` fields added after the Default/Sketch presets were saved). */
function presetDefinedFieldsMatch(presetSettings: Partial<VisualSettings>, cur: VisualPresetSettings): boolean {
  const ps = presetSettings as Record<string, unknown>;
  const curRec = cur as unknown as Record<string, unknown>;
  for (const k of VISUAL_PRESET_FIELDS) {
    const pv = ps[k];
    if (pv === undefined) continue; // preset omits this field → unconstrained
    if (k === 'modeSettings') {
      const pModes = pv as Record<string, Record<string, unknown>>;
      const cModes = curRec.modeSettings as Record<string, Record<string, unknown>> | undefined;
      for (const mode of Object.keys(pModes)) {
        const pm = pModes[mode];
        if (pm == null || typeof pm !== 'object') continue;
        const cm = cModes?.[mode];
        if (cm == null) return false;
        for (const f of Object.keys(pm)) {
          if (pm[f] !== cm[f]) return false;
        }
      }
    } else if (JSON.stringify(pv) !== JSON.stringify(curRec[k])) {
      return false;
    }
  }
  return true;
}

function isValidPreset(p: unknown): p is VisualPreset {
  const o = p as VisualPreset | null;
  return !!o && typeof o === 'object'
    && typeof o.name === 'string'
    && o.schemaVersion === 1
    && !!o.settings && typeof o.settings === 'object';
}

// ─── Capture / apply ──────────────────────────────────────────────────────

/** Snapshot the current live visual settings as a named preset. */
export function captureCurrentPreset(name: string): VisualPreset {
  return { name, schemaVersion: 1, settings: pickPresetFields(loadVisualSettings()) };
}

/** Overlay a preset's fields on a base settings object, guaranteeing every render
 *  mode still carries full lighting settings even if the preset's modeSettings is
 *  partial/empty (hand-edited or older file) — else viewer.applyVisualSettings
 *  dereferences an undefined active mode. */
function mergePresetOverBase(base: VisualSettings, preset: VisualPreset): VisualSettings {
  const def = getDefaultVisualSettings();
  const ps = preset.settings as Partial<VisualSettings>;
  const psModes = (ps.modeSettings ?? {}) as Partial<VisualSettings['modeSettings']>;
  return {
    ...base,
    ...ps,
    // ── Documented exception to the generic preserve semantics (plan-344 R6) ──
    // Everywhere else, a field a preset omits is left at its previous value
    // (see presetDefinedFieldsMatch: omitted = unconstrained). For
    // `uiBlurScale` that would be a user-visible bug: switching from `Fast`
    // (0.25) to an older `Default` preset that predates the field would leave
    // the HMI on Fast's blur while the dropdown says "Default". So this ONE
    // field normalises to its default when the preset does not define it. The
    // generic rule and the test that protects it stay untouched, and
    // `schemaVersion` stays 1 — no preset file needs migrating.
    uiBlurScale: ps.uiBlurScale ?? def.uiBlurScale,
    modeSettings: mergeModeSettings(def.modeSettings, base.modeSettings, psModes),
  };
}

/** Per render mode (every id of RENDER_MODE_IDS): defaults ← base ← preset. */
function mergeModeSettings(
  def: VisualSettings['modeSettings'],
  base: VisualSettings['modeSettings'],
  ps: Partial<VisualSettings['modeSettings']>,
): VisualSettings['modeSettings'] {
  const out = {} as VisualSettings['modeSettings'];
  for (const mode of RENDER_MODE_IDS) {
    out[mode] = { ...def[mode], ...(base?.[mode] ?? {}), ...(ps[mode] ?? {}) };
  }
  return out;
}

/** Apply a preset: merge its fields over the current settings, persist, and
 *  push the whole thing to the viewer via the shared apply path (capability
 *  gating, render-mode switch, etc. all handled there). */
export function applyVisualPreset(viewer: RVViewer, preset: VisualPreset): ApplyPresetResult {
  // F10 (plan-591): drop the APPLIED wireframe view FIRST — the same step
  // `setRenderMode` takes (render-mode-controller.ts). While it is applied,
  // `_suppressWireframeEnvironment` runs per rendered FRAME and switches
  // shadows / AO / reflection back off right after this apply turned them on,
  // while `matchPreset` happily reports "Default". Only the applied state, never
  // the latent editor toggle: outside the editor that toggle is a setting the
  // user will find again, and a quality click must not clear it.
  if (viewer.wireframeActive) viewer.wireframe = false;
  _applyEpoch += 1;
  const merged = mergePresetOverBase(loadVisualSettings(), preset);
  saveVisualSettings(merged);
  // A visual preset carries an explicit environment look (ground/floor/background
  // /checker). Mark it as a user environment override so the model-load default
  // environment preset (rv-model-plugin-manager) does NOT re-clobber these fields
  // on the next reload/model load — otherwise the applied preset would stop
  // matching and the dropdown would show "Custom" after reload.
  markEnvironmentUserModified();
  viewer.applyVisualSettings(merged);
  return {
    name: preset.name,
    // Identity, not name: a local preset may share its name with a shipped one.
    source: _published.includes(preset) ? 'shipped' : 'local',
    antialiasNeedsReload: merged.antialias !== viewer.antialiasActive,
  };
}

/**
 * Apply the preset with the given NAME, resolved from the tier `source` names
 * (plan-591 F12).
 *
 * The one entry point behind the command `view.visualPreset`, and therefore
 * behind all three of its views (the quality rows of the render-mode menu, the
 * Visual tab's dropdown, the MCP tool). `source` travels all the way here
 * instead of stopping at the caller's lookup: a row that resolved the SHIPPED
 * "Default" must not end up applying a browser-local one of the same name,
 * which is exactly what dispatching on the bare name would do
 * ({@link listPresets} lets local win on a clash).
 *
 * Returns null when the name does not exist in that tier — deliberately no
 * fallback to the other tier: the caller refuses with a reason instead of
 * silently applying something else.
 */
export function applyVisualPresetByName(
  viewer: RVViewer,
  name: string,
  source: PresetSource = 'any',
): ApplyPresetResult | null {
  const preset = presetsForSource(source).find((p) => p.name === name);
  if (!preset) return null;
  return applyVisualPreset(viewer, preset);
}

/** On a fresh install (no persisted visual settings), seed the named published
 *  preset — default `"Default"` — as the initial visual settings, so the viewer
 *  boots with that look and the Visual-settings dropdown shows it instead of
 *  "Custom". No-op once the user has any saved visual settings, and a no-op if the
 *  named preset isn't available (e.g. published presets failed to load) — in which
 *  case the built-in code defaults stand.
 *
 *  Must be called AFTER {@link loadPublishedPresets}. Marks an environment override
 *  (same as {@link applyVisualPreset}) so the model-load environment preset does
 *  not clobber the seeded preset's environment on the first model load. */
export function seedInitialVisualPreset(presetName = 'Default'): boolean {
  if (hasStoredVisualSettings()) return false;
  const preset = listPresets().find((p) => p.name === presetName);
  if (!preset) return false;
  const merged = mergePresetOverBase(getDefaultVisualSettings(), preset);
  saveVisualSettings(merged);
  markEnvironmentUserModified();
  return true;
}

/** Return the name of the preset that the given settings (default: current live
 *  settings) were produced by applying, or null when none matches.
 *
 *  A preset matches when every field it explicitly defines equals the live value
 *  (see {@link presetDefinedFieldsMatch}) — fields the preset omits are ignored,
 *  because applyVisualPreset leaves those untouched. This is intentionally a
 *  subset match, not a defaults-filled equality, so the label stays correct after
 *  switching presets without the apply path having to reset omitted fields. */
export function matchPreset(presets: VisualPreset[], settings?: VisualSettings): string | null {
  const cur = pickPresetFields(settings ?? loadVisualSettings());
  for (const p of presets) {
    if (presetDefinedFieldsMatch(p.settings as Partial<VisualSettings>, cur)) return p.name;
  }
  return null;
}

// ─── Local (localStorage) presets ─────────────────────────────────────────

function loadLocalPresets(): VisualPreset[] {
  try {
    const raw = readLocalStorage(LOCAL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isValidPreset) : [];
  } catch { return []; }
}

function saveLocalPreset(p: VisualPreset): void {
  const list = loadLocalPresets().filter((x) => x.name !== p.name);
  list.push(p);
  try { writeLocalStorage(LOCAL_KEY, JSON.stringify(list)); } catch { /* quota — ignore */ }
}

// ─── Published (public/presets) presets ───────────────────────────────────

let _published: VisualPreset[] = [];

/** Fetch the shipped preset manifest (`public/presets/index.json`) and each
 *  referenced `<stem>.preset.json`. Safe to call anytime; a missing manifest
 *  (404) just yields no published presets. */
export async function loadPublishedPresets(): Promise<void> {
  try {
    const base = import.meta.env.BASE_URL ?? '/';
    const idxResp = await fetch(`${base}presets/index.json`, { cache: 'no-store' });
    if (!idxResp.ok) return;
    const stems = await idxResp.json();
    if (!Array.isArray(stems)) return;
    const loaded: VisualPreset[] = [];
    for (const stem of stems) {
      try {
        const r = await fetch(`${base}presets/${encodeURIComponent(String(stem))}.preset.json`, { cache: 'no-store' });
        if (r.ok) {
          const p = await r.json();
          if (isValidPreset(p)) loaded.push(p);
        }
      } catch { /* skip a bad file */ }
    }
    _published = loaded;
  } catch { /* no presets dir — fine */ }
}

// ─── List + save ──────────────────────────────────────────────────────────

/** All presets, deduped by name. published → local (local wins on a name
 *  clash). Presets are shipped as files under public/presets/ (plus any
 *  browser-local ones authored in production); there are no hardcoded built-ins. */
export function listPresets(): VisualPreset[] {
  const byName = new Map<string, VisualPreset>();
  for (const p of _published) byName.set(p.name, p);
  for (const p of loadLocalPresets()) byName.set(p.name, p);
  return [...byName.values()];
}

/**
 * Only the SHIPPED presets — the `public/presets` files, without the
 * browser-local tier (plan-591 F12).
 *
 * The two fixed quality rows mean a specific, known look: the "Default" that
 * ships with the product. {@link listPresets} lets a local preset of the same
 * name win, so a user who once saved a throwaway "Default" would have hijacked
 * "Max Quality". An export in the module that owns `_published` — no outside
 * access to a module private.
 */
export function listShippedPresets(): VisualPreset[] {
  return [..._published];
}

/**
 * THE one resolver behind `source` (plan-591 F12).
 *
 * Both the validity check of the command (`enabled`) and its apply (`run`) go
 * through this, so the list a refusal text is derived from is the same list the
 * apply resolves against. Two lists would mean a row can mark a preset active,
 * or accept it, that it would never actually apply.
 */
export function presetsForSource(source: PresetSource = 'any'): VisualPreset[] {
  return source === 'shipped' ? listShippedPresets() : listPresets();
}

/**
 * Persist a preset. In DEV, POST to the `rv-preset-save` Vite endpoint so it is
 * written into `public/presets/` (part of the published source) and refresh the
 * published cache. Otherwise (production, or endpoint failure) fall back to
 * localStorage. Returns where it landed.
 */
export async function savePreset(preset: VisualPreset): Promise<'file' | 'local'> {
  if (import.meta.env.DEV) {
    try {
      const r = await fetch('/api/preset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: preset.name, preset }),
      });
      if (r.ok) {
        await loadPublishedPresets();
        return 'file';
      }
    } catch { /* fall through to local */ }
  }
  saveLocalPreset(preset);
  return 'local';
}
