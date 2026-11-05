// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * runtime-stage-export — the sync stage of the USD live link (plan-637 Phase 1).
 *
 * The stage Isaac Sim mounts is a snapshot of the RUNNING, baked three.js tree,
 * not the authored document: every prim is exactly one runtime object, so the
 * matrices the tracker streams later are the local matrices of the same
 * hierarchy (spike 0a: parent path in USD == runtime parent, 0 deviations).
 *
 * R2 #4 — the live scene is never touched. A separate export tree is built
 * synchronously in one pass: fresh `Object3D` / `Mesh` nodes that SHARE
 * geometry and materials with the live ones and carry our own names and
 * visibility. (Not `Object3D.clone()`: that JSON-round-trips `userData`, which
 * throws on the circular `_muPool` back reference and costs a full copy per
 * node.) The node table (`nodes[i]` ↔ `primPaths[i]`) comes from the same
 * traversal, so `USDZExporter.parseAsync` may run while the simulation keeps
 * spawning and moving things — it only sees the export tree.
 *
 * What the export tree leaves out: source ghosts / previews / markers, gizmo,
 * label, highlight and process overlays, lines / points / sprites / lights /
 * cameras, every `InstancedMesh` (MU pools — their instances come as
 * `muSpawn`), invisible subtrees, and the spawned clone MUs the caller passes
 * in `exclude`. Pre-placed MUs stay (R2 #1) and are reported in `preplaced`.
 * Source templates are exported even though they are hidden at runtime; a
 * self-template source gets its authored materials back through
 * `getSourceTemplateMaterial` (R2 #3).
 *
 * Textures the exporter cannot read (DataTexture, video, compressed, not yet
 * loaded) never abort the sync: a DataTexture / video frame is converted to a
 * canvas once per texture, everything else is left out of a CLONE of the
 * material (see `exportMaterialFor`); the counts land in the snapshot.
 *
 * Text patches of `model.usda` follow the export:
 * - Shared post-pass: sibling names and registry customData, with no customData
 *   anywhere in MU template subtrees (USD references would inherit addresses).
 * - Uber / vertex-colour materials: `diffuseColor` is connected to a
 *   `UsdPrimvarReader_float3` reading `displayColor` (spike 0a), otherwise the
 *   white base colour of the uber material wins.
 * - `/Materials` moves under `/Root`: the extension REFERENCES the default prim
 *   `Root`, and a material binding that points outside the referenced prim
 *   would be dropped by USD composition.
 */

import {
  DataUtils,
  HalfFloatType,
  Matrix4,
  Mesh,
  Object3D,
  RedFormat,
  RGBAFormat,
  RGBFormat,
  RGFormat,
  Scene,
  Source,
  Texture,
  type Material,
} from 'three';
import { getSourceTemplateMaterial } from '../engine/rv-source';
import { PLACEHOLDER_PREFIX, SiblingNameAllocator } from './usd-prim-names';
import { primIdentityAddress, primIdentityForNode, type PrimAddressRegistry, type PrimIdentity } from './usd-prim-identity';
import type { PrimPostData } from './usd-stage-post';
import { captureStructure, isStageHelper, type StructureBaseline } from './structure-baseline';

/** What the export needs from the running model. */
export interface RuntimeStageInput {
  /** Model root (its world matrix becomes the root prim's matrix). */
  root: Object3D;
  /** MU template node per template index (aligned with the plugin's source table). */
  templates: readonly Object3D[];
  /** Spawned clone MUs (and anything else) to leave out, with their subtree. */
  exclude: ReadonlySet<Object3D>;
  /** Pre-placed MUs that stay in the snapshot. */
  preplaced: ReadonlyArray<{ muId: number; node: Object3D }>;
  /** Registry of the live scene; absent means unresolved, never infer from userData. */
  registry?: PrimAddressRegistry;
}

/** The synchronous half: export tree + node table. */
export interface RuntimeStageTree {
  scene: Scene;
  /** Sibling mode: placeholder index -> final name. Absent in legacy/global mode. */
  finalNames?: string[];
  /** Registry identities captured synchronously with the node table. */
  identities: Array<PrimIdentity | undefined>;
  addresses: Array<string | null>;
  templateAddresses: Array<string | null>;
  /** Mount metadata only; template subtrees deliberately have no customData. */
  prims: Map<number, PrimPostData>;
  /** Live nodes, index = node index. */
  nodes: Object3D[];
  /** Prim path inside the file (`/Root/Scenes/Scene/...`), index = node index. */
  primPaths: string[];
  /** Node index of every exported live node. */
  indexOf: Map<Object3D, number>;
  /** Prim path per template index ('' when that template is not in the tree). */
  templates: string[];
  /** Pre-placed MUs that made it into the tree. */
  preplaced: Array<{ muId: number; nodeIndex: number }>;
  /** `material.id` of every untextured vertex-colour material in the tree. */
  vertexColorMaterialIds: Set<number>;
  /** Textures converted to a canvas for the exporter (DataTexture, video frame). */
  texturesConverted: number;
  /** Textures left out because they cannot be exported (compressed, no image data). */
  texturesSkipped: number;
  /**
   * Structure of the exported live nodes, captured in the same synchronous pass
   * as the tree (plan-2239 Phase 3). Present only with `structure: true`.
   */
  structure?: StructureBaseline;
}

/** The finished snapshot handed to the mount. */
export interface RuntimeStageSnapshot extends Omit<RuntimeStageTree, 'scene' | 'vertexColorMaterialIds' | 'prims'> {
  /** The `.usdz` bytes (uncompressed). */
  usdz: Uint8Array;
  /** Exporter warnings swallowed during `parseAsync` (counted, not printed). */
  exporterWarnings: number;
}

/** Root of every prim path in the exported file. */
export const STAGE_SCENE_PATH = '/Root/Scenes/Scene';

/** Runtime helpers never belong in the sync stage (shared with the structure baseline). */
export { isStageHelper };

/**
 * Local matrix of `node` as the renderer will see it, without touching the
 * node: `compose(position, quaternion, scale)` (+ pivot, as in
 * `Object3D.updateMatrix`) for auto-updating nodes, `node.matrix` otherwise.
 * RVDrive only writes `position` / `quaternion`, so `node.matrix` alone would
 * still hold the value of the last tick (spike 0a).
 */
export function readLocalMatrix(node: Object3D, out: Matrix4): Matrix4 {
  if (!node.matrixAutoUpdate) return out.copy(node.matrix);
  out.compose(node.position, node.quaternion, node.scale);
  const pivot = node.pivot;
  if (pivot) {
    const px = pivot.x, py = pivot.y, pz = pivot.z;
    const te = out.elements;
    te[12] += px - te[0] * px - te[4] * py - te[8] * pz;
    te[13] += py - te[1] * px - te[5] * py - te[9] * pz;
    te[14] += pz - te[2] * px - te[6] * py - te[10] * pz;
  }
  return out;
}

/** Legacy global sanitizer for callers that explicitly build a global tree. */
export function sanitizePrimName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_]/g, '');
  if (/^[0-9]/.test(n)) n = '_' + n;
  return n === '' ? 'Object' : n;
}

