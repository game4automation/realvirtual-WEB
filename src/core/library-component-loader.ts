// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Naming-Convention loader.
 *
 * Scans an entire GLB tree (no marker required) and produces a
 * KinematicsSpec from name-based conventions:
 *
 *   - `Drive-Lin-X/Y/Z`           → RVDrive, Direction = Linear{X,Y,Z}
 *   - `Drive-Rot-X/Y/Z`           → RVDrive, Direction = Rotation{X,Y,Z}
 *   - `Transport-X/Y/Z`           → RVTransportSurface, +X/+Y/+Z axis,
 *                                   parent Drive-* (if any) is auto-linked
 *   - `Sensor` / `Sensor-<id>`    → RVSensor (e.g. `Sensor`, `Sensor-1`, `Sensor-Infeed`)
 *   - `DriveMesh`, `Base`         → hierarchy tags (no component emitted)
 *   - `Snap-<DIR>-<TYPEID>`       → handled by snap-point plugin, untouched
 *
 * The Unity-side `WebLibraryComponent` marker is optional — it serves as
 * a diagnostic hint for asset authors and is detected by `hasLibraryMarker`,
 * but the scanner runs on every loaded GLB regardless. False positives are
 * unlikely because the patterns are specific.
 *
 * Existing `userData.realvirtual` on a node is preserved by the
 * downstream `applyKinematicsSpec` deep-merge (F13).
 */

import type { Object3D } from 'three';
import type {
  KinematicsSpec,
  DirectionEnum,
  AxisCode,
} from './behavior-runtime';

// ─── Name parsers ───────────────────────────────────────────────────────

/** Drive-Lin-X / Drive-Rot-Y / ... — returns Direction enum value or null. */
export function parseDriveName(name: string): DirectionEnum | null {
  const m = /^Drive-(Lin|Rot)-([XYZ])$/.exec(name);
  if (!m) return null;
  const kind = m[1] === 'Lin' ? 'Linear' : 'Rotation';
  return (kind + m[2]) as DirectionEnum;
}

/** Transport-X / Transport-Y / Transport-Z — returns axis code or null. */
export function parseTransportName(name: string): AxisCode | null {
  const m = /^Transport-([XYZ])$/.exec(name);
  if (!m) return null;
  return ('+' + m[1]) as AxisCode;
}

/** Sensor — bare `Sensor` or `Sensor-<id>` (e.g. `Sensor-1`, `Sensor-Infeed`), also
 *  tolerating a Unity/exporter duplicate-name suffix like `Sensor_(1)` / `Sensor (1)`
 *  (two same-named nodes → one gets a `(N)` suffix on GLB export). */
export function isSensorName(name: string): boolean {
  return /^Sensor(-.*)?([_ ]?\(\d+\))?$/.test(name);
}

/** Carrier — bare `Carrier` or `Carrier-<id>` (e.g. `Carrier-1`, `Carrier-Front`),
 *  same suffix tolerance as sensors (plan-268 Phase 4). Overhead-conveyor carriers
 *  are inherently PLURAL, so they are bound via `self.findAll('carrier')` (DFS
 *  traversal order = deterministic pitch index), NOT via the `requires` block
 *  (which injects only the first match). */
export function isCarrierName(name: string): boolean {
  return /^Carrier(-.*)?([_ ]?\(\d+\))?$/.test(name);
}

// ─── Node finders (for behavior files) ──────────────────────────────────
// Behavior files use these to locate kinematics by the same conventions the
// scanner wires up, instead of hardcoded node names. They live here (not in
// src/behaviors/) because the behavior auto-discovery glob requires every
// src/behaviors/*.ts to have a default export.

/** First node in the subtree (root included) for which `test` returns true, or null. */
export function findFirst(root: Object3D, test: (node: Object3D) => boolean): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((o) => { if (!found && test(o)) found = o; });
  return found;
}

/** All nodes in the subtree (root included) for which `test` returns true. */
export function findAll(root: Object3D, test: (node: Object3D) => boolean): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((o) => { if (test(o)) out.push(o); });
  return out;
}

/** True when the node carries a WebViewer-native `rv_extras.Path` payload
 *  (plan-268). Detection is coupled to the PAYLOAD (`userData.realvirtual.Path`
 *  with inner `type === 'Path'` or no inner type), NEVER to the node name —
 *  a node merely NAMED "Path" is not a path (plan-268 §10 review risk). */
