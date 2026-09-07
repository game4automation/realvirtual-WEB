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
    // rather than left to the generator's good intentions.
    expect(cases.tangentBetween.some((c) => c.tangent === null)).toBe(true);
    expect(cases.buildRibbonSegments.some((c) => c.error !== null)).toBe(true);
    expect(cases.sampleArcLength.some((c) => c.resultStepMm > c.stepMm)).toBe(true);
  });
});
