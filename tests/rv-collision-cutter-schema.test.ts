// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-409 §9.2 — GLB round-trip of the seventh collision role `Cutter` (F1/F2).
 *
 * `Cutter` lives in THREE duplicated places that can drift independently:
 *   - `COLLISION_ROLES` (the runtime parser),
 *   - `$defs.CollisionRole.properties.CollisionRole.enum` (the node role), and
 *   - `$defs.Source.properties.CollisionRoleForMUs.enum` (the MU role).
 *
 * The failure this guards is the same one plan-394 hit: `applySchema` only maps
 * a string when the descriptor carries an `enumMap`, so a role missing from ONE
 * of the two schema enums comes back from the GLB as `'None'` — silently, with
 * no warning anywhere. Asserting the runtime list against BOTH schemas is the
 * only way that stays caught.
 */

import { describe, it, expect } from 'vitest';
import { applySchema, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { COLLISION_ROLES, RVCollisionRole, toCollisionRole } from '../src/core/engine/rv-collision-role';
import { RVSource } from '../src/core/engine/rv-source';
import rvOdt from '../schema/v1/rv-odt.json';

const ODT = rvOdt as unknown as {
  $defs: Record<string, { properties?: Record<string, { enum?: string[]; default?: unknown }> }>;
};

/** Apply authored rv_extras through the CollisionRole schema. */
function applyRole(extras: Record<string, unknown>): unknown {
  const inst: Record<string, unknown> = {};
  applySchema(inst, RVCollisionRole.schema, extras);
  return inst.CollisionRole;
}

/** Apply authored rv_extras through the Source schema. */
function applyMURole(extras: Record<string, unknown>): unknown {
  const inst: Record<string, unknown> = {};
  applySchema(inst, RVSource.schema, extras);
  return inst.CollisionRoleForMUs;
}

describe('Cutter role — schema round-trip', () => {
  it('survives applySchema on a CollisionRole component (identity map, not the default)', () => {
    expect(applyRole({ CollisionRole: 'Cutter' })).toBe('Cutter');
    // The neighbours must not regress while the enum grows.
    expect(applyRole({ CollisionRole: 'Environment' })).toBe('Environment');
    expect(applyRole({})).toBe('None');
    expect(applyRole({ CollisionRole: 'Cutters' })).toBe('None');
  });

  it('survives applySchema on Source.CollisionRoleForMUs', () => {
    expect(applyMURole({ CollisionRoleForMUs: 'Cutter' })).toBe('Cutter');
    expect(applyMURole({})).toBe('None');
    expect(applyMURole({ CollisionRoleForMUs: 'cutter' })).toBe('None');
  });

  it('keeps BOTH rv-odt enums identical to the runtime role list', () => {
    const nodeEnum = ODT.$defs.CollisionRole.properties!.CollisionRole.enum;
    const muEnum = ODT.$defs.Source.properties!.CollisionRoleForMUs.enum;
    expect(nodeEnum).toEqual([...COLLISION_ROLES]);
    expect(muEnum).toEqual([...COLLISION_ROLES]);
    expect(ODT.$defs.CollisionRole.properties!.CollisionRole.default).toBe('None');
    expect(ODT.$defs.Source.properties!.CollisionRoleForMUs.default).toBe('None');
  });

  it('builds identity enumMaps for every role on both schemas', () => {
    const roleSchema = loadSchemaFromSpec('CollisionRole');
    const sourceSchema = RVSource.schema;
    for (const role of COLLISION_ROLES) {
      expect(roleSchema.CollisionRole.enumMap![role]).toBe(role);
      expect(sourceSchema.CollisionRoleForMUs.enumMap![role]).toBe(role);
      // ...and the defensive parser agrees with the schema.
      expect(toCollisionRole(role)).toBe(role);
    }
  });

  it('leaves an old GLB without a role at None (backwards compatibility)', () => {
    expect(applyRole({ SomethingElse: 1 })).toBe('None');
    expect(applyMURole({ Interval: 3 })).toBe('None');
  });
});
