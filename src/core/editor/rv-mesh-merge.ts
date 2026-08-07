// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-merge — classification and geometry core of the mesh merger (plan-372).
 *
 * The counterpart of `rv-mesh-separator.ts`: where the separator turns ONE mesh into a
 * same-named `Group` of island children, the merger turns the subtree of a chosen node
 * back into ONE mesh **per material and per Group**. Same rules as there — no scene
 * graph, no registry, no viewer — so every function is unit-testable and could run
 * inside a Web Worker.
 *
 * ## The three rules that must not be broken
 *
 * 1. **Nothing merges across an owner boundary.** A node carrying `Kinematic`, `Drive`,
 *    `CADLink` or `JTData` is an ANCHOR: it survives, but its extras-free geometry still
 *    merges — into an output that stays a CHILD OF THAT ANCHOR. Hanging it under the
 *    subtree root instead would silently stop a Drive from moving its own geometry.
 * 2. **Bake exactly once.** `BufferGeometry.applyMatrix4()` transforms `normal` AND
 *    `tangent` itself. The extra `Matrix3.getNormalMatrix()` step that looks so natural
 *    here would transform the normals TWICE. At a negative determinant the triangle
 *    winding is flipped instead (the renderer's per-mesh `gl.FrontFace` compensation is
 *    gone once mirrored and unmirrored parts share one geometry) plus the tangent
 *    handedness `w` inverted.
 * 3. **`mergeGeometries` returns `null` silently.** Attribute sets are normalised BEFORE
 *    the merge — along a WHITELIST — and the return value is always checked. A
 *    non-reconstructable attribute mismatch is a refused merge with a diagnostic, never a
 *    silently filled-in result and never a second output mesh for the same
 *    (material, Group) pair.
 */

