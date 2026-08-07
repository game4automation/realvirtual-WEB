// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * placeholder-node.ts — the instant stand-in for a still-loading library asset.
 *
 * Dragging a large GLB out of the library used to show NOTHING until the model
 * had decoded (plan-371). `buildPlaceholderNode` returns, synchronously and in
 * well under a millisecond, a catalog-sized wireframe box plus an (optional,
 * lazily loaded) thumbnail billboard. The planner registers that node as a real
 * placement in `light` mode and swaps the decoded geometry in underneath the
 * SAME root later (`scene-mutations.swapPlacedGeometry`).
 *
 * ⛔ Disposal must NEVER go through `disposeSubtree`
 * (`core/engine/rv-traverse-utils.ts`): that helper duck-types on
 * `.geometry` / `.material` WITHOUT an `isMesh` check, and a three.js `Sprite`
 * carries the **module-wide shared singleton geometry** (`Sprite.js`:
 * `this.geometry = _geometry`). Disposing it would destroy every sprite in the
 * application — snap markers, source markers, avatars, annotations,
 * measurements, gizmo overlays. `disposePlaceholderNode` therefore frees only
 * the resources this module allocated, exactly mirroring the precedent in
 * `bbox-snap.ts` (sprite label teardown: `mat.map?.dispose()` + `mat.dispose()`
 * and nothing else).
 */

import {
  Group,
  BoxGeometry,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  LineDashedMaterial,
  Sprite,
  SpriteMaterial,
  TextureLoader,
} from 'three';
import type { Material, Texture } from 'three';

import { buildBadgeTexture, ERROR_COLOR } from '../../core/engine/rv-error-visual';
import type { LibraryCatalogEntry } from './rv-layout-store';

/** Instrument Blue — the single working accent of the Glass Control Room. */
const PLACEHOLDER_COLOR = 0x4fc3f7;
/** Error tint — the app-wide error red from `rv-error-visual.ts`. */
const PLACEHOLDER_ERROR_COLOR = ERROR_COLOR;

/** Text of the warning badge that appears over a failed placeholder. Carries
 *  the state in WORDS, so the failure never rests on colour alone (WCAG 1.4.1);
 *  the dashed outline is the third, non-textual carrier. */
const ERROR_BADGE_TEXT = '⚠ Ladefehler';

/** World height (m) of the warning badge. Fixed rather than footprint-relative:
 *  a badge that shrinks with a small asset stops being readable. */
const ERROR_BADGE_HEIGHT_M = 0.28;

/** Millimetre → metre. */
const MM_TO_M = 0.001;

/** No box edge shorter than this — a degenerate `footprintMm: [0, 0]` would
 *  otherwise produce an invisible placeholder and defeat the whole feature. */
const MIN_EDGE_MM = 100;

/** Cap for the derived default height. Without it a large floor plate would
 *  become an 8 m cube; with it, conveyors stay flat and robots stay upright. */
const MAX_DERIVED_HEIGHT_MM = 1500;

/** Fallback box when the entry declares neither footprint nor gizmo size —
 *  the existing planner convention (`ghost-manager.createVirtualPlaceholder`). */
const FALLBACK_SIZE_MM: [number, number, number] = [500, 500, 500];

/** A placeholder root. The `_rvPendingPlaceholder` flag is the cross-module
 *  contract: the snap gate in `_moveDraft` and the central dispose gate in
 *  `removePlacedFromScene` both key on it. */
export interface PlaceholderNode extends Group {
  userData: { _rvPendingPlaceholder: true; [k: string]: unknown };
}

/**
 * Resources owned by one placeholder. Held OUTSIDE `userData` on purpose:
 * `Object3D.clone()` JSON-round-trips `userData`, which would silently turn
 * live Material/Texture references into plain objects.
 */
interface PlaceholderResources {
  line: LineSegments;
  edges: EdgesGeometry;
  solidMaterial: LineBasicMaterial;
  dashedMaterial: LineDashedMaterial | null;
  sprite: Sprite | null;
  spriteMaterial: SpriteMaterial | null;
  spriteTexture: Texture | null;
  /** Warning badge shown while the load is in the failed state. Same three
   *  resources as the thumbnail billboard, and the same rule: its `geometry`
   *  is the shared three.js Sprite singleton and is never disposed. */
  badge: Sprite | null;
  badgeMaterial: SpriteMaterial | null;
  badgeTexture: Texture | null;
  /** Height (m) of the wireframe box — where the badge is parked. */
  heightM: number;
  /** Set by {@link disposePlaceholderNode}; makes a late thumbnail arrival a no-op. */
  disposed: boolean;
  error: boolean;
}

