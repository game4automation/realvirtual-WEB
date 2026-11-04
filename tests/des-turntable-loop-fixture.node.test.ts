// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The `Test-DES-Turntable-Loop` fixture must flow in the continuous (planner)
 * mode too, not only in DES.
 *
 * Regression of 2026-10-26: the Europallet source placement sat at y = 0 — on
 * the floor, 0.4 m below the roller top (0.5 m) — so its pallet spawned UNDER
 * the first conveyor and never touched a transport surface: one MU, a jammed
 * line. DES did not notice (its topology links by snap / distance, not by
 * contact). The source has no snap point, so nothing pulled it onto the belt.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readGlb } from '../scripts/lib/rv-glb.mjs';

const FIXTURE = resolve(__dirname, '../public/demo-realvirtual/Test-DES-Turntable-Loop.glb');
/** Roller top of `library/PalletHandling/RollConveyor-2m.glb` (its snap height). */
const BELT_TOP_M = 0.5;

interface GlbNode { name?: string; matrix?: number[]; translation?: number[]; extras?: { realvirtual?: { AssetReference?: { path?: string } } } }

function placement(nodes: GlbNode[], assetFile: string): GlbNode[] {
  return nodes.filter(n => n.extras?.realvirtual?.AssetReference?.path?.endsWith(assetFile));
}
function heightOf(n: GlbNode): number {
  return n.matrix ? n.matrix[13] : (n.translation?.[1] ?? 0);
}

describe('Test-DES-Turntable-Loop fixture', () => {
  const { json } = readGlb(readFileSync(FIXTURE)) as { json: { nodes: GlbNode[] } };

  it('places the pallet source on the belt, not on the floor', () => {
    const sources = placement(json.nodes, 'EuropalletLoaded.glb');
    expect(sources).toHaveLength(1);
    expect(heightOf(sources[0])).toBeCloseTo(BELT_TOP_M, 2);
  });

  it('keeps every conveyor on the floor (the belt top comes from the asset)', () => {
    const conveyors = placement(json.nodes, 'RollConveyor-2m.glb');
    expect(conveyors.length).toBe(4);
    for (const c of conveyors) expect(heightOf(c)).toBeCloseTo(0, 3);
  });
});
