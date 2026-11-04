// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVUberArenaMaterial — the editor's uber material for a BatchedMesh arena
 * (plan-766 Phase 2, §2.4.3).
 *
 * The runtime `RVUberMaterial` reads colour and roughness/metalness from
 * per-VERTEX attributes baked into merged geometry. The editor arena cannot
 * bake: every instance must be recolourable in O(1) when the user assigns a
 * material. So here both come per INSTANCE:
 *
 *   - colour: three's own batching colour texture (`BatchedMesh.setColorAt`),
 *     multiplied into `vColor` by `color_vertex` (`USE_BATCHING_COLOR` →
 *     `USE_COLOR_ALPHA`). The material itself keeps `vertexColors: false` and
 *     a white base colour.
 *   - roughness/metalness: an own RG8 `DataTexture`, one texel per instance id,
 *     read in the vertex shader right after `#include <batching_vertex>` via
 *     `getIndirectIndex( gl_DrawID )` (there is no `batchId`, and `gl_DrawID`
 *     is the DRAW index — invisible instances are skipped — so the indirect
 *     texture maps it back to the instance id), forwarded as `vRm` and written
 *     over `roughnessFactor` / `metalnessFactor` in the fragment shader exactly
 *     like the runtime uber patch.
 *
 * WebGPU: `onBeforeCompile` is ignored by the node renderer, so no patch is
 * installed (same guard as `RVUberMaterial`); colour per instance still works,
 * roughness/metalness fall back to the material defaults (1 / 0) — the same
 * reduced state the runtime uber has on WebGPU.
 *
 * One instance per arena: the rm texture is the arena's. Never shared across
 * arenas, disposed by the arena manager together with its texture.
 */

import {
  DataTexture,
  FrontSide,
  MeshStandardMaterial,
  RGFormat,
  UnsignedByteType,
  type IUniform,
} from 'three';

/** Program cache key — every arena material shares one compiled program. */
export const UBER_ARENA_PROGRAM_KEY = '__rvUberArena_v1';
/** Name of the rm sampler uniform in the patched shader. */
export const UBER_ARENA_RM_UNIFORM = 'rvArenaRmTexture';

let _warnedWebGPU = false;
function warnArenaWebGPUOnce(): void {
  if (_warnedWebGPU) return;
  _warnedWebGPU = true;
  console.warn(
    '[UberArenaMaterial] WebGPU renderer: per-instance roughness/metalness is ' +
    'disabled (onBeforeCompile is ignored); per-instance colour stays correct.',
  );
}

/** Side length of the square rm texture for `capacity` instances. */
export function rmTextureSize(capacity: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, capacity))));
}

function makeRmTexture(capacity: number, copyFrom?: Uint8Array): DataTexture {
  const size = rmTextureSize(capacity);
  const data = new Uint8Array(size * size * 2);
  // Default = rough, non-metal (the runtime uber's default for missing rm).
  for (let i = 0; i < size * size; i++) data[i * 2] = 255;
  if (copyFrom) data.set(copyFrom.subarray(0, Math.min(copyFrom.length, data.length)));
  const tex = new DataTexture(data, size, size, RGFormat, UnsignedByteType);
  // Rows of an RG8 texture are 2·size bytes — not 4-aligned for odd sizes.
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.name = '__rvUberArenaRm';
  return tex;
}

/** Vertex patch: sampler + varying after `<common>`, fetch after `<batching_vertex>`. */
export const UBER_ARENA_VERTEX_DECL =
  `uniform highp sampler2D ${UBER_ARENA_RM_UNIFORM};\nvarying vec2 vRm;`;
export const UBER_ARENA_VERTEX_FETCH = [
  '#ifdef USE_BATCHING',
  '\t{',
  '\t\tint rvArenaId = int( getIndirectIndex( gl_DrawID ) );',
  `\t\tint rvArenaSize = textureSize( ${UBER_ARENA_RM_UNIFORM}, 0 ).x;`,
  `\t\tvRm = texelFetch( ${UBER_ARENA_RM_UNIFORM}, ivec2( rvArenaId % rvArenaSize, rvArenaId / rvArenaSize ), 0 ).rg;`,
  '\t}',
  '#else',
  '\tvRm = vec2( 1.0, 0.0 );',
  '#endif',
].join('\n');

