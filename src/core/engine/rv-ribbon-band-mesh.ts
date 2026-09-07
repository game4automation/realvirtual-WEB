// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ribbon-band-mesh.ts — the strip of material a `RibbonPath` renders (plan-459).
 *
 * ## THE mm → m boundary
 *
 * Everything upstream of this file — `ribbon-geometry.ts`, `ribbon-winder-math.ts`,
 * `RVRibbonPath`, `RVRibbonWinder` — is millimetres, exactly as Unity authors it.
 * {@link RVRibbonBandMesh.write} is the ONE place that divides by
 * `MM_TO_METERS` to reach glTF world units. Plan §Entscheidungs-Log fixes that
 * here on purpose: a second conversion point is how a unit contract rots.
 *
 * ## Topology once, positions per change
 *
 * Index and UV buffers are built ONCE for `maxSamples`; only `position` is
 * rewritten, with `DynamicDrawUsage` and a `setDrawRange` that follows the
 * actual sample count. That is what makes a growing winder cost a buffer write
 * rather than a geometry rebuild.
 *
 * The UV `u` coordinate is the sample's ARC LENGTH in millimetres, not a
 * normalised fraction: normalising would rescale the whole band every time a
 * roll changes size, and the pattern would visibly crawl. In millimetres the
 * repetition count is carried by `texture.repeat.x` (mm → repetitions), which
 * {@link setTextureLength} sets — so a standing web needs no UV rewrite at all,
 * and scrolling stays `texture.offset.x` in repetitions.
 *
 * `u` was the raw sample INDEX until the plan-460 follow-up. That was equivalent
 * only while the samples were equidistant; on the absolute `i * step` grid the
 * LAST interval is shorter than a step, and an index-based `u` gave it a full
 * step of texture — a visible compression at the winder tangent point. The UV
 * buffer is therefore rewritten by `setTextureLength` on a rebuild (never per
 * frame, and never by {@link write}), which is the same cadence the position
 * buffer already has.
 *
 * ## Sections (plan-460 F1)
 *
 * A dancer splits the web into sections that run at DIFFERENT speeds, so their
 * texture offsets must move independently — but they are one continuous band and
 * must stay one mesh (a second mesh would leave a visible seam at the dancer,
 * and would double the capacity logic; plan §Alternative 1).
 *
 * The answer is `BufferGeometry.addGroup`: one group per section, each pointing
 * at its own CLONE of the band material. The clones share `map.image`, so N
 * sections still cost ONE texture upload and only N draw calls. A band with a
 * single section keeps a single (non-array) material, which is what makes the
 * plan-459 behaviour bit-identical.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  Vector3,
} from 'three';
import type { Material, Object3D, Texture } from 'three';
import { MM_TO_METERS } from './rv-constants';
import { RV_RIBBON_BAND } from './rv-traverse-utils';
import { CHAIN_SAMPLE_STRIDE } from './rv-chain-path';

/** Floats per 3D sample handed to {@link RVRibbonBandMesh.write}: `[p, t, u] * 3`. */
export const RIBBON_BAND_SAMPLE_STRIDE = CHAIN_SAMPLE_STRIDE;

/** A material that may carry a colour map. */
interface MappedMaterial extends Material {
  map?: Texture | null;
}

// ── Pre-allocated scratch: write() allocates nothing ──
const _p = new Vector3();
const _t = new Vector3();
const _u = new Vector3();
const _n = new Vector3();

/** Size of the generated default band texture (one repeat). */
const DEFAULT_TEX_W = 128;
const DEFAULT_TEX_H = 32;

/**
 * A 2 × 2 paper-white texture with one darker texel, so a band without an
 * authored material still shows that it is moving. Cheap enough to build per
 * band; disposed with it.
 */
function buildDefaultRibbonTexture(): DataTexture {
  // One repeat = TextureLengthMm of web: paper white, a dark register band at
  // the start of the repeat, a dot on the centre line and an arrowhead pointing
  // in the running direction (+u), so speed AND direction read from the band.
  const W = DEFAULT_TEX_W;
  const H = DEFAULT_TEX_H;
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      let r = 246, g = 244, b = 238;
      const edge = v < 0.06 || v > 0.94;                 // selvedge lines
      const band = u < 0.08;                             // register band
      const arrow = u > 0.45 && u < 0.7 && Math.abs(v - 0.5) < 0.5 * (1 - (u - 0.45) / 0.25);
      if (edge) { r = 200; g = 196; b = 186; }
      if (band || arrow) { r = 96; g = 92; b = 86; }
      const at = (y * W + x) * 4;
      data[at] = r; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
    }
  }
  const tex = new DataTexture(data, W, H, RGBAFormat);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Material texture slots that sample the band's own UV channel and must
 * therefore follow its mm → repetition scale and its scroll offset.
 *
 * `envMap` is deliberately absent: it is an environment lookup, not a surface
 * map, and rescaling it would be meaningless. Everything else a
 * `MeshStandardMaterial` can carry is here, because a web borrowed from a CAD
 * material routinely arrives with a normal and a roughness map, and scaling only
 * the colour map leaves the surface relief at a completely different pitch —
 * a normal map that spanned one repetition over the band spanning twenty.
 */
