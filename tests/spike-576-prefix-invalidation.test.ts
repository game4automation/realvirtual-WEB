// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * spike-576-prefix-invalidation.test.ts -- plan-576 Phase 1, FRAGE B.
 *
 * Erkenntnis, kein Feature. Plan 2.5 lists four history mutations it BELIEVES
 * falsify a bare prefix counter, and plan risk table calls the fifth (an
 * identical `restoreHistory`) the highest risk in the plan -- because
 * `recomposeProjection` does exactly that on the way back, so a counter it
 * invalidates would make the binding refuse in the NORMAL path. This file runs
 * all five against a live `RvDocument` and reports which ones a remembered
 * counter survives.
 *
 * **Every test here passes.** They document the IST state, including where that
 * state is the bug.
 *
 * -- Measured answer to Frage B ---------------------------------------------
 *
 * | # | Mutation | Counter still valid? | How it is detectable |
 * |---|---|---|---|
 * | 1 | Coalescing | **NO** | `opCount` and the op ID at the boundary are UNCHANGED while the payload changed -- invisible to a counter AND to an id check (B1) |
 * | 2 | `_enforceCap` (> 500) | **NO** | positions shift by `drop`; `_baselineFloor` is pulled along (rv-document.ts:756), a foreign counter is not (B2) |
 * | 3 | Undo + another edit of equal length | **NO** | same `opCount`, different op ID at the boundary -- detectable by ID, not by number (B3) |
 * | 4 | `rollbackTo(floor)` | **NO**, but DETECTABLE while shorter | `prefix > opCount` while the log is short; re-growing to the same length makes it undetectable again by number alone (B4) |
 * | 5 | Identical `restoreHistory` (`recomposeProjection`) | **YES** | ops are restored by value AND identity -- no divergence (B5/B6) |
 *
 * The protection rule the plan wants to extend, `headIsAboveFloor`
 * (rv-document.ts:737-739), does hold and does transfer: it is a pure
 * "is the head ABOVE this boundary" test on `_ops.length` vs. one number, so a
 * second boundary plugs in with the same single comparison (B7/B8).
 */

import { describe, it, expect } from 'vitest';
import { RvDocument } from '../src/core/ops/rv-document';
import { recomposeProjection } from '../src/core/ops/rv-document-projection';
import { MAX_OP_HISTORY } from '../src/core/ops/rv-op-utils';
import { RecordingExecutor } from './helpers/stack-test-viewer';
import type { RvOp } from '../src/core/ops/rv-unified-ops';

// --- Fixtures ----------------------------------------------------------

let opSeq = 0;

/** A coalescable op: same node/component/field, so `canCoalesceRvOps` says yes. */
function setField(value: number, ts = 10_000, nodePath = 'Asset/Box'): RvOp {
  return {
    id: `op_B_${++opSeq}`, ts, schemaV: 1,
    kind: 'setField',
    nodePath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 50,
  } as unknown as RvOp;
}

/** A never-coalescing op (`addPlacement` is structural in both lineages). */
function structural(id = `plc_${++opSeq}`, ts = 10_000): RvOp {
  return {
    id: `op_B_${++opSeq}`, ts, schemaV: 1,
    kind: 'addPlacement',
    placement: {
      id, assetId: 'lib/belt', name: 'Belt',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
    },
  } as unknown as RvOp;
}

function makeDoc(baselineFloor = 0): RvDocument {
  return new RvDocument({
    id: 'doc_576', name: 'Spike 576', mode: 'scene',
    executor: new RecordingExecutor(), baselineFloor,
  });
}

/** What a coverage stamp could plausibly remember today. */
interface Stamp {
  prefix: number;
  /** The op the prefix ENDS ON, for an id-based cross-check. */
  lastId: string | null;
  /** A content fingerprint of the covered prefix, for the strictest check. */
  fingerprint: string;
}

function stampOf(doc: RvDocument, prefix = doc.opCount): Stamp {
  const ops = doc.captureHistory().ops.slice(0, prefix);
  return {
    prefix,
    lastId: ops[ops.length - 1]?.id ?? null,
    fingerprint: JSON.stringify(ops),
  };
}