/** Shader source transform (exported for the shader-string tests). */
export function patchUberArenaShader(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${UBER_ARENA_VERTEX_DECL}`)
    .replace('#include <batching_vertex>', `#include <batching_vertex>\n${UBER_ARENA_VERTEX_FETCH}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vRm;')
    .replace(
      '#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\nroughnessFactor = vRm.x;',
    )
    .replace(
      '#include <metalnessmap_fragment>',
      '#include <metalnessmap_fragment>\nmetalnessFactor = vRm.y;',
    );
}

export class RVUberArenaMaterial extends MeshStandardMaterial {
  readonly isRVUberArenaMaterial = true;
  /** True when the GLSL patch is installed (false on WebGPU). */
  readonly patched: boolean;
  private _rmTexture: DataTexture;
  private _capacity: number;
  /** The uniform object handed to the program — its `.value` follows growth. */
  private readonly _rmUniform: IUniform<DataTexture>;

  constructor(capacity: number, isWebGPU = false) {
    super({
      color: 0xffffff,    // identity — real colour comes from the batching colour texture
      roughness: 1.0,     // identity — replaced in the fragment shader by vRm.x
      metalness: 0.0,     // identity — replaced in the fragment shader by vRm.y
      vertexColors: false,
      side: FrontSide,
    });
    this.name = '__rvUberArenaMaterial';
    this._capacity = Math.max(1, capacity);
    this._rmTexture = makeRmTexture(this._capacity);
    this._rmUniform = { value: this._rmTexture };
    this.patched = !isWebGPU;

    if (isWebGPU) {
      warnArenaWebGPUOnce();
      return;
    }
    this.onBeforeCompile = (shader) => {
      shader.uniforms[UBER_ARENA_RM_UNIFORM] = this._rmUniform;
      patchUberArenaShader(shader);
    };
    this.customProgramCacheKey = () => UBER_ARENA_PROGRAM_KEY;
  }

  /** The per-instance roughness/metalness texture (RG8). */
  get rmTexture(): DataTexture { return this._rmTexture; }

  /** Instance capacity the rm texture is sized for. */
  get capacity(): number { return this._capacity; }

  /** Write roughness/metalness (0..1) for one instance id. */
  setRmAt(instanceId: number, roughness: number, metalness: number): void {
    if (instanceId >= this._capacity) this.ensureCapacity(instanceId + 1);
    const data = this._rmTexture.image.data as Uint8Array;
    data[instanceId * 2] = Math.round(Math.min(1, Math.max(0, roughness)) * 255);
    data[instanceId * 2 + 1] = Math.round(Math.min(1, Math.max(0, metalness)) * 255);
    this._rmTexture.needsUpdate = true;
  }

  /** Read back roughness/metalness (0..1) of one instance id. */
  getRmAt(instanceId: number): [number, number] {
    const data = this._rmTexture.image.data as Uint8Array;
    return [data[instanceId * 2] / 255, data[instanceId * 2 + 1] / 255];
  }

  /** Grow the rm texture (keeps every written texel). Never shrinks. */
  ensureCapacity(capacity: number): void {
    if (capacity <= this._capacity) return;
    const old = this._rmTexture;
    const oldSize = rmTextureSize(this._capacity);
    const newSize = rmTextureSize(capacity);
    this._capacity = capacity;
    if (newSize === oldSize) return;
    // Texel i lives at the same linear offset in both — the shader indexes by
    // id with the CURRENT texture width, so a linear copy keeps every id.
    this._rmTexture = makeRmTexture(capacity, old.image.data as Uint8Array);
    this._rmUniform.value = this._rmTexture;
    old.dispose();
  }

  override dispose(): void {
    this._rmTexture.dispose();
    super.dispose();
  }
}