import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import type { Material, Mesh, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  deserializeGeometry,
  serializeGeometryParts,
  triangleCount,
  type SerializedAttribute,
} from './rv-mesh-separator';
import { unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';
import { GROUP_KEY_RE } from '../engine/rv-group-sync';
import {
  isCarrierName,
  isSensorName,
  parseDriveName,
  parseTransportName,
} from '../library-component-loader';
import { parseSnapName } from '../../plugins/snap-point/snap-name-parser';

// ─── Worker protocol ────────────────────────────────────────────────────

/**
 * One source mesh on its way to the worker.
 *
 * The arrays come from the `serialize*` helpers, which already produce TIGHT, standalone
 * copies. That is what makes it safe to hand them over on the transfer list rather than
 * letting `postMessage` clone them a second time (plan-372 finding 8): the copy is
 * already independent of the live geometry, so detaching it takes nothing down.
 */
export interface MergeWorkerSource {
  attributes: Record<string, SerializedAttribute>;
  index: Uint32Array | null;
  /** `matrixWorld.toArray()` — column-major 16 floats. */
  worldMatrix: number[];
}

/** One requested output: which sources, and the owner space to bake them into. */
export interface MergeWorkerOutput {
  sourceIndices: number[];
  /** Owner `matrixWorld.toArray()`. */
  ownerMatrix: number[];
}

/** Worker request. `id` is the abort epoch — a stale response is dropped. */
export interface MergeRequest {
  id: number;
  sources: MergeWorkerSource[];
  outputs: MergeWorkerOutput[];
}

/** Worker response. A `null` part is an output with no sources (the empty carrier). */
export type MergeResponse =
  | {
      id: number;
      ok: true;
      parts: ({ attributes: Record<string, SerializedAttribute>; index: Uint32Array } | null)[];
    }
  | { id: number; ok: false; error: string };

/**
 * Run one merge request. Shared by the worker entry point and the client's synchronous
 * fallback, so the two paths cannot diverge.
 *
 * Bakes ADOPTIVELY: the deserialized geometries belong to this call alone, so they are
 * transformed in place instead of copied again.
 */
export function runMergeRequest(request: MergeRequest): MergeResponse {
  try {
    const parts: ({ attributes: Record<string, SerializedAttribute>; index: Uint32Array } | null)[] = [];
    for (const output of request.outputs) {
      if (output.sourceIndices.length === 0) { parts.push(null); continue; }
      const ownerWorld = new Matrix4().fromArray(output.ownerMatrix);
      const sources = output.sourceIndices.map((si) => {
        const source = request.sources[si];
        if (!source) throw new RangeError(`merge request: source index ${si} is out of range`);
        return {
          geometry: deserializeGeometry(source.attributes, source.index),
          worldMatrix: new Matrix4().fromArray(source.worldMatrix),
        };
      });
      const merged = buildMergedGeometry(sources, ownerWorld, { adopt: true });
      parts.push(serializeGeometryParts(merged));
    }
    return { id: request.id, ok: true, parts };
  } catch (err) {
    return { id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Ineligibility reasons ──────────────────────────────────────────────

/** Fewer than two mergeable meshes — nothing to gain. */
export const MERGE_REASON_TOO_FEW = 'Fewer than two mergeable meshes in this subtree';

/** Everything below the node carries information; nothing may be dissolved. */
export const MERGE_REASON_ONLY_PROTECTED =
  'Every mesh in this subtree carries information and is kept as-is';

/** A source mesh with a material ARRAY — one path cannot land in several buckets. */
export const MERGE_REASON_MULTI_MATERIAL =
  'Multi-material mesh — split it with *Separate ▸ By material group* first';

/** The chosen node is a leaf / carries no subtree at all. */
export const MERGE_REASON_NO_SUBTREE = 'This node has no subtree to merge';

// ─── Extras classification ──────────────────────────────────────────────

/**
 * rv_extras keys that must NOT turn a node into a carrier.
 *
 * The Unity GLB exporter stamps boilerplate onto nearly every node. Treating those as
 * "carries information" would classify the whole tree as protected and merge nothing at
 * all. `Group*` is passive in the same sense but for a different reason: its membership
 * is carried over onto the output mesh instead (see {@link groupNamesOf}).
 */
const PASSIVE_EXTRA_KEYS = new Set<string>([
  'layer', 'tag', 'activeSelf', 'isStatic', 'static',
  'renderer', 'rigidbody', 'colliders', 'collider',
  'Hidden', 'name', 'Layer', 'Tag',
]);

/** Anchor component keys — the node survives, its extras-free geometry still merges. */
const ANCHOR_KEY_RE = /^(Kinematic|Drive|CADLink|JTData)(_\d+)?$/;

/** rv_extras object of a node, or undefined. */
function extrasOf(node: Object3D): Record<string, unknown> | undefined {
  return (node.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;
}

/** True when the key is boilerplate or Group membership rather than function. */
function isPassiveKey(key: string): boolean {
  return PASSIVE_EXTRA_KEYS.has(key) || GROUP_KEY_RE.test(key) || key.startsWith('_');
}

/**
 * True when the node carries a naming-convention role.
 *
 * Without this a merge over a library asset would dissolve a whole conveyor — its
 * `Transport-Z`, `Drive-Rot-Y`, `Sensor` and `Snap-…` nodes carry no rv_extras at all
 * until the loader scans them, so the extras check alone sees plain geometry.
 * The parsers are the SAME ones the loader uses; nothing is re-implemented here.
 */
export function isConventionName(name: string): boolean {
  if (!name) return false;
  return parseDriveName(name) !== null
    || parseTransportName(name) !== null
    || isSensorName(name)
    || isCarrierName(name)
    || parseSnapName(name) !== null;
}

/**
 * Why a node (and its whole subtree) is exempt from the merge, or `null`.
 *
 * Checked before {@link isAnchor}: a node carrying BOTH a functional carrier component
 * and an anchor component is protected, because dissolving anything under it could break
 * the carrier.
 */
export function protectedReason(node: Object3D): string | null {
  if (isConventionName(node.name)) return `naming convention "${node.name}"`;
  const rv = extrasOf(node);
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (isPassiveKey(key)) continue;
    if (ANCHOR_KEY_RE.test(key)) continue;
    return `component ${key}`;
  }
  return null;
}

/**
 * True when the node is an anchor: it survives on its own, but the extras-free geometry
 * below it still merges — into ITS OWN owner zone.
 *
 * Without the anchor category `JTData` alone would block nearly everything: a 10 MB JT
 * reference carries it on 2441 of 4261 nodes (plan-335 §2.6).
 */
export function isAnchor(node: Object3D): boolean {
  const rv = extrasOf(node);
  if (!rv) return false;
  for (const key of Object.keys(rv)) if (ANCHOR_KEY_RE.test(key)) return true;
  return false;
}

/** Resolved Group names of a node, from its own `Group*` extras (sorted, deduped). */
export function groupNamesOf(node: Object3D): string[] {
  const rv = extrasOf(node);
  if (!rv) return [];
  const names = new Set<string>();
  for (const key of Object.keys(rv)) {
    if (!GROUP_KEY_RE.test(key)) continue;
    const data = rv[key];
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (record['_enabled'] === false) continue;
    const groupName = record['GroupName'];
    if (typeof groupName === 'string' && groupName.length > 0) names.add(groupName);
  }
  return [...names].sort();
}

// ─── Material fingerprint ───────────────────────────────────────────────

/** FNV-1a, 32 bit — small, dependency-free and stable across sessions. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * SEMANTIC material fingerprint — deliberately NOT `material.uuid`.
 *
 * Three.js mints a fresh uuid in every `Material` constructor, so a plain GLB reload
 * already gives every material a different uuid. An op that recorded uuids would fail its
 * own replay check on the first reload. The fingerprint hashes the value-bearing
 * properties instead, which a GLB round-trip preserves.
 *
 * Every read is defensive (`?? default`): a `MeshNormalMaterial` has no `color`, a
 * `MeshBasicMaterial` no `metalness`.
 */
export function materialFingerprint(material: Material | null | undefined): string {
  if (!material) return fnv1a('null');
  const m = material as unknown as {
    type?: string;
    name?: string;
    color?: { getHexString?: () => string };
    metalness?: number;
    roughness?: number;
    map?: { name?: string } | null;
    side?: number;
    transparent?: boolean;
    opacity?: number;
  };
  const parts = [
    m.type ?? '',
    m.name ?? '',
    m.color?.getHexString?.() ?? '',
    String(m.metalness ?? ''),
    String(m.roughness ?? ''),
    m.map?.name ?? '',
    String(m.side ?? ''),
    String(m.transparent ?? false),
    String(m.opacity ?? 1),
  ];
  return fnv1a(parts.join('|'));
}

/**
 * Bucket key — `ownerPath | sorted group names | materialKey`.
 *
 * Deliberately WITHOUT an attribute signature. "One mesh per material and Group" is a
 * binding requirement; splitting a bucket by attribute layout would produce two output
 * meshes for one material, which is exactly what the requirement forbids. Diverging
 * attribute layouts are reconciled by {@link normalizeBucket} instead — or the merge is
 * refused.
 */
export function bucketKeyOf(ownerPath: string, groupNames: string[], materialKey: string): string {
  return `${ownerPath}|${[...groupNames].sort().join(',')}|${materialKey}`;
}

// ─── Classification ─────────────────────────────────────────────────────

/** One mergeable source mesh with everything the op needs about it. */
export interface MergeCandidate {
  mesh: Mesh;
  /** Zone owner: the subtree root or the nearest enclosing anchor. */
  owner: Object3D;
  material: Material;
  materialKey: string;
  groupNames: string[];
  bucketKey: string;
  vertexCount: number;
  triangleCount: number;
}

/** A node that survives the merge (and, when protected, its whole subtree). */
export interface MergeKeptNode {
  node: Object3D;
  role: 'protected' | 'anchor';
  /** Why it survives — shown in the preview dialog. */
  reason: string;
  /** Zone owner it belongs under after the merge. */
  owner: Object3D;
}

/** One owner zone (the root, or one anchor) with its buckets. */
export interface MergeZone {
  owner: Object3D;
  isRoot: boolean;
  /** Buckets in a stable, first-seen order. */
  buckets: MergeBucket[];
}

/** All source meshes of one (owner, Group set, material) triple. */
export interface MergeBucket {
  key: string;
  owner: Object3D;
  material: Material;
  materialKey: string;
  groupNames: string[];
  candidates: MergeCandidate[];
}

/** The full picture of what a merge on a subtree would do. */
export interface MergeClassification {
  root: Object3D;
  zones: MergeZone[];
  kept: MergeKeptNode[];
  candidates: MergeCandidate[];
  /** Set when the merge must not be offered at all. */
  ineligibleReason: string | null;
}

/** Node paths inside a classification are resolved by the caller, not here. */
type NodePathFn = (node: Object3D) => string;

/**
 * Classify a subtree into mergeable candidates, surviving nodes and owner zones.
 *
 * Traversal rules, in order:
 *
 * 1. A PROTECTED node stops the descent — its whole subtree is untouched.
 * 2. An ANCHOR node survives but opens a new owner zone; the descent continues with that
 *    anchor as owner, so its geometry merges into an output that stays its child.
 * 3. Anything else: a guard-clean single-material `Mesh` becomes a candidate; every node
 *    is descended into.
 *
 * `pathOf` only exists so bucket keys carry the OWNER PATH rather than an object identity
 * — the key has to be reproducible in the op, and object identity is not.
 */
export function classifySubtree(root: Object3D, pathOf: NodePathFn): MergeClassification {
  const zones: MergeZone[] = [];
  const kept: MergeKeptNode[] = [];
  const candidates: MergeCandidate[] = [];
  const zoneByOwner = new Map<Object3D, MergeZone>();
  let ineligibleReason: string | null = null;

  const zoneFor = (owner: Object3D): MergeZone => {
    let zone = zoneByOwner.get(owner);
    if (!zone) {
      zone = { owner, isRoot: owner === root, buckets: [] };
      zoneByOwner.set(owner, zone);
      zones.push(zone);
    }
    return zone;
  };
  // The root zone always exists — it carries the replacement mesh even when it holds no
  // geometry of its own (the "empty carrier" case, plan §2.3).
  zoneFor(root);

  const fail = (reason: string): void => { ineligibleReason ??= reason; };

  const visit = (node: Object3D, owner: Object3D): void => {
    if (node !== root) {
      const reason = protectedReason(node);
      if (reason) {
        kept.push({ node, role: 'protected', reason, owner });
        return; // whole subtree exempt
      }
      if (isAnchor(node)) {
        kept.push({ node, role: 'anchor', reason: 'kinematic or CAD anchor', owner });
        zoneFor(node);
        for (const child of node.children.slice()) visit(child, node);
        return;
      }
    }

    const mesh = node as Mesh;
    if (node !== root && (mesh as { isMesh?: boolean }).isMesh === true) {
      const shape = unsupportedMeshShapeReason(mesh);
      if (shape) {
        fail(shape);
      } else if (Array.isArray(mesh.material)) {
        fail(MERGE_REASON_MULTI_MATERIAL);
      } else {
        const geometry = mesh.geometry as BufferGeometry;
        const material = mesh.material as Material;
        const materialKey = materialFingerprint(material);
        const groupNames = groupNamesOf(node);
        const bucketKey = bucketKeyOf(pathOf(owner), groupNames, materialKey);
        const candidate: MergeCandidate = {
          mesh,
          owner,
          material,
          materialKey,
          groupNames,
          bucketKey,
          vertexCount: geometry.getAttribute('position')?.count ?? 0,
          triangleCount: triangleCount(geometry),
        };
        candidates.push(candidate);
        const zone = zoneFor(owner);
        let bucket = zone.buckets.find((b) => b.key === bucketKey);
        if (!bucket) {
          bucket = { key: bucketKey, owner, material, materialKey, groupNames, candidates: [] };
          zone.buckets.push(bucket);
        }
        bucket.candidates.push(candidate);
      }
    }

    for (const child of node.children.slice()) visit(child, owner);
  };

  visit(root, root);

  if (!ineligibleReason) {
    if (root.children.length === 0) ineligibleReason = MERGE_REASON_NO_SUBTREE;
    else if (candidates.length === 0) ineligibleReason = MERGE_REASON_ONLY_PROTECTED;
    else if (candidates.length < 2) ineligibleReason = MERGE_REASON_TOO_FEW;
  }

  return { root, zones, kept, candidates, ineligibleReason };
}

// ─── Transform bake ─────────────────────────────────────────────────────

/**
 * An independent copy of `geom`, transformed into the owner's local space.
 *
 * Exactly ONE `applyMatrix4()`: it already transforms `normal` (via the normal matrix it
 * builds itself) and `tangent`. A second, manual normal-matrix pass — the obvious-looking
 * addition — would transform the normals twice.
 *
 * At a negative determinant the triangle winding is flipped and, if present, the tangent
 * handedness `w` inverted. The renderer compensates mirroring per MESH via `gl.FrontFace`;
 * once a mirrored and an unmirrored part share one geometry there is only one winding
 * order left, so the compensation has to be baked in here.
 *
 * The index type is deliberately NOT forced: `setIndex()` picks `Uint32` from the actual
 * index VALUES, and `mergeGeometries()` builds a plain JS index array anyway.
 */
export function bakeIntoTargetSpace(geom: BufferGeometry, bake: Matrix4): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of Object.keys(geom.attributes)) {
    const src = geom.attributes[name] as BufferAttribute;
    out.setAttribute(name, cloneAttribute(src));
  }
  const index = geom.index;
  if (index) {
    out.setIndex(new BufferAttribute(
      (index.array as Uint32Array).slice() as unknown as Uint32Array, 1,
    ));
  }
  return bakeGeometryInPlace(out, bake);
}

/**
 * The same bake WITHOUT the copy — only legal on a geometry the caller owns exclusively.
 *
 * The worker path uses it on its own deserialized copies, which is what keeps the peak
 * memory at roughly 2× the source buffers instead of 3× (copy + bake + merge).
 */
export function bakeGeometryInPlace(geom: BufferGeometry, bake: Matrix4): BufferGeometry {
  geom.applyMatrix4(bake);
  if (bake.determinant() < 0) {
    flipWinding(geom);
    flipTangentHandedness(geom);
  }
  return geom;
}

/** Independent copy of an attribute, keeping itemSize, normalized and gpuType. */
function cloneAttribute(src: BufferAttribute): BufferAttribute {
  const array = (src.array as unknown as { slice(): ArrayLike<number> }).slice();
  const out = new BufferAttribute(array as unknown as Float32Array, src.itemSize, src.normalized === true);
  const gpuType = (src as unknown as { gpuType?: number }).gpuType;
  if (gpuType !== undefined) (out as unknown as { gpuType?: number }).gpuType = gpuType;
  return out;
}

/** Reverse every triangle's winding, in place. */
export function flipWinding(geom: BufferGeometry): void {
  const index = geom.index;
  if (index) {
    const arr = index.array as unknown as { [i: number]: number; length: number };
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const b = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = b;
    }
    index.needsUpdate = true;
    return;
  }
  // Non-indexed: swap vertices 1 and 2 of every triangle across ALL attributes.
  for (const name of Object.keys(geom.attributes)) {
    const attr = geom.attributes[name] as BufferAttribute;
    const itemSize = attr.itemSize;
    for (let v = 0; v + 2 < attr.count; v += 3) {
      for (let c = 0; c < itemSize; c++) {
        const b = attr.getComponent(v + 1, c);
        attr.setComponent(v + 1, c, attr.getComponent(v + 2, c));
        attr.setComponent(v + 2, c, b);
      }
    }
    attr.needsUpdate = true;
  }
}

/** Invert the `w` component of a tangent attribute (handedness), if present. */
export function flipTangentHandedness(geom: BufferGeometry): void {
  const tangent = geom.getAttribute('tangent') as BufferAttribute | undefined;
  if (!tangent || tangent.itemSize < 4) return;
  for (let i = 0; i < tangent.count; i++) tangent.setW(i, -tangent.getW(i));
  tangent.needsUpdate = true;
}

/** Local-space bake matrix for one source: `inverse(owner.matrixWorld) * source.matrixWorld`. */
export function bakeMatrixFor(ownerWorld: Matrix4, sourceWorld: Matrix4, out = new Matrix4()): Matrix4 {
  return out.copy(ownerWorld).invert().multiply(sourceWorld);
}

// ─── Attribute normalisation ────────────────────────────────────────────

/**
 * Attributes {@link normalizeBucket} may synthesise when a geometry lacks them.
 *
 * Everything else — `tangent`, `skinIndex`, `skinWeight` and any custom attribute — is
 * NOT reconstructable: a wrong value there is silently wrong geometry, so a mismatch
 * refuses the merge instead.
 */
const RECONSTRUCTABLE = new Set(['normal', 'color', 'uv', 'uv1', 'uv2']);

interface AttributeShape {
  itemSize: number;
  normalized: boolean;
  ctor: string;
  gpuType: number | undefined;
}

function shapeOf(attr: BufferAttribute): AttributeShape {
  return {
    itemSize: attr.itemSize,
    normalized: attr.normalized === true,
    ctor: (attr.array as unknown as object).constructor.name,
    gpuType: (attr as unknown as { gpuType?: number }).gpuType,
  };
}

function sameShape(a: AttributeShape, b: AttributeShape): boolean {
  return a.itemSize === b.itemSize
    && a.normalized === b.normalized
    && a.ctor === b.ctor
    && a.gpuType === b.gpuType;
}

/** Thrown when a bucket cannot be brought onto a common attribute set. */
export class MeshMergeIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshMergeIncompatibleError';
  }
}

