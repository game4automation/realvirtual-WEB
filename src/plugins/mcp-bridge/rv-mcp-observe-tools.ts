// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-observe-tools — deep scene-understanding MCP tools (delegate class
 * of McpBridgePlugin, merged on `discover` like McpViewTools).
 *
 * Side-effect-free perception: nothing here changes selection, camera or the
 * scene. Four capabilities:
 *
 *   web_measure     — part-to-part distances / gaps / overlap (AABB level)
 *   web_node_shape  — PCA shape descriptors: principal axes, shape class,
 *                     functional axis ("which axis does this hinge use?")
 *   web_scene_query — READ-ONLY JS eval over a frozen plain-data snapshot
 *                     of the scene (no live Three.js refs → cannot mutate)
 *   web_eye         — the AGENT CAMERA rendered into up to five aligned
 *                     channels (beauty / idmask / xray)
 *                     from ONE pose in ONE call, with numbered Set-of-Mark
 *                     markers and a sidecar that maps every number to a node
 *                     path, screen box, coverage and depth range (plan-740)
 */

import { Box3, Vector3, type Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { findPickOwner } from '../../core/engine/rv-pick-owner';
import {
  EYE_CHANNELS, EyeChannels, IDMASK_NO_GROUP, dedupeChannels,
  type EyeChannel, type EyeChannelHost, type EyeRenderResult,
} from '../../core/engine/rv-eye-channels';
import type { AgentPose } from '../../core/engine/rv-agent-eye';
import {
  defaultGroupBy, type IdmaskGroupBy, type IdmaskGrouping,
} from '../../core/engine/rv-idmask-grouping';
import { parsePathsParam } from './rv-object-analyzer-math';
import { canvasesToRvImages, saveCanvasToProject } from './rv-frame-capture';
import { drawMarks } from './rv-annotate';
import { SOM_DEFAULT_CAP, computeMarks, type SomMark } from './rv-som-math';
import { buildSceneSnapshot, type SceneNodeSnapshot } from './rv-scene-snapshot';
import { analyzeShapePoints, gatherSubtreePoints } from './rv-shape-descriptor';

const r3 = (n: number): number => +n.toFixed(3);

/** Serialized result cap for web_scene_query (chars). */
export const QUERY_RESULT_CAP = 60_000;

/**
 * `web_eye` VERTICAL-resolution bounds (D-A16). The old 1024 ceiling predated the agent
 * having its own camera: the image was the canvas, so a bigger number bought
 * nothing. 2048 is above the model cap of 1568 px on purpose — the agent may
 * ask for detail it then crops.
 *
 * The FLOOR is 1024 as of 2026-09-14: below that a capture stops being a usable
 * perception frame. Small parts in a machine-scale view land on a handful of
 * pixels, Set-of-Mark discs grow larger than the parts they label, and the
 * ambient occlusion that carries the depth cues has no room to resolve. A
 * cheaper picture that cannot be read is not a saving, so there is no longer a
 * way to ask for one. The number is the HEIGHT and the WIDTH follows the pose
 * aspect, so 1024 means 1024 lines whatever lens the agent set: 1365 x 1024 at
 * the default 4:3, 1024 x 1024 at aspect 1.
 */
export const EYE_SIZE_MIN = 1024;
export const EYE_SIZE_MAX = 2048;
export const EYE_SIZE_DEFAULT = 1024;

/**
 * ID-mask colouring and grouping moved to `core/engine/rv-idmask-grouping.ts`
 * in plan-740 P2.2 — `rv-eye-channels.ts` (core) needs the same partitioning,
 * and leaving it here would have made core import from a plugin while the
 * plugin calls core (review finding A1). Re-exported so existing importers and
 * the delegate census keep resolving the old names.
 */
export { IDMASK_GROUP_CAP, idmaskColor } from '../../core/engine/rv-idmask-grouping';

// ─── The shared agent-capture layer (plan-740 Phase 3) ──────────────────

/**
 * ONE serialization chain for every offscreen capture in the tab.
 *
 * It was a private field of `McpObserveTools` in Phase 2, which was enough
 * while `web_eye` was the only capture verb in this class. Phase 3 moves
 * five more tools onto the same `EyeChannels` instance — one render target and
 * one readback buffer — so the chain has to cover all of them, not just the
 * one that happens to live in this class. It is
 * module scope rather than per-delegate because the thing being serialized is
 * the RENDERER, of which a tab has exactly one.
 *
 * `onmessage` in the bridge plugin is fire-and-forget, so two tool calls CAN be
 * in flight at once. Overlapping them does not fail, it silently returns one
 * call's pixels under the other call's sidecar — the worst possible failure
 * mode for a perception tool.
 */
let _eyeQueue: Promise<unknown> = Promise.resolve();

/** Queue a capture behind every capture already in flight. */
export function serializeEyeCapture<T>(fn: () => Promise<T>): Promise<T> {
  const run = _eyeQueue.then(fn, fn);
  // Keep the chain alive after a rejection — a failed capture must not wedge
  // every later one.
  _eyeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Fallback `EyeChannels` per viewer, for the harnesses and embed contexts that
 * have no `agent-eye` plugin to own one. A WeakMap rather than a field so all
 * delegates share the SAME instance (and therefore the same render target) for
 * a given viewer — two instances would defeat the point of D-A15.
 */
const _ownChannels = new WeakMap<RVViewer, EyeChannels>();

/**
 * The `EyeChannels` for this viewer.
 *
 * Owned by the `agent-eye` plugin when it is loaded, because that is what
 * disposes the render target on a model change (D-A15). Structural lookup, not
 * an import of the plugin class: the plugin already imports MCP-adjacent code,
 * and a delegate importing back would close a cycle.
 */
export function eyeChannelsFor(v: RVViewer): EyeChannels {
  const plugin = v.getPlugin<{ id: string; eyeChannels?: EyeChannels }>('agent-eye');
  if (plugin?.eyeChannels) return plugin.eyeChannels;
  let own = _ownChannels.get(v);
  if (!own) { own = new EyeChannels(v as unknown as EyeChannelHost); _ownChannels.set(v, own); }
  return own;
}

/** What the Phase-3 tools hand the agent camera for one offscreen frame. */
export interface AgentCaptureRequest {
  /** Defaults to the agent's own pose; pass one for a temporary viewpoint. */
  pose?: AgentPose;
  size: number;
  channels: EyeChannel[];
  root?: Object3D;
  idmask?: IdmaskGrouping;
  crop?: Box3;
  /** xray colouring: 'single' (default) or 'group' — see EyeRenderRequest. */
  xrayColorBy?: 'single' | 'group';
}

/**
 * Render channels from the AGENT camera — the single entry point every migrated
 * perception tool uses (D-U10).
 *
 * Callers are responsible for wrapping their whole tool body in
 * {@link serializeEyeCapture}: a burst or a sweep must hold the chain across
 * ALL of its frames, not re-enter it per frame, or a `web_eye` could land in
 * the middle of a sweep and change the render target under it.
 */
export async function renderAgentChannels(
  v: RVViewer, req: AgentCaptureRequest,
): Promise<EyeRenderResult | { error: string }> {
  const eye = v.agentEye;
  if (!eye) return { error: 'No agent eye' };
  eye.ensure();
  const root = req.root ?? v.currentModelRoot ?? undefined;
  return eyeChannelsFor(v).renderChannels({
    pose: req.pose ?? eye.pose,
    size: req.size,
    channels: req.channels,
    ...(root ? { root } : {}),
    ...(req.idmask ? { idmask: req.idmask } : {}),
    ...(req.crop ? { crop: req.crop } : {}),
    ...(req.xrayColorBy ? { xrayColorBy: req.xrayColorBy } : {}),
  });
}

/** The WebGPU refusal for `tool`, or `null` when a capture can run (D-U11). */
export function guardAgentCapture(v: RVViewer, tool: string): string | null {
  return eyeChannelsFor(v).guard(tool);
}

// ─── Read-only eval ─────────────────────────────────────────────────────

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}

/** Helper library handed to query expressions alongside `nodes`. */
export function buildQueryLib() {
  const dist = (a: readonly number[], b: readonly number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  return deepFreeze({
    /** Euclidean distance between two [x,y,z] points. */
    dist,
    /** Largest AABB dimension of a snapshot node (0 without bounds). */
    maxDim: (n: SceneNodeSnapshot): number => (n.bounds ? Math.max(...n.bounds.size) : 0),
    /** AABB volume of a snapshot node (0 without bounds). */
    volume: (n: SceneNodeSnapshot): number =>
      (n.bounds ? n.bounds.size[0] * n.bounds.size[1] * n.bounds.size[2] : 0),
    /** True when point [x,y,z] lies inside the node's world AABB. */
    contains: (n: SceneNodeSnapshot, p: readonly number[]): boolean => {
      const b = n.bounds;
      if (!b) return false;
      return p[0] >= b.min[0] && p[0] <= b.max[0]
        && p[1] >= b.min[1] && p[1] <= b.max[1]
        && p[2] >= b.min[2] && p[2] <= b.max[2];
    },
    /** AABB center distance between two snapshot nodes (Infinity without bounds). */
    centerDist: (a: SceneNodeSnapshot, b: SceneNodeSnapshot): number =>
      (a.bounds && b.bounds ? dist(a.bounds.center, b.bounds.center) : Infinity),
  });
}

/**
 * Compile and run a query expression against the frozen snapshot. The code
 * runs in the page (same origin — the read-only promise is structural, not a
 * security sandbox): it only ever sees frozen plain data, never live scene
 * objects, so it cannot mutate anything through this API.
 */
export function runSceneQuery(expr: string, nodes: readonly SceneNodeSnapshot[]): unknown {
  const body = /\breturn\b/.test(expr) ? expr : `return (${expr});`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('nodes', 'lib', `'use strict'; ${body}`) as
    (nodes: readonly SceneNodeSnapshot[], lib: ReturnType<typeof buildQueryLib>) => unknown;
  return fn(nodes, buildQueryLib());
}

// ─── The delegate ───────────────────────────────────────────────────────

export class McpObserveTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  // ═══ web_measure ══════════════════════════════════════════════════════

  @McpTool('Measure BETWEEN parts (no side effects): for each pair of the given paths returns center distance, per-axis gap (negative = overlap depth), aabbGap (closest AABB separation, 0 = touching/overlapping) and overlaps flag. All meters, world space. The numeric grounding for clearances, conveyor gaps and pivot offsets. For a single node use web_node_bounds.', { readOnly: true })
  async webMeasure(
    @McpParam('paths', 'Two or more node paths, comma/newline-separated. All pairs are measured.') paths: string,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No viewer/registry' });
    const list = parsePathsParam(paths);
    if (list.length < 2) return JSON.stringify({ error: 'Need at least two paths' });
    const boxes = new Map<string, Box3>();
    for (const p of list) {
      const node = reg.getNode(p);
      if (!node) return JSON.stringify({ error: `Node not found: "${p}"` });
      node.updateMatrixWorld(true);
      boxes.set(p, computeSubtreeAABB(node, new Box3()).box);
    }
    const pairs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = boxes.get(list[i])!;
        const b = boxes.get(list[j])!;
        const ca = a.getCenter(new Vector3());
        const cb = b.getCenter(new Vector3());
        // Per-axis gap between the AABBs: positive = clear space, negative = overlap depth.
        const gap = ['x', 'y', 'z'].map((ax) => {
          const k = ax as 'x' | 'y' | 'z';
          return r3(Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k]));
        }) as [number, number, number];
        const pos = gap.map((g) => Math.max(0, g));
        pairs.push({
          a: list[i],
          b: list[j],
          centerDistance: r3(ca.distanceTo(cb)),
          centerDelta: [r3(cb.x - ca.x), r3(cb.y - ca.y), r3(cb.z - ca.z)],
          axisGap: gap,
          aabbGap: r3(Math.hypot(pos[0], pos[1], pos[2])),
          overlaps: gap.every((g) => g < 0),
        });
      }
    }
    return JSON.stringify({ unit: 'm', pairs });
  }

  // ═══ web_node_shape ═══════════════════════════════════════════════════

  @McpTool('PCA shape analysis of nodes (no side effects): principal axes (world unit vectors), extents along them, shape class (cylinder-like | beam-like | disc-like | plate-like | compact) and the FUNCTIONAL AXIS — the rotation/symmetry axis for cylinder- and disc-like parts. Directly answers "which axis does this hinge/roller/shaft use" when kinematizing. Vertex-sampled (cap 20k).', { readOnly: true, timeoutMs: 30_000 })
  async webNodeShape(
    @McpParam('paths', 'Node paths, comma/newline-separated.') paths: string,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No viewer/registry' });
    const list = parsePathsParam(paths);
    if (list.length === 0) return JSON.stringify({ error: 'No node paths given' });
    const out: Array<Record<string, unknown>> = [];
    for (const p of list) {
      const node = reg.getNode(p);
      if (!node) { out.push({ path: p, error: 'not found' }); continue; }
      const pts = gatherSubtreePoints(node);
      const d = analyzeShapePoints(pts);
      out.push({
        path: p,
        shapeClass: d.shapeClass,
        functionalAxis: d.functionalAxis,
        axes: d.axes,
        extents: d.extents,
        elongation: d.elongation,
        flatness: d.flatness,
        radialUniformity: d.radialUniformity,
        centroid: d.centroid,
        sampleCount: d.sampleCount,
      });
    }
    return JSON.stringify({ unit: 'm', results: out });
  }

  // ═══ web_scene_query ══════════════════════════════════════════════════

  @McpTool('READ-ONLY JavaScript query over a frozen plain-data snapshot of the scene — the escape hatch for any geometric/material question no dedicated tool answers. The expression receives `nodes` (array of {path,name,depth,parentPath,components[],isMesh,meshCount,triangles,bounds{center,size,min,max}|null,material{name,color,metalness,roughness,opacity}|null,visible}, meters/world-space) and `lib` ({dist,maxDim,volume,contains,centerDist}). Example: nodes.filter(n=>n.isMesh&&lib.maxDim(n)>1&&n.bounds.center[1]<0.5).map(n=>n.path). Snapshot data only — it CANNOT modify the scene. Result JSON-capped at 60k chars.', { readOnly: true, timeoutMs: 30_000 })
  async webSceneQuery(
    @McpParam('expression', 'JS expression or statements ending in `return …` over (nodes, lib).') expression: string,
    @McpParam('root', 'Optional subtree root path (default: whole model).', 'string', false) root?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    if (!expression?.trim()) return JSON.stringify({ error: 'Empty expression' });
    try {
      const snapshot = buildSceneSnapshot(v, root || undefined);
      if (snapshot.length === 0) {
        return JSON.stringify({ error: root ? `No nodes under "${root}"` : 'No model loaded' });
      }
      deepFreeze(snapshot);
      const result = runSceneQuery(expression, snapshot);
      let json = JSON.stringify({ nodeCount: snapshot.length, result });
      if (json.length > QUERY_RESULT_CAP) {
        json = JSON.stringify({
          nodeCount: snapshot.length,
          error: `Result too large (${json.length} chars > ${QUERY_RESULT_CAP}) — narrow the query (map to paths, slice, aggregate).`,
        });
      }
      return json;
    } catch (e) {
      return JSON.stringify({ error: `Query failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ═══ web_eye ══════════════════════════════════════════════════════════

  /**
   * The capture chain and the channel instance both live at module scope since
   * Phase 3 ({@link serializeEyeCapture}, {@link eyeChannelsFor}) — the sweep,
   * the burst, the annotated shot and `verify_drive` render through the SAME
   * renderer and the same target, so they have to queue behind `web_eye` too.
   */
  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    return serializeEyeCapture(fn);
  }

  private _channels(v: RVViewer): EyeChannels {
    return eyeChannelsFor(v);
  }

  @McpTool('Render the AGENT camera (never the user viewport) into up to three channels from ONE pose in ONE call: beauty (materials), idmask (flat ID colors, white crease edges, legend), xray (LOOK INSIDE a part: the root subtree alone, translucent on black, every internal surface and crease drawn, so bores, cavities and buried components show through the shell). labels=true marks idmask only; beauty stays unannotated but pixel-aligned. The sidecar maps each label to node path, screen box and coverage. Distances in metres: web_measure or web_node_bounds. size = image HEIGHT 1024..2048; width follows the pose aspect. Move the camera first with web_camera_*. Requires the classic WebGL renderer.', { readOnly: true, timeoutMs: 60_000 })
  async webEye(
    @McpParam('channels', 'Comma-separated: beauty, idmask, xray (default "beauty").', 'string', false) channels?: string,
    @McpParam('size', 'Image HEIGHT in px, 1024..2048 (default 1024); smaller values are raised to 1024. Width follows the pose aspect.', 'number', false) size?: number,
    @McpParam('labels', 'Burn numbered Set-of-Mark markers on the idmask channel (default true). beauty is never annotated.', 'boolean', false) labels?: boolean,
    @McpParam('path', 'Crop to this node\'s on-screen box (+8%).', 'string', false) path?: string,
    @McpParam('root', 'Subtree to render and group (default: whole model).', 'string', false) root?: string,
    @McpParam('groupBy', 'Grouping for idmask AND for a group-coloured xray: "hierarchy", "geometry" (identical parts share a color) or "component" (one per Drive/Sensor/... node). Default: geometry for an xray-only call, else component when the model has components and hierarchy otherwise.', 'string', false) groupBy?: string,
    @McpParam('groupDepth', 'hierarchy grouping: ancestor depth below root (default 1 = direct children).', 'number', false) groupDepth?: number,
    @McpParam('paths', 'hierarchy grouping: explicit group-root paths instead of groupDepth.', 'string', false) paths?: string,
    @McpParam('xrayColorBy', 'xray colouring: "single" (default, one hue — reads as pure density) or "group" (identity colours from the SAME grouping groupBy selects, so internal parts are nameable via the legend).', 'string', false) xrayColorBy?: string,
    @McpParam('savePath', 'Optional PROJECT-relative path to also write each channel as PNG ("<name>.<channel>.png"). A bare name lands in "captures/". Requires an open writable project.', 'string', false) savePath?: string,
  ): Promise<string> {
    return this._serialize(() => this._renderEye({
      channels, size, labels, path, root, groupBy, groupDepth, paths, xrayColorBy, savePath,
      source: 'web_eye',
    }));
  }

  // ─── The shared implementation ────────────────────────────────────

  private async _renderEye(req: {
    channels?: string; size?: number; labels?: boolean; path?: string; root?: string;
    groupBy?: string; groupDepth?: number; paths?: string; savePath?: string;
    xrayColorBy?: string;
    /** Tool name for the Agent Eye Monitor, passed in so the filmstrip labels
     *  the frame correctly (plan-481 D-A8). */
    source?: string;
  }): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No viewer/registry' });

    const eyeChannels = this._channels(v);
    const guard = eyeChannels.guard('web_eye');
    if (guard) return JSON.stringify({ error: guard });

    // Channel list: default beauty, empty string means default too (an agent
    // that builds the argument by string concatenation must not get an error
    // for the empty case), duplicates collapse, an unknown name is a hard error
    // rather than a silent drop — a missing channel would otherwise look like a
    // renderer problem.
    const raw = (req.channels ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const wanted = raw.length === 0 ? (['beauty'] as EyeChannel[]) : [];
    for (const name of raw) {
      if (!(EYE_CHANNELS as readonly string[]).includes(name)) {
        return JSON.stringify({
          error: `Unknown channel "${name}". Valid: ${EYE_CHANNELS.join(', ')}.`,
        });
      }
      wanted.push(name as EyeChannel);
    }
    const channels = dedupeChannels(wanted);

    // `size` guard (D-A16 / review finding S7): Math.round(NaN) is NaN, and a
    // NaN long edge produces a zero-pixel render target with no error anywhere.
    const size = Number.isFinite(req.size)
      ? Math.max(EYE_SIZE_MIN, Math.min(EYE_SIZE_MAX, Math.round(req.size as number)))
      : EYE_SIZE_DEFAULT;

    const rootNode = req.root ? reg.getNode(req.root) : v.currentModelRoot;
    if (!rootNode) return JSON.stringify({ error: req.root ? `Node not found: "${req.root}"` : 'No model loaded' });

    const eye = v.agentEye;
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    eye.ensure();
    const pose = { ...eye.pose };

    let crop: Box3 | undefined;
    if (req.path?.trim()) {
      const node = reg.getNode(req.path.trim());
      if (!node) return JSON.stringify({ error: `Node not found: "${req.path}"` });
      node.updateMatrixWorld(true);
      const box = computeSubtreeAABB(node, new Box3()).box;
      if (!box.isEmpty()) crop = box;
    }

    const explicitPaths = parsePathsParam(req.paths ?? '');
    // When xray is the only channel it OWNS the grouping, and geometry is the
    // right default for it: looking inside a part, "which of these are the same
    // part" is the question, and collapsing duplicates frees palette slots that
    // hierarchy would spend on repeats. On the VTUX manifold it took the
    // overflow bucket from 62 groups to 16, so far more of the assembly ends up
    // with a nameable colour instead of falling into grey.
    //
    // With an idmask in the same call the idmask's default wins instead. The
    // two channels share ONE grouping, and a mask's colours must not shift
    // because an unrelated channel was requested alongside it.
    const xrayOwnsGrouping = channels.includes('xray') && !channels.includes('idmask');
    const groupBy = normalizeGroupBy(req.groupBy)
      ?? (explicitPaths.length > 0 ? 'hierarchy'
        : xrayOwnsGrouping ? 'geometry'
          : defaultGroupBy(rootNode));

    // Anything but an explicit "group" stays single-hue: an unrecognised
    // spelling must not silently change how the frame reads.
    const xrayColorBy = (req.xrayColorBy ?? '').trim().toLowerCase() === 'group'
      ? 'group' as const : 'single' as const;

    const rendered = await eyeChannels.renderChannels({
      pose, size, channels, root: rootNode,
      idmask: { groupBy, groupDepth: req.groupDepth, paths: explicitPaths },
      xrayColorBy,
      ...(crop ? { crop } : {}),
    });
    if ('error' in rendered) return JSON.stringify(rendered);

    // ── Set-of-Mark + sidecar, both from the SAME idmask buffer (D-A13) ──
    // Marks go on the ID MASK ONLY. `beauty` is the channel that answers
    // "what does this actually look like", so it stays an unannotated
    // render; the mask is where identity is asked for, and the two frames
    // are pixel-aligned, so a mark read off the mask locates the same spot
    // in beauty.

    const idChannel = rendered.channels.find((c) => c.idBuffer);
    const marks = (req.labels !== false && idChannel?.idBuffer)
      ? computeMarks(idChannel.idBuffer, rendered.width, rendered.height, SOM_DEFAULT_CAP)
      : [];
    const legendColors = rendered.legend.map((l) => l.color);
    if (marks.length > 0) {
      for (const m of marks) {
        const entry = rendered.legend[m.groupIndex];
        if (entry) entry.mark = m.n;
      }
      for (const c of rendered.channels) {
        if (c.channel !== 'idmask') continue;
        const ctx = c.canvas.getContext('2d');
        if (ctx) drawMarks(ctx, marks, legendColors);
      }
    }

    const visible = buildVisible(
      rendered, idChannel?.idBuffer, marks, reg,
    );

    // ── Optional per-channel PNG into the project ──
    const savedPaths: Record<string, string> = {};
    const saveErrors: string[] = [];
    if (req.savePath?.trim()) {
      const base = req.savePath.trim().replace(/\.png$/i, '');
      for (const c of rendered.channels) {
        const target = `${base}.${c.channel}.png`;
        const outcome = await saveCanvasToProject(c.canvas, target);
        if (typeof outcome.savedPath === 'string') savedPaths[c.channel] = outcome.savedPath;
        else if (typeof outcome.saveError === 'string') saveErrors.push(outcome.saveError);
      }
    }

    const sidecar: Record<string, unknown> = {
      channels: rendered.channels.map((c) => c.channel),
      camera: rendered.camera,
      ...(rendered.crop ? { crop: rendered.crop } : {}),
      ...(rendered.legend.length > 0 ? { legend: rendered.legend } : {}),
      ...(visible.length > 0 ? { visible } : {}),
      ...(Object.keys(savedPaths).length > 0 ? { savedPaths } : {}),
      ...(saveErrors.length > 0 ? { saveError: saveErrors[0] } : {}),
    };

    return canvasesToRvImages(
      rendered.channels.map((c) => ({ canvas: c.canvas, mime: c.mime, channel: c.channel })),
      sidecar,
      req.source,
    );
  }
}

// ─── Sidecar helpers ────────────────────────────────────────────────────

/** Accepted `groupBy` spellings, or `null` when nothing was asked for. */
function normalizeGroupBy(raw?: string): IdmaskGroupBy | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'geometry' || s === 'hierarchy' || s === 'component') return s;
  return null;
}

/**
 * The `visible[]` block: what is actually on screen, measured on the ID mask
 * rather than sampled with rays (D-A13).
 *
 * A depth-tested render IS the occlusion answer, so `coverage` is the group's
 * share of the frame AFTER everything in front of it has had its say — which is
 * the number that tells an agent "you cannot see this part from here, move".
 * plan-705's 49-ray raster could only ever approximate that.
 */
export function buildVisible(
  rendered: EyeRenderResult,
  idBuffer: Uint16Array | undefined,
  marks: readonly SomMark[],
  reg: { getNode(path: string): Object3D | null | undefined },
): Array<Record<string, unknown>> {
  if (!idBuffer) return [];
  const total = rendered.width * rendered.height;
  const stats = new Map<number, { n: number; x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < rendered.height; y++) {
    for (let x = 0; x < rendered.width; x++) {
      const i = y * rendered.width + x;
      const g = idBuffer[i];
      if (g === IDMASK_NO_GROUP) continue;
      let s = stats.get(g);
      if (!s) { s = { n: 0, x0: x, y0: y, x1: x, y1: y }; stats.set(g, s); }
      s.n++;
      if (x < s.x0) s.x0 = x; if (y < s.y0) s.y0 = y;
      if (x > s.x1) s.x1 = x; if (y > s.y1) s.y1 = y;
    }
  }
  const markOf = new Map(marks.map((m) => [m.groupIndex, m.n]));
  const out: Array<Record<string, unknown>> = [];
  for (const [g, s] of [...stats.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const entry = rendered.legend[g];
    if (!entry) continue;
    const node = reg.getNode(entry.path);
    const owner = node ? findPickOwner(node, reg as never) : null;
    out.push({
      ...(markOf.has(g) ? { mark: markOf.get(g) } : {}),
      path: entry.path,
      ...(owner && owner.path !== entry.path
        ? { ownerPath: owner.path, ownerComponents: owner.components }
        : owner ? { ownerComponents: owner.components } : {}),
      screenBox: [s.x0, s.y0, s.x1, s.y1],
      coverage: +(s.n / total).toFixed(4),
    });
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const vec3Arr = (v: Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];
