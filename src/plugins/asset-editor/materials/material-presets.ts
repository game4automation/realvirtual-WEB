// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-presets — the material library behind the Materials window.
 *
 * A built-in set covering what industrial assemblies are actually made of
 * (machined metal, painted steel, plastic, rubber, guarding glass), plus
 * user-saved custom presets in localStorage.
 *
 * The built-in values are chosen to read correctly under the viewer's default
 * studio lighting rather than to be physically canonical: CAD assemblies are
 * lit by one environment map, and a textbook metalness=1 / roughness=0.1 steel
 * renders as a near-black mirror in that setting. Metals here sit around
 * roughness 0.35–0.55, which reads as metal without going to mirror.
 */

import type { MaterialValue } from '../../../core/editor/rv-asset-ops';

export interface MaterialPreset extends MaterialValue {
  /** Stable id — also the localStorage key for custom presets. */
  id: string;
  category: PresetCategory;
}

export type PresetCategory =
  | 'Metal'
  | 'Plastic'
  | 'Rubber & Glass'
  | 'Paint (RAL)'
  | 'Lamp / Signal'
  | 'Custom';

/** Display order of the category groups in the panel. */
export const PRESET_CATEGORIES: PresetCategory[] = [
  'Metal', 'Plastic', 'Rubber & Glass', 'Paint (RAL)', 'Lamp / Signal', 'Custom',
];

const m = (
  id: string, name: string, category: PresetCategory,
  color: string, metalness: number, roughness: number,
  extra?: Partial<MaterialValue>,
): MaterialPreset => ({
  id, name, category, color, metalness, roughness,
  opacity: 1, transparent: false, ...extra,
});

export const BUILTIN_MATERIAL_PRESETS: MaterialPreset[] = [
  // ── Metal ──
  m('steel',        'Steel',           'Metal', '#8a8f94', 1.0, 0.45),
  m('stainless',    'Stainless',       'Metal', '#b8bcc0', 1.0, 0.30),
  m('brushed-alu',  'Brushed Alu',     'Metal', '#c3c7ca', 1.0, 0.42),
  m('anodized',     'Anodized Alu',    'Metal', '#6e747a', 1.0, 0.52),
  m('chrome',       'Chrome',          'Metal', '#e8ecef', 1.0, 0.10),
  m('copper',       'Copper',          'Metal', '#b87333', 1.0, 0.38),
  m('brass',        'Brass',           'Metal', '#c9a227', 1.0, 0.40),
  m('galvanized',   'Galvanized',      'Metal', '#9aa3a8', 0.9, 0.60),
  m('cast-iron',    'Cast Iron',       'Metal', '#4a4d50', 0.8, 0.70),

  // ── Plastic ──
  m('plastic-black','Black Plastic',   'Plastic', '#1c1c1e', 0.0, 0.55),
  m('plastic-white','White Plastic',   'Plastic', '#e8e8e6', 0.0, 0.50),
  m('plastic-grey', 'Grey Plastic',    'Plastic', '#9a9a98', 0.0, 0.52),
  m('plastic-blue', 'Blue Plastic',    'Plastic', '#2c5f9e', 0.0, 0.48),
  m('ptfe',         'PTFE / Nylon',    'Plastic', '#f0eee8', 0.0, 0.42),

  // ── Rubber & Glass ──
  m('rubber',       'Rubber',          'Rubber & Glass', '#212124', 0.0, 0.90),
  m('belt',         'Conveyor Belt',   'Rubber & Glass', '#2e3033', 0.0, 0.80),
  m('glass',        'Glass',           'Rubber & Glass', '#cfe3ea', 0.0, 0.05,
    { opacity: 0.25, transparent: true }),
  m('guard',        'Guard Panel',     'Rubber & Glass', '#9fc5d1', 0.0, 0.15,
    { opacity: 0.40, transparent: true }),
  m('acrylic-amber','Amber Acrylic',   'Rubber & Glass', '#e8a33d', 0.0, 0.12,
    { opacity: 0.45, transparent: true }),

  // ── Paint (RAL) ── the tones that actually show up on machine frames
  m('ral-5015',     'RAL 5015 Sky Blue',   'Paint (RAL)', '#2271b3', 0.0, 0.45),
  m('ral-7035',     'RAL 7035 Light Grey', 'Paint (RAL)', '#cbd0cc', 0.0, 0.50),
  m('ral-7016',     'RAL 7016 Anthracite', 'Paint (RAL)', '#383e42', 0.0, 0.48),
  m('ral-9005',     'RAL 9005 Jet Black',  'Paint (RAL)', '#0a0a0d', 0.0, 0.50),
  m('ral-9016',     'RAL 9016 Traffic White','Paint (RAL)', '#f1f0ea', 0.0, 0.50),
  m('ral-1023',     'RAL 1023 Traffic Yellow','Paint (RAL)', '#fad201', 0.0, 0.45),
  m('ral-3020',     'RAL 3020 Traffic Red', 'Paint (RAL)', '#cc0605', 0.0, 0.45),
  m('ral-6018',     'RAL 6018 Yellow Green','Paint (RAL)', '#57a639', 0.0, 0.45),

  // ── Lamp / Signal ── IEC 60073 semantic colors (sRGB approximations)
  m('lamp-red',     'Signal Red',      'Lamp / Signal', '#E30613', 0.0, 0.30,
    { emissive: '#E30613', emissiveIntensity: 2 }),
  m('lamp-amber',   'Signal Amber',    'Lamp / Signal', '#F2A900', 0.0, 0.30,
    { emissive: '#F2A900', emissiveIntensity: 2 }),
  m('lamp-green',   'Signal Green',    'Lamp / Signal', '#008351', 0.0, 0.30,
    { emissive: '#008351', emissiveIntensity: 2 }),
  m('lamp-blue',    'Signal Blue',     'Lamp / Signal', '#0057B8', 0.0, 0.30,
    { emissive: '#0057B8', emissiveIntensity: 4 }),
  m('lamp-white',   'Signal White',    'Lamp / Signal', '#FFFFFF', 0.0, 0.25,
    { emissive: '#FFFFFF', emissiveIntensity: 3 }),
];