/**
 * Bring every geometry of a bucket onto one attribute set and one index-ness, IN PLACE.
 *
 * The geometries must already be independent bakes (see {@link bakeIntoTargetSpace}) —
 * nothing here may touch a live geometry.
 *
 * @throws {MeshMergeIncompatibleError} when an attribute is missing that cannot be
 *         reconstructed, or when the same attribute name has different layouts.
 */
export function normalizeBucket(geoms: BufferGeometry[]): BufferGeometry[] {
  if (geoms.length === 0) return geoms;

  // The LEADING variant of each attribute — first geometry that carries it wins.
  const shapes = new Map<string, AttributeShape>();
  for (const geom of geoms) {
    for (const name of Object.keys(geom.attributes)) {
      const shape = shapeOf(geom.attributes[name] as BufferAttribute);
      const known = shapes.get(name);
      if (!known) { shapes.set(name, shape); continue; }
      if (!sameShape(known, shape)) {
        throw new MeshMergeIncompatibleError(
          `attribute "${name}" has incompatible layouts (` +
          `${known.ctor}[${known.itemSize}]${known.normalized ? ' normalized' : ''} vs ` +
          `${shape.ctor}[${shape.itemSize}]${shape.normalized ? ' normalized' : ''}) — ` +
          `these meshes cannot be merged`,
        );
      }
    }
  }

  for (const [name] of shapes) {
    const missing = geoms.some((g) => g.getAttribute(name) === undefined);
    if (missing && !RECONSTRUCTABLE.has(name)) {
      throw new MeshMergeIncompatibleError(
        `attribute "${name}" is present on some meshes and missing on others and cannot ` +
        `be reconstructed — these meshes cannot be merged`,
      );
    }
  }

  for (const geom of geoms) {
    for (const [name, shape] of shapes) {
      if (geom.getAttribute(name) !== undefined) continue;
      geom.setAttribute(name, synthesizeAttribute(name, shape, vertexCountOf(geom), geom));
    }
  }

  // Indexed / non-indexed must be uniform. Adding a sequential index is the cheap
  // direction; `toNonIndexed()` would multiply the vertex count instead.
  const anyIndexed = geoms.some((g) => g.index !== null);
  if (anyIndexed) {
    for (const geom of geoms) {
      if (geom.index) continue;
      const count = vertexCountOf(geom);
      const Ctor = count > 65535 ? Uint32Array : Uint16Array;
      const seq = new Ctor(count);
      for (let i = 0; i < count; i++) seq[i] = i;
      geom.setIndex(new BufferAttribute(seq as unknown as Uint32Array, 1));
    }
  }

  return geoms;
}

