// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-eye-channels — the three agent channels against a real WebGL renderer
 * (plan-740 §9.5).
 *
 * The `normals`, `depth` and `edges` channels were withdrawn on 2026-09-14 and
 * their render passes deleted with them, so the former property 1 ("the numbers
 * are numbers") no longer has a subject here. What is left is pictures plus the
 * ID mask, and one property carries the file:
 *
 *  NOTHING LEAKS. The agent renders while a human is looking at the same
 *     scene: the viewport camera, the controls target, the render target, the
 *     override material and the scene background must all be exactly where they
 *     were, and the agent's own cone must not appear in its own picture.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Vector3,
} from 'three';
import {
  AGENT_LAYER_MASK, EyeChannels, IDMASK_NO_GROUP,
  dedupeChannels, frameSize, paletteToIds,
  type EyeChannelHost, type EyeRenderResult,
} from '../src/core/engine/rv-eye-channels';
import { AGENT_EYE_LAYER, GroupRegistry, HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';
import type { AgentPose } from '../src/core/engine/rv-agent-eye';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

const POSE = (over: Partial<AgentPose> = {}): AgentPose => ({
  px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0,
  fov: 45, aspect: 4 / 3, projection: 'perspective', ...over,
});

/**
 * A tiny model: two boxes 5 m and 8 m from a camera at z=+5, plus a wall behind
 * them. Registered in a `NodeRegistry` so the idmask grouping can name things.
 */
function buildModel(viewer: RVViewer): { root: Group; registry: NodeRegistry } {
  const root = new Group();
  root.name = 'Cell';
  const front = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#c04040' }));
  front.name = 'Front';
  front.position.set(-0.9, 0, 0);
  const back = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#4040c0' }));
  back.name = 'Back';
  back.position.set(0.9, 0, -3);
  const wall = new Mesh(new PlaneGeometry(20, 20), new MeshStandardMaterial({ color: '#808080' }));
  wall.name = 'Wall';
  wall.position.set(0, 0, -8);
  root.add(front, back, wall);
  viewer.scene.add(root);
  root.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  for (const n of [root, front, back, wall]) {
    registry.registerNode(NodeRegistry.computeNodePath(n), n);
  }
  return { root, registry };
}

/** An `EyeChannelHost` over the test viewer with our own registry and root. */
function hostFor(viewer: RVViewer, root: Group, registry: NodeRegistry): EyeChannelHost {
  return {
    scene: viewer.scene,
    renderer: viewer.renderer,
    registry: registry as unknown as EyeChannelHost['registry'],
    currentModelRoot: root,
  };
}

function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number] {
  const d = canvas.getContext('2d')!.getImageData(Math.round(x), Math.round(y), 1, 1).data;
  return [d[0], d[1], d[2]];
}

/**
 * Is this an idmask CREASE-EDGE pixel?
 *
 * Bright is not enough on its own: the palette's lightest band reaches a
 * min-channel of 202 (index 2), so "all channels high" would call a pale
 * identity colour an edge. What separates them is SATURATION — every palette
 * entry is HSL(h, 0.85, l) and therefore has a wide channel spread, while the
 * edge colour is neutral by definition. Bright AND neutral is unambiguous, and
 * stays so if a driver ever antialiases the lines.
 */
function isEdgePixel(r: number, g: number, b: number): boolean {
  return Math.min(r, g, b) >= 230 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
}

/** Every pixel of a canvas as RGBA bytes. */
function allPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  return canvas.getContext('2d')!
    .getImageData(0, 0, canvas.width, canvas.height).data;
}

// ─── Pure helpers ───────────────────────────────────────────────────────