const _resources = new WeakMap<Group, PlaceholderResources>();

/** Shared loader — `TextureLoader` is stateless per `load()` call. */
const _textureLoader = new TextureLoader();

/** Clamp one box edge to a sane, visible millimetre value. */
function clampEdgeMm(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_EDGE_MM;
  return Math.max(MIN_EDGE_MM, Math.abs(value));
}

/**
 * Size heuristic, in the order fixed by the plan:
 *   1. `entry.footprintMm` (`[x, z]`) — height derived from the smaller edge
 *   2. `entry.gizmoSize` (`[x, y, z]`, virtual entries)
 *   3. `[500, 500, 500]` mm
 * Every edge is clamped to at least {@link MIN_EDGE_MM}.
 */
export function resolvePlaceholderSizeMm(entry: LibraryCatalogEntry): [number, number, number] {
  const footprint = entry.footprintMm;
  if (footprint && footprint.length >= 2) {
    const x = clampEdgeMm(footprint[0]);
    const z = clampEdgeMm(footprint[1]);
    // Derived height: the smaller footprint edge, capped. Flat for conveyors,
    // upright for robots — and never a room-sized cube. The real height shows
    // as soon as the geometry swaps in.
    const h = clampEdgeMm(Math.min(Math.min(x, z), MAX_DERIVED_HEIGHT_MM));
    return [x, h, z];
  }

  const gizmo = entry.gizmoSize;
  if (gizmo && gizmo.length >= 3) {
    return [clampEdgeMm(gizmo[0]), clampEdgeMm(gizmo[1]), clampEdgeMm(gizmo[2])];
  }

  return [...FALLBACK_SIZE_MM];
}

/**
 * Build the instant placeholder for a catalog entry. Synchronous and
 * allocation-light; the thumbnail texture (when the entry declares one) is
 * fetched in the background and attached as a `Sprite` billboard once ready.
 * A thumbnail that fails to load is dropped silently — the box alone is
 * sufficient feedback.
 *
 * The returned root is an identity `Group`, which is exactly the
 * transform-neutral placement root `swapPlacedGeometry` needs.
 */
export function buildPlaceholderNode(entry: LibraryCatalogEntry): PlaceholderNode {
  const [wMm, hMm, dMm] = resolvePlaceholderSizeMm(entry);
  const w = wMm * MM_TO_M;
  const h = hMm * MM_TO_M;
  const d = dMm * MM_TO_M;

  const group = new Group() as PlaceholderNode;
  group.userData._rvPendingPlaceholder = true;
  group.name = entry.name;

  // Wireframe box. The temporary BoxGeometry only seeds the EdgesGeometry and
  // is disposed straight away (same pattern as createVirtualPlaceholder).
  const box = new BoxGeometry(w, h, d);
  const edges = new EdgesGeometry(box);
  box.dispose();

  const solidMaterial = new LineBasicMaterial({ color: PLACEHOLDER_COLOR });
  const line = new LineSegments(edges, solidMaterial);
  // Box bottom on the local floor plane, so the placeholder occupies the same
  // volume the real asset will after `pivotToFloorCenter` + drop-to-surface.
  line.position.y = h / 2;
  line.frustumCulled = false;
  group.add(line);

  const resources: PlaceholderResources = {
    line,
    edges,
    solidMaterial,
    dashedMaterial: null,
    sprite: null,
    spriteMaterial: null,
    spriteTexture: null,
    badge: null,
    badgeMaterial: null,
    badgeTexture: null,
    heightM: h,
    disposed: false,
    error: false,
  };
  _resources.set(group, resources);

  const thumbnailUrl = entry.thumbnailUrl?.trim();
  if (thumbnailUrl) attachThumbnail(group, resources, thumbnailUrl, Math.max(w, d), h);

  return group;
}

/**
 * Load the catalog thumbnail and hang it over the box as a `Sprite`.
 * Deliberately fire-and-forget: a slow or broken thumbnail must never delay or
 * break the placeholder. Attaching after a dispose is a no-op (the texture is
 * freed immediately in that case).
 */
