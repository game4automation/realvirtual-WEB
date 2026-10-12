// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-740 §9.10 (T10) — the Phase-3 perception tools on the agent camera.
 *
 * Phase 1 gave the agent a camera body and Phase 2 gave it a way to look
 * through it. This file is about the five tools that were still reading the
 * HUMAN's drawing buffer afterwards: burst, annotated, analyze, verify_drive
 * and `web_node_measure(focus=true)`. Migrating them is not a refactor — it
 * changes what the returned picture IS, so the properties worth pinning are the
 * ones that make the picture trustworthy:
 *
 *   - the frame comes from the AGENT pose, and `viewer.camera` is where the
 *     human left it (that is the whole complaint the plan started from),
 *   - the simulation keeps running between burst frames, because a burst that
 *     renders three frames back to back shows no motion at all,
 *   - `readOnly` says the truth per tool — `web_editor_verify_drive` stays
 *     FALSE because it moves the DRIVE, not just a camera (D-A8 / I2),
 *   - `captureFrameCanvas` — the read of the visible buffer — has exactly ONE
 *     consumer left, `web_screenshot`, which is the human view by definition.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Vector3 } from 'three';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { AgentEye } from '../src/core/engine/rv-agent-eye';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { allSchemas } from './helpers/mcp-schemas';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

// Raw sources for the one-consumer assertion at the bottom. `?raw` keeps this
// an observation about the CODE, which is what the claim is about — a runtime
// probe could only ever show that the path was not taken in this test.
import VIEW_SRC from '../src/plugins/mcp-bridge/rv-mcp-view-tools.ts?raw';
import EDITOR_SRC from '../src/plugins/mcp-bridge/rv-mcp-editor-tools.ts?raw';
import BRIDGE_SRC from '../src/plugins/mcp-bridge-plugin.ts?raw';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

interface Envelope {
  __rvImage?: {
    data: string; width: number; height: number;
    frames?: number; durationMs?: number;
    labels?: Array<{
      path: string; label: string; mark?: number; coverage?: number;
      screenBox?: number[]; notVisible?: boolean;
    }>;
    camera?: { position: number[]; target: number[] };
    cameraPosition?: number[];
    boundsM?: { x: number; y: number; z: number };
    crop?: { x: number; y: number; w: number; h: number };
  };
  error?: string;
}

interface Harness {
  stub: RVViewer;
  eye: AgentEye;
  view: McpViewTools;
  plugin: McpBridgePlugin;
  root: Group;
  selected: string[];
  /** Standalone stand-in for the human viewport camera — see makeHarness. */
  humanCam: Vector3;
}

/**
 * Three boxes in a row plus one deliberately hidden behind the middle one, so
 * "is this part visible from here" has a real answer.
 */
function makeHarness(viewer: RVViewer): Harness {
  const root = new Group();
  root.name = 'Line';
  root.userData._rvModelRoot = true;
  const mk = (name: string, x: number, z: number, color: string): Mesh => {
    const m = new Mesh(new BoxGeometry(1.2, 1.2, 1.2), new MeshStandardMaterial({ color }));
    m.name = name;
    m.position.set(x, 0, z);
    return m;
  };
  root.add(
    mk('Belt', -2, 0, '#c04040'),
    mk('Motor', 0, 0, '#40c040'),
    mk('Frame', 2, 0, '#4040c0'),
    // Directly behind Motor as seen from +Z: invisible from the agent pose.
    mk('Buried', 0, -1.4, '#c0c040'),
  );
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

  // A camera of its OWN for the viewport, not the harness viewer's: the live
  // one is driven by the viewer's render loop, so a burst that legitimately
  // takes 300 ms would see it drift and the assertion would be about the
  // harness rather than about the tool. What is being claimed is that no
  // migrated tool WRITES viewer.camera at all, and this states exactly that.
  const humanCamera = new PerspectiveCamera(50, 4 / 3, 0.1, 1000);
  humanCamera.position.set(0, 3, 12);
  humanCamera.lookAt(0, 0, 0);
  humanCamera.updateMatrixWorld(true);

  const selected: string[] = [];
  const stub = {
    scene: viewer.scene,
    renderer: viewer.renderer,
    camera: humanCamera,
    isWebGPU: false,
    controls: { enabled: true },
    registry,
    currentModelRoot: root,
    agentEye: eye,
    cameraFollowMode: 'off',
    getPlugin: () => undefined,
    selectionManager: {
      selectPaths: (p: string[]) => { selected.length = 0; selected.push(...p); },
      getSnapshot: () => ({ selectedPaths: [...selected], primaryPath: selected[0] ?? null }),
    },
  } as unknown as RVViewer;

  const plugin = new McpBridgePlugin();
  (plugin as unknown as { viewer: RVViewer }).viewer = stub;

  return {
    stub, eye, root, selected, plugin,
    view: new McpViewTools(() => stub),
    humanCam: humanCamera.position.clone(),
  };
}

const parse = (s: string): Envelope => JSON.parse(s) as Envelope;
const humanMoved = (h: Harness): boolean =>
  !(h.stub.camera as { position: Vector3 }).position.equals(h.humanCam);