function currentOf(doc: RvDocument, prefix: number): Stamp {
  const ops = doc.captureHistory().ops.slice(0, prefix);
  return {
    prefix,
    lastId: ops[ops.length - 1]?.id ?? null,
    fingerprint: JSON.stringify(ops),
  };
}

// ======================================================================
// B1 -- Coalescing.
// ======================================================================

describe('B1 -- Coalescing (rv-document.ts:739 + mergeRvOps, rv-unified-ops.ts:475)', () => {
  it('MESSUNG B1: same length AND same op ID, different content -- a counter cannot see it', async () => {
    const doc = makeDoc();
    await doc.applyOp(setField(100, 10_000));
    const before = stampOf(doc);
    expect(before.prefix).toBe(1);

    // Inside the 500 ms window, same target -> merged into the head.
    await doc.applyOp(setField(999, 10_300));

    const after = currentOf(doc, before.prefix);
    // The two signals a stamp could carry are both unchanged...
    expect(doc.opCount).toBe(before.prefix);
    expect(after.lastId).toBe(before.lastId);
    // ...while the op the stamp claims to describe now says something else.
    expect(after.fingerprint).not.toBe(before.fingerprint);
    const head = doc.captureHistory().ops[0] as unknown as { value: number };
    expect(head.value).toBe(999);
  });

  it('MESSUNG B1b: mergeRvOps keeps `id`, `ts` and `prev` -- so an id+length pair is NOT a guard', async () => {
    const doc = makeDoc();
    await doc.applyOp(setField(100, 10_000));
    const first = doc.captureHistory().ops[0] as unknown as { id: string; ts: number; prev: number };
    await doc.applyOp(setField(777, 10_100));
    const merged = doc.captureHistory().ops[0] as unknown as { id: string; ts: number; prev: number; value: number };
    expect(merged.id).toBe(first.id);
    expect(merged.ts).toBe(first.ts);
    expect(merged.prev).toBe(first.prev);
    expect(merged.value).toBe(777);
    // Consequence for Phase 2: only a CONTENT fingerprint or a no-coalesce rule
    // at the boundary can protect a prefix here. The plan chooses the latter
    // (B7/B8), which is the cheaper of the two.
  });

  it('MESSUNG B1c: coalescing only ever touches the HEAD, so only the topmost prefix is at risk', async () => {
    const doc = makeDoc();
    await doc.applyOp(setField(100, 10_000));
    await doc.applyOp(structural());            // intervening op
    const before = stampOf(doc, 1);             // a prefix BELOW the head
    await doc.applyOp(setField(999, 10_000));   // cannot merge: head is a different kind
    expect(doc.opCount).toBe(3);
    expect(currentOf(doc, 1).fingerprint).toBe(before.fingerprint);
    // So the boundary that needs protecting is exactly `prefix === opCount`
    // -- which is the only case `headIsAboveFloor` has to decide.
  });
});

// ======================================================================
// B2 -- The history cap.
// ======================================================================

describe('B2 -- _enforceCap (rv-document.ts:752)', () => {
  it('MESSUNG B2: every position shifts, baselineFloor is pulled along, a foreign counter is not', async () => {
    const floor = 10;
    const doc = makeDoc(floor);
    expect(doc.baselineFloor).toBe(floor);

    // Fill exactly to the cap with non-coalescing ops.
    for (let i = 0; i < MAX_OP_HISTORY; i++) await doc.applyOp(structural());
    expect(doc.opCount).toBe(MAX_OP_HISTORY);

    const stamp = stampOf(doc, 20);
    const idAt19Before = doc.captureHistory().ops[19].id;

    // One over the cap -> `_ops.splice(0, 1)`.
    await doc.applyOp(structural());
    expect(doc.opCount).toBe(MAX_OP_HISTORY);

    // The document moved its OWN boundary...
    expect(doc.baselineFloor).toBe(floor - 1);
    // ...and the remembered prefix now points one op too far: op 19 is the op
    // that used to be op 20.
    expect(doc.captureHistory().ops[19].id).not.toBe(idAt19Before);
    expect(currentOf(doc, stamp.prefix).fingerprint).not.toBe(stamp.fingerprint);
    expect(currentOf(doc, stamp.prefix).lastId).not.toBe(stamp.lastId);
  });

  it('MESSUNG B2b: a drop LARGER than the prefix leaves nothing of it -- plan 2.5 "prefix < drop"', async () => {
    const doc = makeDoc();
    for (let i = 0; i < 3; i++) await doc.applyOp(structural());
    const stamp = stampOf(doc);            // prefix = 3
    for (let i = 0; i < MAX_OP_HISTORY + 2; i++) await doc.applyOp(structural());
    // The cap dropped 5 ops, i.e. more than the prefix covered -- none of the
    // covered ops is in the log any more. The ONLY way to notice is that the
    // document counted the drop; the number alone is still <= opCount and so
    // still looks plausible.
    expect(stamp.prefix).toBeLessThanOrEqual(doc.opCount);
    expect(currentOf(doc, stamp.prefix).fingerprint).not.toBe(stamp.fingerprint);
  });
});

