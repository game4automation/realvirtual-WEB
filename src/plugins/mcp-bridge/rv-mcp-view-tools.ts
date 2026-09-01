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
 * The real viewport camera is driven (animated moves) so a watching user sees
 * exactly what the agent does.
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { parsePathsParam } from './rv-object-analyzer-math';
import {
  captureFrameCanvas, canvasToRvImage, saveCanvasToProject, compositeMontage,
} from './rv-frame-capture';
import { computeFlyPose, type CameraPose } from './rv-camera-fly-math';
import {
  sweepPoses, sampleGrid, summarizeViewHits,
  DEFAULT_SWEEP_COUNT, DEFAULT_SWEEP_PITCH_DEG, DEFAULT_TOP_N, type ViewNote,
} from './rv-view-sweep-math';
import { findPickOwner } from '../../core/engine/rv-pick-owner';
import { projectLabelAnchors, drawAnnotations, type LabelTarget } from './rv-annotate';
import {
  computeIdenticalPaths,
  computeSameMaterialPaths,
  computeInvertPaths,
  expandToUniverseMeshes,
} from '@rv-private/plugins/asset-editor/select-actions';

const r3 = (n: number): number => +n.toFixed(3);
const vec3 = (v: Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];
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

// ── web_view_sweep defaults (plan-705 D-A10) ────────────────────────────
/** Rays per axis for the visibility notes — 7×7 = 49 samples per view. */
const SWEEP_GRID_N = 7;
/** Long edge of each captured cell; compositeMontage caps cells at 640 px anyway. */
const SWEEP_CELL_PX = 640;
const SWEEP_MOVE_MS = 600;
const SWEEP_SETTLE_MS = 120;

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
  @McpTool('Measure nodes: world AABB (center/size/min/max, meters), node-local box + world quaternion (oriented bounds), mesh count. Also SELECTS and frames the nodes (viewport highlight + camera focus, like a user click + F) unless focus=false. THE numeric grounding for pivot placement, axis positions and part sizes. Paths from web_node_find / web_node_tree.', { readOnly: false })
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
      const node = reg.getNode(p);
      if (!node) { unresolved.push(p); continue; }
      resolvedPaths.push(p);
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
      });
    }
    let selected = 0;
    let framed = false;
    if (focus !== false && resolvedNodes.length > 0) {
      if (v.selectionManager) {
        v.selectionManager.selectPaths(resolvedPaths);
        selected = resolvedPaths.length;
      }
      if (!unionBox.isEmpty()) {
        v.fitToNodes(resolvedNodes, undefined, { easing: 'easeInOut', duration: 0.6 });
      } else {
        // Mesh-less pivots: fitToNodes bails on an empty AABB, so aim at the
        // pivot position directly, keeping the current view direction.
        const pivot = new Vector3();
        for (const n of resolvedNodes) pivot.add(n.getWorldPosition(new Vector3()));
        pivot.divideScalar(resolvedNodes.length);
        const state = v.getCameraState();
        const dir = state.position.clone().sub(state.target).normalize();
        v.animateCameraTo(pivot.clone().add(dir.multiplyScalar(0.8)), pivot, 0.6, 'easeInOut');
      }
      framed = true;
      await sleep(700);
    }
    return JSON.stringify({
      nodes: out,
      ...(selected ? { selected } : {}),
      ...(framed ? { framed } : {}),
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Pick what is at a screen position: returns the hit node path, 3D world point, surface normal and distance. In editor mode, path is the EXACT mesh node you see; ownerPath/ownerComponents name the nearest component-bearing ancestor (e.g. the owning Drive) — use web_select(ownerPath) to select that instead. The hit node is also SELECTED (viewport highlight + panels, like a user click) unless select=false. x/y are fractions 0..1 of the canvas (0,0 = top-left). Use to identify parts and get exact 3D coordinates for pivots/axes.', { readOnly: false })
  async webViewPick(
    @McpParam('x', 'Horizontal position, fraction 0..1 of canvas width.', 'number') x: number,
    @McpParam('y', 'Vertical position, fraction 0..1 of canvas height.', 'number') y: number,
    @McpParam('select', 'Also select the hit node (default true).', 'boolean', false) select?: boolean,
  ): Promise<string> {
    return this._pickAt(x, y, select !== false);
  }

  @McpTool('Pick what is at the CENTER of the current view (the gaze point): hit node path, 3D world point, surface normal, distance. Also selects the hit node unless select=false. Equivalent to web_view_pick at (0.5, 0.5).', { readOnly: false })
  async webViewGaze(
    @McpParam('select', 'Also select the hit node (default true).', 'boolean', false) select?: boolean,
  ): Promise<string> {
    return this._pickAt(0.5, 0.5, select !== false);
  }

  private _pickAt(x: number, y: number, select = true): string {
    const v = this.viewer;
    const rm = v?.raycastManager;
    if (!v || !rm) return JSON.stringify({ error: 'No raycast manager' });
    const rect = v.renderer.domElement.getBoundingClientRect();
    const fx = Math.min(Math.max(Number(x), 0), 1);
    const fy = Math.min(Math.max(Number(y), 0), 1);
    const hit = rm.raycastForRVNodeDetailed({
      clientX: rect.left + fx * rect.width,
      clientY: rect.top + fy * rect.height,
    });
    if (!hit) return JSON.stringify({ hit: false });
    const cam = v.camera.position;
    const p = hit.hitPoint;
    const dist = Math.hypot(p[0] - cam.x, p[1] - cam.y, p[2] - cam.z);
    let selected = false;
    const hitNode = hit.path ? v.registry?.getNode(hit.path) : undefined;
    if (select && hit.path && v.selectionManager && hitNode) {
      v.selectionManager.selectPaths([hit.path]);
      selected = true;
    }
    // Owning component node (self included) — with exact-node editor picks,
    // this is how an agent learns which Drive/component a sub-mesh belongs to.
    const owner = hitNode && v.registry ? findPickOwner(hitNode, v.registry) : null;
    return JSON.stringify({
      hit: true,
      path: hit.path,
      point: p.map(r3),
      normal: hit.hitNormal.map(r3),
      distance: r3(dist),
      selected,
      ...(owner ? { ownerPath: owner.path, ownerComponents: owner.components } : {}),
    });
  }

  @McpTool('Isolate nodes visually: only the given subtrees stay bright and interactive, everything else is dimmed; the camera frames the isolated set. Call with empty paths to EXIT isolation. Use before screenshots of buried parts.', { readOnly: false })
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
    v.isolateNodes(nodes);
    return JSON.stringify({
      isolated: nodes.length, active: true,
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Screenshot with LABELS: captures the current view and pins a labelled marker on each given node (at its bounds center). Optionally crop to one node via cropPath. labels = optional comma-separated custom labels (defaults to each path\'s last segment; pass numbers=true for #1..#n). Ideal for confirming which part is which before kinematizing.', { readOnly: true })
  async webScreenshotAnnotated(
    @McpParam('paths', 'Node paths to label, comma- or newline-separated.') paths: string,
    @McpParam('labels', 'Optional labels, comma-separated, same order as paths.', 'string', false) labels: string,
    @McpParam('cropPath', 'Optional node path to crop the shot to.', 'string', false) cropPath: string,
    @McpParam('numbers', 'Label markers #1..#n instead of names.', 'boolean', false) numbers: boolean,
    @McpParam('savePath', 'Optional PROJECT-relative path to also write the shot as PNG. A bare name lands in "captures/"; a path that names its own folders is taken as given (e.g. "knowledge/MyAsset/views/axis-z.png"). ".png" is appended when missing. Requires an open writable project. The result reports savedPath, or saveError when the write failed.', 'string', false) savePath?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const requested = parsePathsParam(paths);
    if (requested.length === 0) return JSON.stringify({ error: 'No node paths given' });
    const customLabels = (labels ?? '').split(',').map(s => s.trim()).filter(Boolean);

    const targets: LabelTarget[] = [];
    const unresolved: string[] = [];
    for (let i = 0; i < requested.length; i++) {
      const p = requested[i];
      const node = v.registry?.getNode(p);
      if (!node) { unresolved.push(p); continue; }
      node.updateMatrixWorld(true);
      const { center, box } = computeSubtreeAABB(node, new Box3());
      const label = numbers
        ? `#${targets.length + 1}`
        : customLabels[i] ?? p.split('/').filter(Boolean).pop() ?? p;
      targets.push({ point: box.isEmpty() ? node.getWorldPosition(new Vector3()) : center, label });
    }
    if (targets.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ')}` });
    }

    const r = captureFrameCanvas(v, { path: cropPath || undefined });
    if ('error' in r) return JSON.stringify({ error: r.error });
    const src = v.renderer.domElement;
    const anchors = projectLabelAnchors(
      v.camera, src.width, src.height, r.crop, r.canvas.width, r.canvas.height, targets,
    );
    const ctx = r.canvas.getContext('2d');
    if (!ctx) return JSON.stringify({ error: 'No 2D context' });
    drawAnnotations(ctx, anchors);
    const saved = savePath?.trim() ? await saveCanvasToProject(r.canvas, savePath) : {};
    return canvasToRvImage(r.canvas, {
      labels: anchors.map(a => ({ label: a.label, behindCamera: a.behind, offCrop: a.clamped })),
      ...(unresolved.length ? { unresolved } : {}),
      ...saved,
    });
  }

  // ═══ Camera ═══════════════════════════════════════════════════════════

  @McpTool('Get the current camera state: position, orbit target and the canvas size.', { readOnly: true })
  async webCameraGet(): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const state = v.getCameraState();
    const el = v.renderer.domElement;
    return JSON.stringify({
      position: vec3(state.position),
      target: vec3(state.target),
      projection: v.projection,
      canvas: { width: el.clientWidth, height: el.clientHeight },
    });
  }

  @McpTool('Switch the camera between perspective and orthographic (iso) rendering with a smooth animated transition — same as the view-cube Persp/Iso toggle. mode = perspective | orthographic (aliases: persp, ortho, iso); omit to toggle.', { readOnly: false })
  async webCameraProjection(
    @McpParam('mode', 'perspective | orthographic | iso (omit = toggle).', 'string', false) mode: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const raw = (mode ?? '').trim().toLowerCase();
    let next: 'perspective' | 'orthographic';
    if (raw === '' || raw === 'toggle') {
      next = v.projection === 'perspective' ? 'orthographic' : 'perspective';
    } else if (raw === 'perspective' || raw === 'persp' || raw === 'p') {
      next = 'perspective';
    } else if (raw === 'orthographic' || raw === 'ortho' || raw === 'iso' || raw === 'o') {
      next = 'orthographic';
    } else {
      return JSON.stringify({ error: `Unknown mode '${mode}' — use perspective | orthographic | iso, or omit to toggle` });
    }
    if (next === v.projection && !v.isProjectionAnimating) {
      return JSON.stringify({ projection: v.projection, changed: false });
    }
    v.animateProjectionTo(next, 0.45);
    await sleep(500);
    return JSON.stringify({ projection: next, changed: true });
  }

  @McpTool('Move the camera (animated) to an explicit position looking at a target. Coordinates in meters, world space. The visible viewport camera moves — a watching user sees the same view.', { readOnly: false })
  async webCameraSet(
    @McpParam('px', 'Camera position X (m).', 'number') px: number,
    @McpParam('py', 'Camera position Y (m).', 'number') py: number,
    @McpParam('pz', 'Camera position Z (m).', 'number') pz: number,
    @McpParam('tx', 'Look-at target X (m).', 'number') tx: number,
    @McpParam('ty', 'Look-at target Y (m).', 'number') ty: number,
    @McpParam('tz', 'Look-at target Z (m).', 'number') tz: number,
    @McpParam('durationMs', 'Animation duration in ms (default 600).', 'number', false) durationMs: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const dur = typeof durationMs === 'number' && !Number.isNaN(durationMs)
      ? Math.max(0, durationMs) / 1000 : 0.8;
    v.animateCameraTo(new Vector3(px, py, pz), new Vector3(tx, ty, tz), dur, 'easeInOut');
    await sleep(dur * 1000 + 50);
    return this.webCameraGet();
  }

  @McpTool('Frame one or more nodes: animates the camera so they fill the view (keeps the current view direction). THE standard way to look at a part before a screenshot.', { readOnly: false })
  async webCameraFocus(
    @McpParam('paths', 'Node paths, comma- or newline-separated.') paths: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
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
    v.fitToNodes(nodes, undefined, { easing: 'easeInOut', duration: 0.8 });
    await sleep(900);
    return JSON.stringify({
      framed: nodes.length,
      camera: JSON.parse(await this.webCameraGet()),
      ...(unresolved.length ? { unresolved } : {}),
    });
  }

  @McpTool('Orbit the camera around a point: yaw (horizontal, degrees, + = counter-clockwise from above), pitch (vertical, degrees, + = up), and an optional distance factor (0.5 = half distance / zoom in, 2 = zoom out). Relative move — ideal for "look at it from the other side". pivot chooses the point: omit for the current orbit target (unchanged behaviour), "selection" for the centre of what is selected, or a node path. Refused while FPV, camera-follow or XR own the camera.', { readOnly: false })
  async webCameraOrbit(
    @McpParam('yawDeg', 'Horizontal orbit angle in degrees.', 'number') yawDeg: number,
    @McpParam('pitchDeg', 'Vertical orbit angle in degrees (default 0).', 'number', false) pitchDeg: number,
    @McpParam('distanceFactor', 'Multiply camera distance (default 1).', 'number', false) distanceFactor: number,
    @McpParam('pivot', 'Orbit centre: "selection", a node path, or omit for the current target.', 'string', false) pivot?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    // D-A2 (plan-705): the three owners write the pose every frame, so an orbit
    // under them is a silent no-op. Newly applied here — `web_camera_fly` had
    // the guard and this one did not, which is the inconsistency F9 closes.
    const blockedBy = this._cameraOwner(v);
    if (blockedBy) {
      return JSON.stringify({ error: `Camera is owned by ${blockedBy} — stop it before orbiting`, blockedBy });
    }
    const state = v.getCameraState();
    // Default is verbatim the old behaviour: the CURRENT target. `pivot` only
    // ever replaces it, so an existing caller sees no change at all.
    const pivotPoint = this._resolvePivot(v, pivot);
    if (pivotPoint && 'error' in pivotPoint) return JSON.stringify(pivotPoint);
    const target = pivotPoint?.point.clone() ?? state.target.clone();
    const offset = state.position.clone().sub(target);
    const radius = offset.length() * (typeof distanceFactor === 'number' && distanceFactor > 0 ? distanceFactor : 1);
    // Spherical angles: theta = azimuth around +Y, phi = polar from +Y.
    let theta = Math.atan2(offset.x, offset.z) + (yawDeg || 0) * Math.PI / 180;
    let phi = Math.acos(Math.min(Math.max(offset.y / offset.length(), -1), 1))
      - (pitchDeg || 0) * Math.PI / 180;
    phi = Math.min(Math.max(phi, 0.05), Math.PI - 0.05);
    const pos = new Vector3(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    v.animateCameraTo(pos, target, 0.7, 'easeInOut');
    await sleep(750);
    return this.webCameraGet();
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

  @McpTool('Move the camera to a NAMED view: iso | top | front | back | left | right | home (home = iso). target chooses what to frame — "selection", a node path, or omit for the whole scene. The framing distance is MEASURED from the viewer\'s own fit, so a preset frames exactly as tightly as web_camera_focus does. Refused while FPV, camera-follow or XR own the camera.', { readOnly: false, timeoutMs: 30_000 })
  async webCameraView(
    @McpParam('preset', 'iso | top | front | back | left | right | home') preset: string,
    @McpParam('target', '"selection", a node path, or omit for the whole scene.', 'string', false) target?: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const blockedBy = this._cameraOwner(v);
    if (blockedBy) {
      return JSON.stringify({
        error: `Camera is owned by ${blockedBy} — stop it before changing the view`,
        blockedBy,
      });
    }
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
    // D-A5 — measure, never re-derive. One `fitToNodes` in the viewer's own
    // projection and aspect, read back with `getCameraState`; the preset then
    // keeps that distance and swaps only the direction. A second fit formula
    // here would drift from the viewer's the first time either changed.
    if (nodes.length > 0) {
      try {
        v.fitToNodes(nodes, undefined, { duration: 0, easing: 'easeInOut' });
        const measured = v.getCameraState();
        pose = applyMeasuredDistance(pose, {
          position: measured.position.clone(), target: measured.target.clone(),
        });
      } catch { /* keep the bounding-sphere fallback */ }
    }

    v.animateCameraTo(pose.position, pose.target, 0.7, 'easeInOut');
    await sleep(750);
    return JSON.stringify({
      preset: wanted,
      framed: nodes.length,
      distance: +pose.distance.toFixed(3),
      camera: JSON.parse(await this.webCameraGet()),
    });
  }

  /**
   * Which subsystem owns the camera right now, or null if it is free.
   *
   * FPV, follow/sit-on and XR each write the camera pose every frame, so a
   * scripted move would be silently overwritten in the next tick. A hard error
   * beats a silent no-op (plan-705 D-A2).
   */
  private _cameraOwner(v: RVViewer): 'fpv' | 'follow' | 'xr' | null {
    if (v.getPlugin<{ id: string; isActive?: boolean }>('fpv')?.isActive) return 'fpv';
    if (v.cameraFollowMode && v.cameraFollowMode !== 'off') return 'follow';
    if ((v.getPlugin('webxr') as { isPresenting?: boolean } | undefined)?.isPresenting) return 'xr';
    return null;
  }

  @McpTool('Fly the camera RELATIVE to where it is now: forward/right/up in metres plus yawDeg/pitchDeg in degrees (+yaw = to the left, +pitch = up, clamped at ±85°). Unlike web_camera_orbit — which circles a fixed point — this MOVES THROUGH the plant, which is what a long line needs. ground=true walks instead of flying: forward/right stay horizontal and the camera is held at eyeHeight above the nearest surface below (no wall collision — flying through a wall is allowed). Refused while FPV, camera-follow or XR own the camera.', { readOnly: false, timeoutMs: 30_000 })
  async webCameraFly(
    @McpParam('forward', 'Metres along the view direction (default 0).', 'number', false) forward?: number,
    @McpParam('right', 'Metres to the right (default 0).', 'number', false) right?: number,
    @McpParam('up', 'Metres along world +Y (default 0).', 'number', false) up?: number,
    @McpParam('yawDeg', 'Turn in degrees, + = to the left (default 0).', 'number', false) yawDeg?: number,
    @McpParam('pitchDeg', 'Tilt in degrees, + = up, clamped at ±85° (default 0).', 'number', false) pitchDeg?: number,
    @McpParam('ground', 'Walk instead of fly: horizontal moves, eye height above the surface below (default false).', 'boolean', false) ground?: boolean,
    @McpParam('durationMs', 'Animation duration in ms (default 600).', 'number', false) durationMs?: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const blockedBy = this._cameraOwner(v);
    if (blockedBy) {
      return JSON.stringify({
        error: `Camera is owned by ${blockedBy} — stop it before flying`,
        blockedBy,
      });
    }

    const cur = v.getCameraState();
    const next = computeFlyPose(
      { position: cur.position.clone(), target: cur.target.clone() },
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

    const dur = typeof durationMs === 'number' && Number.isFinite(durationMs)
      ? Math.max(0, durationMs) / 1000 : 0.6;
    v.animateCameraTo(next.position, next.target, dur, 'easeInOut');
    await sleep(dur * 1000 + 100);

    const state = JSON.parse(await this.webCameraGet()) as Record<string, unknown>;
    return JSON.stringify({
      ...state,
      deltaM: { forward: num0(forward), right: num0(right), up: num0(up) },
      yawDeg: num0(yawDeg),
      pitchDeg: num0(pitchDeg),
      ground: ground === true,
      groundHit,
      ...(groundY !== undefined ? { groundY: r3(groundY) } : {}),
    });
  }

  @McpTool('Contact sheet of a part: flies 4-8 views evenly around it and returns ONE labelled montage plus a note per view (visible top nodes with coverage, background share, measured camera position). Understands an unknown assembly in a SINGLE call instead of an orbit+screenshot loop, at roughly a fifth of the vision tokens. Each note carries its cameraPosition, so pulling one view up in full resolution is one web_camera_set away. topNodes is a raycast SAMPLE, not a completeness guarantee — thin parts can be missed. Works under WebGPU too. Restores the starting pose unless restore=false.', { readOnly: false, timeoutMs: 120_000 })
  async webViewSweep(
    @McpParam('paths', 'Node paths to sweep around, comma/newline-separated. Empty = whole model.', 'string', false) paths?: string,
    @McpParam('count', 'Number of views, clamped to 4..8 (default 6).', 'number', false) count?: number,
    @McpParam('pitchDeg', 'Elevation of every view in degrees (default 20).', 'number', false) pitchDeg?: number,
    @McpParam('yawStartDeg', 'Yaw of the first view (default: current camera azimuth).', 'number', false) yawStartDeg?: number,
    @McpParam('restore', 'Return to the starting pose afterwards (default true).', 'boolean', false) restore?: boolean,
    @McpParam('savePath', 'Optional PROJECT-relative path to also write the montage as PNG (bare name lands in "captures/").', 'string', false) savePath?: string,
    @McpParam('topN', 'Nodes reported per view, max 10 (default 5).', 'number', false) topN?: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const blockedBy = this._cameraOwner(v);
    if (blockedBy) {
      return JSON.stringify({
        error: `Camera is owned by ${blockedBy} — stop it before sweeping`,
        blockedBy,
      });
    }

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

    const startState = v.getCameraState();
    const start: CameraPose = {
      position: startState.position.clone(),
      target: startState.target.clone(),
    };
    // Freeze the orbit controls for the duration: a watching human could
    // otherwise orbit mid-flight and overwrite the target trajectory, leaving
    // the cell showing a different pose than the note reports (D-A14 / R12).
    // Deliberately NOT setSharedViewMode(), which also disables the raycast
    // manager — exactly the capability the per-view notes need.
    const controls = v.controls as { enabled?: boolean } | undefined;
    const controlsWasEnabled = controls?.enabled;
    if (controls) controls.enabled = false;

    try {
      v.fitToNodes(nodes, undefined, { easing: 'easeInOut', duration: 0.8 });
      await sleep(900);
      // Radius by RE-MEASURING the canonical fit rather than a second fit
      // formula — CameraManager.fitDistanceBothAxes must stay the only copy (D-A5).
      const framed = v.getCameraState();
      const center = framed.target.clone();
      const radius = framed.position.distanceTo(framed.target) || 1;

      const startYaw = typeof yawStartDeg === 'number' && Number.isFinite(yawStartDeg)
        ? yawStartDeg
        : Math.atan2(
          framed.position.x - center.x, framed.position.z - center.z,
        ) * 180 / Math.PI;

      const poses = sweepPoses(center, radius, {
        count: typeof count === 'number' ? count : DEFAULT_SWEEP_COUNT,
        pitchDeg: typeof pitchDeg === 'number' ? pitchDeg : DEFAULT_SWEEP_PITCH_DEG,
        yawStartDeg: startYaw,
      });

      const grid = sampleGrid(SWEEP_GRID_N);
      const tol = Math.max(0.01 * radius, 1e-3);
      const frames: HTMLCanvasElement[] = [];
      const notes: ViewNote[] = [];

      for (const pose of poses) {
        v.animateCameraTo(pose.position, pose.target, SWEEP_MOVE_MS / 1000, 'easeInOut');
        await sleep(SWEEP_MOVE_MS + SWEEP_SETTLE_MS);

        // Capture BEFORE raycasting: captureFrameCanvas renders synchronously,
        // so the rays provably see the pose that is in the frame (§2.4).
        const shot = captureFrameCanvas(v, { maxDim: SWEEP_CELL_PX });
        if ('error' in shot) return JSON.stringify({ error: shot.error, view: pose.index });
        frames.push(shot.canvas);

        const rm = v.raycastManager;
        const rect = v.renderer.domElement.getBoundingClientRect();
        const hits: Array<string | null> = [];
        for (const [gx, gy] of grid) {
          const hit = rm?.raycastForRVNodeDetailed({
            clientX: rect.left + gx * rect.width,
            clientY: rect.top + gy * rect.height,
          });
          hits.push(hit?.path ?? null);
        }
        const measured = v.getCameraState().position.clone();
        notes.push(summarizeViewHits(
          pose, hits, typeof topN === 'number' ? topN : DEFAULT_TOP_N, measured, tol,
        ));
      }

      const mont = compositeMontage(frames, poses.map((p) => p.label));
      if ('error' in mont) return JSON.stringify({ error: mont.error });
      const saved = savePath?.trim() ? await saveCanvasToProject(mont, savePath) : {};
      return canvasToRvImage(mont, {
        views: notes,
        center: vec3(center),
        radius: r3(radius),
        restored: restore !== false,
        ...(unresolved.length ? { unresolved } : {}),
        ...saved,
      });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      // Both restorations live here so they also run on the error path (R11).
      if (controls && controlsWasEnabled !== undefined) controls.enabled = controlsWasEnabled;
      if (restore !== false) {
        v.animateCameraTo(start.position, start.target, SWEEP_MOVE_MS / 1000, 'easeInOut');
        await sleep(SWEEP_MOVE_MS + 100);
      }
    }
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

  @McpTool('Get the current selection: node paths and the primary path.', { readOnly: true })
  async webSelectionGet(): Promise<string> {
    const sm = this.viewer?.selectionManager;
    if (!sm) return JSON.stringify({ error: 'No selection manager' });
    const snap = sm.getSnapshot();
    return JSON.stringify({ paths: snap.selectedPaths, primary: snap.primaryPath });
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
