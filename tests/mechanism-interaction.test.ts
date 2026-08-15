// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mechanism 3D authoring interaction — the testable building blocks
 * (plan-404 §3.2, Phase 5).
 *
 * ── What this covers, and why it is the right cut ───────────────────────────
 * The 3D authoring interaction has three parts with very different testability:
 *
 *   1. the SNAP MATHS      — which candidates a hit offers, and which one wins
 *   2. the FRAME MATHS     — turning a clicked world point/direction into the
 *                            Unity-framed millimetre value a field stores
 *   3. the GESTURE         — pointer capture, orbit suppression, overlay
 *                            lifetime
 *
 * (1) and (2) are where the interaction can be silently WRONG: an anchor that
 * lands 3 mm off, or an axis whose sign is inverted, both look plausible on
 * screen and produce a mechanism that solves to the wrong pose. plan-404's own
 * Phase-0 fix round found exactly such a sign defect on the READ path, so both
 * are pure functions here and both are pinned by this suite — including a
 * round-trip against the read-path rule the private side applies, which is the
 * assertion that would have caught that defect.
 *
 * (3) is a browser gesture. It is covered where gestures are actually
 * observable — the T10 Playwright matrix — and that split is the cut plan-404
 * §9 explicitly permits: drive the matrix through the ops layer, and test the
 * new interaction building blocks individually here.
 *
 * Runs unconditionally: pure geometry and pure arithmetic, no wasm, no GLB, no
 * viewer.
 */

import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Object3D, Quaternion, RingGeometry, Vector3 } from 'three';
import {
  chooseSnapCandidate, computeSnapCandidates, invalidateSnapTopology, snapCandidateLabel,
  type SnapCandidate, type SnapKind,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-snap';
import {
  anchorFieldToWorldPoint, axisFieldToWorldDirection, axisIsTranslation,
  mirrorAxis, mirrorPosition, snapAxisToPrincipal,
  worldDirectionToAxisField, worldPointToAnchorField,
} from '@rv-private/plugins/asset-editor/mechanism/mechanism-frames';
import { planPickAnchor } from '@rv-private/plugins/asset-editor/mechanism/mechanism-authoring';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** A unit quad in the XY plane spanning (0,0)…(1,1), two triangles, +Z normal. */
function quadGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/** Find the first candidate of a kind, or fail loudly with what WAS offered. */
function candidateOfKind(candidates: SnapCandidate[], kind: SnapKind): SnapCandidate {
  const found = candidates.find((c) => c.kind === kind);
  if (!found) {
    throw new Error(
      `no '${kind}' candidate; offered: ${candidates.map((c) => c.kind).join(', ') || '(none)'}`);
  }
  return found;
}

// ─── Snap candidates ────────────────────────────────────────────────────────

describe('mechanism snap candidates', () => {
  it('offers the nearest corner as the vertex candidate', () => {
    const geometry = quadGeometry();
    // Close to corner (1,1,0), which belongs to triangle 0 (0,1,2).
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.95, 0.9, 0));
    expect(candidateOfKind(candidates, 'vertex').position.toArray())
      .toEqual([1, 1, 0]);
  });

  it('offers the midpoint of the nearest edge', () => {
    const geometry = quadGeometry();
    // Near the middle of the bottom edge (0,0)-(1,0) of triangle 0.
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.5, 0.02, 0));
    const edge = candidateOfKind(candidates, 'edge-center');
    expect(edge.position.x).toBeCloseTo(0.5, 6);
    expect(edge.position.y).toBeCloseTo(0, 6);
  });

  it('spans BOTH triangles of a coplanar quad for the face centre', () => {
    // The point of welding + coplanar BFS: a face centre must be the centre of
    // the FACE, not of the one triangle that happened to be hit.
    const geometry = quadGeometry();
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.7, 0.6, 0));
    const face = candidateOfKind(candidates, 'face-center');
    expect(face.position.x).toBeCloseTo(0.5, 6);
    expect(face.position.y).toBeCloseTo(0.5, 6);
    expect(face.position.z).toBeCloseTo(0, 6);
  });

  it('reports the face normal on every candidate', () => {
    const geometry = quadGeometry();
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.5, 0.5, 0));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.normal.z).toBeCloseTo(1, 6);
      expect(candidate.normal.length()).toBeCloseTo(1, 6);
    }
  });

  it('finds a bore as a circular boundary loop, with centre, radius and axis', () => {
    // A flat annulus is the shape of "a face with a hole through it" — the
    // authoring gesture the whole circle branch exists for. Both boundary loops
    // are genuine circles, so both are offered.
    const geometry = new RingGeometry(0.25, 1, 64, 1);
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.6, 0, 0));
    const circles = candidates.filter((c) => c.kind === 'circle-center');
    expect(circles.length).toBe(2);

    for (const circle of circles) {
      expect(circle.position.x).toBeCloseTo(0, 4);
      expect(circle.position.y).toBeCloseTo(0, 4);
      expect(Math.abs(circle.normal.z)).toBeCloseTo(1, 5); // the bore axis
    }
    const radii = circles.map((c) => c.radius ?? 0).sort((a, b) => a - b);
    expect(radii[0]).toBeCloseTo(0.25, 3);
    expect(radii[1]).toBeCloseTo(1, 3);
  });

  it('offers no circle for a plain quad — a square boundary is not a circle', () => {
    // The guard that matters: a bad circle fit is worse than none, because it
    // would hand the user a confidently wrong joint axis.
    const geometry = quadGeometry();
    const candidates = computeSnapCandidates(geometry, 0, new Vector3(0.5, 0.5, 0));
    expect(candidates.some((c) => c.kind === 'circle-center')).toBe(false);
  });

  it('returns an empty list for an out-of-range face index instead of throwing', () => {
    // Hover must never throw: a stale face index simply offers nothing.
    const geometry = quadGeometry();
    expect(computeSnapCandidates(geometry, 99, new Vector3())).toEqual([]);
    expect(computeSnapCandidates(geometry, -1, new Vector3())).toEqual([]);
  });

  it('returns an empty list for a geometry with no positions', () => {
    expect(computeSnapCandidates(new BufferGeometry(), 0, new Vector3())).toEqual([]);
  });

  it('welds across a coordinate offset far from the origin', () => {
    // The adaptive weld tolerance: at x≈1000 the float32 spacing is coarser than
    // the absolute default, so a fixed epsilon would leave the quad as two
    // disconnected triangles and lose the face centre entirely.
    const geometry = quadGeometry();
    const position = geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < position.count; i++) position.setX(i, position.getX(i) + 1000);
    position.needsUpdate = true;
    invalidateSnapTopology(geometry);
    geometry.computeBoundingBox();

    const candidates = computeSnapCandidates(geometry, 0, new Vector3(1000.7, 0.6, 0));
    const face = candidateOfKind(candidates, 'face-center');
    expect(face.position.x).toBeCloseTo(1000.5, 2);
    expect(face.position.y).toBeCloseTo(0.5, 2);
  });
});

