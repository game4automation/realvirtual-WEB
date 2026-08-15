// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mechanism extras parity — every field a Unity mechanism export carries is
 * either CONSUMED or deliberately IGNORED (plan-404 remaining-work item 7).
 *
 * ── What was wrong, and what this pins ──────────────────────────────────────
 * The dev-mode parity check reported five unhandled fields on every mechanism
 * load (`KinematicMechanism.Active`, `KinematicJoint.Active`,
 * `capturedJointLocalPos`, `capturedJointLocalRot`, `hasCapture`). All five are
 * deliberately unconsumed — `Active` is `realvirtualBehavior` metadata, and the
 * three capture fields are Unity EDITOR authoring state, the documented and
 * accepted `[HideInInspector]` side effect of plan-273 §2.3. They belonged in
 * the validator's IGNORED list, and now are.
 *
 * ── Why this is a real test and not a tautology ─────────────────────────────
 * It would be trivial — and worthless — to assert that the five names I just
 * added are in the list I just added them to. So the field names come from the
 * REAL exported artefact instead: the GLB's JSON chunk is parsed and every
 * mechanism extras key found there must be accounted for. That makes this a
 * DRIFT GUARD: when Unity starts exporting a new mechanism field, this fails and
 * forces a decision — consume it or ignore it on purpose — instead of letting it
 * reappear as console noise that everyone learns to scroll past.
 *
 * The reference GLB is a Phase-0 artefact, regenerable in Unity via
 * `realvirtual DEV/Testing/Kinematics/Export Mechanism Reference GLBs`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getConsumedFields, getIgnoredFields,
} from '../src/core/engine/rv-extras-validator';
// The CONSUMED half of the answer is SCHEMA-derived, and the mechanism schemas
// register as a side effect of the private component module loading. Without
// this import every field would look unconsumed and the assertions below would
// fail for the wrong reason — which is also exactly what a public build sees,
// and correctly so: there, no mechanism component is constructed at all.
import '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const GLB_URL = DEV_GLB.mechanismFourbar;

/** Universal Unity serialization metadata, ignored for every type by design. */
const GLOBAL_IGNORED = ['_fullTypeName', '_version', '_enabled'];

/** Extras keys per mechanism component type, read from the real export. */
let exportedKeys: Record<string, Set<string>> = {};

/**
 * Parse a GLB's JSON chunk and collect `extras.realvirtual.<Type>` keys.
 * Deliberately a hand-rolled reader rather than a full GLTF load: this test is
 * about what the FILE contains, before any loader, schema or default has had a
 * chance to add or drop a field.
 */
function collectExtrasKeys(buffer: ArrayBuffer): Record<string, Set<string>> {
  const view = new DataView(buffer);
  const jsonLength = view.getUint32(12, true);
  const jsonBytes = new Uint8Array(buffer, 20, jsonLength);
  const gltf = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
    nodes?: { extras?: { realvirtual?: Record<string, Record<string, unknown>> } }[];
  };

  const out: Record<string, Set<string>> = {};
  for (const node of gltf.nodes ?? []) {
    const realvirtual = node.extras?.realvirtual;
    if (!realvirtual) continue;
    for (const [type, data] of Object.entries(realvirtual)) {
      if (!type.startsWith('Kinematic')) continue;
      (out[type] ??= new Set()).add('');
      out[type].delete('');
      for (const key of Object.keys(data)) out[type].add(key);
    }
  }
  return out;
}

beforeAll(async () => {
  const response = await fetch(GLB_URL);
  if (!response.ok) throw new Error(`${GLB_URL} not reachable (${response.status})`);
  exportedKeys = collectExtrasKeys(await response.arrayBuffer());
});

describe('mechanism extras parity', () => {
  it('finds both mechanism component types in the reference export', () => {
    // Guards the guard: a fixture that silently stopped carrying mechanism
    // extras would make every assertion below vacuously true.
    expect(Object.keys(exportedKeys).sort()).toEqual(['KinematicJoint', 'KinematicMechanism']);
  });

  it.each(['KinematicMechanism', 'KinematicJoint'])(
    'accounts for every %s field the export carries', (type) => {
      const known = new Set([
        ...getConsumedFields(type),
        ...getIgnoredFields(type),
        ...GLOBAL_IGNORED,
      ]);
      const unaccounted = [...(exportedKeys[type] ?? [])].filter((key) => !known.has(key));
      expect(unaccounted).toEqual([]);
    });

  it('ignores the five fields on purpose rather than consuming them', () => {
    // The distinction is the point: these are not "not implemented yet". The
    // web host derives joint state from the solver, never from a captured Unity
    // editor pose, so consuming them would be wrong, not merely unnecessary.
    expect(getIgnoredFields('KinematicMechanism')).toContain('Active');
    for (const field of ['Active', 'capturedJointLocalPos', 'capturedJointLocalRot', 'hasCapture']) {
      expect(getIgnoredFields('KinematicJoint')).toContain(field);
    }
  });

  it('does not ignore any field the solver actually needs', () => {
    // A blanket ignore would silence the noise and break the mechanism. Every
    // blob-relevant field must be CONSUMED, never merely ignored.
    const blobRelevant = [
      'JointType', 'BodyA', 'BodyB', 'AnchorA', 'AnchorB', 'AxisA',
      'SecondaryAxisB', 'UseLimits', 'LowerLimit', 'UpperLimit', 'DrivenBy',
    ];
    const ignored = new Set(getIgnoredFields('KinematicJoint'));
    const consumed = new Set(getConsumedFields('KinematicJoint'));
    for (const field of blobRelevant) {
      expect(ignored.has(field)).toBe(false);
      expect(consumed.has(field)).toBe(true);
    }
  });
});
