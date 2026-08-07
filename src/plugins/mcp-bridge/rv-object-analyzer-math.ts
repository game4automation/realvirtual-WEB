// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-object-analyzer-math.ts — pure layout/camera math for the
 * `web_screenshot_analyze` MCP tool (see rv-object-analyzer.ts).
 *
 * Deliberately renderer-free (no three.js imports) so every function is
 * trivially unit-testable: view definitions, the mosaic tile layout, and
 * small parsing/formatting helpers.
 */

/** Minimal vector shape — matches THREE.Vector3 structurally. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type TileKind = 'context' | 'isolated';

/** How the camera distance is derived for a view. */
export type ViewFraming =
  | 'scene' /** stand back until the whole scene box is in frame */
  | 'near' /** target plus surroundings (~1/3 of the frame is target) */
  | 'tight'; /** target fills the frame */

export interface ViewDef {
  /** View name — keys the mosaic cells ("far", "near", ...). */
  name: string;
  /** Tile label drawn onto the mosaic. */
  label: string;
  kind: TileKind;
  framing: ViewFraming;
  /** Unit direction FROM the target center TOWARDS the camera. */
  dir: readonly [number, number, number];
  /** Camera up vector for this view. */
  up: readonly [number, number, number];
}

/** Smallest half-extent / depth in meters — keeps flat objects renderable. */
export const MIN_EXTENT_M = 0.001;

/** Default tile parameter in pixels (tiles render at 2× this edge). */
export const DEFAULT_TILE_SIZE = 256;

/** Height of the mosaic header strip in pixels. */
export const MOSAIC_HEADER_PX = 48;

/** Distance margin for isolated tiles (target fills the frame). */
export const MARGIN_ISOLATED = 1.08;

/** Distance margin for the near context tile (target ≈ 1/3 of the frame). */
export const MARGIN_NEAR = 2.0;

const norm = (v: readonly [number, number, number]): readonly [number, number, number] => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len] as const;
};

/** ¾ view from front-top-right (front looks along -Z, camera at +Z). */
const ISO_FRONT = norm([1, 0.7, 1]);

/** Opposite ¾ view from back-bottom-left — together with ISO_FRONT every
 *  face of the object appears in at least one isolated tile. */
const ISO_BACK = norm([-1, -0.55, -1]);

/**
 * The 4 analysis views, all perspective. Order matters — `mosaicLayout`
 * places them in this order, two tiles per row:
 *   row 1: "far" (whole scene, target highlighted) | "near" (target + surroundings)
 *   row 2: isolated ¾ front-top | isolated ¾ back-bottom
 */
export const VIEW_DEFS: readonly ViewDef[] = [
  { name: 'far', label: 'context far', kind: 'context', framing: 'scene', dir: ISO_FRONT, up: [0, 1, 0] },
  { name: 'near', label: 'context near', kind: 'context', framing: 'near', dir: ISO_FRONT, up: [0, 1, 0] },
  { name: 'front-top', label: 'isolated front-top', kind: 'isolated', framing: 'tight', dir: ISO_FRONT, up: [0, 1, 0] },
  { name: 'back-bottom', label: 'isolated back-bottom', kind: 'isolated', framing: 'tight', dir: ISO_BACK, up: [0, 1, 0] },
];

/** Split the `paths` tool parameter into clean individual node paths. */
export function parsePathsParam(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  // Newline-separated input treats commas as literal name characters — CAD
  // part names like "ISO 15 ABB - 6020 - Full,SI,NC,Full" are real. The
  // comma/semicolon convenience separators only apply to single-line input.
  const splitter = /[\r\n]/.test(raw) ? /[;\r\n]+/ : /[,;\r\n]+/;
  return raw
    .split(splitter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Clamp/normalize the tileSize tool parameter (default 256, 128..512). */
export function clampTileSize(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_TILE_SIZE;
  return Math.min(512, Math.max(128, v));
}

export interface MosaicCell {
  view: string;
  kind: TileKind;
  /** Left edge in mosaic pixels. */
  x: number;
  /** Top edge in mosaic pixels. */
  y: number;
  /** Square edge length in pixels (always 2T). */
  size: number;
  /** Tile label drawn onto the mosaic. */
  label: string;
}

export interface MosaicLayout {
  width: number;
  height: number;
  header: number;
  cells: MosaicCell[];
}

/**
 * Mosaic geometry for tile parameter T — a 2×2 grid of 2T tiles:
 *   header strip (48 px)
 *   row 1: context far (2T×2T) | context near (2T×2T)
 *   row 2: isolated front-top (2T×2T) | isolated back-bottom (2T×2T)
 * Total: 4T × (48 + 4T).
 */
export function mosaicLayout(tileSize: number): MosaicLayout {
  const T = clampTileSize(tileSize);
  const H = MOSAIC_HEADER_PX;
  const S = 2 * T;

  const cells: MosaicCell[] = VIEW_DEFS.map((v, i) => ({
    view: v.name,
    kind: v.kind,
    x: (i % 2) * S,
    y: H + Math.floor(i / 2) * S,
    size: S,
    label: v.label,
  }));

  return { width: 2 * S, height: H + 2 * S, header: H, cells };
}

/** Header line 2: bounding-box dimensions + center + node count. */
export function formatBoundsLabel(size: Vec3Like, center: Vec3Like, count: number): string {
  const f = (n: number): string => n.toFixed(3);
  return (
    `Bounds ${f(size.x)} × ${f(size.y)} × ${f(size.z)} m` +
    `   center (${f(center.x)}, ${f(center.y)}, ${f(center.z)})` +
    `   ${count} node${count === 1 ? '' : 's'}`
  );
}
