// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-706 T3 — snapping WITHOUT a pointer must find the same geometry the
 * mouse does.
 *
 * The claim under test is the one the whole feature rests on: a canvas
 * coordinate reaches `computeSnapCandidates` through the identical six steps the
 * hover takes (gated hit → triangle refinement → local candidates → ranking →
 * world lift), so an agent aiming at a bore gets the bore's AXIS rather than a
 * surface point it then has to convert by hand.
 *
 * The fixture is a real bore — an inward-facing mantle around +Z — with a real
 * camera inside it and a real canvas, because the refinement is a raycast and
 * faking it away would test nothing. Only the GATED hit is stubbed: that layer
 * is `RaycastManager`'s and has its own tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera,
  Raycaster, Scene, Vector2, Vector3, DoubleSide,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { chooseSnapCandidate, computeSnapCandidates } from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap';
import { querySnapCandidates } from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap-query';

const BORE_RADIUS = 12.5;

/**
 * A tube around +Z whose winding points the normals AT the axis — what a bore's
 * wall looks like on a closed CAD solid (same construction as
 * `mechanism-snap-cylinder.test.ts`).
 */
function boreGeometry(radius: number, height: number, segments = 64, rings = 4): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const index = (ring: number, seg: number): number => ring * (segments + 1) + seg;
  for (let ring = 0; ring <= rings; ring++) {
    const z = (ring / rings - 0.5) * height;
    for (let seg = 0; seg <= segments; seg++) {
      const angle = (seg / segments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let seg = 0; seg < segments; seg++) {
      const a = index(ring, seg), b = index(ring, seg + 1);
      const c = index(ring + 1, seg + 1), d = index(ring + 1, seg);
      indices.push(a, c, b, a, d, c); // inward
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

interface Env {
  viewer: RVViewer;
  mesh: Mesh;
  canvas: HTMLCanvasElement;
  path: string;
}

function makeEnv(): Env {
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  canvas.style.width = '800px';
  canvas.style.height = '600px';
  canvas.style.position = 'fixed';
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  document.body.appendChild(canvas);

  const scene = new Scene();
  const mesh = new Mesh(
    boreGeometry(BORE_RADIUS, 40),
    new MeshBasicMaterial({ side: DoubleSide }),
  );
  mesh.name = 'Bore';
  scene.add(mesh);
  mesh.updateMatrixWorld(true);

  // Inside the bore, looking straight at its wall — the pose a user takes when
  // they mean "this hole".
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(new Vector3(1, 0, 0));
  camera.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  const path = NodeRegistry.computeNodePath(mesh);
  registry.registerNode(path, mesh);

  const raycaster = new Raycaster();
  const viewer = {
    scene, camera, registry,
    renderer: { domElement: canvas },
    // The only stub: the SHARED gated pipeline. Its gating (visibility,
    // isolation, hover-type) is RaycastManager's contract, not this module's.
    raycastManager: {
      raycastForRVNodeDetailed(e: { clientX: number; clientY: number }) {
        const rect = canvas.getBoundingClientRect();
        const ndc = new Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObject(mesh, true)[0];
        if (!hit) return null;
        const n = hit.normal ?? new Vector3(0, 0, 1);
        return {
          path,
          hitPoint: [hit.point.x, hit.point.y, hit.point.z] as [number, number, number],
          hitNormal: [n.x, n.y, n.z] as [number, number, number],
        };
      },
    },
  } as unknown as RVViewer;

  return { viewer, mesh, canvas, path };
}

let env: Env;

beforeEach(() => { env = makeEnv(); });
afterEach(() => { env.canvas.remove(); });

/** Canvas centre in client coordinates. */
function centre(canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

describe('T3 — querySnapCandidates without a pointer', () => {
  it('finds the bore and reports it as a cylinder axis on the inside', () => {
    const p = centre(env.canvas);
    const result = querySnapCandidates(env.viewer, p.x, p.y);
    expect(result).not.toBeNull();
    expect(result!.nodePath).toBe(env.path);

    const cylinder = result!.candidates.find((c) => c.kind === 'cylinder-axis');
    expect(cylinder, 'a bore must offer its axis').toBeDefined();
    // `inner` is the difference between a hole and a shaft, and therefore
    // between an anchor inside the bearing and one on its outside.
    expect(cylinder!.inner).toBe(true);
    expect(cylinder!.radius).toBeCloseTo(BORE_RADIUS, 1);
    // The normal of a bore candidate IS the joint axis a revolute joint wants.
    const axis = cylinder!.worldNormal;
    expect(Math.abs(axis.dot(new Vector3(0, 0, 1)))).toBeGreaterThan(0.99);
  });

  it('exactly one candidate is recommended', () => {
    const p = centre(env.canvas);
    const result = querySnapCandidates(env.viewer, p.x, p.y)!;
    expect(result.candidates.filter((c) => c.recommended)).toHaveLength(1);
  });

  it('the recommendation is what chooseSnapCandidate picks — one ranking, not two', () => {
    const p = centre(env.canvas);
    const result = querySnapCandidates(env.viewer, p.x, p.y)!;
    const recommended = result.candidates.find((c) => c.recommended)!;

    // Re-run the local half by hand and rank it with the SAME function the
    // interactive pick uses. A second ranking is what would drift.
    const rect = env.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((p.x - rect.left) / rect.width) * 2 - 1,
      -((p.y - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new Raycaster();
    raycaster.setFromCamera(ndc, env.viewer.camera);
    const hit = raycaster.intersectObject(env.mesh, true)[0];
    const local = env.mesh.worldToLocal(hit.point.clone());
    const candidates = computeSnapCandidates(env.mesh.geometry, hit.faceIndex!, local, {
      localToWorld: env.mesh.matrixWorld,
    });
    const distance = env.viewer.camera.position.distanceTo(hit.point);
    const chosen = chooseSnapCandidate(candidates, local, distance * 0.012 * 8);

    expect(chosen).not.toBeNull();
    expect(recommended.kind).toBe(chosen!.kind);
    expect(recommended.worldPosition.distanceTo(
      env.mesh.localToWorld(chosen!.position.clone()),
    )).toBeLessThan(1e-6);
  });

  it('maxCandidates caps the list but never drops the recommendation', () => {
    const p = centre(env.canvas);
    const full = querySnapCandidates(env.viewer, p.x, p.y)!;
    const capped = querySnapCandidates(env.viewer, p.x, p.y, { maxCandidates: 1 })!;
    expect(capped.candidates).toHaveLength(1);
    expect(capped.candidates[0].recommended).toBe(true);
    expect(capped.candidates[0].kind).toBe(full.candidates.find((c) => c.recommended)!.kind);
  });

  it('a GATED miss answers null rather than a made-up point', () => {
    // The gate is the shared pipeline's decision, and "nothing pickable here"
    // has to survive it as null — an invented surface point would become an
    // anchor on geometry the user never selected.
    const blind = {
      ...env.viewer,
      raycastManager: { raycastForRVNodeDetailed: () => null },
    } as unknown as RVViewer;
    const p = centre(env.canvas);
    expect(querySnapCandidates(blind, p.x, p.y)).toBeNull();
  });

  it('a hit whose triangle cannot be refined degrades to a surface point', () => {
    // Stage two legitimately misses when the gated hit resolved through an aux
    // target or an ancestor override. Degrading beats refusing: the raw hit
    // point is still a usable anchor, and it is labelled honestly.
    const empty = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    empty.name = 'Empty';
    const registry = new NodeRegistry();
    const path = NodeRegistry.computeNodePath(empty);
    registry.registerNode(path, empty);
    const viewer = {
      ...env.viewer, registry,
      raycastManager: {
        raycastForRVNodeDetailed: () => ({
          path, hitPoint: [1, 2, 3] as [number, number, number],
          hitNormal: [0, 1, 0] as [number, number, number],
        }),
      },
    } as unknown as RVViewer;
    const p = centre(env.canvas);
    const result = querySnapCandidates(viewer, p.x, p.y)!;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].label).toBe('Surface point');
    expect(result.candidates[0].recommended).toBe(true);
    expect(result.candidates[0].worldPosition.toArray()).toEqual([1, 2, 3]);
  });
});
