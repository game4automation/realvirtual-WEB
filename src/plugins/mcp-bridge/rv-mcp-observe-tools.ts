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
 *   web_render      — offscreen render from an ARBITRARY camera pose with
 *                     mode 'beauty' or 'idmask' (segmentation view: each
 *                     part flat-colored + color→path legend)
 */

import {
  Box3, Color, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3,
  type Object3D, type WebGLRenderer,
} from 'three';
import { WebGLRenderTarget, SRGBColorSpace } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { computeSubtreeAABB, traverseMeshes } from '../../core/engine/rv-traverse-utils';
import { parsePathsParam } from './rv-object-analyzer-math';
import { canvasToRvImage, saveCanvasToWorkfolder } from './rv-frame-capture';
import { buildSceneSnapshot, type SceneNodeSnapshot } from './rv-scene-snapshot';
import { analyzeShapePoints, gatherSubtreePoints } from './rv-shape-descriptor';

const r3 = (n: number): number => +n.toFixed(3);

/** Serialized result cap for web_scene_query (chars). */
export const QUERY_RESULT_CAP = 60_000;
/** Max distinct ID-mask groups — beyond this the smallest merge into 'other'. */
export const IDMASK_GROUP_CAP = 48;

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

// ─── ID-mask coloring ───────────────────────────────────────────────────