describe('eye channel maths', () => {
  it('derives the frame size from the vertical resolution and the pose aspect', () => {
    // `size` is the HEIGHT; the width follows the aspect. 1024 lines either way.
    expect(frameSize(1024, 4 / 3)).toEqual({ width: 1365, height: 1024 });
    expect(frameSize(1024, 0.5)).toEqual({ width: 512, height: 1024 });
    expect(frameSize(1024, 1)).toEqual({ width: 1024, height: 1024 });
  });

  it('dedupes channels while preserving the requested order', () => {
    expect(dedupeChannels(['xray', 'beauty', 'xray', 'beauty'])).toEqual(['xray', 'beauty']);
  });

  it('maps flat palette pixels back to group indices, background to the sentinel', () => {
    // Palette entries are compared in sRGB — the space the render target and
    // the legend both use.
    const colors = [new Color('#ff0000'), new Color('#00ff00')];
    const px = new Uint8Array([
      255, 0, 0, 255, // exactly red
      2, 253, 1, 255, // green with readback rounding
      16, 16, 20, 255, // the idmask background
    ]);
    expect(Array.from(paletteToIds(px, colors))).toEqual([0, 1, IDMASK_NO_GROUP]);
  });

  it('excludes every overlay layer — including the agent cone — from the mask', () => {
    expect(AGENT_LAYER_MASK & (1 << AGENT_EYE_LAYER)).toBe(0);
    expect(AGENT_LAYER_MASK & (1 << HIGHLIGHT_OVERLAY_LAYER)).toBe(0);
    expect(AGENT_LAYER_MASK & (1 << 0)).not.toBe(0);
  });
});

// ─── Real renders ───────────────────────────────────────────────────────

