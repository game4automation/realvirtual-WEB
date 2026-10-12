// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-view-tools — mode-agnostic MCP perception, camera and selection tools.
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts): its @McpTool methods are merged with the plugin's own on
 * `discover`. Everything here works in every workspace mode; the editor-only
 * authoring tools live in rv-mcp-editor-tools.ts.
 *
 * These tools give an AI agent the same primitives a human uses to LOOK at a
 * model: measure a node (bounds), look around (camera focus/orbit), point at
 * things (pick/gaze), reduce clutter (isolate), and read labelled screenshots.
 *
 * Since plan-740 every one of them drives the AGENT's own camera body
 * (`viewer.agentEye`) and renders OFFSCREEN through it — never the visible
 * viewport, and never the drawing buffer. Nothing here animates, waits or
 * freezes the controls: a human navigating while an agent works sees a small
 * cone move, not their own view being taken away. Selection and the isolate
 * dimming stay SHARED (D-U3), because those are document state rather than a
 * point of view. `web_screenshot` (mcp-bridge-plugin.ts) is the one deliberate
 * exception in the whole surface: it is still "what the human sees".
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { isChunkMesh, isRuntimeNode } from '../../core/engine/rv-node-classification';
import { parsePathsParam } from './rv-object-analyzer-math';
import {
  canvasToRvImage, canvasesToRvImages, saveCanvasToProject, compositeMontage,
  type RvImageChannel,
} from './rv-frame-capture';
import { computeFlyPose } from './rv-camera-fly-math';
// plan-740: the agent's own camera body, plus the canonical fit formula shared
// with the viewport's CameraManager so there is exactly one copy of the maths.
import type { AgentEye } from '../../core/engine/rv-agent-eye';
import { fitDistanceBothAxesFor } from '../../core/rv-camera-manager';
import { fitPoseToPoints, type Vec3 as FitVec3 } from './rv-frame-fit-math';
import {
  sweepPoses, summarizeVisibleGroups,
  DEFAULT_SWEEP_COUNT, DEFAULT_SWEEP_PITCH_DEG, DEFAULT_TOP_N, type SweepViewNote,
} from './rv-view-sweep-math';
// plan-740 Phase 3: every perception tool renders through the AGENT camera, on
// the one shared capture chain (D-U10 / D-A15).
import {
  buildVisible, guardAgentCapture, renderAgentChannels, serializeEyeCapture,
} from './rv-mcp-observe-tools';
import { defaultGroupBy } from '../../core/engine/rv-idmask-grouping';
import { EYE_CHANNELS, dedupeChannels, type EyeChannel } from '../../core/engine/rv-eye-channels';
import { SOM_DEFAULT_CAP, computeMarks } from './rv-som-math';
import { drawMarks } from './rv-annotate';
import {
  computeIdenticalPaths,
  computeSameMaterialPaths,
  computeInvertPaths,
  expandToUniverseMeshes,
} from '@rv-private/plugins/asset-editor/select-actions';

const r3 = (n: number): number => +n.toFixed(3);
const vec3 = (v: Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];

/**
 * Resolve a path against the DOCUMENT first, then the scene graph (plan-754 F11).
 *
 * `web_node_tree` and `web_node_find` report the whole graph now, chunk meshes
 * and runtime objects included, under the name path those nodes would have. The
 * registry does not know them — so measuring one used to answer "not found" for
 * a path the agent had just been shown. The fallback walks `children` by name,
 * the same rule `NodeRegistry.computeNodePath` produces, and is only ever
 * reached when the registry has no answer; a registered path never changes
 * meaning.
 *
 * Matching is prefix-and-backtrack rather than a `split('/')`, because a chunk
 * mesh is NAMED after the boundary it merged (`mover:Robot/Axis1|tex:cafe`) and
 * that name contains separators. Splitting would make exactly the nodes this
 * fallback exists for unreachable.
 */
function walkByName(node: Object3D, rest: string): Object3D | null {
  for (const child of node.children) {
    const name = child.name;
    if (!name) continue;
    if (rest === name) return child;
    if (rest.startsWith(`${name}/`)) {
      const found = walkByName(child, rest.slice(name.length + 1));
      if (found) return found;
    }
  }
  return null;
}

export function resolveSceneNodeByPath(viewer: RVViewer, path: string): Object3D | null {
  const registered = viewer.registry?.getNode(path) ?? null;
  if (registered) return registered;
  const root = viewer.currentModelRoot ?? viewer.scene ?? null;
  if (!root || !path) return null;
  if (path === root.name) return root;
  if (root.name && path.startsWith(`${root.name}/`)) {
    const below = walkByName(root, path.slice(root.name.length + 1));
    if (below) return below;
  }
  return walkByName(root, path);
}
const num0 = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

// ── web_camera_fly ground probe (plan-705 §2.4 step 4) ──────────────────
/** Eye height above the surface below when walking. Same value as FpvPlugin.DEFAULT_EYE_HEIGHT. */
const EYE_HEIGHT_M = 1.7;
/** Ray length of the downward probe. Same value as GROUND_RAY_MAX in fpv-plugin.tsx (L32). */
const GROUND_RAY_MAX_M = 50;
/**
 * How far ABOVE the computed position the probe starts, so a camera already
 * below a floor still finds it. The FPV plugin uses the same number as an
 * unnamed inline literal (`camPos.y + 10`); only the VALUE is adopted here, it
 * is not an existing exported constant.
 */
const GROUND_PROBE_UP_M = 10;

// ── web_view_sweep defaults (plan-705 D-A10, plan-740 P3.1) ─────────────
/** Long edge of each rendered cell; compositeMontage caps cells at 640 px anyway. */
const SWEEP_CELL_PX = 640;

// ── web_view_ortho ────────────────────────────────────────────────────────
/** Rendered edge of one ortho cell; compositeMontage caps cells at 533 px in a 3-column sheet anyway. */
// Cell edge of one ortho view. The FLOOR matches web_eye's (2026-09-14): a
// view too small to read is not a cheaper answer, it is no answer. The CEILING
// sits above the floor on purpose — with min === max the size parameter would
// silently do nothing again, which is the exact defect this tool just had.
/** Meshes sampled for a framing fit — see `_fitPoints`. */
const FIT_MESH_SAMPLE_CAP = 2000;

const ORTHO_CELL_DEFAULT_PX = 1024;
const ORTHO_CELL_MIN_PX = 1024;
const ORTHO_CELL_MAX_PX = 2048;
/** Frame margin around the part's extents, as a factor of the half-extent. */
const ORTHO_MARGIN = 1.08;
/** Smallest half-extent that is framed — a bare pivot still gets a picture. */
const ORTHO_MIN_HALF_M = 0.01;
/**
 * Ortho fov ceiling for the `clip` placement. `fov` is the eye's width
 * measure in ortho (`halfH = dist·tan(fov/2)`), so a camera sitting right on
 * the face of a thin plate would need ~180°; the body clamps at 120°, and
 * 110° keeps a margin below that.
 */
const ORTHO_MAX_FOV_DEG = 110;

type OrthoAxis = 'x' | 'y' | 'z';

/**
 * The six views. `dir` is the unit offset FROM the target TO the camera, the
 * same spelling (and the same front = +Z convention) as `presetDirection` in
 * rv-camera-presets-math. `across` names the two box axes that span the
 * picture, `along` the view axis. Roll follows Three's `lookAt` fallback for
 * the vertical pair, which puts −Z ("north") at the top of the top view —
 * identical to the `top` preset — and +Z at the top of the bottom view.
 */
