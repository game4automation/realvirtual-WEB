// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.12 — bake-editor isolation guard.
 *
 * A load with `preserveHierarchy` (the asset editor, STEP inspection, the
 * simulating embed runtime) must NEVER reach `bake()`. Phase 0 ships the guard
 * (`assertBakeAllowed`) and its spy hook (`bakeEvents`); this test pins the
 * contract. The end-to-end proof — every `preserveHierarchy` load path in the
 * loader leaves `bakeEvents` without an allowed entry — is the Phase 4 loader
 * integration test, once `bake()` exists and the loader calls it.
 *
 * Call sites that carry `preserveHierarchy` today (`grep -rl preserveHierarchy src`):
 *   src/core/editor/rv-asset-material.ts
 *   src/core/editor/rv-asset-ops.ts
 *   src/core/engine/rv-chain.ts
 *   src/core/engine/rv-component-registry.ts   (doc comment only)
 *   src/core/engine/rv-scene-loader.ts
 *   src/core/rv-viewer.ts
 *   src/embed/rv-embed-viewer.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertBakeAllowed,
  bakeEvents,
  _resetBakeEventsForTesting,
} from '../src/core/engine/rv-bake-pipeline';

describe('assertBakeAllowed', () => {
  beforeEach(() => {
    _resetBakeEventsForTesting();
  });

  it('throws on an authoring load (preserveHierarchy: true) and records the refusal', () => {
    expect(() => assertBakeAllowed({ preserveHierarchy: true })).toThrow(/preserveHierarchy/);
    expect(bakeEvents).toEqual([{ allowed: false, preserveHierarchy: true }]);
  });

  it('passes a runtime load (false / absent) and records the decision', () => {
    expect(() => assertBakeAllowed({ preserveHierarchy: false })).not.toThrow();
    expect(() => assertBakeAllowed({})).not.toThrow();
    expect(bakeEvents).toEqual([
      { allowed: true, preserveHierarchy: false },
      { allowed: true, preserveHierarchy: false },
    ]);
  });

  it('only a literal true refuses — truthy non-booleans are not authoring flags', () => {
    expect(() => assertBakeAllowed({ preserveHierarchy: undefined })).not.toThrow();
    expect(bakeEvents.every((e) => e.allowed)).toBe(true);
  });

  it('the spy hook is bounded (ring of 256)', () => {
    for (let i = 0; i < 300; i++) assertBakeAllowed({});
    expect(bakeEvents.length).toBe(256);
  });

  it('_resetBakeEventsForTesting empties the hook', () => {
    assertBakeAllowed({});
    _resetBakeEventsForTesting();
    expect(bakeEvents).toEqual([]);
  });
});

// plan-753 Phase 4a: the end-to-end proof over loadGLB (preserveHierarchy
// never reaches bake(); a runtime load with the flag ON does) lives in
// tests/loader-bake-inplace.test.ts ("§9.12: a preserveHierarchy load never
// reaches bake(), flag ON or not").