export function hasPathExtras(node: Object3D): boolean {
  const rv = (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
  const p = rv?.['Path'];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const t = (p as Record<string, unknown>).type;
  return t === undefined || t === 'Path';
}

/** The node predicate for each convention-based node kind. All but `path` are
 *  name-based; `path` is payload-based (see {@link hasPathExtras}). */
export const NODE_KIND_TESTS = {
  transport: (n: Object3D): boolean => parseTransportName(n.name) !== null,
  sensor: (n: Object3D): boolean => isSensorName(n.name),
  rotary: (n: Object3D): boolean => (parseDriveName(n.name) ?? '').startsWith('Rotation'),
  path: (n: Object3D): boolean => hasPathExtras(n),
  carrier: (n: Object3D): boolean => isCarrierName(n.name),
} as const;

/** First `Transport-X/Y/Z` node — a belt surface (carries a co-located Drive). */
export function findTransport(root: Object3D): Object3D | null {
  return findFirst(root, (n) => parseTransportName(n.name) !== null);
}

/** First `Drive-Rot-X/Y/Z` node — a rotary axis. */
export function findRotaryDrive(root: Object3D): Object3D | null {
  return findFirst(root, (n) => (parseDriveName(n.name) ?? '').startsWith('Rotation'));
}

/** First `Drive-Lin-X/Y/Z` node — a linear axis. */
export function findLinearDrive(root: Object3D): Object3D | null {
  return findFirst(root, (n) => (parseDriveName(n.name) ?? '').startsWith('Linear'));
}

/** First `Sensor-…` node. */
export function findSensor(root: Object3D): Object3D | null {
  return findFirst(root, (n) => isSensorName(n.name));
}

/** True when name is a structural tag with no associated component. */
export function isStructuralTag(name: string): boolean {
  return name === 'DriveMesh' || name === 'Base';
}

// ─── Scanner ────────────────────────────────────────────────────────────

/**
 * Walk the sub-tree under `root` and produce a spec for every
 * convention-named node found. The root itself is included in the scan
 * (a Drive-Lin-Y named root is itself a drive). No marker is required —
 * pass the GLB root directly.
 *
 * Snap-* nodes are intentionally NOT included — the existing snap-point
 * plugin reads names directly without needing rv_extras.
 *
 * Drive auto-synthesis: every `Transport-<AXIS>` that does NOT live under
 * an existing `Drive-*` parent gets a synthetic linear Drive emitted ON
 * THE SAME NODE in the matching axis. This lets minimal library assets
 * (e.g. a roller conveyor with only `Transport-Z` + `DriveMesh`) work
 * out-of-the-box — the Transport surface picks up the co-located Drive
 * via `RVTransportSurface.init`'s `findInParent('Drive')` fallback.
 */
export function scanLibraryComponent(root: Object3D): KinematicsSpec {
  const spec: KinematicsSpec = { drives: [], transports: [], sensors: [] };

  const traverse = (node: Object3D): void => {
    const driveDir = parseDriveName(node.name);
    if (driveDir) {
      spec.drives!.push({ target: node, direction: driveDir });
    } else if (isSensorName(node.name)) {
      // Sensor / Sensor-<id> → RVSensor. AutoRay derives a raycast beam along the
      // node's longest bounding-box edge (centre face → centre face) for both the
      // colored line visualization and detection.
      spec.sensors!.push({ target: node, extra: { AutoRay: true } });
    } else {
      const transportDir = parseTransportName(node.name);
      if (transportDir) {
        // ALWAYS attach a Drive to the Transport on the SAME node — even
        // when an ancestor Drive-* exists, the surface needs its own
        // co-located drive (the ancestor may be used for unrelated motion,
        // e.g. a lift that moves the whole conveyor sub-assembly). Direction
        // matches the transport axis: Transport-Z → LinearZ.
        const axis = transportDir[1] as 'X' | 'Y' | 'Z';
        spec.drives!.push({
          target: node,
          direction: ('Linear' + axis) as DirectionEnum,
        });
        spec.transports!.push({
          target: node,
          direction: transportDir,
          // No explicit drive ref: RVTransportSurface.init falls back to
          // `findInParent('Drive')` which picks up the co-located Drive
          // we just emitted on the same node.
        });
      }
      // Structural tags + everything else: no component, just recurse.
    }
    for (const child of node.children) traverse(child);
  };

  traverse(root);
  return spec;
}

/**
 * Diagnostic only — true if a node carries the `WebLibraryComponent`
 * rv_extras marker. The marker is NOT required for naming-convention
 * scanning; `scanLibraryComponent` works on any tree.
 */
export function hasLibraryMarker(node: Object3D): boolean {
  const ud = node.userData as { realvirtual?: Record<string, unknown> } | undefined;
  return !!ud?.realvirtual?.['WebLibraryComponent']
      || !!ud?.realvirtual?.['LibraryComponent'];
}
