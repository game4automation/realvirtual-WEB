// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-vectors-drift.test.ts — the web half of the ribbon parity contract (plan-466 Phase 1).
 *
 * The three portable modules under `src/core/engine/ribbon/` have a C# transcription in
 * `Packages/io.realvirtual.professional/Runtime/Ribbon/Math/`. Nothing but a shared set of
 * numbers keeps the two honest, so `scripts/export-ribbon-vectors.mjs` writes the answers of
 * the TypeScript originals into TWO files — the web fixture and a copy inside the Unity
 * package — and the Unity `RibbonVectorsTests` reads the second one.
 *
 * This test regenerates the payload IN MEMORY and compares it against both files. It therefore
 * fails when:
 *   - the mathematics changed and the fixture was not regenerated (the web side drifts), or
 *   - only one of the two copies was regenerated (the Unity side drifts).
 *
 * The `generatedAt` / `sourceCommit` header is not part of the comparison: it changes on every
 * run by design, and comparing it would make the test a clock.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRibbonVectors,
  readFixtureCases,
  RIBBON_VECTOR_FILES,
  // @ts-expect-error — plain JS Node module, no type declarations by design.
} from '../scripts/export-ribbon-vectors.mjs';

describe('ribbon test vectors', () => {
  it('the web fixture matches a fresh generation', async () => {
    const fresh = await buildRibbonVectors();
    const onDisk = readFixtureCases(RIBBON_VECTOR_FILES.web);
    expect(onDisk, `missing or unreadable: ${RIBBON_VECTOR_FILES.web}`).not.toBeNull();
    expect(onDisk).toEqual(fresh);
  });

  it('the Unity package copy matches the web fixture', async () => {
    const fresh = await buildRibbonVectors();
    const onDisk = readFixtureCases(RIBBON_VECTOR_FILES.package);
    if (onDisk === null) {
      // A bare web clone has no Unity checkout; the generator's `--no-package` mode covers that
      // case and this assertion is then vacuous rather than a false failure.
      expect(RIBBON_VECTOR_FILES.package).toContain('io.realvirtual.professional');
      return;
    }
    expect(onDisk).toEqual(fresh);
  });

  it('covers every group the C# tests read', async () => {
    const cases = await buildRibbonVectors();
    for (const group of [
      'tangentBetween', 'resolveAutoSides', 'buildRibbonSegments',
      'samplingChains', 'sampleArcLength', 'winder', 'dancer',
    ]) {
      expect(cases, `group ${group} missing`).toHaveProperty(group);
    }
    // Degenerate cases are the ones a transcription gets wrong, so their presence is asserted
    // rather than left to the generator's good intentions. The generator is an untyped `.mjs`,
    // so every callback parameter is annotated here rather than inferred.
    expect(cases.tangentBetween.some((c: { tangent: unknown }) => c.tangent === null)).toBe(true);
    expect(cases.buildRibbonSegments.some((c: { error: string | null }) => c.error !== null)).toBe(true);
    expect(cases.sampleArcLength.some((c: { resultStepMm: number; stepMm: number }) => c.resultStepMm > c.stepMm))
      .toBe(true);
  });

  it('pins the plan-468 end-wrap cases the Unity port has to reproduce', async () => {
    const cases = await buildRibbonVectors();
    type SegmentCase = {
      name: string;
      rollers: Array<{ r: number; side: number; wrapRad?: number }>;
      error: string | null;
      lengthMm?: number;
      segments?: Array<{ kind: string; sweep?: number; lengthMm: number }>;
    };
    const wrapped: SegmentCase[] = cases.buildRibbonSegments
      .filter((c: SegmentCase) => c.rollers.some((r) => (r.wrapRad ?? 0) > 0));
    // A pre-arc on a CCW end, a post-arc on a CW one, both ends at once, and a
    // wrap past a full turn — the four shapes a transcription can get wrong on
    // its own (sweep sign, `a0` derivation, and the missing [0, 2pi) folding).
    expect(wrapped.length).toBeGreaterThanOrEqual(4);
    for (const c of wrapped) {
      expect(c.error, `${c.name} must build`).toBeNull();
      const segments = c.segments!;
      const first = c.rollers[0];
      const last = c.rollers[c.rollers.length - 1];
      if ((first.wrapRad ?? 0) > 0) {
        expect(segments[0].kind, `${c.name}: leading segment`).toBe('arc');
        expect(segments[0].lengthMm).toBeCloseTo(first.r * first.wrapRad!, 9);
        expect(Math.sign(segments[0].sweep!)).toBe(Math.sign(first.side));
      }
      if ((last.wrapRad ?? 0) > 0) {
        const tail = segments[segments.length - 1];
        expect(tail.kind, `${c.name}: trailing segment`).toBe('arc');
        expect(tail.lengthMm).toBeCloseTo(last.r * last.wrapRad!, 9);
        expect(Math.sign(tail.sweep!)).toBe(Math.sign(last.side));
      }
    }
  });
});