// ─── Ranking ────────────────────────────────────────────────────────────────

describe('snap candidate ranking', () => {
  const at = (kind: SnapKind, x: number, radius?: number): SnapCandidate => ({
    kind, position: new Vector3(x, 0, 0), normal: new Vector3(0, 0, 1), radius,
  });

  it('lets a circle centre win from further away than a face centre', () => {
    // The deliberate bias: the cursor is on the face AROUND a bore, so the
    // circle centre is never the nearest thing — yet it is what the user means.
    const chosen = chooseSnapCandidate(
      [at('face-center', 1), at('circle-center', 2.5)], new Vector3(), 10);
    expect(chosen?.kind).toBe('circle-center');
  });

  it('still prefers a much closer face centre over a distant circle', () => {
    const chosen = chooseSnapCandidate(
      [at('face-center', 0.1), at('circle-center', 5)], new Vector3(), 10);
    expect(chosen?.kind).toBe('face-center');
  });

  it('prefers a vertex over an equidistant face centre', () => {
    const chosen = chooseSnapCandidate(
      [at('face-center', 1), at('vertex', 1)], new Vector3(), 10);
    expect(chosen?.kind).toBe('vertex');
  });

  it('falls back to the nearest candidate when none is inside the snap radius', () => {
    // A click must always commit something; refusing silently reads as a bug.
    const chosen = chooseSnapCandidate(
      [at('face-center', 50), at('vertex', 80)], new Vector3(), 1);
    expect(chosen?.kind).toBe('face-center');
  });

  it('returns null only for an empty candidate list', () => {
    expect(chooseSnapCandidate([], new Vector3())).toBeNull();
  });

  it('names a circle candidate with its radius', () => {
    expect(snapCandidateLabel(at('circle-center', 0, 12.5))).toContain('12.5');
    expect(snapCandidateLabel(at('vertex', 0))).toBe('Vertex');
  });
});

// ─── Frame + unit conversion ────────────────────────────────────────────────

/** A body with a non-trivial pose — translated, rotated and (uniformly) scaled. */
function posedBody(): Object3D {
  const body = new Object3D();
  body.position.set(0.3, -0.2, 1.1);
  body.quaternion.setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
  body.updateMatrixWorld(true);
  return body;
}

