// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.5 — schema round-trip (F2).
 *
 * The exact failure this guards: an INLINE `{ type: 'enum', default: 'None' }`
 * descriptor has no `enumMap`, and `applySchema` then maps NO string at all —
 * every authored role would come back from the GLB as `'None'`, silently.
 */

import { describe, it, expect } from 'vitest';
import { applySchema, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import { RVCollisionRole } from '../src/core/engine/rv-collision-role';
import { RVSource } from '../src/core/engine/rv-source';

function apply(extras: Record<string, unknown>): Record<string, unknown> {
  const inst: Record<string, unknown> = {};
  applySchema(inst, RVCollisionRole.schema, extras);
  return inst;
}

describe('CollisionRole rv_extras round-trip', () => {
  it('reads the enum string from rv_extras instead of falling back to the default', () => {
    expect(apply({ CollisionRole: 'Robot' }).CollisionRole).toBe('Robot');
    expect(apply({ CollisionRole: 'Environment' }).CollisionRole).toBe('Environment');
    expect(apply({}).CollisionRole).toBe('None');
    expect(apply({ CollisionRole: 'Nonsense' }).CollisionRole).toBe('None');
  });

  // plan-409 appended the seventh role `Cutter`.
  it('builds an identity enumMap covering all seven roles', () => {
    const schema = loadSchemaFromSpec('CollisionRole');
    expect(schema.CollisionRole.type).toBe('enum');
    expect(Object.keys(schema.CollisionRole.enumMap!)).toEqual(
      ['None', 'Tool', 'Workpiece', 'Machine', 'Robot', 'Environment', 'Cutter']);
    expect(schema.CollisionRole.default).toBe('None');
  });

  it('gives Source a CollisionRoleForMUs enum with the same seven values', () => {
    const schema = RVSource.schema;
    expect(schema.CollisionRoleForMUs.type).toBe('enum');
    expect(schema.CollisionRoleForMUs.default).toBe('None');
    const inst: Record<string, unknown> = {};
    applySchema(inst, schema, { CollisionRoleForMUs: 'Workpiece' });
    expect(inst.CollisionRoleForMUs).toBe('Workpiece');
  });
});