function vertexCountOf(geom: BufferGeometry): number {
  return geom.getAttribute('position')?.count ?? 0;
}

/** Build the missing attribute according to the whitelist (see {@link RECONSTRUCTABLE}). */
function synthesizeAttribute(
  name: string,
  shape: AttributeShape,
  count: number,
  geom: BufferGeometry,
): BufferAttribute {
  if (name === 'normal') {
    geom.computeVertexNormals();
    const built = geom.getAttribute('normal') as BufferAttribute | undefined;
    if (built && sameShape(shapeOf(built), shape)) return built;
    throw new MeshMergeIncompatibleError(
      `attribute "normal" could not be reconstructed in the layout the other meshes use ` +
      `(${shape.ctor}[${shape.itemSize}]) — these meshes cannot be merged`,
    );
  }

  const array = newTypedArray(shape.ctor, count * shape.itemSize);
  if (name === 'color') {
    // White / opaque, in the encoding of the leading variant.
    const one = shape.normalized ? maxValueOf(shape.ctor) : 1;
    for (let i = 0; i < array.length; i++) array[i] = one;
  }
  // `uv` / `uv1` / `uv2`: zeros — already the fresh-array value.
  const attr = new BufferAttribute(array as unknown as Float32Array, shape.itemSize, shape.normalized);
  if (shape.gpuType !== undefined) (attr as unknown as { gpuType?: number }).gpuType = shape.gpuType;
  return attr;
}