const ORTHO_VIEWS: ReadonlyArray<{
  name: string; label: string; dir: [number, number, number]; across: [OrthoAxis, OrthoAxis]; along: OrthoAxis;
}> = [
  { name: 'front',  label: 'front (+Z)',  dir: [0, 0, 1],  across: ['x', 'y'], along: 'z' },
  { name: 'back',   label: 'back (−Z)',   dir: [0, 0, -1], across: ['x', 'y'], along: 'z' },
  { name: 'left',   label: 'left (−X)',   dir: [-1, 0, 0], across: ['z', 'y'], along: 'x' },
  { name: 'right',  label: 'right (+X)',  dir: [1, 0, 0],  across: ['z', 'y'], along: 'x' },
  { name: 'top',    label: 'top (+Y)',    dir: [0, 1, 0],  across: ['x', 'z'], along: 'y' },
  { name: 'bottom', label: 'bottom (−Y)', dir: [0, -1, 0], across: ['x', 'z'], along: 'y' },
];

/**
 * Position, target and fov of one orthographic view. With `clip` the camera
 * sits just outside the box face along the view axis, so the eye's near plane
 * (`max(dist/1000, 5 mm)`) sections the scene at the box and nothing in front
 * of the part is drawn; the fov is then whatever frames the across-extents
 * from that short distance, capped so the body's lens clamp cannot bite.
 * Without `clip` the camera stands two bounding radii out, like the sweep.
 */
function orthoViewPose(
  view: (typeof ORTHO_VIEWS)[number],
  center: Vector3,
  extent: Vector3,
  radius: number,
  clip: boolean,
): { px: number; py: number; pz: number; tx: number; ty: number; tz: number; fov: number; halfH: number } {
  const halfH = Math.max(extent[view.across[0]], extent[view.across[1]], ORTHO_MIN_HALF_M * 2) / 2 * ORTHO_MARGIN;
  const halfDepth = extent[view.along] / 2;
  const maxTan = Math.tan((ORTHO_MAX_FOV_DEG * Math.PI) / 360);
  let dist = clip
    ? halfDepth * 1.02 + 0.01
    : Math.max(radius * 2 + halfDepth, ORTHO_MIN_HALF_M * 10);
  if (halfH / dist > maxTan) dist = halfH / maxTan;
  const fov = (2 * Math.atan(halfH / dist) * 180) / Math.PI;
  return {
    px: center.x + view.dir[0] * dist,
    py: center.y + view.dir[1] * dist,
    pz: center.z + view.dir[2] * dist,
    tx: center.x, ty: center.y, tz: center.z,
    fov, halfH,
  };
}

/** `groupBy` parser with web_eye's semantics: unknown → undefined (the default applies). */
function normalizeOrthoGroupBy(raw?: string): 'hierarchy' | 'geometry' | 'component' | undefined {
  const s = (raw ?? '').trim().toLowerCase();
  return s === 'hierarchy' || s === 'geometry' || s === 'component' ? s : undefined;
}

/** Long edge of the annotated shot — the historical full-frame capture cap. */

/**
 * Selectable mesh universe for select-similar: every effectively-visible,
 * non-authored-hidden leaf mesh under the model root, keyed by registry path.
 * Same criteria as the editor marquee's buildEditorSelectableMap, rebuilt here
 * (lean, mode-agnostic) so this module never pulls the asset-editor UI chunk.
 * Also used by web_editor_shortcut's S-chords (rv-mcp-editor-tools.ts).
 */
