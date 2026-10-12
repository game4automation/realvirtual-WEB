// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-eye-tool — the `web_eye` tool contract (plan-740 §9.7).
 *
 * The tool is the agent's only way of SEEING, so the contract it has to keep is
 * not "an image comes back" but "the image and the numbers describe the same
 * frame". Everything here is a way that can quietly stop being true:
 *
 *   - the sidecar's `channels[]` must name the image blocks in order, or the
 *     agent matches the wrong picture to the wrong description,
 *   - Set-of-Mark numbers must exist in BOTH the drawn marks and the legend,
 *     or a number the agent reads off the picture resolves to nothing,
 *   - two concurrent calls must not interleave: they share one render target,
 *     and interleaving returns one call's pixels under the other's sidecar.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { McpObserveTools } from '../src/plugins/mcp-bridge/rv-mcp-observe-tools';
import { AgentEye } from '../src/core/engine/rv-agent-eye';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { frameSize } from '../src/core/engine/rv-eye-channels';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface EyeEnvelope {
  __rvImage?: {
    data: string; mimeType: string; width: number; height: number;
    channels?: string[];
    camera?: { position: number[]; target: number[]; aspect: number; fov: number; projection: string };
    legend?: Array<{ path: string; color: string; mark?: number; count?: number }>;
    visible?: Array<{ path: string; coverage: number; screenBox: number[]; mark?: number }>;
    crop?: { x: number; y: number; w: number; h: number };
  };
  __rvImages?: Array<{ data: string; mimeType: string; channel: string }>;
  error?: string;
}

/** Three separated boxes in front of an agent camera at z = +6. */
function buildScene(viewer: RVViewer): { root: Group; registry: NodeRegistry } {
  const root = new Group();
  root.name = 'Line';
  const mk = (name: string, x: number, color: string): Mesh => {
    const m = new Mesh(new BoxGeometry(1.2, 1.2, 1.2), new MeshStandardMaterial({ color }));
    m.name = name;
    m.position.set(x, 0, 0);
    return m;
  };
  root.add(mk('Belt', -2, '#c04040'), mk('Motor', 0, '#40c040'), mk('Frame', 2, '#4040c0'));
  viewer.scene.add(root);
  root.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  registry.registerNode(NodeRegistry.computeNodePath(root), root);
  for (const c of root.children) {
    registry.registerNode(NodeRegistry.computeNodePath(c), c);
  }
  return { root, registry };
}

/**
 * The tool over a REAL WebGL viewer, but with our own model root and registry
 * (the harness loads no GLB) and a fresh agent body.
 */