const BAND_TEXTURE_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'lightMap',
] as const;

/**
 * Replace every {@link BAND_TEXTURE_SLOTS} texture of `material` with a CLONE
 * this band owns, and return the clones.
 *
 * Cloning is not optional: the donor's textures are shared with the donor mesh,
 * so writing `repeat` / `offset` on them would rescale and scroll the CAD part
 * the material was borrowed from. `Texture.clone()` shares the `image` (the GPU
 * upload) and copies only the sampler state, so this costs no extra upload.
 */
function cloneBandTextures(material: MeshStandardMaterial): Texture[] {
  const slots = material as unknown as Record<string, Texture | null | undefined>;
  const out: Texture[] = [];
  for (const slot of BAND_TEXTURE_SLOTS) {
    const tex = slots[slot];
    if (!tex || (tex as { isTexture?: boolean }).isTexture !== true) continue;
    const clone = tex.clone();
    clone.wrapS = RepeatWrapping;
    clone.wrapT = RepeatWrapping;
    clone.needsUpdate = true;
    slots[slot] = clone;
    out.push(clone);
  }
  return out;
}

/**
 * The renderable band. Owns its geometry, and owns whatever material and texture
 * it CREATED (never one it merely borrowed) — see {@link dispose}.
 */
export class RVRibbonBandMesh {
  readonly mesh: Mesh;
  readonly maxSamples: number;

  private readonly _geometry: BufferGeometry;
  private readonly _positions: Float32Array;
  /** Per-vertex normals (`t × u`, both edge vertices alike); DoubleSide flips the back. */
  private readonly _normals: Float32Array;
  /** Textures this band cloned or generated, and must therefore free. */
  private readonly _ownedTextures: Texture[] = [];
  /** True when the material is this band's own creation (not a shared clone). */
  private readonly _ownsMaterial: boolean;
  /** One material per section; `[0]` is the base material (plan-460 F1). */
  private readonly _sectionMaterials: MeshStandardMaterial[] = [];
  /** The scrollable colour map of each section, parallel to {@link _sectionMaterials}. */
  private readonly _maps: Texture[] = [];
  /**
   * EVERY texture of each section, colour map included — parallel to
   * {@link _sectionMaterials}, one inner array per section. This is what the
   * scale and the scroll are applied to; {@link _maps} is only the colour map,
   * which is what diagnostics and the export path ask for.
   */
  private readonly _sectionTextures: Texture[][] = [];
  /** First SAMPLE of each section; `[0]` is always 0. */
  private _sectionStarts: number[] = [0];
  private _widthMm: number;
  private _sampleCount = 0;