function hasVertexColorsUntextured(m: Material): boolean {
  const mm = m as Material & { vertexColors?: boolean; map?: unknown };
  return !!mm.vertexColors && !mm.map;
}

// ── Textures the exporter cannot read ──
//
// `USDZExporter` only draws HTMLImageElement / HTMLCanvasElement /
// OffscreenCanvas / ImageBitmap (`imageToCanvas`) and throws "No valid image
// data found" for anything else; a CompressedTexture throws unless
// `setTextureUtils()` was called. On the export tree (never on the live
// materials) a DataTexture becomes a canvas texture, a video frame is drawn
// once, and every other unreadable map is dropped from a CLONE of the
// material — colour and factors stay.

/** Material map slots `USDZExporter` reads. */
export const EXPORT_MAP_KEYS = [
  'map', 'emissiveMap', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap',
  'alphaMap', 'clearcoatMap', 'clearcoatRoughnessMap',
] as const;

/** Largest edge (px) of a converted texture; bigger data is subsampled. */
export const MAX_CONVERTED_TEXTURE_SIZE = 2048;

type ExportImage = HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;
type ExportCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Per-export cache: one decision per texture, one clone per material. */
export interface ExportTextureContext {
  /** Live texture → texture to export (itself, a converted copy, or null = leave out). */
  textures: Map<Texture, Texture | null>;
  /** Live material → material to export (itself, or a clone with fixed maps). */
  materials: Map<Material, Material>;
  converted: number;
  skipped: number;
}