function makeTools(viewer: RVViewer): { tools: McpObserveTools; eye: AgentEye } {
  const { root, registry } = buildScene(viewer);
  const eye = new AgentEye({
    getViewportState: () => ({
      position: [0, 0, 6], target: [0, 0, 0], fov: 45, projection: 'perspective',
    }),
    modelKey: null,
  });
  eye.ensure();
  const stub = {
    scene: viewer.scene,
    renderer: viewer.renderer,
    registry,
    currentModelRoot: root,
    agentEye: eye,
    // No `agent-eye` plugin in this harness — the delegate owns its channels.
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  return { tools: new McpObserveTools(() => stub), eye };
}

const parse = (s: string): EyeEnvelope => JSON.parse(s) as EyeEnvelope;

describe('web_eye', () => {
  it('defaults to one beauty channel with a full sidecar', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    const r = parse(await tools.webEye());
    expect(r.error).toBeUndefined();
    expect(r.__rvImages).toBeUndefined();
    expect(r.__rvImage!.channels).toEqual(['beauty']);
    expect(r.__rvImage!.mimeType).toBe('image/jpeg');
    // `size` is the HEIGHT; the width follows the pose aspect (4:3 here).
    expect(r.__rvImage!.height).toBe(1024);
    expect(r.__rvImage!.width).toBe(1365);
    expect(r.__rvImage!.camera!.position).toEqual([0, 0, 6]);
    expect(r.__rvImage!.camera!.projection).toBe('perspective');
    // No idmask was asked for, so there is nothing to describe as visible.
    expect(r.__rvImage!.visible).toBeUndefined();
  });

  it('defaults an xray-only call to geometry grouping, but never an idmask call', async () => {
    // The three boxes are separate BufferGeometry objects with identical
    // parameters, so geometry grouping (signature-matched, not identity-
    // matched) collapses them into ONE group of three while hierarchy keeps
    // three. That difference is what makes the default observable.
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);

    // xray alone owns the grouping -> geometry.
    const solo = parse(await tools.webEye(
      'xray', 1024, false, undefined, undefined, undefined, undefined, undefined, 'group',
    ));
    expect(solo.error).toBeUndefined();
    expect(solo.__rvImage!.legend!.length).toBe(1);
    expect(solo.__rvImage!.legend![0].count).toBe(3);

    // Add an idmask and the idmask's own default wins instead: this model has
    // no components, so hierarchy, so three groups again. A mask's colours must
    // not move because another channel was asked for alongside it.
    const withMask = parse(await tools.webEye(
      'idmask,xray', 1024, false, undefined, undefined, undefined, undefined, undefined, 'group',
    ));
    expect(withMask.__rvImage!.legend!.map((l) => l.path)).toEqual(
      expect.arrayContaining(['Line/Belt', 'Line/Motor', 'Line/Frame']),
    );

    // And an explicit groupBy still beats both defaults.
    const explicit = parse(await tools.webEye(
      'xray', 1024, false, undefined, undefined, 'hierarchy', undefined, undefined, 'group',
    ));
    expect(explicit.__rvImage!.legend!.length).toBe(3);
  });

  it('returns aligned channels in the requested order with marks and a sidecar', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    const r = parse(await tools.webEye('beauty,idmask,xray', 384, true));
    expect(r.error).toBeUndefined();
    expect(r.__rvImage!.channels).toEqual(['beauty', 'idmask', 'xray']);
    // Channel 1 in __rvImage, 2..n in __rvImages — disjoint, order preserved.
    expect(r.__rvImages!.map((c) => c.channel)).toEqual(['idmask', 'xray']);
    expect(r.__rvImages![0].mimeType).toBe('image/png'); // idmask stays lossless

    // Sidecar: every visible group is named, marked and measured.
    const visible = r.__rvImage!.visible!;
    expect(visible.length).toBeGreaterThanOrEqual(3);
    expect(visible.map((v) => v.path)).toEqual(
      expect.arrayContaining(['Line/Belt', 'Line/Motor', 'Line/Frame']),
    );
    // Coverage is a share of the frame, so the total cannot exceed 1.
    const total = visible.reduce((a, v) => a + v.coverage, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(1);
    for (const v of visible) {
      expect(v.screenBox).toHaveLength(4);
      expect(v.screenBox[2]).toBeGreaterThanOrEqual(v.screenBox[0]);
    }
    // Every mark an agent can read off the picture resolves through the legend.
    const marked = visible.filter((v) => v.mark !== undefined);
    expect(marked.length).toBeGreaterThanOrEqual(3);
    const legendMarks = r.__rvImage!.legend!.filter((l) => l.mark !== undefined);
    expect(legendMarks.length).toBe(marked.length);
    for (const v of marked) {
      expect(r.__rvImage!.legend!.some((l) => l.path === v.path && l.mark === v.mark)).toBe(true);
    }
  });

  it('labels=false leaves the sidecar intact but burns no marks', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    const r = parse(await tools.webEye('idmask', 256, false));
    expect(r.__rvImage!.visible!.length).toBeGreaterThanOrEqual(3);
    for (const v of r.__rvImage!.visible!) expect(v.mark).toBeUndefined();
    for (const l of r.__rvImage!.legend!) expect(l.mark).toBeUndefined();
  });

  it('guards the parameters an agent gets wrong', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);

    // Empty string is "not specified", not an error — agents build this by
    // string concatenation and an empty list is the natural degenerate case.
    expect(parse(await tools.webEye('', 256)).__rvImage!.channels).toEqual(['beauty']);
    // Duplicates collapse, order preserved.
    expect(parse(await tools.webEye('xray,beauty,xray', 256)).__rvImage!.channels)
      .toEqual(['xray', 'beauty']);
    // An unknown channel is a hard error: silently dropping it would look like
    // a renderer fault to the caller.
    const bad = parse(await tools.webEye('beauty,thermal', 256));
    expect(bad.error).toMatch(/Unknown channel "thermal"/);
    expect(bad.__rvImage).toBeUndefined();

    // size: NaN → default (Math.round(NaN) is NaN and would size a 0-px target),
    // out of range → clamped to the 1024..2048 window.
    expect(parse(await tools.webEye('beauty', Number.NaN)).__rvImage!.height).toBe(1024);
    expect(parse(await tools.webEye('beauty', undefined)).__rvImage!.height).toBe(1024);
    expect(parse(await tools.webEye('beauty', 99999)).__rvImage!.height).toBe(2048);
    expect(parse(await tools.webEye('beauty', 4)).__rvImage!.height).toBe(1024);
  });

  it('crops to a node path without moving the camera', async () => {
    handle = await createTestViewer('webgl');
    const { tools, eye } = makeTools(handle.viewer);
    const before = eye.pose;
    const r = parse(await tools.webEye('idmask', 512, false, 'Line/Motor'));
    expect(r.__rvImage!.crop).toBeDefined();
    expect(r.__rvImage!.width).toBeLessThan(512);
    // The crop is a framing of the SAME shot — the body did not move.
    expect(eye.pose).toEqual(before);
    // …and the sidecar reports the pose that was actually rendered.
    expect(r.__rvImage!.camera!.position).toEqual([0, 0, 6]);
  });

  it('reports a node path it cannot resolve instead of rendering something else', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    expect(parse(await tools.webEye('beauty', 256, true, 'Line/Ghost')).error)
      .toMatch(/Node not found: "Line\/Ghost"/);
    expect(parse(await tools.webEye('beauty', 256, true, undefined, 'Nope')).error)
      .toMatch(/Node not found: "Nope"/);
  });

  it('serializes concurrent calls so each result carries its own frame', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    // Two calls at DIFFERENT sizes: interleaved rendering through the shared
    // render target would hand one call the other's dimensions.
    const [a, b] = await Promise.all([
      tools.webEye('beauty,idmask', 1024, false).then(parse),
      tools.webEye('beauty', 1536, false).then(parse),
    ]);
    expect(a.__rvImage!.height).toBe(1024);
    expect(a.__rvImage!.channels).toEqual(['beauty', 'idmask']);
    expect(b.__rvImage!.height).toBe(1536);
    expect(b.__rvImage!.channels).toEqual(['beauty']);
    expect(b.__rvImages).toBeUndefined();
  });

  it('keeps the rendered frame consistent with the agent pose', async () => {
    handle = await createTestViewer('webgl');
    const { tools, eye } = makeTools(handle.viewer);
    const r = parse(await tools.webEye('idmask', 1024, false));
    // The sidecar reports the pose and aspect the image was rendered at, so a
    // fraction read off the picture means the same thing to the caller as it did
    // to the renderer.
    // 4 decimals: the sidecar rounds, and a 1e-5 mismatch on the aspect moves
    // nothing an agent could pick at.
    expect(r.__rvImage!.camera!.aspect).toBeCloseTo(eye.pose.aspect, 4);
    const { width, height } = frameSize(1024, eye.pose.aspect);
    expect([r.__rvImage!.width, r.__rvImage!.height]).toEqual([width, height]);
    // The centre of the frame is the gaze direction.
    const { direction } = eye.unproject(0.5, 0.5);
    expect(direction.z).toBeLessThan(-0.99);
  });
});

describe('web_eye under WebGPU', () => {
  it('refuses with the renderer hint', async () => {
    const stub = {
      scene: {},
      renderer: { isWebGPURenderer: true },
      registry: { getNode: () => undefined, getPathForNode: () => undefined },
      currentModelRoot: {},
      agentEye: new AgentEye({
        getViewportState: () => ({
          position: [0, 0, 1], target: [0, 0, 0], fov: 45, projection: 'perspective',
        }),
        modelKey: null,
      }),
      getPlugin: () => undefined,
    } as unknown as RVViewer;
    const tools = new McpObserveTools(() => stub);
    expect(parse(await tools.webEye('beauty')).error)
      .toMatch(/classic WebGL renderer \(Settings → Visual → Renderer\)/);
  });
});
