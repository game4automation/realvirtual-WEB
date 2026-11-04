// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-layers.ts — Unity physics layers in the web (plan-2016 S6c).
 *
 * Unity stores a node's layer as an INDEX (`extras.realvirtual.layer`, 0..31);
 * what the index means is project-wide (Unity `ProjectSettings/TagManager.asset`).
 * Components that filter by layer NAME — `Sensor.AdditionalRayCastLayers` — need
 * the index→name table:
 *
 * - the **default table**: Unity's built-in layers (0..5) plus the canonical
 *   realvirtual layers, which the realvirtual project setup always creates at
 *   13 and up (`ProjectSettingsTools.RealvirtualLayers`: rvMUSensor = 13 …
 *   rvCollissionCheck = 23);
 * - a **file table** on the scene extras, `scenes[0].extras.realvirtual.layerNames`
 *   — an array of up to 32 names, index = layer, `""` = unused — for projects with
 *   own layers (e.g. 24 = `MauserParts`). Every decoded GLB registers its table
 *   here (`parseGlbCollectingResources`); like Unity's one TagManager the table is
 *   scene-wide, a later file overrides a conflicting index (with a warning).
 *
 * Lifetime (plan-2016 Codex review): the table belongs to the loaded SCENE, not to
 * the page. `RVViewer.clearModel()` calls {@link resetLayerNames} before the next
 * main model is decoded, so a former model's names do not leak into the next
 * scene. Within a scene the tables of all its files (main model, placements) are
 * merged; an empty entry never clears a name (exporters write `""` for every
 * index they do not set, the standard layers included). Every change bumps
 * {@link getLayerRevision} so cached masks
 * (`RVSensor.rayLayerMask`, `WebPhysicsZone.layerMask`) are rebuilt.
 *
 * Layer of a node: its `extras.realvirtual.layer`, or for a spawned MU clone (whose
 * extras are stripped) the stash {@link RV_LAYER_KEY}. `-1` = unknown — an unknown
 * layer is never filtered out (web-authored parts carry no layer).
 */

import type { Object3D } from 'three';

/** `userData` key of the layer index a spawned MU clone keeps after its rv-extras are stripped. */
export const RV_LAYER_KEY = '_rvLayer';

/** Number of Unity layers. */
export const LAYER_COUNT = 32;

/** Unity built-in layers + the canonical realvirtual layers (index = layer). */
export const DEFAULT_LAYER_NAMES: readonly string[] = Object.freeze([
  'Default', 'TransparentFX', 'Ignore Raycast', '', 'Water', 'UI', '', '',
  '', '', '', '', '',
  'rvMUSensor', 'rvMUTransport', 'rvSensor', 'rvTransport', 'rvMU', 'rvSnapping',
  'rvSimDynamic', 'rvSimStatic', 'rvSelection', 'rvSceneMesh', 'rvCollissionCheck',
  '', '', '', '', '', '', '', '',
]);

const _names: string[] = [...DEFAULT_LAYER_NAMES];
/** Bumped on every table change — masks built from names cache against it. */
let _revision = 0;

/** Current layer table (index = layer, `""` = unused). */
export function getLayerNames(): readonly string[] {
  return _names;
}

/** Revision of the layer table; changes whenever a name changes or the table is reset. */
export function getLayerRevision(): number {
  return _revision;
}

/**
 * Restore the default table — called when the scene context ends
 * (`RVViewer.clearModel()`, before the next model is decoded) and by tests.
 */
export function resetLayerNames(): void {
  for (let i = 0; i < LAYER_COUNT; i++) _names[i] = DEFAULT_LAYER_NAMES[i];
  _revision++;
}

/**
 * Register a file's layer table from its scene `userData` (= scene extras):
 * `realvirtual.layerNames`. Non-string / empty entries are skipped; a name that
 * conflicts with one an earlier file of the same scene registered overrides it
 * (with a warning). Returns the number of names taken over.
 */
export function registerFileLayerNames(sceneUserData: unknown): number {
  const rv = (sceneUserData as { realvirtual?: { layerNames?: unknown } } | null | undefined)?.realvirtual;
  const list = rv?.layerNames;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  let changed = false;
  for (let i = 0; i < Math.min(list.length, LAYER_COUNT); i++) {
    const name = list[i];
    if (typeof name !== 'string' || name === '') continue;
    if (_names[i] !== name) {
      if (_names[i] !== '' && _names[i] !== DEFAULT_LAYER_NAMES[i]) {
        console.warn(`[layers] layer ${i} renamed from "${_names[i]}" to "${name}" by a loaded file`);
      }
      _names[i] = name;
      changed = true;
    }
    n++;
  }
  if (changed) _revision++;
  return n;
}