describe('mechanism frame conversion', () => {
  it('mirrors positions and axes as involutions', () => {
    const v = new Vector3(1, 2, 3);
    expect(mirrorPosition(mirrorPosition(v)).toArray()).toEqual([1, 2, 3]);
    expect(mirrorAxis(mirrorAxis(v, false), false).toArray()).toEqual([1, 2, 3]);
    expect(mirrorAxis(mirrorAxis(v, true), true).toArray()).toEqual([1, 2, 3]);
  });

  it('applies the POSITION rule to a position and the QUATERNION rule to a rotation axis', () => {
    // The two rules must stay distinct — conflating them is precisely the
    // defect plan-404's Phase-0 fix round had to repair on the read path.
    expect(mirrorPosition(new Vector3(1, 2, 3)).toArray()).toEqual([-1, 2, 3]);
    expect(mirrorAxis(new Vector3(1, 2, 3), false).toArray()).toEqual([1, -2, -3]);
    expect(mirrorAxis(new Vector3(1, 2, 3), true).toArray()).toEqual([-1, 2, 3]);
  });

  it('classifies only Prismatic as a translation axis', () => {
    expect(axisIsTranslation('Prismatic')).toBe(true);
    for (const kind of ['Revolute', 'Spherical', 'Universal']) {
      expect(axisIsTranslation(kind)).toBe(false);
    }
  });

  it('round-trips a world point through an anchor field on a posed body', () => {
    const body = posedBody();
    const world = new Vector3(0.42, 1.7, -0.9);
    const field = worldPointToAnchorField(world, body);
    const back = anchorFieldToWorldPoint(field, body);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
    expect(back.z).toBeCloseTo(world.z, 6);
  });

  it('writes an anchor in MILLIMETRES', () => {
    // The scene is metres, the field is millimetres — a factor of 1000 that is
    // invisible in a round-trip and catastrophic if dropped.
    const body = new Object3D();
    body.updateMatrixWorld(true);
    const field = worldPointToAnchorField(new Vector3(0, 0.25, 0), body);
    expect(field.y).toBeCloseTo(250, 6);
  });

  it('round-trips a world direction through an axis field, for both axis rules', () => {
    const body = posedBody();
    const world = new Vector3(0.3, -0.8, 0.5).normalize();
    for (const isTranslation of [false, true]) {
      const field = worldDirectionToAxisField(world, body, isTranslation);
      const back = axisFieldToWorldDirection(field, body, isTranslation);
      expect(back.x).toBeCloseTo(world.x, 6);
      expect(back.y).toBeCloseTo(world.y, 6);
      expect(back.z).toBeCloseTo(world.z, 6);
    }
  });

  it('agrees with the private READ path, rule for rule', () => {
    // The read path is: schema `unityCoords` negates X, then `jointAxisToGltf`
    // negates the whole vector for a ROTATION axis and leaves a TRANSLATION
    // axis alone. Writing must be that composition inverted — if the two ever
    // disagree, an authored axis and an imported one mean different things.
    const schemaMirror = (v: Vector3) => new Vector3(-v.x, v.y, v.z);
    const jointAxisToGltf = (v: Vector3, isTranslation: boolean) =>
      isTranslation ? v.clone() : v.clone().negate();

    const body = new Object3D(); // identity: isolate the frame rule from the pose
    body.updateMatrixWorld(true);

    for (const isTranslation of [false, true]) {
      const unityField = new Vector3(0.2, -0.6, 0.77).normalize();
      const gltf = jointAxisToGltf(schemaMirror(unityField), isTranslation);
      // What the WRITE path produces for that same world direction must be the
      // Unity field we started from.
      const written = worldDirectionToAxisField(gltf, body, isTranslation);
      expect(written.x).toBeCloseTo(unityField.x, 6);
      expect(written.y).toBeCloseTo(unityField.y, 6);
      expect(written.z).toBeCloseTo(unityField.z, 6);
    }
  });

  it('treats a null body as the world frame (the authored world anchor)', () => {
    // An absent BodyA means "the world IS the body" — not "no body", and not an
    // error to guard against (plan-404 §2.4).
    const field = worldPointToAnchorField(new Vector3(1, 2, 3), null);
    expect(field).toEqual({ x: -1000, y: 2000, z: 3000 });
    const back = anchorFieldToWorldPoint(field, null);
    expect(back.toArray()).toEqual([1, 2, 3]);
  });

  it('keeps an axis unit-length regardless of the input magnitude', () => {
    const body = posedBody();
    const field = worldDirectionToAxisField(new Vector3(0, 17, 0), body, false);
    const length = Math.hypot(field.x, field.y, field.z);
    expect(length).toBeCloseTo(1, 6);
  });

  it('survives a rotated body without leaking the rotation into the anchor', () => {
    // A point AT the body's origin must be the zero anchor whatever the pose.
    const body = posedBody();
    const origin = body.getWorldPosition(new Vector3());
    const field = worldPointToAnchorField(origin, body);
    expect(field.x).toBeCloseTo(0, 6);
    expect(field.y).toBeCloseTo(0, 6);
    expect(field.z).toBeCloseTo(0, 6);
  });
});

