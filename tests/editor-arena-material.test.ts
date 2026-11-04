// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.8 — RVUberArenaMaterial: per-instance colour (batching colour
 * texture) and roughness/metalness (own RG8 texture read via
 * getIndirectIndex(gl_DrawID)).
 *
 * What is verified:
 *   - PIXEL PROBE (real WebGL2 in headless Chromium): two instances of the SAME
 *     geometry in one BatchedMesh draw with different colours, and with
 *     different metalness (metal under ambient-only light renders dark, so the
 *     rm texture demonstrably reaches the fragment shader);
 *   - the shader patch strings land on all four anchors of the physical shader;
 *   - the colour texture exists before the first render (no program switch);
 *   - bucket switch uber → textured → transparent → uber via setMaterial;
 *   - WebGPU guard: no patch, no error.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AmbientLight, BatchedMesh, Color, Group, MeshStandardMaterial, OrthographicCamera, PlaneGeometry,
  Scene, ShaderLib, UnsignedByteType, WebGLRenderer, WebGLRenderTarget, Matrix4,
} from 'three';
import {
  RVUberArenaMaterial, UBER_ARENA_PROGRAM_KEY, UBER_ARENA_RM_UNIFORM, patchUberArenaShader, rmTextureSize,
} from '../src/core/engine/rv-uber-arena-material';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { part, testRoleOf, texturedMat, uberMat } from './helpers/editor-arena-fixture';

const W = 64;
const H = 32;

function renderTwoInstances(
  a: { color: number; rough: number; metal: number },
  b: { color: number; rough: number; metal: number },
): { left: number[]; right: number[]; errors: number } {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = new WebGLRenderer({ canvas });
  const errors = vi.spyOn(console, 'error');
  const scene = new Scene();
  scene.background = new Color(0x000000);
  scene.add(new AmbientLight(0xffffff, 3));
  const camera = new OrthographicCamera(-2, 2, 1, -1, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.updateMatrixWorld();

  const mat = new RVUberArenaMaterial(4);
  const bm = new BatchedMesh(4, 64, 128, mat);
  bm.sortObjects = false;
  bm.perObjectFrustumCulled = false;
  bm.frustumCulled = false;
  const gid = bm.addGeometry(new PlaneGeometry(1.8, 1.8));
  const i0 = bm.addInstance(gid);
  const i1 = bm.addInstance(gid);
  bm.setMatrixAt(i0, new Matrix4().makeTranslation(-1, 0, 0));
  bm.setMatrixAt(i1, new Matrix4().makeTranslation(1, 0, 0));
  bm.setColorAt(i0, new Color(a.color));
  bm.setColorAt(i1, new Color(b.color));
  mat.setRmAt(i0, a.rough, a.metal);
  mat.setRmAt(i1, b.rough, b.metal);
  scene.add(bm);

  const target = new WebGLRenderTarget(W, H, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, px);
  renderer.setRenderTarget(null);
  const at = (x: number, y: number) => {
    const o = (y * W + x) * 4;
    return [px[o], px[o + 1], px[o + 2]];
  };
  const out = { left: at(W / 4, H / 2), right: at((3 * W) / 4, H / 2), errors: errors.mock.calls.length };
  errors.mockRestore();
  target.dispose();
  bm.dispose();
  mat.dispose();
  renderer.dispose();
  return out;
}

describe('RVUberArenaMaterial — pixel probe (WebGL2)', () => {
  it('per-instance colour: same geometry, red left, green right', () => {
    const r = renderTwoInstances(
      { color: 0xff0000, rough: 1, metal: 0 },
      { color: 0x00ff00, rough: 1, metal: 0 },
    );
    expect(r.errors).toBe(0);
    expect(r.left[0]).toBeGreaterThan(100);
    expect(r.left[1]).toBeLessThan(30);
    expect(r.right[1]).toBeGreaterThan(100);
    expect(r.right[0]).toBeLessThan(30);
  });

  it('per-instance roughness/metalness reaches the fragment shader (metal = dark under ambient light)', () => {
    const r = renderTwoInstances(
      { color: 0xffffff, rough: 1, metal: 0 },
      { color: 0xffffff, rough: 1, metal: 1 },
    );
    expect(r.errors).toBe(0);
    const lum = (p: number[]) => p[0] + p[1] + p[2];
    expect(lum(r.left)).toBeGreaterThan(300);
    expect(lum(r.right)).toBeLessThan(lum(r.left) / 4);
  });
});

describe('RVUberArenaMaterial — shader patch + texture', () => {
  it('patch lands on all four anchors of the physical shader and the sampler is a uniform', () => {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    };
    const mat = new RVUberArenaMaterial(10);
    (mat.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, null);
    expect(shader.uniforms[UBER_ARENA_RM_UNIFORM]).toEqual({ value: mat.rmTexture });
    expect(shader.vertexShader).toContain(`uniform highp sampler2D ${UBER_ARENA_RM_UNIFORM};`);
    expect(shader.vertexShader).toContain('getIndirectIndex( gl_DrawID )');
    expect(shader.vertexShader).not.toContain('batchId');
    expect(shader.vertexShader.indexOf('#include <batching_vertex>'))
      .toBeLessThan(shader.vertexShader.indexOf('getIndirectIndex( gl_DrawID )'));
    expect(shader.fragmentShader).toContain('roughnessFactor = vRm.x;');
    expect(shader.fragmentShader).toContain('metalnessFactor = vRm.y;');
    expect(mat.customProgramCacheKey()).toBe(UBER_ARENA_PROGRAM_KEY);
    expect(mat.vertexColors).toBe(false);
    // the helper alone is the same transform
    const s2 = { vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
    patchUberArenaShader(s2);
    expect(s2.vertexShader).toBe(shader.vertexShader);
  });

  it('rm texture grows with the arena and keeps every written texel', () => {
    const mat = new RVUberArenaMaterial(4);
    mat.setRmAt(3, 0.25, 0.75);
    const before = mat.rmTexture;
    expect(before.image.width).toBe(rmTextureSize(4));
    mat.ensureCapacity(1000);
    expect(mat.rmTexture).not.toBe(before);
    expect(mat.rmTexture.image.width).toBe(rmTextureSize(1000));
    const [r, m] = mat.getRmAt(3);
    expect(r).toBeCloseTo(0.25, 1);
    expect(m).toBeCloseTo(0.75, 1);
    mat.dispose();
  });

  it('WebGPU guard: no onBeforeCompile patch, no program key, no throw', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mat = new RVUberArenaMaterial(8, true);
    expect(mat.patched).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')).toBe(false);
    expect(mat.customProgramCacheKey()).not.toBe(UBER_ARENA_PROGRAM_KEY);
    mat.setRmAt(2, 0.5, 0.5);
    mat.dispose();
    warn.mockRestore();
  });
});

