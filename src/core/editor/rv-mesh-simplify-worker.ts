// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Worker entry and reusable handler. No client or worker factory is imported here. */
import { classifyPreparedGeometry, detectContacts, eligibility, planContactTasks, prepareGeometry, simplifyGeometry, simplifyPreparedGeometry } from './rv-mesh-simplify';
import type {
  ContactProbe, ContactResult, EligibilityDescriptor, GeometryClass, GeometryResult,
  Matrix, SimplifyInput, SimplifyOptions, PreparedGeometry,
} from './rv-mesh-simplify';

export interface MeshSimplifyGeometry {
  id: string;
  input: SimplifyInput;
  descriptor: EligibilityDescriptor;
  /** Adapter-level exclusions (e.g. an unknown attribute or partial draw range). */
  skipReason?: string;
}

export interface MeshSimplifyInstance {
  geometryId: string;
  world: Float32Array | number[];
}

/** Geometry arrays are loaded once; subsequent contact messages contain only ids/matrices. */
export interface MeshSimplifyContactTask {
  p: { geometryId: string; world: Matrix };
  q: { geometryId: string; world: Matrix };
  relTransform: Matrix;
  stretchQ: number;
  worldSpace: boolean;
}

export interface MeshSimplifyCommands {
  load: { geometries: MeshSimplifyGeometry[] };
  classify: { geometryId: string; errorMm: number };
  plan: { instances: MeshSimplifyInstance[]; activeIds: string[] };
  contact: { task: MeshSimplifyContactTask };
  simplify: { geometryId: string; options: SimplifyOptions; locks: Uint8Array; probes: ContactProbe[] };
}

export interface MeshSimplifyReplies {
  load: null;
  classify: { classification: GeometryClass | null; skipReason: string | null };
  plan: MeshSimplifyContactTask[];
  contact: ContactResult;
  simplify: GeometryResult;
}

export type MeshSimplifyCommand = keyof MeshSimplifyCommands;
export type MeshSimplifyWorkerRequest = {
  [K in MeshSimplifyCommand]: {
    epoch: number; id: number; command: K; payload: MeshSimplifyCommands[K];
  }
}[MeshSimplifyCommand];

export type MeshSimplifyWorkerResponse = {
  epoch: number;
  id: number;
} & (
  { ok: true; value: MeshSimplifyReplies[MeshSimplifyCommand] } |
  { ok: false; error: string }
);

export interface MeshSimplifyWorkerReply {
  response: MeshSimplifyWorkerResponse;
  transfer: Transferable[];
}