export function createExportTextureContext(): ExportTextureContext {
  return { textures: new Map(), materials: new Map(), converted: 0, skipped: 0 };
}

function isDrawableImage(image: unknown): image is ExportImage {
  return (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement)
    || (typeof HTMLCanvasElement !== 'undefined' && image instanceof HTMLCanvasElement)
    || (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas)
    || (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap);
}

/** False for an image the exporter would draw as an empty canvas (not loaded, 0 px). */
function hasPixels(image: ExportImage): boolean {
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }
  return image.width > 0 && image.height > 0;
}

function createCanvas(width: number, height: number): ExportCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  return null;
}

/** Channels per pixel of a DataTexture (format first, data length as fallback). */
function channelsOf(format: number, length: number, pixels: number): number {
  if (format === RGBAFormat) return 4;
  if (format === RGBFormat) return 3;
  if (format === RGFormat) return 2;
  if (format === RedFormat) return 1;
  const c = pixels > 0 ? length / pixels : 0;
  return c === 1 || c === 2 || c === 3 || c === 4 ? c : 0;
}

/**
 * Pixels of a DataTexture-style image (`{ data, width, height }`) as a canvas,
 * data row 0 as the top canvas row (the row order of the upload, so the
 * texture keeps its `flipY`). Uint8 is copied, Float32 / HalfFloat are
 * normalised to 0–255 (divided by the maximum when that exceeds 1). Larger
 * than `maxSize` is subsampled. Null for any other layout.
 */