// ─── Custom presets (localStorage) ──────────────────────────────────────

const LS_KEY = 'rv-editor-material-presets';

/**
 * User-saved presets, newest first.
 *
 * Storage failures are swallowed and reported as "no custom presets": a private
 * browsing window or a corrupted entry must not take the Materials window down
 * with it — the built-in library still works.
 */
export function loadCustomPresets(): MaterialPreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPreset).map((p) => ({ ...p, category: 'Custom' as const }));
  } catch {
    return [];
  }
}

/** Append a custom preset. Returns the saved list, or null when storage failed. */
export function saveCustomPreset(value: MaterialValue, name: string): MaterialPreset[] | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const preset: MaterialPreset = {
    ...value,
    name: trimmed,
    id: `custom-${Date.now().toString(36)}`,
    category: 'Custom',
  };
  const next = [preset, ...loadCustomPresets()];
  return writeCustomPresets(next) ? next : null;
}

export function deleteCustomPreset(id: string): MaterialPreset[] {
  const next = loadCustomPresets().filter((p) => p.id !== id);
  writeCustomPresets(next);
  return next;
}

function writeCustomPresets(list: MaterialPreset[]): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Structural check — a hand-edited or half-written entry must not reach the UI. */
function isValidPreset(p: unknown): p is MaterialPreset {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return typeof o.id === 'string'
    && typeof o.name === 'string'
    && typeof o.color === 'string'
    && typeof o.metalness === 'number'
    && typeof o.roughness === 'number'
    && typeof o.opacity === 'number';
}

// ─── Swatch rendering ───────────────────────────────────────────────────

/**
 * A CSS background approximating how the preset will look, for the swatch grid.
 *
 * A radial gradient standing in for a lit sphere: a specular highlight whose
 * tightness follows roughness, over the base color. Metals get a cooler, darker
 * falloff (they reflect the environment rather than scattering), which is what
 * makes steel read as steel next to grey plastic at 28px.
 *
 * Deliberately CSS and not an offscreen render — 30+ live WebGL previews in a
 * side panel would cost more than the whole editor viewport.
 */
export function swatchBackground(v: MaterialValue): string {
  const shine = Math.max(0, 1 - v.roughness);
  const highlightSize = 10 + shine * 34;          // tight highlight = glossy
  const highlightAlpha = 0.12 + shine * 0.62;
  const shadeAlpha = 0.18 + v.metalness * 0.35;   // metals fall off darker
  const layers: string[] = [];
  if (v.emissive && (v.emissiveIntensity ?? 0) > 0) {
    const glowAlpha = Math.round(
      Math.min(0.8, 0.28 + (v.emissiveIntensity ?? 0) * 0.1) * 255,
    ).toString(16).padStart(2, '0');
    layers.push(
      `radial-gradient(circle at 50% 50%, ${v.emissive}${glowAlpha} 0%, `
      + `${v.emissive}55 42%, transparent 74%),`,
    );
  }
  layers.push(
    `radial-gradient(circle at 34% 28%,`,
    `rgba(255,255,255,${highlightAlpha.toFixed(2)}) 0%,`,
    `rgba(255,255,255,0) ${highlightSize.toFixed(0)}%),`,
    `radial-gradient(circle at 68% 78%,`,
    `rgba(0,0,0,${shadeAlpha.toFixed(2)}) 0%,`,
    `rgba(0,0,0,0) 62%),`,
    v.color,
  );
  return layers.join(' ');
}