describe('web_screenshot_burst on the agent camera', () => {
  it('spreads N frames over the window while the simulation keeps running', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    const poseBefore = h.eye.pose;

    // A "drive": something in the scene that keeps moving while the burst runs.
    const motor = h.root.getObjectByName('Motor')!;
    const ticker = setInterval(() => {
      motor.position.y += 0.05;
      motor.updateMatrixWorld(true);
    }, 40);
    const t0 = performance.now();
    const r = parse(await h.plugin.webScreenshotBurst(3, 300, ''));
    const elapsed = performance.now() - t0;
    clearInterval(ticker);

    expect(r.error).toBeUndefined();
    expect(r.__rvImage!.frames).toBe(3);
    expect(r.__rvImage!.durationMs).toBe(300);
    // The frames are SPACED — three back-to-back reads would show no motion,
    // which is exactly what the tool exists to show.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    // The sim really did advance underneath the capture.
    expect(motor.position.y).toBeGreaterThan(0.1);
    // Neither camera moved: the frames are the agent's, the viewport is the
    // human's, and a burst touches neither body.
    expect(humanMoved(h)).toBe(false);
    expect(h.eye.pose).toEqual(poseBefore);
  });

  it('crops every frame to a node without moving anything', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    const full = parse(await h.plugin.webScreenshotBurst(2, 0, ''));
    const cropped = parse(await h.plugin.webScreenshotBurst(2, 0, 'Line/Motor'));
    expect(cropped.error).toBeUndefined();
    // A cube crop is far squarer than the whole 4:3 line — the montage aspect
    // is the observable proof the crop was applied to the agent frame.
    const aspect = (e: Envelope): number => e.__rvImage!.width / e.__rvImage!.height;
    expect(aspect(cropped)).toBeLessThan(aspect(full));
    expect(humanMoved(h)).toBe(false);
  });

  it('reports a node path it cannot resolve', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    expect(parse(await h.plugin.webScreenshotBurst(2, 0, 'Line/Ghost')).error)
      .toMatch(/Node not found: "Line\/Ghost"/);
  });
});

describe('web_screenshot_analyze on the agent camera', () => {
  it('takes its context tiles from the agent pose and reports it', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    // Put the agent somewhere unmistakably NOT the fixed ISO_FRONT angle.
    h.eye.setPose({ px: -6, py: 1, pz: -6, tx: 0, ty: 0, tz: 0 });

    const r = parse(await h.plugin.webScreenshotAnalyze('Line/Motor', true, 128));
    expect(r.error).toBeUndefined();
    expect(r.__rvImage!.boundsM!.x).toBeCloseTo(1.2, 2);
    // The sidecar names the pose the context tiles were rendered from, so an
    // agent can tell whether the mosaic answers the question it asked.
    expect(r.__rvImage!.cameraPosition).toEqual([-6, 1, -6]);
    expect(humanMoved(h)).toBe(false);
  });
});

describe('web_node_measure(focus=true) on the agent camera', () => {
  it('frames with the agent, selects for the human, and leaves the viewport alone', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    const before = h.eye.pose;

    const r = JSON.parse(await h.view.webNodeBounds('Line/Frame', true)) as {
      nodes: Array<{ world: { center: number[] } }>; selected: number; framed: boolean;
    };
    expect(r.nodes[0].world.center[0]).toBeCloseTo(2, 3);
    // Selection is SHARED with the human (D-U3) …
    expect(r.selected).toBe(1);
    expect(h.selected).toEqual(['Line/Frame']);
    // … the FRAMING is not: the agent body moved, the viewport did not.
    expect(r.framed).toBe(true);
    expect(h.eye.pose).not.toEqual(before);
    expect(h.eye.pose.tx).toBeCloseTo(2, 3);
    expect(humanMoved(h)).toBe(false);
  });

  it('focus=false measures without touching either camera', async () => {
    handle = await createTestViewer('webgl');
    const h = makeHarness(handle.viewer);
    const before = h.eye.pose;
    await h.view.webNodeBounds('Line/Frame', false);
    expect(h.eye.pose).toEqual(before);
    expect(h.selected).toEqual([]);
  });
});

describe('the migrated surface declares itself correctly', () => {
  const byName = new Map(allSchemas().map((s) => [s.name, s]));

  it('keeps web_editor_verify_drive a WRITE — it moves the drive, not a camera', () => {
    const t = byName.get('web_editor_verify_drive')!;
    expect(t).toBeTruthy();
    // D-A8 / review finding I2. CONNECT takes `readOnlyHint` blind for its
    // write gate, so a `true` here would hand an unauthenticated read-only
    // client the ability to drag an axis through its range.
    expect(t.annotations?.readOnlyHint).toBe(false);
    expect(t.description).toContain('AGENT camera');
  });

  it('keeps the three capture tools read-only and says whose camera they use', () => {
    for (const name of ['web_screenshot_burst',
      'web_screenshot_analyze', 'web_view_sweep']) {
      expect(byName.get(name)!.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get('web_screenshot_burst')!.description).toContain('AGENT camera');
    expect(byName.get('web_screenshot_analyze')!.description).toContain('AGENT camera');
  });

  it('leaves web_screenshot as the one human view', () => {
    const shot = byName.get('web_screenshot')!;
    expect(shot.annotations?.readOnlyHint).toBe(true);
    // It is the deliberate exception (D-U9), so it must NOT claim to be the
    // agent's camera — an agent that reads this has to be able to tell the two
    // apart.
    expect(shot.description).not.toContain('AGENT');
  });

  it('leaves captureFrameCanvas with exactly one consumer', () => {
    // The read of the VISIBLE drawing buffer. Everything else renders offscreen
    // through the agent camera now (D-U10), and a second consumer appearing
    // here is precisely how that would erode.
    expect(VIEW_SRC).not.toContain('captureFrameCanvas');
    expect(EDITOR_SRC).not.toContain('captureFrameCanvas');
    // In the bridge plugin it survives behind `_captureFrameCanvas`, whose only
    // call site is web_screenshot.
    const calls = BRIDGE_SRC.match(/this\._captureFrameCanvas\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
