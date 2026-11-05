// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Names of the RUNTIME visualisation a Sensor builds on every load
 * (rv-sensor.ts): the box `<node>_sensorViz` and the ray tube `<node>_sensorRay`.
 *
 * Neither is file content. The export used to prune only `_sensorViz`, so every
 * save wrote the ray tube into the GLB and the next load built another one next
 * to it — one more beam per round trip. Three.js / the export dedup then
 * renamed the copies `_sensorRay_1`, `_sensorRay_1_1`, … which is why the match
 * accepts any run of `_<n>` suffixes: a file polluted before the fix is cleaned
 * by the same rule that keeps new saves clean. The box outline
 * (`<node>_sensorViz_edges`) used to be unnamed and is matched the same way.
 */
import type { Object3D } from 'three';
import { isSensorName } from '../library-component-loader';
import { RV_ORIG_NAME_KEY, RV_SEEDED_NODE_ID_KEY } from './rv-authored-keys';

const SENSOR_RUNTIME_VIZ_NAME = /_sensor(?:Viz|Ray)(?:_edges)?(?:_\d+)*$/;

/** True for a node name produced by a Sensor's runtime visualisation (any dedup suffix). */
export function isSensorRuntimeVizName(name: string): boolean {
  return SENSOR_RUNTIME_VIZ_NAME.test(name);
}

/** Name AND the runtime marker the Sensor sets: destructive paths act on nothing else. */
export function isConfirmedSensorRuntimeViz(node: Object3D): boolean {
  return isSensorRuntimeVizName(node.name) && (node.userData as Record<string, unknown> | undefined)?.['_rvRuntimeVisual'] === true;
}

const LEGACY_VIZ_SUFFIX = /^_sensor(?:Viz|Ray)(?:_edges)?(?:_\d+)*$/;
const SENSOR_KEY = /^Sensor(?:_\d+)?$/;
/** Measured on shipped files (extras `{name}` or none) + loader stamps; else authored. */
const LEGACY_VIZ_USERDATA = new Set(['name', RV_ORIG_NAME_KEY, RV_SEEDED_NODE_ID_KEY]);

/** three's name and the authored one (`detectRenamedNodes`). */
function namesOf(node: Object3D): string[] {
  const orig = (node.userData as Record<string, unknown> | undefined)?.[RV_ORIG_NAME_KEY];
  return typeof orig === 'string' && orig && orig !== node.name ? [node.name, orig] : [node.name];
}

/** A Sensor by rv_extras or by convention name (the strip runs before the naming scan). */
export function isSensorNode(node: Object3D): boolean {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'];
  if (!!rv && typeof rv === 'object' && Object.keys(rv).some((k) => SENSOR_KEY.test(k))) return true;
  return namesOf(node).some(isSensorName);
}

/**
 * LEGACY MIGRATION, the one rule - applied only by the load strip, before the
 * naming scan: a DIRECT Mesh/line LEAF without authored extras of a Sensor node named
 * `<sensor>_sensorViz|_sensorViz_edges|_sensorRay` (+`_<n>`; three's and the
 * authored names, three dedups parent and child independently). Anything else is
 * authored. Every other path acts on the runtime marker only.
 */
export function isLegacySensorVizChild(child: Object3D, sensorNode: Object3D): boolean {
  if (child.parent !== sensorNode || child.children.length > 0) return false;
  const kind = child as { isMesh?: boolean; isLine?: boolean };
  if (!kind.isMesh && !kind.isLine) return false;
  for (const key of Object.keys(child.userData ?? {})) if (!LEGACY_VIZ_USERDATA.has(key)) return false;
  const parents = namesOf(sensorNode);
  return namesOf(child).some((name) => parents.some((p) =>
    name.startsWith(p) && LEGACY_VIZ_SUFFIX.test(name.slice(p.length))));
}

/**
 * THE legacy migration of every GLB entry: `loadGLB`, the bake recipe and
 * `parseGlbSubtreeWithMeta` (editor import, CAD reimport, composition), each
 * right after `detectRenamedNodes`, BEFORE the naming scan. Idempotent.
 */
export function stripPersistedSensorViz(root: Object3D): number {
  const stale: Object3D[] = [];
  root.traverse((node) => {
    if (!isSensorNode(node)) return;
    for (const child of node.children) if (isLegacySensorVizChild(child, node)) stale.push(child);
  });
  for (const node of stale) node.removeFromParent();
  return stale.length;
}