function attachThumbnail(
  group: PlaceholderNode,
  resources: PlaceholderResources,
  url: string,
  widthM: number,
  heightM: number,
): void {
  _textureLoader.load(
    url,
    (texture) => {
      if (resources.disposed) { texture.dispose(); return; }

      const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
      const sprite = new Sprite(material);
      const size = Math.max(widthM * 0.6, 0.1);
      sprite.scale.set(size, size, 1);
      sprite.position.y = heightM + size * 0.6;
      sprite.frustumCulled = false;
      group.add(sprite);

      resources.sprite = sprite;
      resources.spriteMaterial = material;
      resources.spriteTexture = texture;
    },
    undefined,
    () => { /* no thumbnail — the wireframe box alone is enough feedback */ },
  );
}

/**
 * Toggle the failed-load look. Three independent carriers, deliberately:
 * error red, a DASHED outline, and a worded warning badge — so the state
 * survives for a user who cannot distinguish the colour (WCAG 1.4.1).
 * Idempotent.
 *
 * The pulse and the HMI status line live in the planner (`index.ts`); this
 * module only owns what hangs off the placeholder node itself.
 */
export function setPlaceholderError(node: PlaceholderNode, on: boolean): void {
  const resources = _resources.get(node);
  if (!resources || resources.disposed || resources.error === on) return;
  resources.error = on;

  if (on) {
    if (!resources.dashedMaterial) {
      resources.dashedMaterial = new LineDashedMaterial({
        color: PLACEHOLDER_ERROR_COLOR,
        dashSize: 0.05,
        gapSize: 0.03,
      });
    }
    resources.line.material = resources.dashedMaterial;
    // LineDashedMaterial needs the per-vertex lineDistance attribute.
    resources.line.computeLineDistances();
    attachErrorBadge(node, resources);
  } else {
    resources.line.material = resources.solidMaterial;
    detachErrorBadge(resources);
  }
}

/** Hang the worded warning badge over the box. No-op when already present. */
function attachErrorBadge(node: PlaceholderNode, resources: PlaceholderResources): void {
  if (resources.badge) return;

  const { texture, aspect } = buildBadgeTexture(ERROR_BADGE_TEXT, PLACEHOLDER_ERROR_COLOR);
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new Sprite(material);
  sprite.scale.set(ERROR_BADGE_HEIGHT_M * aspect, ERROR_BADGE_HEIGHT_M, 1);
  // Just above the box — and above the thumbnail billboard when that exists,
  // because the failure is the more important of the two messages.
  sprite.position.y = resources.heightM + ERROR_BADGE_HEIGHT_M * 1.6;
  sprite.frustumCulled = false;
  sprite.renderOrder = 12;
  node.add(sprite);

  resources.badge = sprite;
  resources.badgeMaterial = material;
  resources.badgeTexture = texture;
}

/** Remove + free the warning badge (retry succeeded, or the node is going away). */
function detachErrorBadge(resources: PlaceholderResources): void {
  if (!resources.badge) return;
  resources.badge.parent?.remove(resources.badge);
  resources.badgeTexture?.dispose();
  (resources.badgeMaterial as Material | null)?.dispose();
  resources.badge = null;
  resources.badgeMaterial = null;
  resources.badgeTexture = null;
}

/** Whether `node` is a pending placeholder root. */
export function isPlaceholderNode(node: { userData?: Record<string, unknown> } | null | undefined): boolean {
  return node?.userData?._rvPendingPlaceholder === true;
}

/**
 * Free everything the placeholder owns — and nothing else.
 *
 * ⛔ NEVER route this through `disposeSubtree`: see the module docstring.
 * `Sprite.geometry` is a three.js module singleton and is deliberately absent
 * from the list below.
 *
 * Idempotent, and safe to call while a thumbnail request is still in flight.
 */
export function disposePlaceholderNode(node: PlaceholderNode | Group): void {
  const resources = _resources.get(node);
  if (!resources || resources.disposed) return;
  resources.disposed = true;

  // Wireframe box — geometry and both materials belong to this placeholder.
  resources.edges.dispose();
  resources.solidMaterial.dispose();
  resources.dashedMaterial?.dispose();
  resources.line.parent?.remove(resources.line);

  // Billboard — texture + material only. NOT `sprite.geometry`.
  resources.spriteTexture?.dispose();
  (resources.spriteMaterial as Material | null)?.dispose();
  resources.sprite?.parent?.remove(resources.sprite);

  // Warning badge — same rule, same three resources.
  detachErrorBadge(resources);

  resources.dashedMaterial = null;
  resources.sprite = null;
  resources.spriteMaterial = null;
  resources.spriteTexture = null;

  _resources.delete(node);
}