describe('EyeChannels.renderChannels (WebGL)', () => {
  it('renders all requested channels aligned, lossless where it must be', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const out = await eye.renderChannels({
        pose: POSE(), size: 256,
        channels: ['beauty', 'idmask', 'xray'],
        root,
      });
      expect('error' in out).toBe(false);
      const r = out as EyeRenderResult;

      // All three, all the same size, long edge = size, aspect = pose aspect.
      expect(r.channels.map((c) => c.channel))
        .toEqual(['beauty', 'idmask', 'xray']);
      expect(r.width).toBe(341); // 256 lines at the 4:3 test pose
      expect(r.height).toBe(256);
      for (const c of r.channels) {
        expect(c.canvas.width).toBe(341);
        expect(c.canvas.height).toBe(256);
      }
      // idmask must stay lossless; the pictorial channels may not.
      expect(r.channels.find((c) => c.channel === 'idmask')!.mime).toBe('image/png');
      expect(r.channels.find((c) => c.channel === 'xray')!.mime).toBe('image/png');
      expect(r.channels.find((c) => c.channel === 'beauty')!.mime).toBe('image/jpeg');

      // The ID MASK is the remaining ground truth: every pixel is either a
      // palette index or the sentinel, and the model does cover some of them.
      const ids = r.channels.find((c) => c.idBuffer)!.idBuffer!;
      expect(ids.length).toBe(r.width * r.height);
      let covered = 0;
      for (const g of ids) {
        // No third state: a pixel belongs to a legend group or to nothing.
        expect(g === IDMASK_NO_GROUP || g < r.legend.length).toBe(true);
        if (g !== IDMASK_NO_GROUP) covered++;
      }
      expect(covered).toBeGreaterThan(0);

      // IDMASK legend + buffer agree, and the buffer indexes the legend.
      expect(r.legend.map((l) => l.path)).toEqual(
        expect.arrayContaining(['Cell/Front', 'Cell/Back', 'Cell/Wall']),
      );
      const idBuf = r.channels.find((c) => c.channel === 'idmask')!.idBuffer!;
      expect(idBuf.length).toBe(r.width * r.height);
      const seen = new Set(Array.from(idBuf));
      seen.delete(IDMASK_NO_GROUP);
      expect(seen.size).toBeGreaterThanOrEqual(3);
      for (const g of seen) expect(r.legend[g]).toBeDefined();
    } finally {
      eye.dispose();
    }
  });

  it('leaves the viewport, the render target and the scene exactly as it found them', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const camBefore = viewer.camera.position.clone();
      const targetBefore = viewer.controls
        ? (viewer.controls as unknown as { target: Vector3 }).target.clone()
        : null;
      const bgBefore = viewer.scene.background;
      const rtBefore = (viewer.renderer as unknown as {
        getRenderTarget(): unknown;
      }).getRenderTarget();

      await eye.renderChannels({
        pose: POSE({ px: 3, py: 4 }), size: 128,
        channels: ['beauty', 'xray'], root,
      });

      expect(viewer.camera.position.distanceTo(camBefore)).toBeLessThan(1e-9);
      if (targetBefore) {
        expect((viewer.controls as unknown as { target: Vector3 }).target
          .distanceTo(targetBefore)).toBeLessThan(1e-9);
      }
      expect(viewer.scene.background).toBe(bgBefore);
      expect(viewer.scene.overrideMaterial).toBeNull();
      expect((viewer.renderer as unknown as { getRenderTarget(): unknown })
        .getRenderTarget()).toBe(rtBefore);
    } finally {
      eye.dispose();
    }
  });

  it('never photographs anything on an overlay layer (the agent cone)', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    // A big magenta plane right in front of the camera, on the cone's layer.
    const cone = new Mesh(
      new PlaneGeometry(50, 50),
      new MeshStandardMaterial({ color: '#ff00ff' }),
    );
    cone.position.set(0, 0, 4);
    cone.layers.set(AGENT_EYE_LAYER);
    viewer.scene.add(cone);
    viewer.scene.updateMatrixWorld(true);

    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const out = await eye.renderChannels({
        pose: POSE(), size: 128, channels: ['idmask'], root,
      }) as EyeRenderResult;
      // Were the plane visible it would fill the frame; the ID mask must still
      // show the model's own groups behind it.
      const idBuf = out.channels[0].idBuffer!;
      const seen = new Set(Array.from(idBuf));
      seen.delete(IDMASK_NO_GROUP);
      expect(seen.size).toBeGreaterThanOrEqual(2);
    } finally {
      eye.dispose();
      viewer.scene.remove(cone);
    }
  });

  it('draws white crease edges on the mask WITHOUT punching holes in the ID buffer', async () => {
    // THE two-pass invariant. White is not a palette colour, so a mask decoded
    // from the frame the agent sees would read every edge pixel as background
    // and quietly erode coverage, screen boxes and Set-of-Mark placement along
    // the outline of every part. The ground truth therefore comes from an
    // edge-free render and the picture from a second one. Collapse the two and
    // this test fails on the second assertion, not on a subtle coverage drift
    // noticed months later.
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const out = await eye.renderChannels({
        pose: POSE(), size: 256, channels: ['idmask'], root,
      }) as EyeRenderResult;
      const mask = out.channels[0];
      const px = allPixels(mask.canvas);
      const idBuf = mask.idBuffer!;

      const edgePixels: number[] = [];
      for (let i = 0; i < idBuf.length; i++) {
        const o = i * 4;
        if (isEdgePixel(px[o], px[o + 1], px[o + 2])) edgePixels.push(i);
      }

      // The boxes have crease edges and they are drawn.
      expect(edgePixels.length).toBeGreaterThan(0);

      // ...and every one of them still has its group in the buffer.
      for (const i of edgePixels) expect(idBuf[i]).not.toBe(IDMASK_NO_GROUP);
    } finally {
      eye.dispose();
    }
  });

  it('depth-tests the mask edges, so a hidden part never draws through its occluder', async () => {
    // The x-ray channel draws its edges through walls ON PURPOSE. The mask must
    // not: the colour under a line there would belong to the part in front and
    // the line to the part behind, and the frame would contradict itself.
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const root = new Group();
    root.name = 'Cell';
    // A 4x4 wall at z=0 and a 1 m box at z=-2 entirely behind it: at the test
    // pose the box subtends ~0.07 rad against the wall's ~0.4, so it is wholly
    // covered and its creases land near the frame centre, far from the wall's
    // own border edges.
    const occluder = new Mesh(
      new PlaneGeometry(4, 4), new MeshStandardMaterial({ color: '#c04040' }),
    );
    occluder.name = 'Occluder';
    const hidden = new Mesh(
      new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: '#4040c0' }),
    );
    hidden.name = 'Hidden';
    hidden.position.set(0, 0, -2);
    root.add(occluder, hidden);
    viewer.scene.add(root);
    root.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    for (const n of [root, occluder, hidden]) {
      registry.registerNode(NodeRegistry.computeNodePath(n), n);
    }

    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const out = await eye.renderChannels({
        pose: POSE(), size: 256, channels: ['idmask'], root,
      }) as EyeRenderResult;
      const mask = out.channels[0];
      const px = allPixels(mask.canvas);

      // The middle half of the frame is pure occluder. Nothing white may
      // appear there — the wall's own creases are its border, outside it.
      const x0 = Math.floor(out.width * 0.25), x1 = Math.floor(out.width * 0.75);
      const y0 = Math.floor(out.height * 0.25), y1 = Math.floor(out.height * 0.75);
      let bled = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * out.width + x) * 4;
          if (isEdgePixel(px[o], px[o + 1], px[o + 2])) bled++;
        }
      }
      expect(bled).toBe(0);

      // Sanity: the occluder IS what fills that region, so the absence of
      // white above is a depth test doing its job, not an empty frame.
      const mid = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2));
      expect(mask.idBuffer![mid]).not.toBe(IDMASK_NO_GROUP);
    } finally {
      eye.dispose();
      viewer.scene.remove(root);
    }
  });

  it('gives a group-coloured xray its legend, and a single-hue one none', async () => {
    // The legend used to be the idmask's alone. A group-coloured xray shows the
    // SAME identity colours, and a colour nobody can name is no better than no
    // colour at all — so the legend now follows the colours, not the channel.
    // Single-hue stays legend-free: there is nothing to name.
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const grouped = await eye.renderChannels({
        pose: POSE(), size: 128, channels: ['xray'], root, xrayColorBy: 'group',
      }) as EyeRenderResult;
      expect(grouped.legend.length).toBeGreaterThanOrEqual(3);
      expect(grouped.legend.map((l) => l.path))
        .toEqual(expect.arrayContaining(['Cell/Front', 'Cell/Back', 'Cell/Wall']));

      const single = await eye.renderChannels({
        pose: POSE(), size: 128, channels: ['xray'], root, xrayColorBy: 'single',
      }) as EyeRenderResult;
      expect(single.legend).toEqual([]);

      // The grouped frame really is multi-coloured: more than one hue survives
      // where the single-hue frame has exactly one.
      const hues = (r: EyeRenderResult): Set<string> => {
        const c = r.channels[0].canvas;
        const px = allPixels(c);
        const seen = new Set<string>();
        for (let i = 0; i < px.length; i += 4) {
          const [r8, g8, b8] = [px[i], px[i + 1], px[i + 2]];
          // Skip the near-black ground; keep anything the overlay drew.
          if (Math.max(r8, g8, b8) < 40) continue;
          seen.add(`${r8 >> 4},${g8 >> 4},${b8 >> 4}`);
        }
        return seen;
      };
      expect(hues(grouped).size).toBeGreaterThan(hues(single).size);
    } finally {
      eye.dispose();
    }
  });

  it('crops every channel and its buffers to a node box', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      const box = registry.getNode('Cell/Front')!;
      box.updateMatrixWorld(true);
      const { Box3 } = await import('three');
      const crop = new Box3().setFromObject(box);
      const out = await eye.renderChannels({
        pose: POSE(), size: 256, channels: ['idmask', 'xray'], root, crop,
      }) as EyeRenderResult;
      expect(out.width).toBeLessThan(341);
      expect(out.crop).toBeDefined();
      for (const c of out.channels) {
        expect(c.canvas.width).toBe(out.width);
        expect(c.canvas.height).toBe(out.height);
      }
      expect(out.channels.find((c) => c.idBuffer)!.idBuffer!.length)
        .toBe(out.width * out.height);
    } finally {
      eye.dispose();
    }
  });

  it('refuses a renderer that cannot read pixels back (plan-763: WebGPU itself captures)', async () => {
    const eye = new EyeChannels({
      scene: { } as never,
      renderer: { isWebGPURenderer: true }, // no readRenderTargetPixels(Async) at all
      registry: undefined,
      currentModelRoot: null,
    });
    const out = await eye.renderChannels({ pose: POSE(), size: 512, channels: ['beauty'] });
    expect(out).toEqual({ error: expect.stringMatching(/needs a renderer that can read pixels back/) });
    expect(eye.guard('web_eye')).toMatch(/^web_eye needs a renderer/);
    eye.dispose();
  });

  it('disposes the render target and every channel material exactly once', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    await eye.renderChannels({
      pose: POSE(), size: 64, channels: ['beauty', 'idmask', 'xray'], root,
    });
    const inner = eye as unknown as {
      _colorCapture: { _rt: { dispose(): void } | null };
      _xrayFillMat: { dispose(): void } | null;
      _xrayEdgeMat: { dispose(): void } | null;
      _idmaskMats: Array<{ dispose(): void }>;
    };
    expect(inner._colorCapture._rt).not.toBeNull();
    const spies = [
      vi.spyOn(inner._colorCapture._rt!, 'dispose'),
      vi.spyOn(inner._xrayFillMat!, 'dispose'),
      vi.spyOn(inner._xrayEdgeMat!, 'dispose'),
      ...inner._idmaskMats.map((m) => vi.spyOn(m, 'dispose')),
    ];
    expect(spies.length).toBeGreaterThan(3);
    eye.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    // A second dispose is a no-op, not a double free.
    eye.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  it('measures the three-channel latency at 1024 px (NFR, plan-740 §1)', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    const eye = new EyeChannels(hostFor(viewer, root, registry));
    try {
      // Warm-up: the first call compiles the override shaders.
      await eye.renderChannels({ pose: POSE(), size: 256, channels: ['beauty'], root });
      const t0 = performance.now();
      const out = await eye.renderChannels({
        pose: POSE(), size: 1024,
        channels: ['beauty', 'idmask', 'xray'], root,
      });
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log(`[plan-740 NFR] three channels at 1024 px: ${ms.toFixed(0)} ms`);
      expect('error' in out).toBe(false);
      // The NFR target is 1.5 s on a real machine; headless SwiftShader is far
      // slower than the reference GPU, so the assertion is a REGRESSION guard
      // (something pathological, e.g. a per-pixel allocation), not the NFR.
      expect(ms).toBeLessThan(30_000);
    } finally {
      eye.dispose();
    }
  });
});