type AnyTypedArray = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array
  | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array;

const TYPED_ARRAYS: Record<string, new (length: number) => AnyTypedArray> = {
  Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
  Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
};

function newTypedArray(ctorName: string, length: number): AnyTypedArray {
  const Ctor = TYPED_ARRAYS[ctorName];
  if (!Ctor) {
    throw new MeshMergeIncompatibleError(
      `unsupported attribute array type "${ctorName}" — these meshes cannot be merged`,
    );
  }
  return new Ctor(length);
}

function maxValueOf(ctorName: string): number {
  switch (ctorName) {
    case 'Int8Array': return 127;
    case 'Uint8Array': case 'Uint8ClampedArray': return 255;
    case 'Int16Array': return 32767;
    case 'Uint16Array': return 65535;
    case 'Int32Array': return 2147483647;
    case 'Uint32Array': return 4294967295;
    default: return 1;
  }
}

// ─── Merge ──────────────────────────────────────────────────────────────

/**
 * Merge one normalised bucket into a single geometry.
 *
 * `mergeGeometries()` reports every failure by returning `null` and logging to the
 * console — it never throws. Passing that `null` on would produce a `Mesh` with no
 * geometry, so the result is always checked and the actual cause named.
 */
export function mergeBucket(geoms: BufferGeometry[]): BufferGeometry {
  if (geoms.length === 0) {
    throw new MeshMergeIncompatibleError('mergeBucket: nothing to merge');
  }
  const merged = mergeGeometries(geoms, false);
  if (!merged) {
    throw new MeshMergeIncompatibleError(
      `mergeGeometries returned null — ${diagnoseMergeFailure(geoms)}`,
    );
  }
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** Best available explanation for a `null` from `mergeGeometries`. */
function diagnoseMergeFailure(geoms: BufferGeometry[]): string {
  const indexed = geoms.filter((g) => g.index !== null).length;
  if (indexed !== 0 && indexed !== geoms.length) {
    return `${indexed} of ${geoms.length} geometries are indexed and the rest are not`;
  }
  const reference = new Set(Object.keys(geoms[0].attributes));
  for (let i = 1; i < geoms.length; i++) {
    const names = new Set(Object.keys(geoms[i].attributes));
    for (const name of names) {
      if (!reference.has(name)) return `geometry ${i} has an extra attribute "${name}"`;
    }
    for (const name of reference) {
      if (!names.has(name)) return `geometry ${i} is missing attribute "${name}"`;
    }
  }
  for (const geom of geoms) {
    if (Object.keys(geom.morphAttributes).length > 0) return 'morph attributes are not mergeable';
  }
  return 'incompatible attribute layouts';
}

/**
 * Whole pipeline for one bucket: bake every source into the owner space, normalise, merge.
 *
 * Pure — takes geometries and matrices, returns a geometry. This is what the worker runs.
 *
 * @param options.adopt Bake the passed geometries IN PLACE and dispose them afterwards.
 *   Only for geometries the caller owns exclusively (the worker's deserialized copies).
 *   It removes one full copy of every source buffer from the peak.
 */
export function buildMergedGeometry(
  sources: { geometry: BufferGeometry; worldMatrix: Matrix4 }[],
  ownerWorld: Matrix4,
  options?: { adopt?: boolean },
): BufferGeometry {
  const adopt = options?.adopt === true;
  const baked: BufferGeometry[] = [];
  try {
    const bake = new Matrix4();
    for (const source of sources) {
      bakeMatrixFor(ownerWorld, source.worldMatrix, bake);
      baked.push(adopt
        ? bakeGeometryInPlace(source.geometry, bake)
        : bakeIntoTargetSpace(source.geometry, bake));
    }
    normalizeBucket(baked);
    return mergeBucket(baked);
  } finally {
    // The intermediates own their buffers exclusively — nothing else ever saw them.
    for (const geom of baked) geom.dispose();
  }
}
