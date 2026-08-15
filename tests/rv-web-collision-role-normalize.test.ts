// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-419 §9.1 — Unity marker-key normalization, as a PATH MATRIX.
 *
 * `WebCollisionRole` is what the Unity exporter writes (the C# class carries the
 * `Web` prefix; the field keeps the canonical name). Every construction path
 * that reads rv_extras must turn it into exactly ONE `RVCollisionRole` — not
 * zero (the plan-417 symptom: the role silently vanishes on re-export) and not
 * two (what a second registered factory would have produced).
 *
 * The matrix is the test: SOL round 2 found that normalizing only in
 * `processExtras()` would leave the normal `loadGLB` traverse blind, which is
 * exactly the path a shared demo GLB takes.
 */

import { describe, it, expect } from 'vitest';
import { RVCollisionRole } from '../src/core/engine/rv-collision-role';
import { normalizeComponentKeys } from '../src/core/engine/rv-scene-loader';
import { CONSTRUCTION_PATHS } from './web-collision-role-fixture';

describe('normalizeComponentKeys', () => {
  it('renames the alias key and removes it, so only one factory can match', () => {
    const rv: Record<string, unknown> = { WebCollisionRole: { CollisionRole: 'Machine' } };
    normalizeComponentKeys(rv);
    expect(Object.keys(rv)).toEqual(['CollisionRole']);
    expect(rv.CollisionRole).toEqual({ CollisionRole: 'Machine' });
  });

  it('leaves unrelated keys and alias-free extras untouched', () => {
    const rv: Record<string, unknown> = { Drive: { Direction: 'LinearX' }, CollisionRole: { CollisionRole: 'Tool' } };
    const before = JSON.stringify(rv);
    normalizeComponentKeys(rv);
    expect(JSON.stringify(rv)).toBe(before);
  });

  it('tolerates missing / empty extras', () => {
    expect(() => normalizeComponentKeys(undefined)).not.toThrow();
    expect(() => normalizeComponentKeys(null)).not.toThrow();
    const rv: Record<string, unknown> = {};
    normalizeComponentKeys(rv);
    expect(rv).toEqual({});
  });

  // A canonical key stamped with no value must not swallow the alias — the
  // factory loops test truthiness, so "present but empty" is not a component.
  it('treats a null/undefined canonical stamp as absent', () => {
    const rv: Record<string, unknown> = {
      CollisionRole: undefined, WebCollisionRole: { CollisionRole: 'Robot' },
    };
    normalizeComponentKeys(rv);
    expect(rv.CollisionRole).toEqual({ CollisionRole: 'Robot' });
    expect('WebCollisionRole' in rv).toBe(false);
  });
});

describe.each(CONSTRUCTION_PATHS)('alias-only extras via %s', (_name, run) => {
  it('constructs exactly ONE RVCollisionRole and registers it canonically', () => {
    const r = run({ WebCollisionRole: { CollisionRole: 'Machine' } });

    const roles = r.componentsAt().filter(([, inst]) => inst instanceof RVCollisionRole);
    expect(roles).toHaveLength(1);
    expect(roles[0][0]).toBe('CollisionRole');
    expect(r.registry.getComponentTypes(r.path)).toEqual(['CollisionRole']);
  });

  it('rewrites the node extras to the canonical key', () => {
    const r = run({ WebCollisionRole: { CollisionRole: 'Machine' } });
    expect(Object.keys(r.extras())).toEqual(['CollisionRole']);
  });

  it('applies the authored role and registers it with the collision manager', () => {
    const r = run({ WebCollisionRole: { CollisionRole: 'Machine' } });
    const inst = r.componentsAt()[0][1] as RVCollisionRole;

    expect(inst.CollisionRole).toBe('Machine');
    expect(r.registrar.registered).toHaveLength(1);
    expect(r.registrar.registered[0].node).toBe(r.node);
    expect(r.registrar.registered[0].role).toBe('Machine');
  });

  it('disposes cleanly — one unregister, no leftover registrar', () => {
    const r = run({ WebCollisionRole: { CollisionRole: 'Machine' } });
    const inst = r.componentsAt()[0][1] as RVCollisionRole;

    inst.dispose();
    expect(r.registrar.unregistered).toEqual([r.node]);
    // A second dispose must not reach a torn-down manager again.
    inst.dispose();
    expect(r.registrar.unregistered).toHaveLength(1);
  });

  it('falls back to None for an unknown role name', () => {
    const r = run({ WebCollisionRole: { CollisionRole: 'Tuerchen' } });
    const inst = r.componentsAt()[0][1] as RVCollisionRole;

    expect(inst.CollisionRole).toBe('None');
    expect(r.registrar.lastRole).toBe('None');
  });

  it('behaves exactly like the canonical key authored web-natively', () => {
    const viaAlias = run({ WebCollisionRole: { CollisionRole: 'Workpiece' } });
    const viaCanonical = run({ CollisionRole: { CollisionRole: 'Workpiece' } });

    expect(viaAlias.registry.getComponentTypes(viaAlias.path))
      .toEqual(viaCanonical.registry.getComponentTypes(viaCanonical.path));
    expect((viaAlias.componentsAt()[0][1] as RVCollisionRole).getLiveState())
      .toEqual((viaCanonical.componentsAt()[0][1] as RVCollisionRole).getLiveState());
    expect(viaAlias.registrar.registered.map((x) => x.role))
      .toEqual(viaCanonical.registrar.registered.map((x) => x.role));
  });
});
