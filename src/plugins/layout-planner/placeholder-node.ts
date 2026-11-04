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
import type { Camera, Material, OrthographicCamera, PerspectiveCamera, Texture, WebGLRenderer } from 'three';
import { Vector3 } from 'three';

import { buildBadgeTexture, ERROR_COLOR } from '../../core/engine/rv-error-visual';
import { NO_AO_LAYER } from '../../core/engine/rv-constants';
import { worldPerPixelAt } from '../../core/engine/rv-screen-space-scale';
import type { LibraryCatalogEntry } from './rv-layout-store';

/** Instrument Blue — the single working accent of the Glass Control Room. */
const PLACEHOLDER_COLOR = 0x4fc3f7;
/** Error tint — the app-wide error red from `rv-error-visual.ts`. */
const PLACEHOLDER_ERROR_COLOR = ERROR_COLOR;

/** Text of the warning badge that appears over a failed placeholder. Carries
 *  the state in WORDS, so the failure never rests on colour alone (WCAG 1.4.1);
 *  the dashed outline is the third, non-textual carrier. */
const ERROR_BADGE_TEXT = '⚠ Ladefehler';

/** On-screen height (px) of the loading label and the warning badge. Screen
 *  constant, not world sized: a project document carries no footprint, so its
 *  placeholder is the 0.5 m fallback box — next to a 70 m plant seen from
 *  150 m away, any world-sized marker is a few pixels and the load looks like
 *  nothing is happening. */
const BADGE_HEIGHT_PX = 24;

/** Longest asset name the loading label spells out before it is shortened. */
const LABEL_MAX_NAME = 40;

/** Object name of the loading label — tells it apart from the thumbnail sprite. */
export const PLACEHOLDER_LABEL_NAME = 'rv-placeholder-loading-label';

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
  /** "Loading <name>…" label — screen-constant, hidden while the error badge shows. */
  label: Sprite | null;
  labelMaterial: SpriteMaterial | null;
  labelTexture: Texture | null;
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
    label: null,
    labelMaterial: null,
    labelTexture: null,
    heightM: h,
    disposed: false,
    error: false,
  };
  _resources.set(group, resources);

  // The loading label is the part of the placeholder that is readable at ANY
  // scale — centred on the box, so even a box of a few pixels is marked.
  const name = entry.name.length > LABEL_MAX_NAME ? `${entry.name.slice(0, LABEL_MAX_NAME - 1)}…` : entry.name;
  const label = buildScreenBadge(`Loading ${name}…`, PLACEHOLDER_COLOR);
  label.sprite.name = PLACEHOLDER_LABEL_NAME;
  label.sprite.position.y = h / 2;
  group.add(label.sprite);
  resources.label = label.sprite;
  resources.labelMaterial = label.material;
  resources.labelTexture = label.texture;

  // No billboard for a `noPrefetch` entry (plan-660, SimReady): its load is a
  // server-side download + conversion that takes minutes, and a card picture
  // hanging in the scene that long reads as a left-over drag image rather than
  // as "loading" — the pulsing box and the progress toast carry that state.
  const thumbnailUrl = entry.noPrefetch === true ? undefined : entry.thumbnailUrl?.trim();
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
      // In-scene UI: never part of the AO depth/normal pass, or GTAO/N8AO paint
      // a dark box around the transparent billboard.
      sprite.layers.set(NO_AO_LAYER);
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

const _badgePos = new Vector3();
const _parentScale = new Vector3();

/**
 * A worded badge sprite that keeps {@link BADGE_HEIGHT_PX} on screen at any
 * camera distance or zoom, drawn over the scene and never hit by a raycast.
 *
 * Sized in `onBeforeRender` rather than with `sizeAttenuation: false`, because
 * three.js ignores that flag under an orthographic camera (see `bbox-snap.ts`).
 * The renderer computes the model-view matrix AFTER `onBeforeRender`, so the
 * scale set here applies to the very frame being drawn.
 */
function buildScreenBadge(text: string, color: number): { sprite: Sprite; material: SpriteMaterial; texture: Texture } {
  const { texture, aspect } = buildBadgeTexture(text, color);
  // depthTest off: the label must stay visible inside or behind geometry —
  // it marks WHERE the asset is coming, and that spot is often occluded.
  const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new Sprite(material);
  sprite.frustumCulled = false;
  sprite.renderOrder = 12;
  sprite.layers.set(NO_AO_LAYER);
  // A marker, not a target: it must never steal hover or a pick from the
  // placement it labels (Sprite.raycast also throws without raycaster.camera).
  sprite.raycast = () => {};
  sprite.onBeforeRender = (renderer: WebGLRenderer, _scene, camera: Camera) => {
    const flags = camera as Partial<PerspectiveCamera & OrthographicCamera>;
    if (!flags.isPerspectiveCamera && !flags.isOrthographicCamera) return;
    const cam = camera as PerspectiveCamera | OrthographicCamera;
    sprite.getWorldPosition(_badgePos);
    const wpp = worldPerPixelAt(cam, renderer.domElement.clientHeight, _badgePos);
    sprite.parent?.getWorldScale(_parentScale);
    const ps = sprite.parent ? Math.max(Math.abs(_parentScale.x), Math.abs(_parentScale.y), Math.abs(_parentScale.z)) || 1 : 1;
    const hWorld = (BADGE_HEIGHT_PX * wpp) / ps;
    sprite.scale.set(hWorld * aspect, hWorld, 1);
    sprite.updateMatrixWorld();
  };
  return { sprite, material, texture };
}

/** Hang the worded warning badge over the box. No-op when already present. */
function attachErrorBadge(node: PlaceholderNode, resources: PlaceholderResources): void {
  if (resources.badge) return;

  const { sprite, material, texture } = buildScreenBadge(ERROR_BADGE_TEXT, PLACEHOLDER_ERROR_COLOR);
  // Where the loading label was — the failure replaces that message.
  sprite.position.y = resources.heightM / 2;
  node.add(sprite);
  if (resources.label) resources.label.visible = false;

  resources.badge = sprite;
  resources.badgeMaterial = material;
  resources.badgeTexture = texture;
}

/** Remove + free the warning badge (retry succeeded, or the node is going away). */
function detachErrorBadge(resources: PlaceholderResources): void {
  if (!resources.badge) return;
  if (resources.label) resources.label.visible = true; // retry: loading again
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

  // Loading label — same rule again: texture + material, never the geometry.
  resources.labelTexture?.dispose();
  (resources.labelMaterial as Material | null)?.dispose();
  resources.label?.parent?.remove(resources.label);
  resources.label = null;
  resources.labelMaterial = null;
  resources.labelTexture = null;

  resources.dashedMaterial = null;
  resources.sprite = null;
  resources.spriteMaterial = null;
  resources.spriteTexture = null;

  _resources.delete(node);
}
