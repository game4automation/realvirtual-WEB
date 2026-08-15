// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-419 §9.2 — the double-key rule, as a PATH MATRIX.
 *
 * A node can carry BOTH keys: `CollisionRole` from web-native authoring (asset
 * editor / rv-extras overlay) and `WebCollisionRole` from the Unity marker. The
 * rule is deterministic and structural: normalization simply does not happen,
 * the canonical key wins, and the alias stays inert because no factory is
 * registered for it. That is the whole reason the design normalizes keys instead
 * of registering a second factory — two factories would have built two
 * instances with an order-dependent winner.
 */

import { describe, it, expect } from 'vitest';
import { RVCollisionRole } from '../src/core/engine/rv-collision-role';
import { CONSTRUCTION_PATHS } from './web-collision-role-fixture';

/** Web-native `Robot` next to a Unity-authored `Machine` on the same node. */
const BOTH_KEYS = {
  CollisionRole: { CollisionRole: 'Robot' },
  WebCollisionRole: { CollisionRole: 'Machine' },
};

describe.each(CONSTRUCTION_PATHS)('double-key extras via %s', (_name, run) => {
  it('builds exactly ONE RVCollisionRole', () => {
    const r = run({ ...BOTH_KEYS });
    const roles = r.componentsAt().filter(([, inst]) => inst instanceof RVCollisionRole);
    expect(roles).toHaveLength(1);
    expect(r.registry.getComponentTypes(r.path)).toEqual(['CollisionRole']);
  });

  it('lets the canonical CollisionRole win', () => {
    const r = run({ ...BOTH_KEYS });
    const inst = r.componentsAt()[0][1] as RVCollisionRole;
    expect(inst.CollisionRole).toBe('Robot');
  });

  it('registers the canonical role exactly once with the manager', () => {
    const r = run({ ...BOTH_KEYS });
    expect(r.registrar.registered).toHaveLength(1);
    expect(r.registrar.registered[0].node).toBe(r.node);
    expect(r.registrar.registered[0].role).toBe('Robot');
  });

  it('leaves the alias key in the extras, untouched and inert', () => {
    const r = run({ ...BOTH_KEYS });
    const extras = r.extras();
    expect(extras.WebCollisionRole).toEqual({ CollisionRole: 'Machine' });
    expect(extras.CollisionRole).toEqual({ CollisionRole: 'Robot' });
  });

  it('disposes the single instance cleanly', () => {
    const r = run({ ...BOTH_KEYS });
    const inst = r.componentsAt()[0][1] as RVCollisionRole;
    inst.dispose();
    expect(r.registrar.unregistered).toEqual([r.node]);
  });

  // Key ORDER in the extras object must not decide the winner — a GLB writes
  // whatever order the exporter produced.
  it('is order-independent — the alias listed first still loses', () => {
    const r = run({
      WebCollisionRole: { CollisionRole: 'Machine' },
      CollisionRole: { CollisionRole: 'Robot' },
    });
    const roles = r.componentsAt().filter(([, inst]) => inst instanceof RVCollisionRole);
    expect(roles).toHaveLength(1);
    expect((roles[0][1] as RVCollisionRole).CollisionRole).toBe('Robot');
    expect(r.registrar.registered.map((x) => x.role)).toEqual(['Robot']);
  });
});