describe('principal axis magnet', () => {
  it('snaps a nearly-axis-aligned direction onto the axis', () => {
    const almostZ = new Vector3(0.02, 0.01, 1).normalize();
    expect(snapAxisToPrincipal(almostZ, 5).toArray()).toEqual([0, 0, 1]);
  });

  it('leaves a deliberately oblique direction alone', () => {
    const oblique = new Vector3(1, 1, 0).normalize();
    const snapped = snapAxisToPrincipal(oblique, 5);
    expect(snapped.x).toBeCloseTo(oblique.x, 6);
    expect(snapped.y).toBeCloseTo(oblique.y, 6);
  });

  it('snaps to the NEGATIVE axis when that is the nearer one', () => {
    // Sign matters: a joint axis flipped 180° reverses the drive's direction.
    expect(snapAxisToPrincipal(new Vector3(-1, 0.03, 0).normalize(), 5).toArray())
      .toEqual([-1, 0, 0]);
  });

  it('returns a defined axis for a degenerate input instead of NaN', () => {
    expect(snapAxisToPrincipal(new Vector3(0, 0, 0)).toArray()).toEqual([0, 0, 1]);
  });
});

// ─── The pick commit is still a generic composite ───────────────────────────

describe('planPickAnchor', () => {
  const anchor = { x: 1, y: 2, z: 3 };

  it('writes the anchor and the body reference as ONE composite', () => {
    // Clicking a bore on a part means "this part, at this point" — one act, so
    // one undo step. Splitting them could leave an anchor expressed in the
    // frame of a body that is no longer assigned.
    const plan = planPickAnchor({
      jointPath: 'M/J1', componentType: 'KinematicJoint', side: 'A', anchor, bodyPath: 'M/Arm',
    });
    expect(plan.intents).toHaveLength(2);
    expect(plan.intents[0]).toMatchObject({ op: 'setField', fieldName: 'AnchorA', value: anchor });
    expect(plan.intents[1]).toMatchObject({
      op: 'setField',
      fieldName: 'BodyA',
      value: { type: 'ComponentReference', path: 'M/Arm', componentType: 'UnityEngine.Transform' },
    });
  });

  it('writes a world anchor as an ABSENT key, never a null or empty reference', () => {
    const plan = planPickAnchor({
      jointPath: 'M/J1', componentType: 'KinematicJoint', side: 'A', anchor, bodyPath: null,
    });
    expect(plan.intents[1]).toEqual({
      op: 'unsetField', nodePath: 'M/J1', componentType: 'KinematicJoint', fieldName: 'BodyA',
    });
  });

  it('leaves the body untouched when no bodyPath is given', () => {
    const plan = planPickAnchor({
      jointPath: 'M/J1', componentType: 'KinematicJoint', side: 'B', anchor,
    });
    expect(plan.intents).toHaveLength(1);
    expect(plan.intents[0]).toMatchObject({ fieldName: 'AnchorB' });
  });

  it('targets side B fields when the B side is picked', () => {
    const plan = planPickAnchor({
      jointPath: 'M/J1', componentType: 'KinematicJoint', side: 'B', anchor, bodyPath: 'M/Rod',
    });
    expect(plan.intents.map((i) => 'fieldName' in i && i.fieldName)).toEqual(['AnchorB', 'BodyB']);
  });

  it('introduces no new op kinds — only the three generic primitives', () => {
    // plan-404 §2.6 / SOL round-2 finding 1: the op union and its three
    // dispatchers must stay untouched, so nothing here may grow a new kind.
    const plans = [
      planPickAnchor({ jointPath: 'J', componentType: 'KinematicJoint', side: 'A', anchor, bodyPath: 'B' }),
      planPickAnchor({ jointPath: 'J', componentType: 'KinematicJoint', side: 'B', anchor, bodyPath: null }),
    ];
    for (const plan of plans) {
      for (const intent of plan.intents) {
        expect(['addComponent', 'setField', 'unsetField']).toContain(intent.op);
      }
    }
  });
});

// A rotation-only sanity check that the Quaternion import is exercised, keeping
// the fixture honest about what "posed" means.
describe('fixture sanity', () => {
  it('poses the test body with a real rotation', () => {
    const body = posedBody();
    const q = body.getWorldQuaternion(new Quaternion());
    expect(Math.abs(q.w)).toBeLessThan(1);
  });
});