export function dataImageToCanvas(
  image: { data?: unknown; width?: number; height?: number },
  format: number,
  type: number,
  maxSize = MAX_CONVERTED_TEXTURE_SIZE,
): ExportCanvas | null {
  const w = image.width ?? 0;
  const h = image.height ?? 0;
  const data = image.data as ArrayLike<number> | undefined;
  if (!data || !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  const ch = channelsOf(format, data.length, w * h);
  if (!ch || data.length < w * h * ch) return null;

  let read: (i: number) => number;
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    read = (i) => data[i];
  } else if (data instanceof Float32Array || (data instanceof Uint16Array && type === HalfFloatType)) {
    const f = data instanceof Float32Array
      ? (i: number) => data[i]
      : (i: number) => DataUtils.fromHalfFloat((data as Uint16Array)[i]);
    let max = 0;
    for (let i = 0; i < w * h * ch; i++) { const v = f(i); if (v > max) max = v; }
    const scale = max > 1 ? 255 / max : 255;
    read = (i) => {
      const v = f(i) * scale;
      return !(v > 0) ? 0 : v >= 255 ? 255 : v;
    };
  } else {
    return null;
  }

  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxSize));
  const cw = Math.ceil(w / step);
  const chh = Math.ceil(h / step);
  const canvas = createCanvas(cw, chh);
  const ctx = canvas?.getContext('2d') as Ctx2D | null | undefined;
  if (!canvas || !ctx) return null;
  const out = ctx.createImageData(cw, chh);
  const px = out.data;
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const s = (y * step * w + x * step) * ch;
      const d = (y * cw + x) * 4;
      if (ch === 1) {
        const v = read(s);
        px[d] = v; px[d + 1] = v; px[d + 2] = v; px[d + 3] = 255;
      } else if (ch === 2) {
        px[d] = read(s); px[d + 1] = read(s + 1); px[d + 2] = 0; px[d + 3] = 255;
      } else {
        px[d] = read(s); px[d + 1] = read(s + 1); px[d + 2] = read(s + 2);
        px[d + 3] = ch === 4 ? read(s + 3) : 255;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** The current frame of a video as a canvas (null before the first frame). */
function videoFrameToCanvas(video: HTMLVideoElement): ExportCanvas | null {
  if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) return null;
  const s = Math.min(1, MAX_CONVERTED_TEXTURE_SIZE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = createCanvas(Math.max(1, Math.round(video.videoWidth * s)), Math.max(1, Math.round(video.videoHeight * s)));
  const ctx = canvas?.getContext('2d') as Ctx2D | null | undefined;
  if (!canvas || !ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A texture exporting `image` with the sampling of `src` — own `Source`, the live one stays untouched. */
function withImage(src: Texture, image: ExportCanvas): Texture {
  const t = new Texture();
  t.source = new Source(image);
  t.name = src.name;
  t.flipY = src.flipY;
  t.channel = src.channel;
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  t.repeat.copy(src.repeat);
  t.offset.copy(src.offset);
  t.center.copy(src.center);
  t.rotation = src.rotation;
  t.colorSpace = src.colorSpace;
  return t;
}

/** What the export uses for `tex`: itself, a converted copy, or null (leave the map out). Cached per texture. */
export function resolveExportTexture(tex: Texture, ctx: ExportTextureContext): Texture | null {
  const cached = ctx.textures.get(tex);
  if (cached !== undefined) return cached;
  let out: Texture | null = null;
  try {
    const image = tex.image as unknown;
    if ((tex as Texture & { isCompressedTexture?: boolean }).isCompressedTexture || image == null) {
      out = null;
    } else if (isDrawableImage(image)) {
      out = hasPixels(image) ? tex : null;
    } else if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) {
      const c = videoFrameToCanvas(image);
      out = c ? withImage(tex, c) : null;
    } else if (typeof image === 'object' && 'data' in image) {
      const c = dataImageToCanvas(image as { data?: unknown; width?: number; height?: number }, tex.format, tex.type);
      out = c ? withImage(tex, c) : null;
    }
  } catch {
    out = null;
  }
  if (out === null) ctx.skipped++;
  else if (out !== tex) ctx.converted++;
  ctx.textures.set(tex, out);
  return out;
}

/**
 * Clone of a live material. `Material.copy` JSON-round-trips `userData`, which
 * throws on circular references — the clone gets the same object by reference
 * instead (synchronous swap, restored before returning).
 */
function cloneMaterial(material: Material): Material {
  const ud = material.userData;
  material.userData = {};
  try {
    const c = material.clone();
    c.userData = ud;
    return c;
  } finally {
    material.userData = ud;
  }
}

/**
 * The material the export tree uses for `material`: the live one when every
 * map is exportable, else one clone (per material) with converted maps and
 * unexportable maps set to null.
 */
export function exportMaterialFor(material: Material, ctx: ExportTextureContext): Material {
  const cached = ctx.materials.get(material);
  if (cached) return cached;
  const m = material as unknown as Record<string, unknown>;
  let changes: Array<[string, Texture | null]> | null = null;
  for (const key of EXPORT_MAP_KEYS) {
    const tex = m[key] as Texture | null | undefined;
    if (!tex || !tex.isTexture) continue;
    const resolved = resolveExportTexture(tex, ctx);
    if (resolved !== tex) (changes ??= []).push([key, resolved]);
  }
  let out = material;
  if (changes) {
    out = cloneMaterial(material);
    const o = out as unknown as Record<string, unknown>;
    for (const [key, tex] of changes) o[key] = tex;
  }
  ctx.materials.set(material, out);
  return out;
}

export interface RuntimeStageTreeOptions {
  /** Default global for existing tree callers; the live mount opts into sibling. */
  primNames?: 'global' | 'sibling';
  /** One cache across the model and MU snapshots: sanitized resources stay shared. */
  textureContext?: ExportTextureContext;
  /**
   * Also capture the {@link StructureBaseline} of the exported nodes (live link,
   * plan-2239 Phase 3). Same filter as the visit: excluded, helper and invisible
   * non-template children are not structural; pre-placed MUs are exported but
   * never counted (gripping re-parents them).
   */
  structure?: boolean;
}

/**
 * Build a detached export tree in traversal order. Global mode retains the
 * historical names. Sibling mode carries placeholders until the post-pass;
 * primPaths already describe the final names, indexed by the same node table.
 */
export function buildRuntimeStageTree(input: RuntimeStageInput, options: RuntimeStageTreeOptions = {}): RuntimeStageTree {
  const scene = new Scene();
  const nodes: Object3D[] = [];
  const primPaths: string[] = [];
  const indexOf = new Map<Object3D, number>();
  const usedNames = new Set<string>();
  const siblingNames = options.primNames === 'sibling' ? new SiblingNameAllocator() : null;
  const finalNames: string[] = [];
  const vertexColorMaterialIds = new Set<number>();
  const templateSet = new Set(input.templates);
  const preplacedSet = new Set(input.preplaced.map((p) => p.node));
  const identities: Array<PrimIdentity | undefined> = [];
  const addresses: Array<string | null> = [];
  const prims = new Map<number, PrimPostData>();
  const textureCtx = options.textureContext ?? createExportTextureContext();
  const convertedBefore = textureCtx.converted, skippedBefore = textureCtx.skipped;

  const uniqueName = (raw: string): string => {
    const base = sanitizePrimName(raw);
    let name = base;
    for (let i = 1; usedNames.has(name); i++) name = `${base}_${i}`;
    usedNames.add(name);
    return name;
  };

  const visit = (node: Object3D, parentClone: Object3D, parentPath: string, isRoot: boolean, inTemplate: boolean): void => {
    if (input.exclude.has(node) || isStageHelper(node)) return;
    if (!node.visible && !templateSet.has(node)) return;

    let clone: Object3D;
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      let material: Material | Material[] = mesh.material;
      const authored = getSourceTemplateMaterial(mesh);
      if (authored) material = authored;
      material = Array.isArray(material)
        ? material.map((mat) => exportMaterialFor(mat, textureCtx))
        : exportMaterialFor(material, textureCtx);
      const m = new Mesh(mesh.geometry, material);
      for (const mat of Array.isArray(material) ? material : [material]) {
        if (hasVertexColorsUntextured(mat)) vertexColorMaterialIds.add((mat as unknown as { id: number }).id);
      }
      clone = m;
    } else {
      clone = new Object3D();
    }
    const finalName = siblingNames ? siblingNames.allocate(parentClone, node.name) : uniqueName(node.name);
    clone.name = siblingNames ? `${PLACEHOLDER_PREFIX}${nodes.length}` : finalName;
    if (siblingNames) finalNames.push(finalName);
    clone.visible = true;
    clone.matrixAutoUpdate = false;
    if (isRoot) {
      node.updateWorldMatrix(true, false);
      clone.matrix.copy(node.matrixWorld);
    } else {
      readLocalMatrix(node, clone.matrix);
    }
    parentClone.add(clone);

    const path = `${parentPath}/${finalName}`;
    inTemplate ||= templateSet.has(node);
    const identity = input.registry ? primIdentityForNode(node, input.registry,
      preplacedSet.has(node) ? { mu: { preplaced: true } } : {}) : undefined;
    identities.push(identity);
    addresses.push(primIdentityAddress(identity));
    if (!inTemplate && identity) prims.set(nodes.length, { customData: identity });
    indexOf.set(node, nodes.length);
    nodes.push(node);
    primPaths.push(path);
    for (const child of node.children) visit(child, clone, path, false, inTemplate);
  };

  visit(input.root, scene, STAGE_SCENE_PATH, true, false);
  // Same synchronous pass: nothing can change the live scene in between.
  const structure = options.structure
    ? captureStructure(nodes, { exclude: input.exclude, templates: templateSet, isMu: (o) => preplacedSet.has(o) })
    : undefined;
  scene.updateMatrixWorld(true);

  const templates = input.templates.map((t) => {
    const i = indexOf.get(t);
    return i === undefined ? '' : primPaths[i];
  });
  const preplaced: Array<{ muId: number; nodeIndex: number }> = [];
  for (const p of input.preplaced) {
    const i = indexOf.get(p.node);
    if (i !== undefined) preplaced.push({ muId: p.muId, nodeIndex: i });
  }
  return {
    scene, nodes, primPaths, indexOf, templates, preplaced, vertexColorMaterialIds,
    identities, addresses, prims,
    templateAddresses: input.templates.map((t) => {
      const i = indexOf.get(t);
      return i === undefined ? null : addresses[i];
    }),
    ...(siblingNames ? { finalNames } : {}),
    ...(structure ? { structure } : {}),
    texturesConverted: textureCtx.converted - convertedBefore,
    texturesSkipped: textureCtx.skipped - skippedBefore,
  };
}

/**
 * Text patches of `model.usda` (see the module comment): primvar reader for
 * vertex-colour materials, `/Materials` moved under `/Root`.
 */
export function patchModelUsda(usda: string, vertexColorMaterialIds: ReadonlySet<number>): string {
  let text = usda;

  for (const id of vertexColorMaterialIds) {
    const head = `def Material "Material_${id}"`;
    const start = text.indexOf(head);
    if (start < 0) continue;
    const surface = text.indexOf('def Shader "PreviewSurface"', start);
    if (surface < 0) continue;
    const diffuseRe = /color3f inputs:diffuseColor = \([^)]*\)/y;
    const diffuseAt = text.indexOf('color3f inputs:diffuseColor = (', surface);
    const nextMaterial = text.indexOf('def Material "', start + head.length);
    if (diffuseAt < 0 || (nextMaterial >= 0 && diffuseAt > nextMaterial)) continue; // textured
    diffuseRe.lastIndex = diffuseAt;
    const match = diffuseRe.exec(text);
    if (!match) continue;
    const readerPath = `</Materials/Material_${id}/PrimvarReader_displayColor.outputs:result>`;
    text = text.slice(0, diffuseAt)
      + `color3f inputs:diffuseColor.connect = ${readerPath}`
      + text.slice(diffuseAt + match[0].length);
    const lineStart = text.lastIndexOf('\n', surface) + 1;
    const indent = text.slice(lineStart, surface);
    const reader = [
      `def Shader "PrimvarReader_displayColor"`,
      '{',
      '\tuniform token info:id = "UsdPrimvarReader_float3"',
      '\tfloat3 inputs:fallback = (1, 1, 1)',
      '\tstring inputs:varname = "displayColor"',
      '\tfloat3 outputs:result',
      '}',
      '',
    ].map((l) => (l ? indent + l : '')).join('\n');
    text = text.slice(0, lineStart) + reader + '\n' + text.slice(lineStart);
  }

  // Move the top-level `def "Materials"` block into `Root`.
  const matHead = text.search(/^def "Materials"/m);
  if (matHead >= 0) {
    const materials = text.slice(matHead).replace(/\s+$/, '');
    let body = text.slice(0, matHead).replace(/\s+$/, '');
    // `body` ends with the closing brace of `Root` (column 0).
    if (body.endsWith('}')) {
      body = body.slice(0, -1).replace(/\s+$/, '');
      const indented = materials.split('\n').map((l) => (l ? '\t' + l : l)).join('\n');
      text = `${body}\n\n${indented}\n}\n`;
    }
  }
  return text.split('</Materials/').join('</Root/Materials/');
}

