// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-740 §9.8 — `web_view_sweep` after the migration to the agent camera.
 *
 * The tool used to be the riskiest one in the surface: it froze the orbit
 * controls, flew the VISIBLE camera through 4-8 animated poses, raycast a 7×7
 * grid at each of them and had to put everything back even when a capture blew
 * up halfway. Phase 3 deletes all of that. Six poses are six offscreen renders
 * from temporary poses; there is nothing to restore because nothing moved, and
 * no fake timers because nothing waits.
 *
 * What is pinned here is exactly what could silently stop being true:
 *
 *   - the pose ring is still the same maths (six views, ascending index, cell
 *     caption i ↔ note i),
 *   - the notes come from the ID MASK of the frame in the cell, so `coverage`
 *     is a pixel share of that very picture rather than a ray sample of some
 *     other pose,
 *   - the user's camera and controls are untouched, and so is the agent's own
 *     body — a sweep aims temporary shots, it does not teleport the agent,
 *   - the schema says `readOnly: true` (D-A8/I3), which is what lets a
 *     read-only MCP client use it at all.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { AgentEye } from '../src/core/engine/rv-agent-eye';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { allSchemas } from './helpers/mcp-schemas';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface SweepNote {
  index: number;
  label: string;
  yawDeg: number;
  cameraPosition: [number, number, number];
  topNodes: Array<{ path: string; ownerPath?: string; coverage: number }>;
  background: number;
}

interface SweepEnvelope {
  __rvImage?: {
    data: string; width: number; height: number;
    views?: SweepNote[];
    center?: number[];
    radius?: number;
    restored?: unknown;
  };
  error?: string;
}

/** Three separated boxes around the origin, the agent looking at them from +Z. */
function makeTools(viewer: RVViewer): {
  tools: McpViewTools;
  eye: AgentEye;
  stub: RVViewer;
  controls: { enabled: boolean };
} {
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
  for (const c of root.children) registry.registerNode(NodeRegistry.computeNodePath(c), c);

  const eye = new AgentEye({
    getViewportState: () => ({
      position: [0, 0, 8], target: [0, 0, 0], fov: 45, projection: 'perspective',
    }),
    modelKey: null,
  });
  eye.ensure();

  // A camera of its own for the viewport: the harness viewer's is driven by
  // its render loop, and the claim being tested is that the sweep never WRITES
  // viewer.camera — not that a live camera happens to sit still.
  const humanCamera = new PerspectiveCamera(50, 4 / 3, 0.1, 1000);
  humanCamera.position.set(0, 3, 12);
  humanCamera.updateMatrixWorld(true);

  const controls = { enabled: true };
  const stub = {
    scene: viewer.scene,
    renderer: viewer.renderer,
    camera: humanCamera,
    controls,
    registry,
    currentModelRoot: root,
    agentEye: eye,
    cameraFollowMode: 'off',
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  return { tools: new McpViewTools(() => stub), eye, stub, controls };
}

const parse = (s: string): SweepEnvelope => JSON.parse(s) as SweepEnvelope;

describe('web_view_sweep', () => {
  it('renders six offscreen views and describes each from its own ID mask', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);

    const r = parse(await tools.webViewSweep('', 6));
    expect(r.error).toBeUndefined();

    const views = r.__rvImage!.views!;
    expect(views).toHaveLength(6);
    views.forEach((v, i) => {
      // The index contract: cell i, note i and pose i are the same view.
      expect(v.index).toBe(i);
      expect(v.label).toContain(`#${i}`);
      // Ring geometry unchanged — evenly spaced yaw around the target.
      expect(v.yawDeg).toBeCloseTo((views[0].yawDeg + i * 60) % 360, 3);
      expect(v.cameraPosition).toHaveLength(3);
    });

    // Coverage is a PIXEL share of the very frame in the cell (D-A13), not a
    // ray sample: every value is a fraction, and what the groups do not cover
    // is the reported background.
    for (const v of views) {
      expect(v.topNodes.length).toBeGreaterThan(0);
      let covered = 0;
      for (const n of v.topNodes) {
        expect(n.coverage).toBeGreaterThan(0);
        expect(n.coverage).toBeLessThanOrEqual(1);
        expect(n.path.startsWith('Line')).toBe(true);
        covered += n.coverage;
      }
      expect(v.background).toBeGreaterThan(0);   // the boxes do not fill the frame
      expect(covered + v.background).toBeLessThanOrEqual(1.02);
    }
    // All three parts are seen from at least one of the six views.
    const seen = new Set(views.flatMap((v) => v.topNodes.map((n) => n.path)));
    expect([...seen].sort()).toEqual(['Line/Belt', 'Line/Frame', 'Line/Motor']);

    // The montage is one image, and the ring is reported so an agent can
    // re-create a single view with web_camera_set.
    expect(r.__rvImage!.width).toBeGreaterThan(0);
    expect(r.__rvImage!.center).toEqual([0, 0, 0]);
    expect(r.__rvImage!.radius).toBeGreaterThan(0);
  });

  it('moves neither the user viewport nor the agent body, and never restores anything', async () => {
    handle = await createTestViewer('webgl');
    const { tools, eye, stub, controls } = makeTools(handle.viewer);
    const camBefore = (stub.camera as { position: Vector3 }).position.clone();
    const poseBefore = eye.pose;

    const r = parse(await tools.webViewSweep('', 4));
    expect(r.error).toBeUndefined();

    // The whole point of the migration: a watching human keeps their view, and
    // the agent keeps the pose it chose — the cells are TEMPORARY poses.
    expect((stub.camera as { position: Vector3 }).position.equals(camBefore)).toBe(true);
    expect(eye.pose).toEqual(poseBefore);
    // Controls were never frozen, so there is nothing to thaw…
    expect(controls.enabled).toBe(true);
    // …and no restore happened, so the field that used to report one is gone.
    expect(r.__rvImage!.restored).toBeUndefined();
  });

  it('honours count, pitch and an explicit start yaw', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    const r = parse(await tools.webViewSweep('Line/Motor', 4, 35, 90));
    const views = r.__rvImage!.views!;
    expect(views).toHaveLength(4);
    expect(views[0].yawDeg).toBeCloseTo(90, 3);
    expect(views.map((v) => v.yawDeg)).toEqual([90, 180, 270, 0]);
  });

  it('reports paths it cannot resolve instead of sweeping something else', async () => {
    handle = await createTestViewer('webgl');
    const { tools } = makeTools(handle.viewer);
    expect(parse(await tools.webViewSweep('Line/Ghost')).error)
      .toMatch(/Node\(s\) not found: Line\/Ghost/);
  });

  it('is announced as read-only — it renders offscreen and mutates nothing', () => {
    const sweep = allSchemas().find((s) => s.name === 'web_view_sweep');
    expect(sweep).toBeTruthy();
    // D-A8 / review finding I3: before Phase 3 this flew the viewport, so it
    // had to be gated as a write. CONNECT takes this hint blind for its write
    // gate, which is why the value is pinned rather than assumed.
    expect(sweep!.annotations?.readOnlyHint).toBe(true);
    expect(sweep!.timeoutMs).toBe(120_000);
    // `restore` survives as an ignored parameter so a caller written against
    // the frozen schema still validates.
    const props = sweep!.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.restore).toBeTruthy();
    expect(props.restore.description).toMatch(/Ignored/);
  });
});