  /**
   * @param maxSamples  capacity of the sample buffer (>= 2).
   * @param widthMm     web width; extruded symmetrically along the up vector.
   * @param source      optional node whose FIRST mapped material the band copies.
   */
  constructor(maxSamples: number, widthMm: number, source?: Object3D | null) {
    this.maxSamples = Math.max(2, Math.floor(maxSamples));
    this._widthMm = widthMm;

    const verts = this.maxSamples * 2;
    this._positions = new Float32Array(verts * 3);
    this._normals = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const indices = new Uint32Array((this.maxSamples - 1) * 6);

    for (let i = 0; i < this.maxSamples; i++) {
      // u = arc length in mm (see the header), seeded with the sample index and
      // rewritten by `setTextureLength` once the real grid is known; v = 0 / 1
      // across the width, and never rewritten.
      uvs[i * 4] = i;
      uvs[i * 4 + 1] = 0;
      uvs[i * 4 + 2] = i;
      uvs[i * 4 + 3] = 1;
    }
    for (let i = 0; i < this.maxSamples - 1; i++) {
      const a = i * 2;
      const at = i * 6;
      indices[at] = a;
      indices[at + 1] = a + 1;
      indices[at + 2] = a + 2;
      indices[at + 3] = a + 1;
      indices[at + 4] = a + 3;
      indices[at + 5] = a + 2;
    }

    const posAttr = new BufferAttribute(this._positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    this._geometry = new BufferGeometry();
    this._geometry.setAttribute('position', posAttr);
    const nrmAttr = new BufferAttribute(this._normals, 3);
    nrmAttr.setUsage(DynamicDrawUsage);
    this._geometry.setAttribute('normal', nrmAttr);
    this._geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    this._geometry.setIndex(new BufferAttribute(indices, 1));
    this._geometry.setDrawRange(0, 0);

    const borrowed = source ? firstMappedMaterial(source) : null;
    let material: MeshStandardMaterial;
    let textures: Texture[];
    if (borrowed) {
      material = borrowed.clone() as MeshStandardMaterial;
      // ALL of them, not just the colour map: a borrowed CAD material brings its
      // normal / roughness / ao maps along, and they share the donor's textures
      // until they are cloned here.
      textures = cloneBandTextures(material);
      this._ownedTextures.push(...textures);
    } else {
      const tex = buildDefaultRibbonTexture();
      this._ownedTextures.push(tex);
      material = new MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0 });
      textures = [tex];
    }
    material.side = DoubleSide;
    this._ownsMaterial = true;
    this._sectionMaterials.push(material);
    this._sectionTextures.push(textures);
    if (material.map) this._maps.push(material.map);