type Fflate = typeof import('three/examples/jsm/libs/fflate.module.js');

/**
 * Re-zip the usdz files with the alignment `USDZExporter` uses (64-byte data
 * alignment, no compression — required by the USDZ spec).
 */
export function repackUsdz(fflate: Fflate, files: Record<string, Uint8Array>): Uint8Array {
  const ordered: Record<string, Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }]> = {};
  const names = Object.keys(files);
  names.sort((a, b) => (a === 'model.usda' ? -1 : b === 'model.usda' ? 1 : 0));
  let offset = 0;
  for (const name of names) {
    const file = files[name];
    offset += 34 + name.length;
    const mod = offset & 63;
    if (mod !== 4) {
      ordered[name] = [file, { extra: { 12345: new Uint8Array(64 - mod) } }];
    } else {
      ordered[name] = file;
    }
    offset = file.length;
  }
  return fflate.zipSync(ordered as Parameters<Fflate['zipSync']>[0], { level: 0 });
}

/** Optional seams (tests). */
export interface RuntimeStageExportOptions {
  /** Called after the export tree is built and before `parseAsync` starts. */
  onTreeBuilt?(tree: RuntimeStageTree): void;
}

/**
 * Snapshot the running model as `.usdz`. The heavy part (`parseAsync`) runs on
 * the export tree only; the live scene can change meanwhile.
 */
