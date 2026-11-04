// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mjcf-problems-store.test.ts — plan-673 Phase 4 closes the open point of
 * Phase 3: the thirteen codes of the MJCF writer reach the Problems store.
 *
 * `writeMjcf()` is a pure function in the private tree and returns its findings
 * instead of reporting them, because only the caller knows which document they
 * belong to. This file tests that caller's vocabulary: all thirteen codes
 * arrive, two regions keep their findings apart, a rewrite replaces rather than
 * stacks, and `clearMjcfProblems()` empties the panel the way every load
 * expects.
 *
 * The lifecycle half — every code is classified in
 * `tests/helpers/problem-code-classification.ts` — is enforced by
 * `problems-clear-per-load.node.test.ts`, which only sees codes in the public
 * `src/`. That is precisely why the vocabulary is public while the writer is
 * not.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MJCF_PROBLEM_CODES,
  MJCF_PROBLEM_MASS_DEGRADED,
  MJCF_PROBLEM_NO_FORCE_LIMIT,
  MJCF_PROBLEM_REGION_DISABLED,
  clearMjcfProblems,
  clearMjcfProblemsOf,
  reportMjcfProblems,
  type MjcfProblemLike,
} from '../src/core/engine/rv-mjcf-problems';
import { PROBLEM_CODE_CLASSIFICATION } from './helpers/problem-code-classification';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';

const mjcf = () => getProblems().filter((p) => p.code.startsWith('mjcf-'));

beforeEach(() => {
  clearMjcfProblems();
  clearAllProblems();
});

describe('the MJCF writer vocabulary', () => {
  it('lists exactly thirteen codes, each classified for its lifecycle', () => {
    expect(MJCF_PROBLEM_CODES).toHaveLength(13);
    expect(new Set(MJCF_PROBLEM_CODES).size).toBe(13);
    for (const code of MJCF_PROBLEM_CODES) {
      const classification = PROBLEM_CODE_CLASSIFICATION[code];
      expect(classification, `${code} is not classified`).toBeDefined();
      // Document-scoped: a degraded physics document is a statement about THIS
      // model and must leave the panel when the model does.
      expect(classification.retire).toBe('clear-model');
    }
  });

  it('publishes every code with the writer severity and the writer message', () => {
    const problems: MjcfProblemLike[] = MJCF_PROBLEM_CODES.map((code, i) => ({
      code,
      node: `Body_${i}`,
      severity: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info',
      message: `message for ${code} with the number 42.5`,
    }));
    reportMjcfProblems('Cell/Region', problems, 'Cell/Region');
    const found = mjcf();
    expect(found).toHaveLength(13);
    for (const p of found) {
      // The writer's message is what names the node, the source AND the number
      // — the title never restates it.
      expect(p.detail).toContain('42.5');
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.detail).not.toBe(p.title);
      expect(p.nodePath?.startsWith('Cell/Region/')).toBe(true);
    }
    const bySeverity = new Set(found.map((p) => p.severity));
    expect([...bySeverity].sort()).toEqual(['error', 'info', 'warning']);
  });

  it('keeps two regions apart and replaces only the region that is rewritten', () => {
    const one: MjcfProblemLike[] = [
      { code: MJCF_PROBLEM_MASS_DEGRADED, node: 'A2', severity: 'warning', message: 'mass of A2 fell back to bounds: 11.5 kg' },
      { code: MJCF_PROBLEM_NO_FORCE_LIMIT, node: 'A3', severity: 'warning', message: 'A3 has no forcerange' },
    ];
    const two: MjcfProblemLike[] = [
      { code: MJCF_PROBLEM_MASS_DEGRADED, node: 'Pallet', severity: 'warning', message: 'mass of Pallet fell back: 7.32 kg' },
    ];
    reportMjcfProblems('RegionA', one, 'RegionA');
    reportMjcfProblems('RegionB', two, 'RegionB');
    expect(mjcf()).toHaveLength(3);

    // Rewriting A with ONE finding drops A's second entry and leaves B alone.
    reportMjcfProblems('RegionA', one.slice(0, 1), 'RegionA');
    const after = mjcf();
    expect(after).toHaveLength(2);
    expect(after.some((p) => p.nodePath === 'RegionA/A3')).toBe(false);
    expect(after.some((p) => p.nodePath === 'RegionB/Pallet')).toBe(true);

    clearMjcfProblemsOf('RegionB');
    expect(mjcf()).toHaveLength(1);
  });

  it('does not double a row when one document raises the same code on the same node twice', () => {
    const twice: MjcfProblemLike[] = [
      { code: MJCF_PROBLEM_MASS_DEGRADED, node: 'A2', severity: 'warning', message: 'first reason' },
      { code: MJCF_PROBLEM_MASS_DEGRADED, node: 'A2', severity: 'warning', message: 'second reason' },
    ];
    reportMjcfProblems('Region', twice, 'Region');
    expect(mjcf()).toHaveLength(1);
  });

  it('points a region-level finding at the region itself', () => {
    reportMjcfProblems('Cell/Region', [
      { code: MJCF_PROBLEM_REGION_DISABLED, node: '', severity: 'info', message: 'RegionEnabled is false' },
    ], 'Cell/Region');
    const found = mjcf();
    expect(found).toHaveLength(1);
    expect(found[0].nodePath).toBe('Cell/Region');
    expect(found[0].title).toBe('Physics region is switched off');
  });

  it('a document with no findings publishes nothing — and clears what it had', () => {
    reportMjcfProblems('Region', [
      { code: MJCF_PROBLEM_MASS_DEGRADED, node: 'A2', severity: 'warning', message: 'x' },
    ], 'Region');
    expect(mjcf()).toHaveLength(1);
    reportMjcfProblems('Region', []);
    expect(mjcf()).toHaveLength(0);
  });

  it('clearMjcfProblems() empties the panel — the clear-model contract', () => {
    reportMjcfProblems('A', MJCF_PROBLEM_CODES.map((code) => ({
      code, node: 'N', severity: 'warning' as const, message: 'm',
    })), 'A');
    expect(mjcf()).toHaveLength(13);
    clearMjcfProblems();
    expect(mjcf()).toHaveLength(0);
    // And it is idempotent, because clearModel() runs at the head of EVERY load.
    clearMjcfProblems();
    expect(mjcf()).toHaveLength(0);
  });
});