    this.mesh = new Mesh(this._geometry, material);
    this.mesh.name = '__rvRibbonBand';
    // The band is written in the path node's local frame every rebuild, so its
    // bounding sphere is stale between rebuilds — and a winder makes it change
    // shape continuously. Frustum culling would blink it out; the whole band is
    // one draw call, so there is nothing to save by keeping it.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.userData[RV_RIBBON_BAND] = true;
    // Never a click target: the RibbonPath node is what the user selects.
    this.mesh.raycast = () => { /* not pickable */ };
    // Keep the band out of the loader's asynchronous BVH build. That build hands
    // the position/index buffers to a worker as transferables, which DETACHES the
    // ArrayBuffer — and this band rewrites its position attribute every tick
    // (DynamicDrawUsage). The race yields NaN bounding spheres and a fatal
    // "Resizing buffer attributes is not supported" on the next render pass.
    // Nothing is lost: the mesh is not pickable, so it needs no BVH at all.
    this.mesh.userData._rvSkipBVH = true;
  }

  /** Sample count of the last {@link write} (diagnostics + tests). */
  get sampleCount(): number {
    return this._sampleCount;
  }

  /** The scrollable colour map of the FIRST section, or `null` without one. */
  get map(): Texture | null {
    return this._maps[0] ?? null;
  }

  /** One colour map per section, in running order (plan-460 F1). */
  get maps(): readonly Texture[] {
    return this._maps;
  }

  /** Number of sections the band is currently split into (>= 1). */
  get sectionCount(): number {
    return this._sectionMaterials.length;
  }

  /** First sample of each section, in running order; `[0]` is always 0. */
  get sectionStarts(): readonly number[] {
    return this._sectionStarts;
  }

  /** mm — the current web width. */
  get widthMm(): number {
    return this._widthMm;
  }

  set widthMm(value: number) {
    this._widthMm = value;
  }

  /**
   * Write `count` samples into the position buffer. **This is the single
   * mm → m boundary** (see the file header).
   *
   * @param samples  flat `[px,py,pz, tx,ty,tz, ux,uy,uz] * n` in MILLIMETRES,
   *                 in the band's parent frame; `u` is the web axis.
   * @param count    number of samples to use (clamped to the capacity).
   * @param widthMm  web width in millimetres.
   * @param thicknessOffsetMm  optional lift along the surface normal
   *                 (`t × u`). `RVRibbonPath` passes `0` — it folds the half
   *                 thickness into the CONTACT RADIUS instead, which is correct
   *                 for a Right-side wrap too; the parameter exists for callers
   *                 that want a flat lift and is what test §9.5 exercises.
   */
  write(
    samples: Float32Array,
    count: number,
    widthMm: number,
    thicknessOffsetMm = 0,
    slitIndex = -1,
    fullWidthMm = 0,
    drawStart = 0,
  ): void {
    const n = Math.max(0, Math.min(count, this.maxSamples));
    this._widthMm = widthMm;
    const halfW = widthMm / 2 / MM_TO_METERS;
    // Before a slit the band is the FULL web; from the slit sample on, the strip.
    const halfFull = fullWidthMm > 0 ? fullWidthMm / 2 / MM_TO_METERS : halfW;
    const slit = slitIndex >= 0 && fullWidthMm > 0 ? slitIndex : -1;
    const off = thicknessOffsetMm / MM_TO_METERS;

    for (let i = 0; i < n; i++) {
      const s = i * RIBBON_BAND_SAMPLE_STRIDE;
      _p.set(samples[s] / MM_TO_METERS, samples[s + 1] / MM_TO_METERS, samples[s + 2] / MM_TO_METERS);
      _t.set(samples[s + 3], samples[s + 4], samples[s + 5]);
      _u.set(samples[s + 6], samples[s + 7], samples[s + 8]);
      // Triangle winding is (left_i, right_i, left_i+1), i.e. u × t — the normal
      // must agree with it, or the lit side is the back face.
      _n.copy(_u).cross(_t);
      const len = _n.length();
      if (len > 1e-9) _n.multiplyScalar(1 / len); else _n.set(0, 1, 0);
      // The lift keeps its original direction (`t x u`), the normal is its negation.
      if (off !== 0) _p.addScaledVector(_n, -off);
      const hw = slit >= 0 && i < slit ? halfFull : halfW;
      const at = i * 6;
      this._normals[at] = _n.x; this._normals[at + 1] = _n.y; this._normals[at + 2] = _n.z;
      this._normals[at + 3] = _n.x; this._normals[at + 4] = _n.y; this._normals[at + 5] = _n.z;
      this._positions[at] = _p.x - _u.x * hw;
      this._positions[at + 1] = _p.y - _u.y * hw;
      this._positions[at + 2] = _p.z - _u.z * hw;
      this._positions[at + 3] = _p.x + _u.x * hw;
      this._positions[at + 4] = _p.y + _u.y * hw;
      this._positions[at + 5] = _p.z + _u.z * hw;
    }

    this._sampleCount = n;
    const attr = this._geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
    (this._geometry.getAttribute('normal') as BufferAttribute).needsUpdate = true;
    this.setDrawStart(drawStart);
    this._geometry.computeBoundingSphere();
  }

  /**
   * Draw from sample `start` to the end. A slit strip that does NOT own the
   * shared full-width part hides everything before its slit sample.
   */
  setDrawStart(start: number): void {
    const n = this._sampleCount;
    const s = Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(start)));
    this._geometry.setDrawRange(s * 6, Math.max(0, (n - 1 - s) * 6));
  }

  /**
   * Map the texture along the band by ARC LENGTH: the `u` of sample `i` is its
   * distance from the path start in millimetres, and `repeat.x` turns those
   * millimetres into texture repetitions.
   *
   * ## Why `u` is millimetres and not the sample index
   *
   * `sampleArcLength` writes an ABSOLUTE grid — sample `i` at `i * stepMm`, with
   * the LAST sample on the path end — so the final interval is `length mod step`
   * long and every other one is exactly a step. A `u` that counts SAMPLES gives
   * every interval the same slice of texture, so a last interval a millimetre
   * long would carry a whole step of it: a visible compression right at the
   * winder tangent point, which is the one place a converting machine is looked
   * at closely. In millimetres the mapping is proportional by construction, for
   * every interval including the last.
   *
   * `repeat.x` stays the SCALE (mm → repetitions) so `offset.x` keeps meaning
   * repetitions, which is what {@link scroll} adds to it.
   *
   * `stepMm` is the grid `sampleArcLength` actually used — NOT `1000 /
   * SamplesPerMeter`, which the capacity rule may have coarsened. Omitting it
   * falls back to the uniform `length / (count - 1)` spacing, which is what a
   * caller that does not sample on a grid (a test) wants.
   */
  setTextureLength(lengthMm: number, textureLengthMm: number, stepMm?: number): void {
    const n = this._sampleCount;
    if (n < 2) return;
    const step = stepMm !== undefined && stepMm > 0 ? stepMm : lengthMm / (n - 1);
    const uv = this._geometry.getAttribute('uv') as BufferAttribute;
    const array = uv.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const at = Math.min(i * step, lengthMm);
      array[i * 4] = at;
      array[i * 4 + 2] = at;
    }
    uv.needsUpdate = true;
    // EVERY texture of EVERY section: the sections share one `u` space, so a
    // stale repeat on section 1 shows as a texture jump at the dancer — and a
    // normal map left at the colour map's old scale shows as relief at the wrong
    // pitch, which is worse because it does not look like a bug.
    const perMm = textureLengthMm > 0 ? 1 / textureLengthMm : (lengthMm > 0 ? 1 / lengthMm : 1);
    for (const textures of this._sectionTextures) {
      for (const tex of textures) tex.repeat.x = perMm;
    }
  }

  /**
   * Scroll by `du` (in texture repetitions).
   *
   * `scroll(du)` moves EVERY section — the plan-459 single-speed band, and the
   * shape the reset path wants. `scroll(section, du)` moves one section, which
   * is what a path with a dancer calls once per section per tick.
   */
  scroll(sectionOrDu: number, du?: number): void {
    if (du === undefined) {
      if (sectionOrDu === 0) return;
      // Every texture, not only the colour map: a normal map that stood still
      // while the colour ran would read as a printed pattern sliding over a
      // stationary surface.
      for (const textures of this._sectionTextures) {
        for (const tex of textures) scrollMap(tex, sectionOrDu);
      }
      return;
    }
    if (du === 0) return;
    for (const tex of this._sectionTextures[sectionOrDu] ?? []) scrollMap(tex, du);
  }

  /** Reset every section's scroll offset to the authored state. */
  resetScroll(): void {
    for (const textures of this._sectionTextures) {
      for (const tex of textures) tex.offset.set(0, 0);
    }
  }

  /**
   * Split the drawn band into sections starting at the given SAMPLE indices.
   * `starts[0]` is forced to 0; entries must be ascending. A single section
   * removes the groups and the material array again, so the plan-459 band stays
   * a single-material, single-draw-call mesh.
   *
   * Material clones are created once per section index and reused across
   * rebuilds — a dancer moves every tick, and reallocating materials at 60 Hz
   * would be the one GC source in this whole subsystem.
   */
  setSections(starts: readonly number[]): void {
    const n = this._sampleCount;
    const clean: number[] = [0];
    for (const raw of starts) {
      const s = Math.max(0, Math.min(Math.max(0, n - 1), Math.floor(raw)));
      if (s > clean[clean.length - 1]) clean.push(s);
    }
    this._sectionStarts = clean;
    this._ensureSectionMaterials(clean.length);

    this._geometry.clearGroups();
    if (clean.length <= 1) {
      this.mesh.material = this._sectionMaterials[0];
      return;
    }
    for (let k = 0; k < clean.length; k++) {
      const from = clean[k];
      const to = k + 1 < clean.length ? clean[k + 1] : Math.max(0, n - 1);
      if (to <= from) continue;
      // Six indices per sample step, matching the index buffer built in the ctor.
      this._geometry.addGroup(from * 6, (to - from) * 6, k);
    }
    this.mesh.material = this._sectionMaterials.slice(0, clean.length);
  }

  /** Grow the per-section material/map arrays to `count` entries. */
  private _ensureSectionMaterials(count: number): void {
    const base = this._sectionMaterials[0];
    while (this._sectionMaterials.length < count) {
      const clone = base.clone();
      // `Texture.clone()` shares the `image` (the GPU upload) and copies only
      // the sampler state, so N sections cost ONE upload and N offsets — for
      // every map the material carries, so a section scrolls its whole surface.
      const textures = cloneBandTextures(clone);
      this._ownedTextures.push(...textures);
      this._sectionTextures.push(textures);
      if (clone.map) this._maps.push(clone.map);
      clone.side = DoubleSide;
      this._sectionMaterials.push(clone);
    }
  }

  /** Free geometry, generated/cloned textures and the band's own materials. */
  dispose(): void {
    this.mesh.removeFromParent();
    this._geometry.dispose();
    for (const tex of this._ownedTextures) tex.dispose();
    this._ownedTextures.length = 0;
    this._maps.length = 0;
    this._sectionTextures.length = 0;
    if (this._ownsMaterial) for (const mat of this._sectionMaterials) mat.dispose();
    this._sectionMaterials.length = 0;
  }
}

/**
 * A fragment at `u` samples the map at `u + offset`, so the pattern moves
 * towards `-u` as the offset grows. The web runs towards `+u`: subtract. The
 * wrap keeps a long run from losing float precision in the offset.
 */
function scrollMap(map: Texture, du: number): void {
  map.offset.x -= du;
  map.offset.x -= Math.floor(map.offset.x);
}

/** The first material carrying a colour map anywhere under `source`. */
function firstMappedMaterial(source: Object3D): MeshStandardMaterial | null {
  let found: MeshStandardMaterial | null = null;
  source.traverse((child) => {
    if (found) return;
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      const mat = raw as MappedMaterial;
      if (mat?.map) {
        found = mat as MeshStandardMaterial;
        return;
      }
    }
  });
  return found;
}