export function buildMeshUniverse(viewer: RVViewer): Map<string, Object3D> {
  const map = new Map<string, Object3D>();
  const root = viewer.currentModelRoot;
  const registry = viewer.registry;
  if (!root || !registry) return map;
  root.traverse((obj) => {
    if (!(obj as Mesh).isMesh) return;
    // Effectively visible: every ancestor up to the root visible, and no
    // authored rv.Hidden flag on the chain (matches raycast BVH exclusion).
    let n: Object3D | null = obj;
    let ok = true;
    while (n) {
      if (!n.visible) { ok = false; break; }
      const rv = (n.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
        Record<string, unknown> | undefined;
      if (rv?.['Hidden'] === true) { ok = false; break; }
      if (n === root) break;
      n = n.parent;
    }
    if (!ok) return;
    const path = registry.getPathForNode(obj);
    if (path) map.set(path, obj);
  });
  return map;
}

export class McpViewTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  // ═══ Perception ═══════════════════════════════════════════════════════

  // readOnly:false although the MEASUREMENT is pure: `focus` defaults to true, so the default
  // call selects the nodes and flies the operator's camera. An MCP annotation is per tool, not
  // per argument, and cannot say "read-only iff focus=false" — so the conservative value wins.
  // Read-only clients keep web_measure and web_node_shape, which are side-effect free by
  // construction, so nothing is actually unmeasurable.
  @McpTool('Measure nodes: world AABB (center/size/min/max, meters), node-local box + world quaternion (oriented bounds), mesh count. Also SELECTS the nodes (shared viewport highlight, like a user click) and frames them with the AGENT camera, unless focus=false. THE numeric grounding for pivot placement, axis positions and part sizes. Paths from web_node_find / web_node_tree — including the chunk/runtime nodes those report, which come back flagged and are measured but never selected.', { readOnly: false })
  async webNodeBounds(
    @McpParam('paths', 'Node paths, comma- or newline-separated.') paths: string,
    @McpParam('focus', 'Also select and frame the measured nodes (default true); pass false for measurement only.', 'boolean', false) focus?: boolean,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No viewer/registry' });
    const requested = parsePathsParam(paths);
    if (requested.length === 0) return JSON.stringify({ error: 'No node paths given' });
    const out: Array<Record<string, unknown>> = [];
    const unresolved: string[] = [];
    const resolvedPaths: string[] = [];
    const resolvedNodes: Object3D[] = [];
    const unionBox = new Box3();
    for (const p of requested) {
      const node = resolveSceneNodeByPath(v, p);
      if (!node) { unresolved.push(p); continue; }
      // Only a REGISTERED path may reach the selection below — `selectPaths`
      // goes through the registry, and a chunk mesh has no entry there.
      const registered = reg.getPathForNode(node);
      if (registered !== null) resolvedPaths.push(registered);
      resolvedNodes.push(node);
      node.updateMatrixWorld(true);
      const { box, size, center } = computeSubtreeAABB(node, new Box3());
      if (!box.isEmpty()) unionBox.union(box);
      // Node-local AABB: subtree geometry expressed in the node's own frame —
      // together with the world quaternion this describes the oriented box.
      const invWorld = new Matrix4().copy(node.matrixWorld).invert();
      const localBox = new Box3();
      const tmp = new Box3();
      let meshCount = 0;
      node.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        meshCount++;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        if (!mesh.geometry.boundingBox) return;
        tmp.copy(mesh.geometry.boundingBox)
          .applyMatrix4(new Matrix4().multiplyMatrices(invWorld, mesh.matrixWorld));
        localBox.union(tmp);
      });
      const q = node.getWorldQuaternion(new Quaternion());
      out.push({
        path: p,
        world: box.isEmpty() ? null : {
          center: vec3(center), size: vec3(size), min: vec3(box.min), max: vec3(box.max),
        },
        local: localBox.isEmpty() ? null : { min: vec3(localBox.min), max: vec3(localBox.max) },
        worldQuaternion: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
        worldPosition: vec3(node.getWorldPosition(new Vector3())),
        meshCount,
        // Same two flags the panel and web_node_tree carry (plan-754 F11).
        ...(isChunkMesh(node) ? { chunk: true } : {}),
        ...(isRuntimeNode(node, registered) ? { runtime: true } : {}),
      });
    }
    let selected = 0;
    let framed = false;
    if (focus !== false && resolvedNodes.length > 0) {
      // Selection stays SHARED with the human (plan-740 D-U3) — only the
      // framing moved to the agent camera, so a measurement no longer yanks a
      // watching operator's viewport around.
      if (v.selectionManager) {
        v.selectionManager.selectPaths(resolvedPaths);
        selected = resolvedPaths.length;
      }
      const eye = this._eye(v);
      if (eye) {
        const pose = eye.pose;
        const dir = new Vector3(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
        dir.normalize();
        if (!unionBox.isEmpty()) {
          this._frameEyeToBox(eye, unionBox, dir, resolvedNodes);
        } else {
          // Mesh-less pivots have no AABB to fit, so aim at the pivot position
          // directly from a fixed short distance, keeping the view direction.
          const pivot = new Vector3();
          for (const n of resolvedNodes) pivot.add(n.getWorldPosition(new Vector3()));
          pivot.divideScalar(resolvedNodes.length);
          this._placeEye(eye, pivot, dir, 0.8);
        }
        framed = true;
      }
    }
    return JSON.stringify({
      nodes: out,
      ...(selected ? { selected } : {}),
      ...(framed ? { framed } : {}),
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Isolate nodes visually: only the given subtrees stay bright and interactive, everything else is dimmed. The dimming is SHARED with the user (it is document state), but only the AGENT camera frames the isolated set — the user viewport stays where it is. Call with empty paths to EXIT isolation. Use before captures of buried parts.', { readOnly: false })
  async webViewIsolate(
    @McpParam('paths', 'Node paths to isolate (comma/newline-separated). Empty = exit isolation.', 'string', false) paths: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const requested = parsePathsParam(paths ?? '');
    if (requested.length === 0) {
      v.exitIsolate();
      return JSON.stringify({ isolated: 0, active: false });
    }
    const nodes: Object3D[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const n = v.registry?.getNode(p);
      if (n) nodes.push(n); else unresolved.push(p);
    }
    if (nodes.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ')}` });
    }
    // Dimming yes, viewport flight no (plan-740 D-U3): the isolation itself is
    // shared scene state, the framing belongs to whoever asked for it.
    v.isolateNodes(nodes, false);
    let framed = false;
    const eye = this._eye(v);
    if (eye) {
      const box = new Box3().makeEmpty();
      for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }
      if (!box.isEmpty()) {
        const pose = eye.pose;
        const dir = new Vector3(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
        dir.normalize();
        this._frameEyeToBox(eye, box, dir, nodes);
        framed = true;
      }
    }
    return JSON.stringify({
      isolated: nodes.length, active: true, framed,
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  // ═══ Camera ═══════════════════════════════════════════════════════════

  /**
   * The agent's camera body, spawned on demand (plan-740 D-A18).
   *
   * Every camera verb below drives THIS, never `viewer.camera`: a human
   * orbiting the viewport must not move the agent, and the agent must not drag
   * the human's view around. `undefined` means the `agent-eye` plugin is not
   * loaded (the embed viewer), which is a hard error for these tools rather
   * than a silent fall-back to the viewport.
   */
  private _eye(v: RVViewer): AgentEye | null {
    const eye = v.agentEye;
    if (!eye) return null;
    eye.ensure();
    return eye;
  }

  /** The camera block every camera verb answers with. */
  private _eyeReport(v: RVViewer, eye: AgentEye): Record<string, unknown> {
    const p = eye.pose;
    const el = v.renderer.domElement;
    return {
      position: [r3(p.px), r3(p.py), r3(p.pz)],
      target: [r3(p.tx), r3(p.ty), r3(p.tz)],
      projection: p.projection,
      fov: r3(p.fov),
      aspect: r3(p.aspect),
      ...(p.projection === 'orthographic' ? { orthoHalfHeight: r3(eye.orthoHalfHeight) } : {}),
      attached: eye.attached,
      canvas: { width: el.clientWidth, height: el.clientHeight },
    };
  }

  /**
   * Fit distance for the AGENT lens — same canonical formula and the same 1.25
   * framing margin `fitToNodes` uses, evaluated with the agent's fov/aspect
   * instead of the viewport's (they are independent since plan-740).
   */
  private _eyeFitDistance(eye: AgentEye, maxDim: number): number {
    const p = eye.pose;
    return fitDistanceBothAxesFor(Math.max(maxDim, 0.1), p.fov, p.aspect, 1.25);
  }

  /**
   * Pose that frames `box` from `dir` with the AGENT's lens.
   *
   * Replaces "largest world edge + 25 % margin, aimed at the box centre", which
   * left a valve terminal at 54 % of the frame width and 134 px below centre —
   * see {@link fitPoseToBox} for why both halves of that were wrong.
   */
  private _fitBox(
    eye: AgentEye, box: Box3, dir: Vector3, nodes?: readonly Object3D[],
  ): { eye: Vector3; target: Vector3 } {
    const p = eye.pose;
    const fit = fitPoseToPoints(
      this._fitPoints(box, nodes),
      [dir.x, dir.y, dir.z],
      p.fov, p.aspect,
    );
    return {
      eye: new Vector3(fit.eye[0], fit.eye[1], fit.eye[2]),
      target: new Vector3(fit.target[0], fit.target[1], fit.target[2]),
    };
  }

  /**
   * Points the fit should frame: the corners of each MESH's own box, falling
   * back to the subtree's single world AABB when there are no meshes.
   *
   * One world-axis AABB around a rotated assembly has large empty corners, so
   * centring its projection centres the empty box rather than the part — the
   * valve terminal still came out 122 px right of centre that way. Per-mesh
   * boxes follow each part's own placement and hug the geometry far more
   * tightly. Capped because this is per-corner arithmetic and a big assembly
   * can carry tens of thousands of meshes; the subsample keeps the extremes,
   * which is all an extent needs.
   */
  private _fitPoints(box: Box3, nodes?: readonly Object3D[]): FitVec3[] {
    const out: FitVec3[] = [];
    if (nodes && nodes.length > 0) {
      const meshes: Mesh[] = [];
      for (const n of nodes) {
        n.updateMatrixWorld(true);
        n.traverse((c) => { if ((c as Mesh).isMesh && (c as Mesh).geometry) meshes.push(c as Mesh); });
      }
      const step = Math.max(1, Math.ceil(meshes.length / FIT_MESH_SAMPLE_CAP));
      const corner = new Vector3();
      for (let i = 0; i < meshes.length; i += step) {
        const m = meshes[i];
        const g = m.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox;
        if (!bb || bb.isEmpty()) continue;
        for (let k = 0; k < 8; k++) {
          corner.set(
            k & 1 ? bb.max.x : bb.min.x,
            k & 2 ? bb.max.y : bb.min.y,
            k & 4 ? bb.max.z : bb.min.z,
          ).applyMatrix4(m.matrixWorld);
          out.push([corner.x, corner.y, corner.z]);
        }
      }
    }
    if (out.length === 0 && !box.isEmpty()) {
      for (let k = 0; k < 8; k++) {
        out.push([
          k & 1 ? box.max.x : box.min.x,
          k & 2 ? box.max.y : box.min.y,
          k & 4 ? box.max.z : box.min.z,
        ]);
      }
    }
    return out;
  }

  /** Frame `box` with the agent camera, keeping its current view direction. */
  private _frameEyeToBox(
    eye: AgentEye, box: Box3, dir: Vector3, nodes?: readonly Object3D[],
  ): void {
    const fit = this._fitBox(eye, box, dir, nodes);
    eye.setPose({
      px: fit.eye.x, py: fit.eye.y, pz: fit.eye.z,
      tx: fit.target.x, ty: fit.target.y, tz: fit.target.z,
    });
  }

  /** Aim the agent at `center` from `distance` along `dir` (normalised). */
  private _placeEye(eye: AgentEye, center: Vector3, dir: Vector3, distance: number): void {
    eye.setPose({
      px: center.x + dir.x * distance,
      py: center.y + dir.y * distance,
      pz: center.z + dir.z * distance,
      tx: center.x, ty: center.y, tz: center.z,
    });
  }

  @McpTool('Get the AGENT camera state: position, look-at target, projection, fov, aspect and whether the user viewport is currently attached to it. This is the agent\'s own camera body — it is NOT moved by the user navigating the viewport, and moving it does not move their view. canvas reports the user viewport size for reference only.', { readOnly: true })
  async webCameraGet(): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    return JSON.stringify(this._eyeReport(v, eye));
  }

  @McpTool('Switch the AGENT camera between perspective and orthographic (iso) rendering. mode = perspective | orthographic (aliases: persp, ortho, iso); omit to toggle. In orthographic the frustum half-height is distance x tan(fov/2), reported as orthoHalfHeight in metres. Instant — the user viewport is not switched.', { readOnly: false })
  async webCameraProjection(
    @McpParam('mode', 'perspective | orthographic | iso (omit = toggle).', 'string', false) mode: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    const raw = (mode ?? '').trim().toLowerCase();
    const current = eye.pose.projection;
    let next: 'perspective' | 'orthographic';
    if (raw === '' || raw === 'toggle') {
      next = current === 'perspective' ? 'orthographic' : 'perspective';
    } else if (raw === 'perspective' || raw === 'persp' || raw === 'p') {
      next = 'perspective';
    } else if (raw === 'orthographic' || raw === 'ortho' || raw === 'iso' || raw === 'o') {
      next = 'orthographic';
    } else {
      return JSON.stringify({ error: `Unknown mode '${mode}' — use perspective | orthographic | iso, or omit to toggle` });
    }
    if (next === current) return JSON.stringify({ projection: current, changed: false });
    eye.setLens({ projection: next });
    return JSON.stringify({ projection: next, changed: true });
  }

  @McpTool('Move the AGENT camera to an explicit position looking at a target. Coordinates in meters, world space. fov (5..120 degrees, vertical) and aspect (width/height, 0.2..5) set the lens for every later capture. Instant: the pose is set and the call returns, nothing is animated and the user viewport does not move. The scene shows a small cone where the agent now stands.', { readOnly: false })
  async webCameraSet(
    @McpParam('px', 'Camera position X (m).', 'number') px: number,
    @McpParam('py', 'Camera position Y (m).', 'number') py: number,
    @McpParam('pz', 'Camera position Z (m).', 'number') pz: number,
    @McpParam('tx', 'Look-at target X (m).', 'number') tx: number,
    @McpParam('ty', 'Look-at target Y (m).', 'number') ty: number,
    @McpParam('tz', 'Look-at target Z (m).', 'number') tz: number,
    @McpParam('durationMs', 'Ignored since the agent camera moves instantly; kept so older callers still work.', 'number', false) durationMs: number,
    @McpParam('fov', 'Vertical field of view in degrees, clamped 5..120.', 'number', false) fov?: number,
    @McpParam('aspect', 'Image aspect (width/height), clamped 0.2..5.', 'number', false) aspect?: number,
  ): Promise<string> {
    void durationMs;
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    eye.setPose({ px, py, pz, tx, ty, tz, fov, aspect });
    return JSON.stringify(this._eyeReport(v, eye));
  }

  @McpTool('Frame one or more nodes with the AGENT camera: it moves so they fill its view, keeping its current view direction. THE standard way to look at a part before a capture. Instant, and the user viewport stays where it is.', { readOnly: false })
  async webCameraFocus(
    @McpParam('paths', 'Node paths, comma- or newline-separated.') paths: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    const requested = parsePathsParam(paths);
    const nodes: Object3D[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const n = v.registry?.getNode(p);
      if (n) nodes.push(n); else unresolved.push(p);
    }
    if (nodes.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ') || '(none given)'}` });
    }
    const box = new Box3().makeEmpty();
    for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }
    if (box.isEmpty()) {
      return JSON.stringify({ error: 'The requested node(s) have no geometry to frame (empty bounds).' });
    }
    const pose = eye.pose;
    // Keep the agent's own view direction, exactly like the viewport's Focus.
    const dir = new Vector3(pose.px - pose.tx, pose.py - pose.ty, pose.pz - pose.tz);
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
    dir.normalize();
    this._frameEyeToBox(eye, box, dir, nodes);
    return JSON.stringify({
      framed: nodes.length,
      camera: this._eyeReport(v, eye),
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Orbit the AGENT camera around a point: yaw (horizontal, degrees, + = counter-clockwise from above), pitch (vertical, degrees, + = up), and an optional distance factor (0.5 = half distance / zoom in, 2 = zoom out). Relative move — ideal for "look at it from the other side". pivot chooses the point: omit for the agent\'s current target, "selection" for the centre of what is selected, or a node path. Instant; the user viewport is untouched.', { readOnly: false })
  async webCameraOrbit(
    @McpParam('yawDeg', 'Horizontal orbit angle in degrees.', 'number') yawDeg: number,
    @McpParam('pitchDeg', 'Vertical orbit angle in degrees (default 0).', 'number', false) pitchDeg: number,
    @McpParam('distanceFactor', 'Multiply camera distance (default 1).', 'number', false) distanceFactor: number,
    @McpParam('pivot', 'Orbit centre: "selection", a node path, or omit for the current target.', 'string', false) pivot?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    // No ownership refusal any more (plan-740 D-A7): FPV, follow and XR own the
    // VIEWPORT camera, and this no longer touches it.
    const state = eye.pose;
    // Default is verbatim the old behaviour: the CURRENT target. `pivot` only
    // ever replaces it, so an existing caller sees no change at all.
    const pivotPoint = this._resolvePivot(v, pivot);
    if (pivotPoint && 'error' in pivotPoint) return JSON.stringify(pivotPoint);
    const target = pivotPoint?.point.clone() ?? new Vector3(state.tx, state.ty, state.tz);
    const offset = new Vector3(state.px, state.py, state.pz).sub(target);
    const radius = offset.length() * (typeof distanceFactor === 'number' && distanceFactor > 0 ? distanceFactor : 1);
    // Spherical angles: theta = azimuth around +Y, phi = polar from +Y.
    const theta = Math.atan2(offset.x, offset.z) + (yawDeg || 0) * Math.PI / 180;
    let phi = Math.acos(Math.min(Math.max(offset.y / offset.length(), -1), 1))
      - (pitchDeg || 0) * Math.PI / 180;
    phi = Math.min(Math.max(phi, 0.05), Math.PI - 0.05);
    eye.setPose({
      px: target.x + radius * Math.sin(phi) * Math.sin(theta),
      py: target.y + radius * Math.cos(phi),
      pz: target.z + radius * Math.sin(phi) * Math.cos(theta),
      tx: target.x, ty: target.y, tz: target.z,
    });
    return JSON.stringify(this._eyeReport(v, eye));
  }

  // ═══ Named views (plan-713 F9) ════════════════════════════════════════

  /**
   * Resolve a `pivot` / `target` parameter to a point plus the nodes it covers.
   *
   * Shared by `web_camera_view` and `web_camera_orbit` so the two spell
   * "selection" and "a node path" identically — an agent that learnt one must
   * not have to discover that the other takes a different vocabulary.
   *
   * `undefined`/empty returns null, which every caller reads as "use your own
   * default". That is what keeps the new parameter behaviour-neutral.
   */
  private _resolvePivot(
    v: RVViewer, raw: string | undefined,
  ): { point: Vector3; nodes: Object3D[] } | { error: string } | null {
    const want = (raw ?? '').trim();
    if (!want) return null;

    const nodes: Object3D[] = [];
    if (want.toLowerCase() === 'selection') {
      const paths = v.selectionManager?.getSnapshot().selectedPaths ?? [];
      if (paths.length === 0) {
        return { error: 'pivot="selection" but nothing is selected — select something with web_select, or pass a node path.' };
      }
      for (const p of paths) { const n = v.registry?.getNode(p); if (n) nodes.push(n); }
      if (nodes.length === 0) {
        return { error: 'The selected paths no longer resolve to nodes — reselect and retry.' };
      }
    } else {
      const n = v.registry?.getNode(want);
      if (!n) return { error: `Node not found: ${want}. Pass "selection" or a path from web_node_find.` };
      nodes.push(n);
    }

    const union = new Box3().makeEmpty();
    for (const n of nodes) { n.updateMatrixWorld(true); union.union(computeSubtreeAABB(n, new Box3()).box); }
    if (union.isEmpty()) {
      return { error: `"${want}" has no geometry to aim at (empty bounds).` };
    }
    return { point: union.getCenter(new Vector3()), nodes };
  }

  @McpTool('Move the AGENT camera to a NAMED view: iso | top | front | back | left | right | home (home = iso). target chooses what to frame — "selection", a node path, or omit for the whole scene. The framing distance uses the same fit formula web_camera_focus does, evaluated with the agent\'s own fov and aspect. Instant; the user viewport is untouched.', { readOnly: false, timeoutMs: 30_000 })
  async webCameraView(
    @McpParam('preset', 'iso | top | front | back | left | right | home') preset: string,
    @McpParam('target', '"selection", a node path, or omit for the whole scene.', 'string', false) target?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    const {
      CAMERA_PRESETS, isCameraPreset, presetPose, applyMeasuredDistance,
    } = await import('./rv-camera-presets-math');
    const wanted = (preset ?? '').trim().toLowerCase();
    if (!isCameraPreset(wanted)) {
      return JSON.stringify({
        error: `Unknown preset "${preset}". Use one of: ${CAMERA_PRESETS.join(', ')}.`,
      });
    }

    const resolved = this._resolvePivot(v, target);
    if (resolved && 'error' in resolved) return JSON.stringify(resolved);

    // Bounds: the requested nodes, else the whole model.
    const nodes = resolved?.nodes ?? (v.currentModelRoot ? [v.currentModelRoot] : []);
    const box = new Box3().makeEmpty();
    for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }

    let pose = presetPose(wanted, box);
    // plan-740: the old D-A5 step measured the distance by actually running
    // `fitToNodes` on the VIEWPORT and reading it back. That is exactly the
    // side effect this plan removes, and the viewport lens is no longer the
    // agent's anyway. The canonical formula is now shared as a pure function
    // (`fitDistanceBothAxesFor`), so the distance is computed with the AGENT's
    // fov/aspect — still one copy of the maths, just the right lens.
    if (!box.isEmpty()) {
      const dir = pose.position.clone().sub(pose.target);
      if (dir.lengthSq() > 1e-12) {
        const fit = this._fitBox(eye, box, dir.normalize());
        pose = applyMeasuredDistance(pose, { target: fit.target, position: fit.eye });
      }
    }

    this._placeEye(
      eye, pose.target,
      pose.position.clone().sub(pose.target).normalize(),
      pose.distance,
    );
    return JSON.stringify({
      preset: wanted,
      framed: nodes.length,
      distance: +pose.distance.toFixed(3),
      camera: this._eyeReport(v, eye),
    });
  }

  @McpTool('Fly the AGENT camera RELATIVE to where it is now: forward/right/up in metres plus yawDeg/pitchDeg in degrees (+yaw = to the left, +pitch = up, clamped at ±85°). Unlike web_camera_orbit — which circles a fixed point — this MOVES THROUGH the plant, which is what a long line needs. ground=true walks instead of flying: forward/right stay horizontal and the camera is held at eye height above the nearest surface below (no wall collision — flying through a wall is allowed). Instant; the user viewport is untouched.', { readOnly: false, timeoutMs: 30_000 })
  async webCameraFly(
    @McpParam('forward', 'Metres along the view direction (default 0).', 'number', false) forward?: number,
    @McpParam('right', 'Metres to the right (default 0).', 'number', false) right?: number,
    @McpParam('up', 'Metres along world +Y (default 0).', 'number', false) up?: number,
    @McpParam('yawDeg', 'Turn in degrees, + = to the left (default 0).', 'number', false) yawDeg?: number,
    @McpParam('pitchDeg', 'Tilt in degrees, + = up, clamped at ±85° (default 0).', 'number', false) pitchDeg?: number,
    @McpParam('ground', 'Walk instead of fly: horizontal moves, eye height above the surface below (default false).', 'boolean', false) ground?: boolean,
    @McpParam('durationMs', 'Ignored since the agent camera moves instantly; kept so older callers still work.', 'number', false) durationMs?: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    // The FPV/follow/XR refusal is gone (plan-740 D-A7): those own the VIEWPORT
    // camera, and the agent no longer flies it. `attach()` keeps the guard.
    const cur = eye.pose;
    const next = computeFlyPose(
      {
        position: new Vector3(cur.px, cur.py, cur.pz),
        target: new Vector3(cur.tx, cur.ty, cur.tz),
      },
      { forward, right, up, yawDeg, pitchDeg, ground },
    );

    // Ground probe (F4). The raycast manager only exists after a GLB load, so a
    // missing one is the SAME branch as "ray hit nothing": groundHit:false, no
    // throw and no refusal (plan-705 §2.4 step 4 / D-A13 — pick BVH, not the FPV
    // ground whitelist, so modelled floors and platforms count too).
    let groundHit = false;
    let groundY: number | undefined;
    if (ground === true) {
      const rm = v.raycastManager;
      const hit = rm
        ? rm.raycastRay(
          new Vector3(next.position.x, next.position.y + GROUND_PROBE_UP_M, next.position.z),
          new Vector3(0, -1, 0),
          GROUND_RAY_MAX_M,
        )
        : null;
      if (hit) {
        groundHit = true;
        groundY = hit.hitPoint[1];
        const newY = groundY + EYE_HEIGHT_M;
        // Shift the target by the same Δy, otherwise the view tips over on a step.
        const dy = newY - next.position.y;
        next.position.y = newY;
        next.target.y += dy;
      }
    }

    void durationMs;   // instant since plan-740; parameter kept for old callers
    eye.setPose({
      px: next.position.x, py: next.position.y, pz: next.position.z,
      tx: next.target.x, ty: next.target.y, tz: next.target.z,
    });
    return JSON.stringify({
      ...this._eyeReport(v, eye),
      deltaM: { forward: num0(forward), right: num0(right), up: num0(up) },
      yawDeg: num0(yawDeg),
      pitchDeg: num0(pitchDeg),
      ground: ground === true,
      groundHit,
      ...(groundY !== undefined ? { groundY: r3(groundY) } : {}),
    });
  }

  @McpTool('Contact sheet of a part: renders 4-8 views evenly around it OFFSCREEN through the AGENT camera and returns ONE labelled montage plus a note per view (visible top nodes with coverage and ownerPath, background share, camera position). Understands an unknown assembly in a SINGLE call instead of an orbit+screenshot loop. Coverage is measured on the ID MASK of a depth-tested frame, so it is occlusion-correct rather than ray-sampled. Instant: nothing is animated, neither the user viewport nor the agent body moves. Each note carries its cameraPosition, so pulling one view up is one web_camera_set away. Requires the classic WebGL renderer.', { readOnly: true, timeoutMs: 120_000 })
  async webViewSweep(
    @McpParam('paths', 'Node paths to sweep around, comma/newline-separated. Empty = whole model.', 'string', false) paths?: string,
    @McpParam('count', 'Number of views, clamped to 4..8 (default 6).', 'number', false) count?: number,
    @McpParam('pitchDeg', 'Elevation of every view in degrees (default 20).', 'number', false) pitchDeg?: number,
    @McpParam('yawStartDeg', 'Yaw of the first view (default: current camera azimuth).', 'number', false) yawStartDeg?: number,
    @McpParam('restore', 'Ignored since the sweep renders offscreen and moves no camera; kept so older callers still work.', 'boolean', false) restore?: boolean,
    @McpParam('savePath', 'Optional PROJECT-relative path to also write the montage as PNG (bare name lands in "captures/").', 'string', false) savePath?: string,
    @McpParam('topN', 'Nodes reported per view, max 10 (default 5).', 'number', false) topN?: number,
  ): Promise<string> {
    void restore;   // offscreen since plan-740; parameter kept for old callers
    return serializeEyeCapture(() => this._sweep(paths, count, pitchDeg, yawStartDeg, savePath, topN));
  }

  /**
   * The sweep body, run inside the shared capture chain (D-A15).
   *
   * Everything the old implementation did to the VIEWPORT is gone (D-A7/D-U10):
   * no `fitToNodes`, no `animateCameraTo`, no 600 ms flight and 120 ms settle
   * per pose, no `controls.enabled` freeze, no restore, no ownership refusal —
   * and therefore no `poseDrift` either, because a human orbiting mid-sweep can
   * no longer change what the frames show. Six poses that took ~4.5 s of pure
   * waiting are now six offscreen renders.
   */
  private async _sweep(
    paths?: string, count?: number, pitchDeg?: number, yawStartDeg?: number,
    savePath?: string, topN?: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    const guard = guardAgentCapture(v, 'web_view_sweep');
    if (guard) return JSON.stringify({ error: guard });

    const requested = parsePathsParam(paths ?? '');
    const nodes: Object3D[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const n = v.registry?.getNode(p);
      if (n) nodes.push(n); else unresolved.push(p);
    }
    if (requested.length > 0 && nodes.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ')}` });
    }
    if (nodes.length === 0) {
      const root = v.currentModelRoot;
      if (!root) return JSON.stringify({ error: 'No model loaded' });
      nodes.push(root);
    }

    const reg = v.registry;
    if (!reg) return JSON.stringify({ error: 'No registry' });

    // Ring geometry: the union box gives the centre, and the radius comes from
    // the SAME canonical fit formula `web_camera_focus` uses, evaluated through
    // the AGENT's lens. The old code got the radius by actually flying the
    // viewport with `fitToNodes` and reading the distance back — the very side
    // effect this plan removes, and the viewport's fov/aspect are no longer the
    // agent's anyway.
    const box = new Box3().makeEmpty();
    for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }
    if (box.isEmpty()) {
      return JSON.stringify({ error: 'The requested node(s) have no geometry to sweep around (empty bounds).' });
    }
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = this._eyeFitDistance(eye, Math.max(size.x, size.y, size.z)) || 1;

    const agent = eye.pose;
    const startYaw = typeof yawStartDeg === 'number' && Number.isFinite(yawStartDeg)
      ? yawStartDeg
      // Default is the AGENT's current azimuth, so view #0 is roughly where the
      // agent already looks from and the sheet reads as "turning around it".
      : Math.atan2(agent.px - center.x, agent.pz - center.z) * 180 / Math.PI;

    const poses = sweepPoses(center, radius, {
      count: typeof count === 'number' ? count : DEFAULT_SWEEP_COUNT,
      pitchDeg: typeof pitchDeg === 'number' ? pitchDeg : DEFAULT_SWEEP_PITCH_DEG,
      yawStartDeg: startYaw,
    });

    const root = nodes.length === 1 ? nodes[0] : (v.currentModelRoot ?? nodes[0]);
    const grouping = { groupBy: defaultGroupBy(root) };
    const frames: HTMLCanvasElement[] = [];
    const notes: SweepViewNote[] = [];

    for (const pose of poses) {
      // A TEMPORARY pose per cell: the agent's body does not move, so the cone
      // a watching human sees stays where the agent put it and the next
      // `web_eye` still frames what the agent chose.
      const rendered = await renderAgentChannels(v, {
        pose: {
          ...agent,
          px: pose.position.x, py: pose.position.y, pz: pose.position.z,
          tx: pose.target.x, ty: pose.target.y, tz: pose.target.z,
        },
        size: SWEEP_CELL_PX,
        channels: ['beauty', 'idmask'],
        root,
        idmask: grouping,
      });
      if ('error' in rendered) return JSON.stringify({ error: rendered.error, view: pose.index });
      const beauty = rendered.channels.find((c) => c.channel === 'beauty');
      const idChannel = rendered.channels.find((c) => c.idBuffer);
      if (!beauty) return JSON.stringify({ error: 'Beauty channel missing', view: pose.index });
      frames.push(beauty.canvas);
      // The note comes off the ID MASK of the very frame in the cell (D-A13) —
      // there is no longer a second sampling pass that could describe a
      // different pose than the picture shows.
      const visible = buildVisible(rendered, idChannel?.idBuffer, [], reg);
      notes.push(summarizeVisibleGroups(
        pose, visible, typeof topN === 'number' ? topN : DEFAULT_TOP_N,
      ));
    }

    const mont = compositeMontage(frames, poses.map((p) => p.label));
    if ('error' in mont) return JSON.stringify({ error: mont.error });
    const saved = savePath?.trim() ? await saveCanvasToProject(mont, savePath) : {};
    return canvasToRvImage(mont, {
      views: notes,
      center: vec3(center),
      radius: r3(radius),
      ...(unresolved.length ? { unresolved } : {}),
      ...saved,
    }, 'web_view_sweep');
  }

  // ═══ web_view_ortho ═══════════════════════════════════════════════════

  @McpTool('Render the six ORTHOGRAPHIC views (front, back, left, right, top, bottom) OFFSCREEN through the AGENT camera into ONE labelled 3×2 mosaic per requested channel (beauty, idmask = flat ID colors + white crease edges, xray = look inside, translucent on black). labels=true marks the idmask mosaic only, capped at topN so every marker has a topNodes entry; beauty stays unannotated and pixel-aligned. The sidecar lists per view the marks, top visible nodes and the camera pose. clip=true (default) puts each camera on the bounding-box face, so a part inside a cabinet still shows. Instant: neither the user viewport nor the agent body moves. Requires the classic WebGL renderer.', { readOnly: true, timeoutMs: 120_000 })
  async webViewOrtho(
    @McpParam('paths', 'Node paths, comma/newline-separated. Empty = whole model.', 'string', false) paths?: string,
    @McpParam('channels', 'Comma-separated: beauty, idmask, xray (default "beauty"). One mosaic per channel.', 'string', false) channels?: string,
    @McpParam('size', 'Edge of each view in px, 1024..2048 (default 1024); smaller values are raised to 1024. The mosaic is 3 cells wide, so 1024 gives a 3072px sheet — the returned image is downscaled to the transport cap, savePath keeps full size.', 'number', false) size?: number,
    @McpParam('labels', 'Burn numbered Set-of-Mark markers on the idmask mosaic (default true). beauty is never annotated.', 'boolean', false) labels?: boolean,
    @McpParam('clip', 'Cut away everything in front of the bounding box (default true); false = views from outside, occluders included.', 'boolean', false) clip?: boolean,
    @McpParam('groupBy', 'idmask groups: "hierarchy", "geometry" or "component" (default: component when the model has components, else hierarchy).', 'string', false) groupBy?: string,
    @McpParam('savePath', 'Optional PROJECT-relative path to also write each mosaic as PNG ("<name>.<channel>.png"; bare name lands in "captures/").', 'string', false) savePath?: string,
    @McpParam('topN', 'Nodes reported per view, max 10 (default 5).', 'number', false) topN?: number,
  ): Promise<string> {
    return serializeEyeCapture(() => this._ortho(paths, channels, size, labels, clip, groupBy, savePath, topN));
  }

  /**
   * The ortho-mosaic body, run inside the shared capture chain (D-A15).
   *
   * Each view is a TEMPORARY orthographic pose for the agent eye: the body
   * itself stays where the agent put it, exactly like the sweep. `clip` places
   * the camera on the AABB face of the requested nodes, so the eye's own near
   * plane (`dist/1000`, see EyeChannels._camera) becomes a section plane at the
   * box — no live-scene mutation, no isolate state, nothing to restore.
   */
  private async _ortho(
    paths?: string, channelsRaw?: string, size?: number, labels?: boolean,
    clip?: boolean, groupByRaw?: string, savePath?: string, topN?: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const eye = this._eye(v);
    if (!eye) return JSON.stringify({ error: 'No agent eye' });
    const guard = guardAgentCapture(v, 'web_view_ortho');
    if (guard) return JSON.stringify({ error: guard });
    const reg = v.registry;
    if (!reg) return JSON.stringify({ error: 'No registry' });

    // Channels: same rules as web_eye — default beauty, duplicates collapse,
    // an unknown name is a hard error rather than a silently missing mosaic.
    const rawChannels = (channelsRaw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const wanted: EyeChannel[] = rawChannels.length === 0 ? ['beauty'] : [];
    for (const name of rawChannels) {
      if (!(EYE_CHANNELS as readonly string[]).includes(name)) {
        return JSON.stringify({ error: `Unknown channel "${name}". Valid: ${EYE_CHANNELS.join(', ')}.` });
      }
      wanted.push(name as EyeChannel);
    }
    const requestedChannels = dedupeChannels(wanted);
    // The idmask is always rendered: marks and the per-view notes come off it.
    const renderChannels = dedupeChannels([...requestedChannels, 'idmask']);

    const requested = parsePathsParam(paths ?? '');
    const nodes: Object3D[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const n = reg.getNode(p);
      if (n) nodes.push(n); else unresolved.push(p);
    }
    if (requested.length > 0 && nodes.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ')}` });
    }
    if (nodes.length === 0) {
      const root = v.currentModelRoot;
      if (!root) return JSON.stringify({ error: 'No model loaded' });
      nodes.push(root);
    }

    const box = new Box3().makeEmpty();
    for (const n of nodes) { n.updateMatrixWorld(true); box.union(computeSubtreeAABB(n, new Box3()).box); }
    if (box.isEmpty()) {
      return JSON.stringify({ error: 'The requested node(s) have no geometry to view (empty bounds).' });
    }
    const center = box.getCenter(new Vector3());
    const extent = box.getSize(new Vector3());
    const radius = Math.max(extent.length() / 2, ORTHO_MIN_HALF_M);

    const cellPx = Number.isFinite(size)
      ? Math.max(ORTHO_CELL_MIN_PX, Math.min(ORTHO_CELL_MAX_PX, Math.round(size as number)))
      : ORTHO_CELL_DEFAULT_PX;
    const doClip = clip !== false;
    const root = nodes.length === 1 ? nodes[0] : (v.currentModelRoot ?? nodes[0]);
    const groupBy = normalizeOrthoGroupBy(groupByRaw) ?? defaultGroupBy(root);
    const grouping = { groupBy };
    const cap = Math.max(1, Math.min(10, Math.round(num0(topN) || DEFAULT_TOP_N)));

    const frames = new Map<EyeChannel, HTMLCanvasElement[]>();
    for (const ch of requestedChannels) frames.set(ch, []);
    const mimes = new Map<EyeChannel, 'image/png' | 'image/jpeg'>();
    const views: Array<Record<string, unknown>> = [];

    for (const view of ORTHO_VIEWS) {
      const pose = orthoViewPose(view, center, extent, radius, doClip);
      const rendered = await renderAgentChannels(v, {
        pose: {
          ...eye.pose,
          px: pose.px, py: pose.py, pz: pose.pz,
          tx: pose.tx, ty: pose.ty, tz: pose.tz,
          fov: pose.fov, aspect: 1, projection: 'orthographic',
        },
        size: cellPx,
        channels: renderChannels,
        root,
        idmask: grouping,
      });
      if ('error' in rendered) return JSON.stringify({ error: rendered.error, view: view.name });

      // Set-of-Mark + note, both off the SAME idmask buffer (D-A13). Mark
      // numbers are PER VIEW — each cell is its own picture.
      const idChannel = rendered.channels.find((c) => c.idBuffer);
      // Cap the marks at the SAME number the sidecar reports. With the generic
      // SOM cap the picture carried up to 24 markers while `topNodes` listed at
      // most `topN` (default 5, max 10), so every mark above that was visible
      // and unresolvable. Both rank by descending area, so one cap aligns them.
      const marks = (labels !== false && idChannel?.idBuffer)
        ? computeMarks(idChannel.idBuffer, rendered.width, rendered.height, cap)
        : [];
      // Marks go on the ID MASK ONLY. `beauty` is the channel that answers
      // "what does this actually look like", so it stays an unannotated
      // render; the mask is where identity is asked for, and the two frames
      // are pixel-aligned, so a mark read off the mask locates the same spot
      // in beauty.
      if (marks.length > 0) {
        const colors = rendered.legend.map((l) => l.color);
        for (const c of rendered.channels) {
          if (c.channel !== 'idmask') continue;
          const ctx = c.canvas.getContext('2d');
          if (ctx) drawMarks(ctx, marks, colors);
        }
      }
      for (const c of rendered.channels) {
        const list = frames.get(c.channel);
        if (!list) continue;   // the internal idmask the caller did not ask for
        list.push(c.canvas);
        mimes.set(c.channel, c.mime);
      }

      const rows = buildVisible(rendered, idChannel?.idBuffer, marks, reg);
      let covered = 0;
      for (const row of rows) covered += typeof row.coverage === 'number' ? row.coverage : 0;
      views.push({
        view: view.name,
        cameraPosition: [r3(pose.px), r3(pose.py), r3(pose.pz)],
        cameraTarget: [r3(pose.tx), r3(pose.ty), r3(pose.tz)],
        orthoHalfHeight: rendered.camera.orthoHalfHeight ?? r3(pose.halfH),
        topNodes: rows.slice(0, cap).map((row) => ({
          ...(typeof row.mark === 'number' ? { mark: row.mark } : {}),
          path: row.path,
          ...(typeof row.ownerPath === 'string' ? { ownerPath: row.ownerPath } : {}),
          coverage: row.coverage,
        })),
        background: r3(Math.max(0, 1 - covered)),
      });
    }

    const labelsPerCell = ORTHO_VIEWS.map((o) => o.label);
    const mosaics: RvImageChannel[] = [];
    const savedPaths: Record<string, string> = {};
    const saveErrors: string[] = [];
    const base = savePath?.trim() ? savePath.trim().replace(/\.png$/i, '') : '';
    for (const ch of requestedChannels) {
      // Pass the rendered cell size: the montage default would rescale every
      // cell to 533px and make `size` a no-op (the sheet came out 1599×1066
      // whether 256 or 1024 was asked for, savePath included).
      const mont = compositeMontage(frames.get(ch) ?? [], labelsPerCell, cellPx);
      if ('error' in mont) return JSON.stringify({ error: mont.error, channel: ch });
      mosaics.push({ canvas: mont, mime: mimes.get(ch) ?? 'image/png', channel: ch });
      if (base) {
        const outcome = await saveCanvasToProject(mont, `${base}.${ch}.png`);
        if (typeof outcome.savedPath === 'string') savedPaths[ch] = outcome.savedPath;
        else if (typeof outcome.saveError === 'string') saveErrors.push(outcome.saveError);
      }
    }

    return canvasesToRvImages(mosaics, {
      channels: requestedChannels,
      views,
      center: vec3(center),
      sizeM: vec3(extent),
      clip: doClip,
      groupBy,
      ...(unresolved.length ? { unresolved } : {}),
      ...(Object.keys(savedPaths).length ? { savedPaths } : {}),
      ...(saveErrors.length ? { saveErrors } : {}),
    }, 'web_view_ortho');
  }

  // ═══ Selection ════════════════════════════════════════════════════════

  @McpTool('Change the selection (reflected in the viewport highlight and all panels, exactly like user clicks). mode: replace (default) | add | toggle | clear. paths = comma/newline-separated node paths (ignored for clear).', { readOnly: false })
  async webSelect(
    @McpParam('paths', 'Node paths, comma- or newline-separated.', 'string', false) paths: string,
    @McpParam('mode', 'replace | add | toggle | clear (default replace).', 'string', false) mode: string,
  ): Promise<string> {
    const v = this.viewer;
    const sm = v?.selectionManager;
    if (!v || !sm) return JSON.stringify({ error: 'No selection manager' });
    const m = (mode || 'replace').toLowerCase();
    if (m === 'clear') {
      sm.clear();
      return JSON.stringify({ selected: 0, primary: null });
    }
    const requested = parsePathsParam(paths ?? '');
    const valid: string[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      if (v.registry?.getNode(p)) valid.push(p); else unresolved.push(p);
    }
    if (valid.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ') || '(none given)'}` });
    }
    if (m === 'replace') {
      sm.selectPaths(valid);
    } else if (m === 'add') {
      const merged = [...new Set([...sm.selectedPaths, ...valid])];
      sm.selectPaths(merged);
    } else if (m === 'toggle') {
      for (const p of valid) sm.toggle(p);
    } else {
      return JSON.stringify({ error: `Unknown mode "${mode}" — use replace | add | toggle | clear` });
    }
    const snap = sm.getSnapshot();
    return JSON.stringify({
      selected: snap.selectedPaths.length,
      primary: snap.primaryPath,
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Get the current selection: paths (only what the document addresses), the primary path, and nodes[] — one entry per selected object with uuid, name and either path or runtime:true. Selection identity is the OBJECT since plan-754, so a chunk mesh, a light or an overlay can be selected by a user click and then appears in nodes[] with no path; paths stays the subset a path-taking tool can act on.', { readOnly: true })
  async webSelectionGet(): Promise<string> {
    const v = this.viewer;
    const sm = v?.selectionManager;
    if (!sm) return JSON.stringify({ error: 'No selection manager' });
    const snap = sm.getSnapshot();
    // Selection identity is the object (plan-754 D10), so a selected chunk
    // mesh, light or overlay has a uuid and no path. `paths` keeps its old
    // meaning — what the document can address — and `nodes` is the full truth.
    const nodes = snap.nodes.map((node) => {
      const path = v?.registry?.getPathForNode(node) ?? null;
      return {
        uuid: node.uuid,
        name: node.name || node.type,
        ...(path !== null ? { path } : { runtime: true as const }),
      };
    });
    return JSON.stringify({ paths: snap.selectedPaths, primary: snap.primaryPath, nodes });
  }

  @McpTool('Select-similar (the editor\'s "Select ▸" menu, remote): kind = identical (same geometry content — all copies of a part, e.g. all rollers), material (same material/appearance), or invert (everything not selected). Seeds from seedPath or the current selection. Replaces the selection with the match set and returns the count.', { readOnly: false })
  async webSelectSimilar(
    @McpParam('kind', 'identical | material | invert.') kind: string,
    @McpParam('seedPath', 'Seed node path (default: current selection).', 'string', false) seedPath: string,
  ): Promise<string> {
    const v = this.viewer;
    const sm = v?.selectionManager;
    if (!v || !sm) return JSON.stringify({ error: 'No selection manager' });
    const k = (kind || '').toLowerCase();
    if (!['identical', 'material', 'invert'].includes(k)) {
      return JSON.stringify({ error: `Unknown kind "${kind}" — use identical | material | invert` });
    }
    const universe = buildMeshUniverse(v);
    if (universe.size === 0) return JSON.stringify({ error: 'No selectable meshes in the scene' });
    const selected = sm.getSnapshot().selectedPaths;
    let result: string[];
    if (k === 'invert') {
      result = computeInvertPaths(universe, selected);
    } else {
      const seedRoots = seedPath ? [seedPath] : [...selected];
      if (seedRoots.length === 0) {
        return JSON.stringify({ error: 'No seed — pass seedPath or select something first' });
      }
      const seeds = expandToUniverseMeshes(universe, seedRoots);
      if (seeds.size === 0) {
        return JSON.stringify({ error: 'Seed path(s) contain no selectable meshes' });
      }
      result = k === 'identical'
        ? computeIdenticalPaths(universe, seeds)
        : computeSameMaterialPaths(universe, seeds);
    }
    sm.selectPaths(result);
    return JSON.stringify({ kind: k, selected: result.length });
  }
}