/** One stateful handler per port, shared by native workers and the deterministic inline port. */
export function createMeshSimplifyHandler() {
  let epoch = -1;
  let geometries = new Map<string, MeshSimplifyGeometry>();
  const prepared = new Map<string, PreparedGeometry>();
  const classifications = new Map<string, { errorMm: number; value: GeometryClass }>();
  const prepare = (id: string) => {
    let value = prepared.get(id);
    if (!value) { value = prepareGeometry(geometry(id).input); prepared.set(id, value); }
    return value;
  };
  const classify = async (id: string, errorMm: number) => {
    let cached = classifications.get(id);
    if (!cached || cached.errorMm !== errorMm) {
      cached = { errorMm, value: await classifyPreparedGeometry(prepare(id), errorMm) };
      classifications.set(id, cached);
    }
    return cached.value;
  };

  function geometry(id: string): MeshSimplifyGeometry {
    const found = geometries.get(id);
    if (!found) throw new Error(`Unknown mesh simplification geometry: ${id}`);
    return found;
  }

  return async (request: MeshSimplifyWorkerRequest): Promise<MeshSimplifyWorkerReply> => {
    const transfer: Transferable[] = [];
    try {
      let value: MeshSimplifyReplies[MeshSimplifyCommand];
      if (request.command === 'load') {
        // The empty startup load waits for WASM too, before phase timing begins.
        const { MeshoptSimplifier } = await import('meshoptimizer');
        await MeshoptSimplifier.ready;
        epoch = request.epoch;
        geometries = new Map(request.payload.geometries.map(g => [g.id, g]));
        prepared.clear(); classifications.clear();
        value = null;
      } else {
        if (request.epoch !== epoch) throw new Error('Stale mesh simplification worker epoch');
        switch (request.command) {
          case 'classify': {
            const g = geometry(request.payload.geometryId);
            const skipReason = g.skipReason ?? eligibility(g.descriptor);
            value = {
              classification: skipReason ? null : await classify(g.id, request.payload.errorMm),
              skipReason,
            };
            break;
          }
          case 'plan': {
            const active = new Set(request.payload.activeIds);
            // Lines/points have no triangle surface to query. Other skipped parts
            // (e.g. multi-material triangles) still protect adjacent eligible parts.
            const instances = request.payload.instances.filter(i => !geometry(i.geometryId).descriptor.nonTriangle);
            value = planContactTasks(instances.map(i => ({
              ...i, mesh: geometry(i.geometryId).input,
            }))).filter(task => active.has(task.p.geometryId) || active.has(task.q.geometryId))
              .map(task => ({
                p: { geometryId: task.p.geometryId, world: task.p.world },
                q: { geometryId: task.q.geometryId, world: task.q.world },
                relTransform: task.relTransform,
                stretchQ: task.stretchQ,
                worldSpace: task.worldSpace,
              }));
            break;
          }
          case 'contact': {
            const task = request.payload.task;
            const result = detectContacts({
              ...task,
              p: { ...task.p, mesh: geometry(task.p.geometryId).input },
              q: { ...task.q, mesh: geometry(task.q.geometryId).input },
            });
            value = result;
            transfer.push(result.pLocks.buffer as ArrayBuffer, result.qLocks.buffer as ArrayBuffer,
              result.probe.points.buffer as ArrayBuffer);
            if (result.probe.originalDistances) transfer.push(result.probe.originalDistances.buffer as ArrayBuffer);
            break;
          }
          case 'simplify': {
            const { geometryId, options, locks, probes } = request.payload;
            const g = geometry(geometryId);
            const result = eligibility(g.descriptor)
              ? await simplifyGeometry(g.input, options, g.descriptor, locks, probes)
              : await simplifyPreparedGeometry(g.input, options, prepare(g.id), await classify(g.id, options.errorMm), locks, probes);
            // A kept/skipped result aliases the loaded payload. Never transfer (detach)
            // those buffers: later jobs on this persistent worker may still need them.
            if (result.mesh === g.input) {
              value = { ...result, mesh: {
                ...result.mesh,
                positions: result.mesh.positions.slice(),
                normals: result.mesh.normals?.slice(),
                uvs: result.mesh.uvs?.slice(),
                index: result.mesh.index.slice(),
              } };
            } else {
              value = result;
            }
            for (const array of [value.mesh.positions, value.mesh.normals, value.mesh.uvs, value.mesh.index]) {
              if (array) transfer.push(array.buffer as ArrayBuffer);
            }
            break;
          }
        }
      }
      return { response: { epoch: request.epoch, id: request.id, ok: true, value }, transfer };
    } catch (error) {
      return {
        response: { epoch: request.epoch, id: request.id, ok: false,
          error: error instanceof Error ? error.message : String(error) },
        transfer: [],
      };
    }
  };
}

// importScripts exists on module-worker globals too; we never call it. This guard
// leaves browser window and Node globals untouched when the handler is imported inline.
const scope = globalThis as unknown as {
  importScripts?: unknown;
  document?: unknown;
  onmessage: ((event: { data: MeshSimplifyWorkerRequest }) => void) | null;
  postMessage: (message: MeshSimplifyWorkerResponse, transfer: Transferable[]) => void;
};
if (typeof scope.importScripts === 'function' && typeof scope.document === 'undefined') {
  const handle = createMeshSimplifyHandler();
  // Browser messages arrive in order; preserve that order across asynchronous WASM startup.
  let queue = Promise.resolve();
  scope.onmessage = event => {
    queue = queue.then(async () => {
      const reply = await handle(event.data);
      scope.postMessage(reply.response, reply.transfer);
    });
  };
}