describe('manager: colour texture + bucket switches', () => {
  function setup() {
    const scene = new Scene();
    const root = new Group();
    scene.add(root);
    const target = part('target', uberMat(0xff0000, 0.3, 0));
    const tex = texturedMat('T');
    const texParts = Array.from({ length: 16 }, (_, i) => part(`t${i}`, tex, [i, 2, 0]));
    root.add(target, ...texParts);
    root.updateMatrixWorld(true);
    const mgr = new EditorArenaManager({ scene, roleOf: testRoleOf });
    mgr.build(root);
    return { scene, root, target, tex, mgr };
  }

  it('the uber arena owns its colour texture before the first render', () => {
    const { mgr, target } = setup();
    const arena = mgr.refOf(target)!.arena;
    expect((arena.mesh as unknown as { _colorsTexture: unknown })._colorsTexture).not.toBeNull();
    const c = new Color();
    arena.mesh.getColorAt(mgr.refOf(target)!.instanceId, c);
    expect(c.r).toBeCloseTo(1, 3);
    expect(c.g).toBeCloseTo(0, 3);
    mgr.dispose();
  });

  it('same bucket → setColorAt + rm in place; uber → textured → transparent → uber', () => {
    const { mgr, target, tex } = setup();
    const uberArena = mgr.refOf(target)!.arena;
    const iid = mgr.refOf(target)!.instanceId;

    // same bucket: new uber-eligible material
    target.material = uberMat(0x0000ff, 0.8, 1);
    mgr.setMaterial(target);
    expect(mgr.refOf(target)!.arena).toBe(uberArena);
    const c = new Color();
    uberArena.mesh.getColorAt(iid, c);
    expect(c.b).toBeCloseTo(1, 3);
    expect((uberArena.mesh.material as RVUberArenaMaterial).getRmAt(iid)[1]).toBeCloseTo(1, 2);

    // → textured: joins the textured arena of T; the uber arena (now empty) is gone
    target.material = tex;
    mgr.setMaterial(target);
    const texArena = mgr.refOf(target)!.arena;
    expect(texArena.bucket).toEqual({ kind: 'material', material: tex });
    expect(mgr.arenas.includes(uberArena)).toBe(false);
    expect(target.layers.mask).toBe(0);

    // → transparent: standalone, drawn by itself again
    const glass = uberMat(0xffffff);
    glass.transparent = true;
    glass.opacity = 0.4;
    target.material = glass;
    mgr.setMaterial(target);
    expect(mgr.refOf(target)).toBeUndefined();
    expect(mgr.isStandalone(target)).toBe(true);
    expect(target.layers.mask).toBe(1);

    // → uber again: a fresh uber arena
    target.material = new MeshStandardMaterial({ color: 0x00ff00 });
    mgr.setMaterial(target);
    const back = mgr.refOf(target)!;
    expect(back.arena.bucket).toEqual({ kind: 'uber' });
    expect(target.layers.mask).toBe(0);
    back.arena.mesh.getColorAt(back.instanceId, c);
    expect(c.g).toBeCloseTo(1, 3);
    mgr.dispose();
  });
});
