// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * physics-zone2d-unity-fields.node.test.ts — plan-661 test 9.2 (Unity half).
 *
 * The public fields of Unity `WebPhysicsZone2D.cs` are exactly the rv-ODT keys
 * (properties + rawFields), because the GLB export is the generic catch-all
 * serializer (field name = extras key). Skipped when the Unity project is not
 * reachable (public checkout, worktree without RV_WORKSPACE_ROOT).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REL = 'Packages/io.realvirtual.professional/Runtime/WebViewerHMI/WebPhysicsZone2D.cs';
const candidates = [
  resolve(here, '../../..', REL), // canonical: <project>/Assets/realvirtual-WebViewer~/tests
  ...(process.env.RV_WORKSPACE_ROOT ? [resolve(process.env.RV_WORKSPACE_ROOT, 'game4automation/realvirtual', REL)] : []),
];
const CS = candidates.find((p) => existsSync(p)) ?? null;
const odt = JSON.parse(readFileSync(resolve(here, '../schema/v1/rv-odt.json'), 'utf8')) as {
  $defs: Record<string, { properties: Record<string, unknown>; rawFields?: Record<string, unknown> }>;
};

describe.skipIf(!CS)('WebPhysicsZone2D Unity fields = schema keys (plan-661 9.2)', () => {
  it('public fields match properties + rawFields', () => {
    const src = readFileSync(CS as string, 'utf8');
    const fields = [...src.matchAll(/^\s*public\s+(?!enum|class)[\w.<>]+\s+(\w+)\s*(?:=|;)/gm)].map((m) => m[1]).sort();
    const def = odt.$defs['WebPhysicsZone2D'];
    const keys = [...Object.keys(def.properties), ...Object.keys(def.rawFields ?? {})].sort();
    expect(fields).toEqual(keys);
  });

  it('follows the Web* marker convention', () => {
    const src = readFileSync(CS as string, 'utf8');
    for (const s of ['[Preserve]', '[DisallowMultipleComponent]', '[SelectionBase]', '#region doc',
      'AddComponentMenu("realvirtual/WebHMI/Web Physics Zone 2D")', ': realvirtualBehavior',
      'UI-only marker for realvirtual WEB 3D-HMI. No Unity runtime function.']) {
      expect(src).toContain(s);
    }
    expect(src).not.toMatch(/void\s+(Awake|Start|Update|FixedUpdate|OnStartSim)\s*\(/);
  });

  it('Kind enum values match the schema enum', () => {
    const src = readFileSync(CS as string, 'utf8');
    const body = /enum\s+ZoneKind\s*\{([^}]*)\}/.exec(src)?.[1] ?? '';
    const values = [...body.matchAll(/^\s*(\w+)\s*,?/gm)].map((m) => m[1]);
    expect(values).toEqual((odt.$defs['WebPhysicsZone2D'].properties['Kind'] as { enum: string[] }).enum);
  });
});
