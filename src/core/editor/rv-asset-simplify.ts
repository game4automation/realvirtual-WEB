// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Document adapter for plan-663. Kernel imports stay lazy; the scene is never
 * mutated during preview. Source bindings include ALL contact partners/users.
 */
import { BufferAttribute, BufferGeometry, Mesh } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { AssetDocument } from './rv-asset-document';
import { singleMeshOf } from './rv-asset-executors';
import { unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';
import { objectToGlb } from '../import/rv-import-object';
import { putCadGlb, sha256Hex } from '../import/rv-cad-glb-cache';
import { MeshSimplifyAbortError, RVMeshSimplifyClient } from './rv-mesh-simplify-client';
import type { MeshSimplifyProgress, SimplifyOutcome, SimplifyRequest, SimplifyReport } from './rv-mesh-simplify-client';
import type { EligibilityDescriptor, SimplifyOptions } from './rv-mesh-simplify';

export type SimplifyNodesOptions = Partial<SimplifyOptions>;
export type AssetSimplifyClient = Pick<RVMeshSimplifyClient, 'simplify' | 'cancel' | 'dispose'>;
export interface SimplifyGeometryBinding {
  geometryId: string;
  sourceGeometryUuid: string;
  worldStretchMax: number;
  users: string[];
}
export interface SimplifyPreview {
  documentId: string;
  documentRevision: number;
  options: SimplifyOptions;
  geometries: SimplifyGeometryBinding[];
  coUsers: string[];
  outcome: SimplifyOutcome;
}
export interface SimplifiedNode {
  path: string;
  trianglesBefore: number;
  trianglesAfter: number;
  geometryId: string;
  users: string[];
}
export interface SimplifyNodesResult {
  simplified: SimplifiedNode[];
  kept: (SimplifiedNode & { reason: string })[];
  skipped: { path: string; reason: string }[];
  coUsers: string[];
  report: SimplifyReport;
}
export interface SimplifyNodesHooks {
  onProgress?: (progress: MeshSimplifyProgress) => void;
  preview?: SimplifyPreview;
}
interface Group {
  geometry: BufferGeometry;
  users: { mesh: Mesh; path: string }[];
  selectedPaths: string[];
  binding: SimplifyGeometryBinding;
  skipReason?: string;
}
interface Snapshot {
  stamp: string;
  users: { mesh: Mesh; world: number[] }[];
  groups: Group[];
  request: SimplifyRequest;
  skipped: { path: string; reason: string }[];
  coUsers: string[];
}

function optionsOf(opts: SimplifyNodesOptions): SimplifyOptions {
  const options = { errorMm: opts.errorMm ?? .5, ratio: opts.ratio ?? 0,
    normalWeight: opts.normalWeight ?? 1, lockBorder: opts.lockBorder ?? true };
  if (!Number.isFinite(options.errorMm) || options.errorMm < 0 ||
      !Number.isFinite(options.normalWeight) || options.normalWeight < 0 ||
      !Number.isFinite(options.ratio) || options.ratio < 0 || options.ratio > 1) {
    throw new Error('Invalid mesh simplification options');
  }
  return options;
}

function descriptorOf(mesh: Mesh): { descriptor: EligibilityDescriptor; reason?: string } {
  const g = mesh.geometry;
  const exotic = mesh as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
  const shape = unsupportedMeshShapeReason(mesh);
  const descriptor: EligibilityDescriptor = {
    materialCount: Array.isArray(mesh.material) || g.groups.length ? 2 : 1,
    hasColor: !!g.attributes.color, hasTangent: !!g.attributes.tangent,
    hasUv1: !!g.attributes.uv1 || !!g.attributes.uv2,
    isInstanced: !!exotic.isInstancedMesh, isSkinned: !!exotic.isSkinnedMesh,
    hasMorph: Object.keys(g.morphAttributes).length > 0 || !!g.attributes.skinIndex || !!g.attributes.skinWeight,
    interleaved: Object.values(g.attributes).some(a => 'isInterleavedBufferAttribute' in a),
    nonTriangle: (g.index?.count ?? g.attributes.position?.count ?? 0) % 3 !== 0,
  };
  // Use the shared guard, but translate its separation-specific prose into the
  // kernel's stable skip codes. Unknown attributes must never silently disappear.
  let reason = exotic.isInstancedMesh ? 'instanced' : exotic.isSkinnedMesh ? 'skinned' :
    descriptor.hasMorph ? 'morph' : descriptor.interleaved ? 'interleaved' :
    shape ? 'no-position' : undefined;
  if (!reason && descriptor.materialCount !== 1) reason = 'multi-material';
  if (!reason && descriptor.hasColor) reason = 'vertex-color';
  if (!reason && descriptor.hasTangent) reason = 'tangent';
  if (!reason && descriptor.hasUv1) reason = 'uv1';
  if (!reason && descriptor.nonTriangle) reason = 'non-triangle';
  const unknown = Object.keys(g.attributes).find(k => !['position', 'normal', 'uv'].includes(k));
  if (!reason && unknown) reason = `attribute:${unknown}`;
  if (!reason && (g.drawRange.start !== 0 || g.drawRange.count !== Infinity)) reason = 'draw-range';
  return { descriptor, reason };
}

export class AssetSimplifyController {
  private client?: AssetSimplifyClient;
  private epoch = 0;
  private disposed = false;
  private readonly issued = new WeakMap<SimplifyPreview, Snapshot>();

  constructor(private readonly doc: AssetDocument, private readonly viewer: RVViewer,
    private readonly assertEditable: () => void, client?: AssetSimplifyClient) {
    this.client = client;
  }

  cancel(): void { ++this.epoch; this.client?.cancel(); }
  dispose(): void { this.disposed = true; this.cancel(); this.client?.dispose(); }

  private check(epoch: number): void {
    if (this.disposed || epoch !== this.epoch) throw new MeshSimplifyAbortError();
    this.assertEditable();
  }

  private async project(): Promise<string> {
    const { getProjectStore } = await import('../project/project-store');
    const project = getProjectStore().getProject();
    if (!project) throw new Error('Mesh simplification needs a project');
    return project.id;
  }

  private async preflight(epoch: number): Promise<string> {
    this.check(epoch);
    const id = await this.project();
    // Capability checks alone miss quota/private-mode failures. One tiny reusable
    // cache entry proves that an undo payload can be written BEFORE worker work.
    const bytes = new ArrayBuffer(0);
    if (await putCadGlb(await sha256Hex(bytes), 'simplify-storage-check', bytes, 'browser') === 'none') {
      throw new Error('Mesh simplification needs a project');
    }
    this.check(epoch);
    return id;
  }

  private async collect(paths: string[], options: SimplifyOptions, projectId: string): Promise<Snapshot> {
    const { worldStretchMax } = await import('./rv-mesh-simplify');
    const root = this.viewer.currentModelRoot;
    if (!root) throw new Error('Mesh simplification needs an asset root');
    const registry = this.viewer.registry;
    if (!registry) throw new Error('Mesh simplification needs a node registry');
    root.updateWorldMatrix(true, true);
    const skipped: Snapshot['skipped'] = [];
    const selected = new Map<Mesh, string[]>();
    for (const path of [...new Set(paths)].sort()) {
      const node = registry.getNode(path);
      const mesh = node ? singleMeshOf(node) : null;
      if (!mesh) { skipped.push({ path, reason: node ? 'not-single-mesh' : 'not-found' }); continue; }
      const list = selected.get(mesh) ?? [];
      list.push(path);
      selected.set(mesh, list);
    }
    const groups = new Map<BufferGeometry, Group>();
    const matrices: unknown[] = [];
    root.traverse((node: Object3D) => {
      if (!(node as Mesh).isMesh) return;
      const mesh = node as Mesh;
      const path = registry.getPathForNode(mesh);
      if (!path) throw new Error('Mesh simplification needs registered geometry users');
      const g = mesh.geometry;
      let group = groups.get(g);
      if (!group) {
        group = { geometry: g, users: [], selectedPaths: [], binding: {
          geometryId: g.uuid, sourceGeometryUuid: g.uuid, worldStretchMax: 0, users: [],
        } };
        groups.set(g, group);
      }
      group.users.push({ mesh, path });
      group.binding.users.push(path);
      group.selectedPaths.push(...(selected.get(mesh) ?? []));
      group.binding.worldStretchMax = Math.max(group.binding.worldStretchMax, worldStretchMax(mesh.matrixWorld.elements));
      group.skipReason ??= descriptorOf(mesh).reason;
      if (!Number.isFinite(mesh.matrixWorld.determinant()) || mesh.matrixWorld.determinant() === 0) group.skipReason = 'singular-transform';
      matrices.push([path, mesh.uuid, g.uuid, mesh.matrixWorld.elements.slice(), descriptorOf(mesh),
        Object.entries(g.attributes).map(([name, a]) => [name, a.count, 'version' in a ? a.version : a.data.version]),
        g.index?.version, g.index?.count, g.drawRange, g.groups]);
    });
    const all = [...groups.values()];
    const targets = all.filter(g => g.selectedPaths.length);
    const coUsers = targets.flatMap(g => g.users.filter(u => !selected.has(u.mesh)).map(u => u.path)).sort();
    const request: SimplifyRequest = {
      options, targetGeometryIds: targets.map(g => g.geometry.uuid), instances: [], geometries: [],
    };
    for (const group of all) {
      const geometry = group.geometry;
      const position = geometry.getAttribute('position');
      const copy = (name: string, size: number) => {
        const a = geometry.getAttribute(name);
        if (!a) return undefined;
        const out = new Float32Array(a.count * size);
        for (let v = 0; v < a.count; v++) for (let c = 0; c < size; c++) out[v * size + c] = a.getComponent(v, c);
        return out;
      };
      request.geometries.push({
        id: geometry.uuid, descriptor: descriptorOf(group.users[0].mesh).descriptor, skipReason: group.skipReason,
        input: { positions: copy('position', 3) ?? new Float32Array(), normals: copy('normal', 3), uvs: copy('uv', 2),
          index: !position ? new Uint32Array() : geometry.index ? Uint32Array.from(geometry.index.array) :
            Uint32Array.from({ length: position.count }, (_, i) => i),
          worldStretchMax: group.binding.worldStretchMax || 1 },
      });
      if (group.skipReason !== 'singular-transform') for (const user of group.users) {
        request.instances.push({ geometryId: geometry.uuid, world: user.mesh.matrixWorld.elements.slice() });
      }
    }
    const stamp = JSON.stringify([this.doc.id, this.doc.revision, projectId, [...new Set(paths)].sort(), options, matrices]);
    return { stamp, groups: targets, request, skipped, coUsers,
      users: all.flatMap(g => g.users.map(u => ({ mesh: u.mesh, world: u.mesh.matrixWorld.elements.slice() }))) };
  }

  private async compute(paths: string[], options: SimplifyOptions, projectId: string, epoch: number,
    onProgress?: SimplifyNodesHooks['onProgress']): Promise<SimplifyPreview> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.collect(paths, options, projectId);
      this.check(epoch);
      this.client ??= new RVMeshSimplifyClient();
      const outcome = await this.client.simplify(snapshot.request, onProgress);
      this.check(epoch);
      if (await this.project() !== projectId) throw new MeshSimplifyAbortError('The project changed during mesh simplification');
      const current = await this.collect(paths, options, projectId);
      this.check(epoch);
      if (snapshot.stamp !== current.stamp) continue;
      const preview: SimplifyPreview = {
        documentId: this.doc.id, documentRevision: this.doc.revision, options,
        geometries: snapshot.groups.map(g => ({ ...g.binding, users: [...g.binding.users] })),
        coUsers: snapshot.coUsers.slice(), outcome,
      };
      this.issued.set(preview, snapshot);
      return preview;
    }
    throw new MeshSimplifyAbortError('The document kept changing during mesh simplification');
  }

  async preview(paths: string[], opts: SimplifyNodesOptions = {}): Promise<SimplifyPreview> {
    this.cancel();
    const epoch = this.epoch;
    const project = await this.preflight(epoch);
    return this.compute(paths, optionsOf(opts), project, epoch);
  }

  async apply(paths: string[], opts: SimplifyNodesOptions = {}, hooks: SimplifyNodesHooks = {}): Promise<SimplifyNodesResult> {
    this.cancel();
    const epoch = this.epoch;
    const project = await this.preflight(epoch);
    const options = optionsOf(opts);
    let preview = hooks.preview;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.collect(paths, options, project);
      if (!preview || this.issued.get(preview)?.stamp !== current.stamp) {
        preview = await this.compute(paths, options, project, epoch, hooks.onProgress);
      }
      const snapshot = this.issued.get(preview)!;
      const prepared: { group: Group; bytes: ArrayBuffer; quality: string }[] = [];
      for (const group of snapshot.groups) {
        const result = preview.outcome.results.get(group.geometry.uuid)!;
        if (result.status !== 'simplified') continue;
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(result.mesh.positions, 3));
        if (result.mesh.normals) geometry.setAttribute('normal', new BufferAttribute(result.mesh.normals, 3));
        if (result.mesh.uvs) geometry.setAttribute('uv', new BufferAttribute(result.mesh.uvs, 2));
        geometry.setIndex(new BufferAttribute(result.mesh.index, 1));
        const mesh = new Mesh(geometry);
        try {
          const basis = (this.doc.executor.geometryKeyOf(group.geometry)?.quality ?? 'source').split('|simplify:')[0];
          const quality = `${basis}|simplify:v1:e=${options.errorMm}:r=${options.ratio}:nw=${options.normalWeight}:lb=${options.lockBorder ? 1 : 0}`;
          prepared.push({ group, bytes: await objectToGlb(mesh), quality });
        } finally { geometry.dispose(); (mesh.material as { dispose(): void }).dispose(); }
      }
      this.check(epoch);
      if (await this.project() !== project) throw new MeshSimplifyAbortError('The project changed during mesh simplification');
      if ((await this.collect(paths, options, project)).stamp !== snapshot.stamp) { preview = undefined; continue; }
      if (prepared.length) await this.doc.withTransaction('Simplify', async () => {
        for (const item of prepared) {
          this.check(epoch);
          const revision = this.doc.revision;
          const [first, ...others] = item.group.users;
          await this.doc.replaceNodeGeometry(first.path, item.bytes, 'browser', {
            quality: item.quality, sharedNodePaths: others.map(u => u.path),
            validate: () => {
              this.check(epoch);
              if (this.doc.revision !== revision) throw new MeshSimplifyAbortError('History changed before Apply');
              this.viewer.currentModelRoot?.updateWorldMatrix(true, true);
              for (const user of snapshot.users) {
                if (user.world.some((v, i) => v !== user.mesh.matrixWorld.elements[i])) {
                  throw new MeshSimplifyAbortError('A transform changed before Apply');
                }
              }
              for (const user of item.group.users) {
                if (user.mesh.geometry !== item.group.geometry) throw new MeshSimplifyAbortError('Source geometry changed before Apply');
              }
            },
          });
        }
        this.check(epoch); // Cancellation during persistence rolls back the entire transaction.
      });
      return this.result(preview, snapshot);
    }
    throw new MeshSimplifyAbortError('The document kept changing before Apply');
  }

  private result(preview: SimplifyPreview, snapshot: Snapshot): SimplifyNodesResult {
    const out: SimplifyNodesResult = { simplified: [], kept: [], skipped: [...snapshot.skipped],
      coUsers: snapshot.coUsers.slice(), report: preview.outcome.report };
    for (const group of snapshot.groups) {
      const result = preview.outcome.results.get(group.geometry.uuid)!;
      const before = snapshot.request.geometries.find(g => g.id === group.geometry.uuid)!.input.index.length / 3;
      const entry: SimplifiedNode = { path: group.selectedPaths[0], geometryId: group.geometry.uuid,
        users: group.binding.users.slice(), trianglesBefore: before, trianglesAfter: result.mesh.index.length / 3 };
      if (result.status === 'simplified') out.simplified.push(entry);
      else if (result.status === 'kept') out.kept.push({ ...entry, reason: result.reason });
      else for (const path of group.selectedPaths) out.skipped.push({ path, reason: result.reason });
    }
    return out;
  }
}