// ======================================================================
// B3 -- Undo, then another edit of equal length.
// ======================================================================

describe('B3 -- Undo + another edit of equal length', () => {
  it('MESSUNG B3: identical opCount, different content -- a number cannot see it, an ID can', async () => {
    const doc = makeDoc();
    await doc.applyOp(structural('a'));
    await doc.applyOp(structural('b'));
    const stamp = stampOf(doc);
    expect(stamp.prefix).toBe(2);

    await doc.undo();
    expect(doc.opCount).toBe(1);
    await doc.applyOp(structural('c'));
    expect(doc.opCount).toBe(2);

    const after = currentOf(doc, stamp.prefix);
    expect(after.prefix).toBe(stamp.prefix);       // the number is unchanged...
    expect(after.lastId).not.toBe(stamp.lastId);   // ...the identity is not.
    expect(after.fingerprint).not.toBe(stamp.fingerprint);
  });
});

// ======================================================================
// B4 -- rollbackTo (the discard of a binding).
// ======================================================================

describe('B4 -- rollbackTo (rv-document.ts:596)', () => {
  it('MESSUNG B4: cuts the log -- detectable while short, undetectable once re-grown', async () => {
    const doc = makeDoc();
    for (let i = 0; i < 3; i++) await doc.applyOp(structural());
    const stamp = stampOf(doc);
    expect(stamp.prefix).toBe(3);

    const taken = await doc.rollbackTo(1);
    expect(taken).toBe(2);
    expect(doc.opCount).toBe(1);
    // While the log is shorter, `prefix > opCount` is a decidable refusal
    // (plan 2.5 `prefix-beyond-log`).
    expect(stamp.prefix).toBeGreaterThan(doc.opCount);

    // Re-grow to the same length and that signal is gone.
    await doc.applyOp(structural());
    await doc.applyOp(structural());
    expect(doc.opCount).toBe(stamp.prefix);
    expect(currentOf(doc, stamp.prefix).fingerprint).not.toBe(stamp.fingerprint);
  });

  it('MESSUNG B4b: rollbackTo also clears the redo branch -- the state is not recoverable', async () => {
    const doc = makeDoc();
    for (let i = 0; i < 3; i++) await doc.applyOp(structural());
    await doc.rollbackTo(1);
    expect(doc.canRedo()).toBe(false);
  });
});

// ======================================================================
// B5/B6 -- restoreHistory with an IDENTICAL history. The critical case.
// ======================================================================

