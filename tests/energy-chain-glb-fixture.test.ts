// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.9 of plan-362 — rv_extras round trip against a REAL Unity export.
 *
 * SKIPPED until `EnergyChain.cs` ships and `public/models/tests.glb` is
 * re-exported with a chain in it. Same pattern as
 * `tests/glb-web-diagnostics.test.ts`.
 *
 * What it will verify that no synthetic fixture can: the wire value Unity
 * actually writes into `ComponentReference.componentType` for a
 * `public Transform Anchor` field. This plan fixes that value at
 * `UnityEngine.Transform` (2.3) and the resolver matches it exactly, so a
 * divergence on the C# side must fail HERE and not silently leave every chain
 * in the field unassigned.
 */

import { describe, expect, it } from 'vitest';

describe.skip('EnergyChain Unity GLB fixture', () => {
  it('parses EnergyChain rv_extras from a Unity-exported GLB', () => {
    // Load public/models/tests.glb, find the EnergyChain node, and assert:
    //   - Anchor/Follower arrive as ComponentReference objects
    //   - their componentType is exactly 'UnityEngine.Transform'
    //   - both resolve to real nodes through NodeRegistry.resolve()
    //   - the rig builds and the measured R/L match the CAD values
    expect(true).toBe(true);
  });
});