export async function exportRuntimeStage(
  input: RuntimeStageInput,
  options: RuntimeStageExportOptions = {},
): Promise<RuntimeStageSnapshot> {
  const tree = buildRuntimeStageTree(input, { primNames: 'sibling', structure: true });
  options.onTreeBuilt?.(tree);
  const [{ USDZExporter }, fflate, { postProcessModelUsda }, { withSplitOversizedMeshes }, packageLimit] = await Promise.all([
    import('three/examples/jsm/exporters/USDZExporter.js'),
    import('three/examples/jsm/libs/fflate.module.js'),
    import('./usd-stage-post'),
    import('./usd-export-geometry-split'),
    import('./usd-package-limit'),
  ]);
  const exporter = new USDZExporter();
  let exporterWarnings = 0;
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('THREE.USDZExporter')) { exporterWarnings++; return; }
    origWarn(...args);
  };
  let raw: Uint8Array;
  let partNames: ReadonlyMap<string, string> = new Map();
  try {
    // plan-2246: oversized chunk geometries are split for exactly this call
    // (after every table is built), the tree is restored afterwards.
    raw = await withSplitOversizedMeshes(tree.scene, { finalNames: tree.finalNames!, primPaths: tree.primPaths }, async (split) => {
      partNames = split.partNames;
      packageLimit.assertStageUsdzPackageFits(tree.scene, {
        post: { finalNames: tree.finalNames!, prims: tree.prims, partNames },
      });
      return new Uint8Array(await exporter.parseAsync(tree.scene, {
        onlyVisible: true,
        includeAnchoringProperties: false,
        quickLookCompatible: false,
      }));
    });
  } finally {
    console.warn = origWarn;
  }
  const files = fflate.unzipSync(raw);
  const usda = fflate.strFromU8(files['model.usda']);
  const patched = patchModelUsda(usda, tree.vertexColorMaterialIds);
  files['model.usda'] = fflate.strToU8(postProcessModelUsda(patched, {
    finalNames: tree.finalNames!, prims: tree.prims, ...(partNames.size ? { partNames } : {}),
  }).text);
  // Complete payload sizes, before the final archive allocation.
  packageLimit.assertUsdzFilesFit(files);
  const usdz = repackUsdz(fflate, files);
  packageLimit.assertUsdzPackageSize(usdz.byteLength);
  return {
    usdz,
    nodes: tree.nodes,
    primPaths: tree.primPaths,
    indexOf: tree.indexOf,
    templates: tree.templates,
    identities: tree.identities,
    addresses: tree.addresses,
    templateAddresses: tree.templateAddresses,
    preplaced: tree.preplaced,
    exporterWarnings,
    texturesConverted: tree.texturesConverted,
    texturesSkipped: tree.texturesSkipped,
    ...(tree.structure ? { structure: tree.structure } : {}),
  };
}

/** gzip via `CompressionStream` when the browser has it, else identity. */
export async function compressForMount(bytes: Uint8Array): Promise<{ bytes: Uint8Array; encoding: 'gzip' | 'identity' }> {
  const { assertUsdzPackageSize } = await import('./usd-package-limit');
  assertUsdzPackageSize(bytes.byteLength);
  if (typeof CompressionStream === 'undefined') return { bytes, encoding: 'identity' };
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return { bytes: out, encoding: 'gzip' };
}