// ─── The viewport isolate ──────────────────────────────────────────────

describe('EyeChannels under the viewport isolate', () => {
  /** Centre-of-list pixel of a legend group in a mask — always a member pixel. */
  function memberPixel(r: EyeRenderResult, path: string): [number, number] {
    const gi = r.legend.findIndex((l) => l.path === path);
    expect(gi, `legend has ${path}`).toBeGreaterThanOrEqual(0);
    const ids = r.channels.find((c) => c.idBuffer)!.idBuffer!;
    const members: number[] = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] === gi) members.push(i);
    expect(members.length, `${path} covers pixels`).toBeGreaterThan(0);
    const i = members[members.length >> 1];
    return [i % r.width, Math.floor(i / r.width)];
  }
  const maxDelta = (a: [number, number, number], b: [number, number, number]): number =>
    Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

  it('dims the non-isolated parts in beauty and drops them from the mask, then lets go on exit', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    // The test viewer loads no model, so the group registry a load would
    // install is created by hand — isolateNodes() is a no-op without one.
    if (!viewer.groups) viewer.groups = new GroupRegistry();
    const eye = new EyeChannels({
      ...hostFor(viewer, root, registry),
      groups: viewer.groups,
      autoFilters: viewer.autoFilters,
    });
    const render = async (): Promise<EyeRenderResult> => {
      const out = await eye.renderChannels({
        pose: POSE(), size: 256, channels: ['beauty', 'idmask'], root,
      });
      expect('error' in out).toBe(false);
      return out as EyeRenderResult;
    };
    const beauty = (r: EyeRenderResult): HTMLCanvasElement =>
      r.channels.find((c) => c.channel === 'beauty')!.canvas;
    try {
      const plain = await render();
      expect(plain.isolate).toBeUndefined();
      const front = memberPixel(plain, 'Cell/Front');
      const back = memberPixel(plain, 'Cell/Back');

      viewer.isolateNodes([registry.getNode('Cell/Front')!], false);
      expect(viewer.groups!.isIsolateActive).toBe(true);
      const iso = await render();
      expect(iso.isolate).toBe(true);

      // The mask knows only the focus set: Back and Wall have no identity.
      expect(iso.legend.map((l) => l.path)).toEqual(['Cell/Front']);
      const isoIds = iso.channels.find((c) => c.idBuffer)!.idBuffer!;
      expect(isoIds[back[1] * iso.width + back[0]]).toBe(IDMASK_NO_GROUP);
      expect(isoIds[front[1] * iso.width + front[0]]).toBe(0);

      // Beauty: the isolated part is drawn as before, the other one is dimmed
      // towards the background — the viewport's own composite, not a
      // photograph of the whole machine.
      const plainBeauty = beauty(plain), isoBeauty = beauty(iso);
      expect(maxDelta(pixelAt(plainBeauty, ...front), pixelAt(isoBeauty, ...front))).toBeLessThan(32);
      expect(maxDelta(pixelAt(plainBeauty, ...back), pixelAt(isoBeauty, ...back))).toBeGreaterThan(40);

      // Exiting the isolate hands the eye the whole model back.
      viewer.exitIsolate();
      const again = await render();
      expect(again.isolate).toBeUndefined();
      expect(again.legend.map((l) => l.path)).toEqual(
        expect.arrayContaining(['Cell/Front', 'Cell/Back', 'Cell/Wall']),
      );
      expect(maxDelta(pixelAt(plainBeauty, ...back), pixelAt(beauty(again), ...back))).toBeLessThan(32);
    } finally {
      eye.dispose();
    }
  });

  it('leaves the eye camera mask and the live scene background exactly as it found them', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const { root, registry } = buildModel(viewer);
    if (!viewer.groups) viewer.groups = new GroupRegistry();
    const eye = new EyeChannels({
      ...hostFor(viewer, root, registry), groups: viewer.groups, autoFilters: viewer.autoFilters,
    });
    try {
      const background = viewer.scene.background;
      const viewportMask = viewer.camera.layers.mask;
      viewer.isolateNodes([registry.getNode('Cell/Back')!], false);
      const out = await eye.renderChannels({
        pose: POSE(), size: 128, channels: ['beauty', 'idmask', 'xray'], root,
      });
      expect('error' in out).toBe(false);
      expect(viewer.scene.background).toBe(background);
      expect(viewer.camera.layers.mask).toBe(viewportMask);
      expect((viewer.renderer as unknown as { getRenderTarget(): unknown }).getRenderTarget()).toBeNull();
    } finally {
      viewer.exitIsolate();
      eye.dispose();
    }
  });
});