describe('B5 -- restoreHistory with an identical history (rv-document.ts:682)', () => {
  it('MESSUNG B5: a byte-identical restore changes NOTHING -- a counter survives', async () => {
    const doc = makeDoc(1);
    await doc.applyOp(structural());
    await doc.applyOp(setField(100, 10_000));
    const stamp = stampOf(doc);

    const frozen = doc.captureHistory();
    doc.restoreHistory(frozen);

    const after = currentOf(doc, stamp.prefix);
    expect(doc.opCount).toBe(stamp.prefix);
    expect(after.lastId).toBe(stamp.lastId);
    expect(after.fingerprint).toBe(stamp.fingerprint);
    // Identity, not just value: the restore copies the ARRAY, never the ops.
    expect(doc.captureHistory().ops[0]).toBe(frozen.ops[0]);
    expect(doc.baselineFloor).toBe(1);
  });

  it('MESSUNG B6: a real recomposeProjection round trip leaves the log untouched', async () => {
    const doc = makeDoc(1);
    await doc.applyOp(structural());
    await doc.applyOp(setField(100, 10_000));
    const stamp = stampOf(doc);
    const idsBefore = doc.captureHistory().ops.map((o) => o.id);

    // The way back from a bound editor session, verbatim: `replay: 'none'`,
    // because the authored bytes already carry both halves of the log.
    let reloaded = 0;
    await recomposeProjection({
      doc,
      reload: async () => { reloaded++; },
      replay: 'none',
      label: 'spike-576',
    });
    expect(reloaded).toBe(1);

    // Nothing moved. So Phase 2's `generation` MUST NOT be bumped here -- this
    // is the plan's highest-rated risk, and the measurement says the data gives
    // Phase 2 everything it needs to tell this apart (identical ids, identical
    // content, identical floor).
    expect(doc.opCount).toBe(stamp.prefix);
    expect(doc.captureHistory().ops.map((o) => o.id)).toEqual(idsBefore);
    expect(currentOf(doc, stamp.prefix).fingerprint).toBe(stamp.fingerprint);
    expect(doc.baselineFloor).toBe(1);
  });

  it('MESSUNG B6b: the same call with replay other than none would re-apply -- hence the asymmetry', async () => {
    const doc = makeDoc();
    await doc.applyOp(structural());
    const executor = doc.executor as RecordingExecutor;
    const forwardBefore = executor.forward.length;

    await recomposeProjection({ doc, reload: async () => {}, replay: 'all' });
    // The log is unchanged either way -- `restoreHistory` puts the freeze back
    // -- but the TREE got the op a second time. That is the duplication
    // mechanism plan 2.1 describes, visible here as executor traffic with an
    // unmoved log: a counter that only watches the log cannot see it.
    expect(executor.forward.length).toBe(forwardBefore + 1);
    expect(doc.opCount).toBe(1);
  });
});

// ======================================================================
// B7/B8 -- Does `headIsAboveFloor` transfer to a second boundary?
// ======================================================================

describe('B7 -- the headIsAboveFloor protection rule (rv-document.ts:737-739)', () => {
  it('MESSUNG B7: with the head AT the floor, two coalescable ops do NOT merge', async () => {
    const doc = makeDoc();
    await doc.applyOp(setField(100, 10_000));
    // Arm the floor at the current head -- the state a save/bind leaves behind.
    doc.markSaved({ floor: 1 });
    expect(doc.baselineFloor).toBe(1);

    await doc.applyOp(setField(999, 10_100));
    // Appended, not merged: the protected op kept its payload.
    expect(doc.opCount).toBe(2);
    expect((doc.captureHistory().ops[0] as unknown as { value: number }).value).toBe(100);
    expect((doc.captureHistory().ops[1] as unknown as { value: number }).value).toBe(999);
  });

  it('MESSUNG B8: the rule is one comparison of opCount against ONE number -- a second boundary plugs in', async () => {
    // Control: with the floor BELOW the head the same two ops DO merge, so the
    // rule is doing the work rather than something else about this fixture.
    const doc = makeDoc();
    await doc.applyOp(setField(100, 10_000));
    await doc.applyOp(setField(200, 10_050));
    expect(doc.opCount, 'no floor -> merged').toBe(1);

    // And with the floor armed one op lower, the head is above it and merging
    // resumes. `max(baselineFloor, coverage.prefix)` is therefore the whole
    // Phase 2 change at this site: the condition takes a number, and the
    // stricter of two numbers is still a number.
    const doc2 = makeDoc();
    await doc2.applyOp(structural());
    await doc2.applyOp(setField(100, 10_000));
    doc2.markSaved({ floor: 1 });
    await doc2.applyOp(setField(200, 10_050));
    expect(doc2.opCount, 'floor is below the head -> merged').toBe(2);
    expect((doc2.captureHistory().ops[1] as unknown as { value: number }).value).toBe(200);
  });
});
