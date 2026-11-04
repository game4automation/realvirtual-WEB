// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.6 — I4 fires on `severity: 'error'` and stays silent on
 * `warning` and `info`. Explicitly covered: `placement-cap` and
 * `override-orphaned`, the two codes an earlier plan draft listed as errors
 * when they are in fact warnings (`problems-store.ts:355`, `:630`). plan-610:
 * `reference-unresolved` is an error, `reference-rescued` a warning.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { checkInvariants, checkNoErrorProblems, resetInvariants } from '../src/core/engine/rv-invariants';
import { clearAllProblems, reportProblem, reportReferenceAudit } from '../src/core/hmi/problems-store';
import { makeStubViewer } from './helpers/invariant-stub-viewer';

describe('I4 — Problems entries with severity error', () => {
  beforeEach(() => { clearAllProblems(); });

  it('stays silent on an empty store', () => {
    expect(checkNoErrorProblems()).toEqual([]);
  });

  it('fires on an error entry and names its code', () => {
    reportProblem({ id: 'x', severity: 'error', code: 'missing-reference', title: 'Missing reference', detail: 'd' });
    const found = checkNoErrorProblems();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^I4 missing-reference: /);
  });

  it('stays silent on placement-cap — it is a WARNING, not an error', () => {
    reportProblem({ id: 'cap', severity: 'warning', code: 'placement-cap', title: 'Placement cap reached', detail: 'd' });
    expect(checkNoErrorProblems()).toEqual([]);
  });

  it('stays silent on override-orphaned — also a WARNING', () => {
    reportProblem({ id: 'orph', severity: 'warning', code: 'override-orphaned', title: 'Override orphaned', detail: 'd' });
    expect(checkNoErrorProblems()).toEqual([]);
  });

  it('fires on reference-unresolved (plan-610: an ERROR) and stays silent on reference-rescued (a WARNING)', () => {
    reportReferenceAudit([
      { kind: 'unresolved', referrerPath: 'Cell/Panel', componentType: 'Holder', field: 'Ref', writtenPath: 'Cell/Gone' },
      {
        kind: 'rescued', referrerPath: 'Cell/Lift', componentType: 'Drive_Cylinder', field: 'In',
        writtenPath: 'FG01/X', resolvedPath: 'Cell/Signals/FG01/X', stage: 'suffix',
      },
    ]);
    const found = checkNoErrorProblems();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^I4 reference-unresolved: /);
  });

  it('stays silent on info entries', () => {
    reportProblem({ id: 'i', severity: 'info', code: 'signal-reconcile', title: 'Reconciled', detail: 'd' });
    expect(checkNoErrorProblems()).toEqual([]);
  });

  it('filters by the severity FIELD, not by a list of known codes', () => {
    // A code nobody has ever seen, with severity error, must still fire —
    // that is the whole point of reading the field the store maintains.
    reportProblem({ id: 'novel', severity: 'error', code: 'a-code-invented-today', title: 'Novel', detail: 'd' });
    reportProblem({ id: 'warn', severity: 'warning', code: 'missing-reference', title: 'Also novel', detail: 'd' });
    const found = checkNoErrorProblems();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('a-code-invented-today');
  });

  it('is returned by checkInvariants at every reason — I4 is synchronous', () => {
    const v = makeStubViewer();
    resetInvariants(v);
    reportProblem({ id: 'e', severity: 'error', code: 'bake-failed', title: 'Bake failed', detail: 'd' });
    for (const reason of ['explicit', 'model-loaded', 'mode-changing', 'mode-changed'] as const) {
      expect(checkInvariants(v, reason).some((m) => m.startsWith('I4 bake-failed')), reason).toBe(true);
    }
  });
});