/** Golden-angle hue stepping — up to ~48 clearly distinct saturated colors. */
export function idmaskColor(index: number): Color {
  const hue = (index * 137.508) % 360;
  const light = 0.5 + 0.14 * (index % 3); // 3 lightness bands double the pool
  return new Color().setHSL(hue / 360, 0.85, light);
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

  // ═══ web_render ═══════════════════════════════════════════════════════

  @McpTool('Offscreen render from an ARBITRARY camera pose — never touches the user viewport, selection or scene. mode "beauty" renders the live scene; mode "idmask" renders a SEGMENTATION view: part groups flat-colored by identity, with the color→path legend returned as a JSON text block alongside the image (nothing burned into the frame) — one image + legend tells you which object owns which pixels, regardless of node names. groupBy "hierarchy" = subtrees at groupDepth under root (or explicit paths) — the kinematize view; groupBy "geometry" = all copies of an identical part share one color ("12× wheel") — the materialize view. Requires the classic WebGL renderer.', { readOnly: true, timeoutMs: 60_000 })
  async webRender(
    @McpParam('mode', '"beauty" (real materials) or "idmask" (flat ID colors + legend).', 'string', false) mode?: string,
    @McpParam('root', 'Subtree to render (default: whole model).', 'string', false) root?: string,
    @McpParam('groupBy', 'idmask: "hierarchy" (default) or "geometry" (identical parts share a color).', 'string', false) groupBy?: string,
    @McpParam('groupDepth', 'idmask hierarchy: group parts by ancestor at this depth below root (default 1 = direct children).', 'number', false) groupDepth?: number,
    @McpParam('paths', 'idmask hierarchy: explicit group-root paths instead of groupDepth.', 'string', false) paths?: string,
    @McpParam('cameraPosition', 'World camera position "x,y,z" (default: auto ¾ view).', 'string', false) cameraPosition?: string,
    @McpParam('cameraTarget', 'Look-at point "x,y,z" (default: bounds center).', 'string', false) cameraTarget?: string,
    @McpParam('size', 'Long-edge pixels 256..1024 (default 800).', 'number', false) size?: number,
    @McpParam('savePath', 'Optional work-folder-relative path to also write the frame as PNG (e.g. "knowledge/MyAsset/views/overview.png"). Creates directories; ".png" is appended when missing. The result reports savedPath, or saveError when the write failed.', 'string', false) savePath?: string,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No viewer/registry' });
    const renderer = v.renderer as unknown as WebGLRenderer & { isWebGPURenderer?: boolean };
    if (renderer.isWebGPURenderer || typeof renderer.readRenderTargetPixels !== 'function') {
      return JSON.stringify({ error: 'web_render requires the classic WebGL renderer (Settings → Visual → Renderer)' });
    }
    const rootNode = root ? reg.getNode(root) : v.currentModelRoot;
    if (!rootNode) return JSON.stringify({ error: root ? `Node not found: "${root}"` : 'No model loaded' });
    rootNode.updateMatrixWorld(true);

    const renderMode = (mode || 'beauty').toLowerCase() === 'idmask' ? 'idmask' : 'beauty';
    const grouping = (groupBy || 'hierarchy').toLowerCase() === 'geometry' ? 'geometry' : 'hierarchy';

    // ── Resolve idmask groups: label + the meshes that get its color ──
    let groups: Array<{ path: string; meshes: Mesh[]; paths?: string[]; count?: number }> = [];
    if (renderMode === 'idmask') {
      const meshesUnder = (n: Object3D): Mesh[] => {
        const out: Mesh[] = [];
        traverseMeshes(n, (m) => { if (m.geometry) out.push(m); });
        return out;
      };
      if (grouping === 'geometry') {
        // All copies of an identical part (geometry-signature match — the same
        // identity select_similar 'identical' uses) share one color.
        const { geometrySignature, signaturesMatch } = await import('../asset-editor/select-actions');
        const reps: Array<{ sig: ReturnType<typeof geometrySignature>; path: string; meshes: Mesh[]; paths: string[] }> = [];
        traverseMeshes(rootNode, (mesh) => {
          if (!mesh.geometry) return;
          const sig = geometrySignature(mesh.geometry);
          const p = reg.getPathForNode(mesh) ?? mesh.name;
          const g = reps.find((r) => signaturesMatch(r.sig, sig));
          if (g) { g.meshes.push(mesh); g.paths.push(p); }
          else reps.push({ sig, path: p, meshes: [mesh], paths: [p] });
        });
        groups = reps.map((r) => ({ path: r.path, meshes: r.meshes, paths: r.paths, count: r.meshes.length }));
      } else {
        const explicit = parsePathsParam(paths ?? '');
        const roots: Array<{ path: string; node: Object3D }> = [];
        if (explicit.length > 0) {
          for (const p of explicit) {
            const n = reg.getNode(p);
            if (!n) return JSON.stringify({ error: `Node not found: "${p}"` });
            roots.push({ path: p, node: n });
          }
        } else {
          const depth = Math.max(1, Math.min(6, Math.round(groupDepth ?? 1)));
          const collect = (node: Object3D, d: number): void => {
            if (d === depth || node.children.length === 0) {
              const p = reg.getPathForNode(node);
              if (p) roots.push({ path: p, node });
              return;
            }
            for (const c of node.children) collect(c, d + 1);
          };
          for (const c of rootNode.children) collect(c, 1);
          if (roots.length === 0) {
            const p = reg.getPathForNode(rootNode);
            if (p) roots.push({ path: p, node: rootNode });
          }
        }
        groups = roots.map((r) => ({ path: r.path, meshes: meshesUnder(r.node) }));
      }
      // Cap the palette: keep the VISUALLY largest groups (by AABB extent —
      // a 6 m structural beam outranks a triangle-rich bearing), merge the
      // rest into 'other'.
      if (groups.length > IDMASK_GROUP_CAP) {
        const extentOf = (meshes: Mesh[]): number => {
          const box = new Box3();
          const mb = new Box3();
          for (const m of meshes) {
            const geo = m.geometry;
            if (!geo.boundingBox) geo.computeBoundingBox();
            if (geo.boundingBox && !geo.boundingBox.isEmpty()) {
              box.union(mb.copy(geo.boundingBox).applyMatrix4(m.matrixWorld));
            }
          }
          if (box.isEmpty()) return 0;
          const size = box.getSize(new Vector3());
          return Math.max(size.x, size.y, size.z);
        };
        groups = groups
          .map((g) => ({ ...g, ext: extentOf(g.meshes) }))
          .sort((a, b) => b.ext - a.ext);
      }
    }

    // ── Build the private scene ──
    const scene = new Scene();
    const disposables: Array<{ dispose(): void }> = [];
    const legend: Array<{
      color: string; path: string; meshCount: number;
      count?: number; paths?: string[]; morePaths?: number;
    }> = [];
    let renderScene: Scene | Object3D = scene;

    if (renderMode === 'idmask') {
      scene.background = new Color('#101014');
      const otherMat = new MeshBasicMaterial({ color: '#555555' });
      disposables.push(otherMat);
      const addFlat = (mesh: Mesh, mat: MeshBasicMaterial): void => {
        const flat = new Mesh(mesh.geometry, mat);
        flat.matrixAutoUpdate = false;
        flat.matrix.copy(mesh.matrixWorld);
        scene.add(flat);
      };
      const capped = groups.slice(0, IDMASK_GROUP_CAP);
      const overflow = groups.slice(IDMASK_GROUP_CAP);
      capped.forEach((g, i) => {
        const color = idmaskColor(i);
        const mat = new MeshBasicMaterial({ color });
        disposables.push(mat);
        for (const mesh of g.meshes) addFlat(mesh, mat);
        if (g.meshes.length > 0) {
          legend.push({
            color: `#${color.getHexString()}`,
            path: g.path,
            meshCount: g.meshes.length,
            // Geometry grouping: instance count + capped path list per part.
            ...(g.count != null && g.count > 1 ? { count: g.count } : {}),
            ...(g.paths && g.paths.length > 1
              ? { paths: g.paths.slice(0, 8), ...(g.paths.length > 8 ? { morePaths: g.paths.length - 8 } : {}) }
              : {}),
          });
        }
      });
      let otherCount = 0;
      for (const g of overflow) {
        for (const mesh of g.meshes) addFlat(mesh, otherMat);
        otherCount += g.meshes.length;
      }
      if (otherCount > 0) legend.push({ color: '#555555', path: `(other — ${overflow.length} smaller groups)`, meshCount: otherCount });
    } else {
      // Beauty: render the LIVE scene with a private camera (analyzer pattern).
      renderScene = v.scene;
    }

    // ── Camera ──
    const bounds = computeSubtreeAABB(rootNode, new Box3());
    const target = cameraTarget ? parseVec3(cameraTarget) : bounds.center.clone();
    if (!target) return JSON.stringify({ error: 'cameraTarget must be "x,y,z"' });
    let camPos = cameraPosition ? parseVec3(cameraPosition) : null;
    if (cameraPosition && !camPos) return JSON.stringify({ error: 'cameraPosition must be "x,y,z"' });
    const radius = Math.max(bounds.size.length() * 0.5, 0.25);
    if (!camPos) {
      camPos = target.clone().add(new Vector3(1, 0.7, 1).normalize().multiplyScalar(radius * 2.4));
    }
    const camera = new PerspectiveCamera(35, 4 / 3, Math.max(radius / 500, 0.01), radius * 40);
    camera.position.copy(camPos);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);

    // ── Render to a private target, read back, flip into a canvas ──
    const long = Math.max(256, Math.min(1024, Math.round(size ?? 800)));
    const W = long, H = Math.round((long * 3) / 4);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    const rt = new WebGLRenderTarget(W, H, { colorSpace: SRGBColorSpace });
    const prevTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(rt);
      renderer.render(renderScene as Scene, camera);
      const px = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, px);
      renderer.setRenderTarget(prevTarget);

      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return JSON.stringify({ error: 'No 2D context' });
      const img = ctx.createImageData(W, H);
      for (let row = 0; row < H; row++) {
        const src = (H - 1 - row) * W * 4;
        img.data.set(px.subarray(src, src + W * 4), row * W * 4);
      }
      ctx.putImageData(img, 0, 0);

      // Legend + camera/bounds travel as METADATA (the bridge forwards the
      // extra __rvImage fields as a text content block) — the image itself
      // stays pure geometry, nothing burned in.
      const saved = savePath?.trim() ? await saveCanvasToWorkfolder(canvas, savePath) : {};
      return canvasToRvImage(canvas, {
        mode: renderMode,
        ...(renderMode === 'idmask' ? { groupBy: grouping } : {}),
        camera: { position: vec3Arr(camPos), target: vec3Arr(target) },
        boundsM: { x: r3(bounds.size.x), y: r3(bounds.size.y), z: r3(bounds.size.z) },
        ...(renderMode === 'idmask' ? { legend } : {}),
        ...saved,
      });
    } finally {
      renderer.setRenderTarget(prevTarget);
      rt.dispose();
      for (const d of disposables) d.dispose();
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parseVec3(s: string): Vector3 | null {
  const parts = s.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return new Vector3(parts[0], parts[1], parts[2]);
}

const vec3Arr = (v: Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];