/** Layer index of `name`, or -1. */
export function layerIndexOf(name: string): number {
  return name ? _names.indexOf(name) : -1;
}

/** Layer index of a node: its rv-extras `layer`, else the clone stash; -1 = unknown. */
export function layerOfNode(node: Object3D): number {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (!ud) return -1;
  const rv = ud.realvirtual as { layer?: unknown } | undefined;
  const v = rv && typeof rv === 'object' ? rv.layer : ud[RV_LAYER_KEY];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < LAYER_COUNT ? v : -1;
}

/** The string entries of a raw layer-name list (an old export wrote strings as `{}`). */
export function layerNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) if (typeof v === 'string' && v !== '') out.push(v);
  return out;
}

/** Result of {@link buildLayerMask}. */
export interface LayerMaskResult {
  /** Bit mask over the layer indices; `null` = no filter (detect every layer). */
  mask: number | null;
  /** Names that are not in the layer table. */
  unknown: string[];
  /** The raw value was a non-empty list without a single string entry — the broken
   *  Unity export of `List<string>` (`[{}, {}]`). Caller should warn. */
  broken?: boolean;
}

/**
 * Filter mask of a name list WITHOUT an own layer (`WebPhysicsZone.LimitToLayers`):
 * Unity `LayerMask.GetMask(names)`. No valid name at all — an empty or broken
 * list, or none that resolves — means no filter.
 */
export function buildLayerMask(rawNames: unknown): LayerMaskResult {
  const names = layerNameList(rawNames);
  const unknown: string[] = [];
  let mask = 0;
  let resolved = 0;
  for (const name of names) {
    const i = layerIndexOf(name);
    if (i < 0) { unknown.push(name); continue; }
    mask |= 1 << i;
    resolved++;
  }
  return { mask: resolved === 0 ? null : mask, unknown };
}

/**
 * Raycast mask of a sensor — Unity `Sensor.Start()`:
 * `AdditionalRayCastLayers.Add(LayerToName(gameObject.layer))`, then
 * `LayerMask.GetMask(list)`: the names that resolve PLUS the sensor's own layer.
 *
 * NO FILTER (`mask: null`) whenever the list carries no usable name: the field is
 * missing (models exported before it existed), the list is EMPTY, or it is the
 * broken Unity export of `List<string>` (`[{}, {}]` — `broken: true`, the caller
 * warns). An empty list meaning "own layer only" (7d19d6d8) blinded every model
 * whose export wrote an empty array — withdrawn by Thomas on 2026-10-29,
 * plan-2016 point (e) hardening.
 *
 * Unknown names: `GetMask` drops them, and so does this mask as long as one name
 * resolves. When names were given but NONE resolves, the web is missing the
 * project's layer table (a file without `layerNames`) — then no filter, instead of
 * blinding the sensor to everything but its own layer.
 */
export function buildRaycastLayerMask(rawNames: unknown, ownLayer = -1): LayerMaskResult {
  if (!Array.isArray(rawNames)) return { mask: null, unknown: [] };
  if (layerNameList(rawNames).length === 0) {
    return { mask: null, unknown: [], broken: rawNames.length > 0 };
  }
  const unknown: string[] = [];
  let mask = 0;
  let resolved = 0;
  for (const name of rawNames) {
    if (typeof name !== 'string' || name === '') continue;
    const i = layerIndexOf(name);
    if (i < 0) { unknown.push(name); continue; }
    mask |= 1 << i;
    resolved++;
  }
  if (resolved === 0 && unknown.length > 0) return { mask: null, unknown };
  if (ownLayer >= 0 && ownLayer < LAYER_COUNT) mask |= 1 << ownLayer;
  return { mask, unknown };
}

/** Does `layer` pass `mask`? A null mask or an unknown layer (-1) always passes. */
export function layerPasses(mask: number | null, layer: number): boolean {
  return mask === null || layer < 0 || ((mask >>> layer) & 1) === 1;
}
