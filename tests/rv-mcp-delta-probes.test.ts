// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-707 T1 + T3 — the effect-delta mechanism.
 *
 * Two things are under test, and they matter for opposite reasons.
 *
 * T1 (safety): the delta wrapper sits in the ONE dispatch path of all 119
 * tools, so its failure mode is "the whole MCP surface stops working". Every
 * case here therefore asks the same question from a different angle — can this
 * damage a tool call? A throwing probe, an image payload, a JSON array, an
 * error result: none may change what the caller receives.
 *
 * T3 (truth): the op-log probe must tell "the tool named a group" apart from
 * "the tool actually moved its members" — the distinction the group-assignment
 * dead end turned on, and the reason the delta counts op KINDS rather than
 * reporting a boolean.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DELTA_PROBES,
  DELTA_MAX_ENTRIES,
  makeDelta,
  mergeDelta,
  parseResult,
  releaseCall,
  safeProbe,
  _inFlightCountForTest,
  _resetInFlightForTest,
  _setActiveDocForTest,
  type DeltaProbe,
  type ProbeContext,
} from '../src/plugins/mcp-bridge/rv-mcp-delta-probes';
import { allSchemas } from './helpers/mcp-schemas';

beforeEach(() => {
  _resetInFlightForTest();
  _setActiveDocForTest(null);
});

// ── Fixtures ────────────────────────────────────────────────────────────

type Op = { kind: string; ops?: { kind: string }[] };

/** A stand-in document: an op log and the snapshot fields the probes read. */
function fakeDoc(initial: Op[] = []) {
  const ops: Op[] = [...initial];
  let dirty = false;
  const doc = {
    ops,
    getSnapshot: () => ({
      id: 'doc-1', name: 'Asset', opCount: ops.length, dirty, base: { kind: 'empty' },
    }),
    opsSince: vi.fn((i: number) => ops.slice(Math.max(0, i))),
    append: (...added: Op[]) => { ops.push(...added); dirty = true; },
  };
  return doc;
}

function ctxFor(tool: string, callId = 1, viewer: unknown = {}): ProbeContext {
  return { viewer: viewer as never, tool, callId };
}

function runProbe(
  probe: DeltaProbe, tool: string, args: Record<string, unknown>,
  act: () => void, callId = 1, viewer: unknown = {},
) {
  const ctx = ctxFor(tool, callId, viewer);
  const snap = probe.before(ctx, args);
  act();
  return probe.after(ctx, args, snap, null);
}

// ── T1: the wrapper can never damage a call ─────────────────────────────

describe('T1 — mergeDelta never damages a result', () => {
  it('an image payload comes back byte-identical', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUg==';
    expect(mergeDelta(png, makeDelta(['a: 1→2']))).toBe(png);
  });

  it('a JSON array comes back unchanged — only objects are merged', () => {
    const arr = '[{"name":"D1"},{"name":"D2"}]';
    expect(mergeDelta(arr, makeDelta(['x']))).toBe(arr);
  });

  it('a result carrying `error` gets NO verified field (R9)', () => {
    const err = JSON.stringify({ error: 'Signal "X" not found' });
    const out = mergeDelta(err, makeDelta([], 'nothing happened'));
    expect(JSON.parse(out).verified).toBeUndefined();
    expect(out).toBe(err);
  });

  it('a null delta leaves the result alone', () => {
    const ok = JSON.stringify({ ok: true });
    expect(mergeDelta(ok, null)).toBe(ok);
  });

  it('the normal case adds `verified` and keeps every original field', () => {
    const src = JSON.stringify({ name: 'Sig1', value: false, previous: true });
    const out = JSON.parse(mergeDelta(src, makeDelta(['Sig1.value: true→false'])));
    expect(out.name).toBe('Sig1');
    expect(out.value).toBe(false);
    expect(out.previous).toBe(true);
    expect(out.verified.changed).toEqual(['Sig1.value: true→false']);
  });

  it('an empty or non-string result is passed through', () => {
    expect(mergeDelta('', makeDelta(['x']))).toBe('');
  });
});

describe('T1 — parseResult never throws', () => {
  it('returns null for non-JSON, arrays, empty and non-strings', () => {
    expect(parseResult('not json')).toBeNull();
    expect(parseResult('[1,2]')).toBeNull();
    expect(parseResult('')).toBeNull();
    expect(parseResult(undefined)).toBeNull();
    expect(parseResult(42)).toBeNull();
  });

  it('returns the object for a JSON object', () => {
    expect(parseResult('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('T1 — a throwing probe is swallowed', () => {
  it('safeProbe returns undefined instead of propagating', () => {
    expect(safeProbe(() => { throw new Error('probe exploded'); })).toBeUndefined();
    expect(safeProbe(() => 5)).toBe(5);
  });

  it('a probe that throws in `before` leaves `after` with no snapshot, and after copes', () => {
    const probe = DELTA_PROBES['web_editor_set_field'];
    const ctx = ctxFor('web_editor_set_field');
    const snap = safeProbe(() => probe.before(ctx, {})); // no document → undefined
    expect(() => probe.after(ctx, {}, snap, null)).not.toThrow();
    expect(probe.after(ctx, {}, undefined, null)).toBeNull();
  });
});

describe('T1 — the policy table is a decision, not an accident', () => {
  it('viewport-transient writes carry no probe', () => {
    for (const t of ['web_camera_set', 'web_camera_focus', 'web_camera_orbit',
      'web_camera_projection', 'web_view_isolate', 'web_view_pick', 'web_view_gaze',
      'web_select', 'web_select_similar', 'web_view_source_markers', 'web_node_bounds']) {
      expect(DELTA_PROBES[t], `${t} persists nothing and must have no probe`).toBeUndefined();
    }
  });

  it('the transient editor tools carry no probe either', () => {
    // They append no op by design; reporting `noop` would be true and misleading.
    expect(DELTA_PROBES['web_editor_verify_drive']).toBeUndefined();
    expect(DELTA_PROBES['web_editor_mechanism_jog']).toBeUndefined();
  });

  it('every probe key is a REAL tool name', () => {
    // The table is keyed by string. A typo does not fail anything — it just
    // silently means that tool never gets verified, which is precisely the
    // class of quiet nothing-happened this whole feature exists to expose.
    const announced = new Set(allSchemas().map((s) => s.name));
    const unknown = Object.keys(DELTA_PROBES).filter((k) => !announced.has(k));
    expect(unknown, `DELTA_PROBES keys matching no announced tool: ${unknown.join(', ')}`)
      .toEqual([]);
  });

  it('no read-only tool carries a probe', () => {
    // A delta on a tool that changes nothing is noise by construction.
    const readOnly = new Set(
      allSchemas().filter((s) => s.annotations?.readOnlyHint === true).map((s) => s.name),
    );
    const wrong = Object.keys(DELTA_PROBES).filter((k) => readOnly.has(k));
    expect(wrong, `read-only tools must not be probed: ${wrong.join(', ')}`).toEqual([]);
  });

  it('the persisting families all carry one', () => {
    for (const t of ['web_signal_set_bool', 'web_signal_set_float', 'web_drive_jog',
      'web_sim_reset', 'web_mode_set', 'web_layout_place', 'web_editor_open',
      'web_editor_save', 'web_editor_assign_to_kinematic', 'web_editor_reparent']) {
      expect(DELTA_PROBES[t], `${t} persists state and must have a probe`).toBeTruthy();
    }
  });
});

// ── T1: argument-addressed probes ───────────────────────────────────────

describe('T1 — the signal probe reads one signal, not the store', () => {
  it('reports the transition', () => {
    const values = new Map<string, unknown>([['Sig1', true]]);
    const viewer = { signalStore: { get: (n: string) => values.get(n) } };
    const delta = runProbe(
      DELTA_PROBES['web_signal_set_bool'], 'web_signal_set_bool', { name: 'Sig1' },
      () => values.set('Sig1', false), 1, viewer,
    );
    expect(delta!.changed).toEqual(['Sig1.value: true→false']);
    expect(delta!.noop).toBeUndefined();
  });

  it('a write that changed nothing is a noop with a reason', () => {
    const values = new Map<string, unknown>([['Sig1', true]]);
    const viewer = { signalStore: { get: (n: string) => values.get(n) } };
    const delta = runProbe(
      DELTA_PROBES['web_signal_set_bool'], 'web_signal_set_bool', { name: 'Sig1' },
      () => { /* the tool "succeeded" and wrote nothing */ }, 1, viewer,
    );
    expect(delta!.noop).toBe(true);
    expect(delta!.changed).toEqual([]);
    expect(delta!.why).toBeTruthy();
  });

  it('is O(1): `get` twice, `getAll` never — even with 5000 signals (NF3)', () => {
    const values = new Map<string, unknown>();
    for (let i = 0; i < 5000; i++) values.set(`S${i}`, false);
    const get = vi.fn((n: string) => values.get(n));
    const getAll = vi.fn(() => values);
    const viewer = { signalStore: { get, getAll, size: values.size } };
    runProbe(
      DELTA_PROBES['web_signal_set_bool'], 'web_signal_set_bool', { name: 'S42' },
      () => values.set('S42', true), 1, viewer,
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(getAll).not.toHaveBeenCalled();
  });
});

describe('T1 — the drive probe reads command fields, not position', () => {
  it('reports jog flags flipping', () => {
    const drive = { name: 'D1', jogForward: false, jogBackward: false, targetSpeed: 100, currentPosition: 0 };
    const viewer = { drives: [drive] };
    const delta = runProbe(
      DELTA_PROBES['web_drive_jog'], 'web_drive_jog', { name: 'D1' },
      () => { drive.jogForward = true; drive.currentPosition = 12.5; }, 1, viewer,
    );
    expect(delta!.changed).toContain('D1.jogForward: false→true');
    // The position moved too, and must NOT be in the delta: it moves on the
    // next tick anyway, so a position diff reports noise or a false noop.
    expect(JSON.stringify(delta)).not.toContain('currentPosition');
  });
});

// ── T3: the op-log probe ────────────────────────────────────────────────

describe('T3 — op-log probe: what was appended', () => {
  it('counts primitives and flattens a composite', () => {
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const delta = runProbe(
      DELTA_PROBES['web_editor_kinematize'], 'web_editor_kinematize', {},
      () => doc.append({
        kind: 'composite',
        ops: [
          ...Array.from({ length: 8 }, () => ({ kind: 'reparentNode' })),
          { kind: 'addComponent' },
        ],
      }),
    );
    expect(delta!.changed).toContain('reparentNode×8');
    expect(delta!.changed).toContain('addComponent×1');
    // The composite wrapper itself is NOT what happened.
    expect(delta!.changed.some((c) => c.startsWith('composite'))).toBe(false);
  });

  it('a tool that appended nothing is a noop — scenario A3', () => {
    const doc = fakeDoc([{ kind: 'setField' }]);
    _setActiveDocForTest(() => doc as never);
    const delta = runProbe(
      DELTA_PROBES['web_editor_assign_to_kinematic'], 'web_editor_assign_to_kinematic', {},
      () => { /* the tool answered { ok: true } and appended nothing */ },
    );
    expect(delta!.noop).toBe(true);
    expect(delta!.changed).toEqual([]);
    expect(delta!.why).toContain('appended no op');
  });

  it('"named" and "moved" are DIFFERENT deltas — the A3 distinction', () => {
    // Assignment alone writes one setField: the group exists, nothing moved.
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const named = runProbe(
      DELTA_PROBES['web_editor_assign_to_kinematic'], 'web_editor_assign_to_kinematic', {},
      () => doc.append({ kind: 'setField' }),
    );
    expect(named!.changed).toEqual(['setField×1']);
    expect(named!.changed.some((c) => c.startsWith('reparentNode'))).toBe(false);

    // Reparenting the members is what actually makes the axis carry them.
    const moved = runProbe(
      DELTA_PROBES['web_editor_reparent'], 'web_editor_reparent', {},
      () => doc.append({ kind: 'composite', ops: [{ kind: 'reparentNode' }, { kind: 'reparentNode' }] }),
      2,
    );
    expect(moved!.changed).toEqual(['reparentNode×2']);
  });

  it('`before` reads opCount only — it never touches the ops getter (R4/NF3)', () => {
    const doc = fakeDoc(Array.from({ length: 1200 }, () => ({ kind: 'setField' })));
    let opsReads = 0;
    const spied = {
      ...doc,
      get ops() { opsReads++; return (doc as unknown as { ops: Op[] }).ops; },
      getSnapshot: doc.getSnapshot,
      opsSince: doc.opsSince,
    };
    _setActiveDocForTest(() => spied as never);
    const ctx = ctxFor('web_editor_set_field');
    DELTA_PROBES['web_editor_set_field'].before(ctx, {});
    expect(opsReads).toBe(0);
  });

  it('`before` does NOT walk the scene graph (NF3)', () => {
    // A node count in the op probe's snapshot would be a full traverse per
    // editor write — six figures of callback on a real CAD import, for a
    // number that probe never reads.
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    let traversals = 0;
    const viewer = {
      currentModelRoot: { traverse: () => { traversals++; } },
    };
    DELTA_PROBES['web_editor_set_field']
      .before(ctxFor('web_editor_set_field', 600, viewer), {});
    expect(traversals).toBe(0);
  });

  it('`after` maps only the tail (opsSince), never the whole log', () => {
    const doc = fakeDoc(Array.from({ length: 1200 }, () => ({ kind: 'setField' })));
    _setActiveDocForTest(() => doc as never);
    runProbe(
      DELTA_PROBES['web_editor_set_field'], 'web_editor_set_field', {},
      () => doc.append({ kind: 'transformNode' }, { kind: 'transformNode' }),
    );
    expect(doc.opsSince).toHaveBeenCalledTimes(1);
    expect(doc.opsSince).toHaveBeenCalledWith(1200);
    expect(doc.opsSince.mock.results[0].value).toHaveLength(2);
  });
});

// ── T1/R13: overlapping calls ───────────────────────────────────────────

describe('T1 — overlapping calls are reported, not attributed (R13)', () => {
  it('two writes on the SAME document: the overlap is admitted', () => {
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_set_field'];
    const ctxA = ctxFor('web_editor_set_field', 101);
    const ctxB = ctxFor('web_editor_set_field', 102);

    // A opens its window, B opens and closes inside it, then A closes.
    const snapA = probe.before(ctxA, {});
    const snapB = probe.before(ctxB, {});
    doc.append({ kind: 'setField' });
    const deltaB = probe.after(ctxB, {}, snapB, null);
    doc.append({ kind: 'transformNode' });
    const deltaA = probe.after(ctxA, {}, snapA, null);

    expect(deltaB!.ambiguous).toBe(true);
    expect(deltaB!.changed).toEqual([]);
    expect(deltaB!.why).toContain('overlapping call');
    expect(deltaA!.ambiguous).toBe(true);
  });

  it('`noop` survives an overlap — "nothing happened" needs no attribution', () => {
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_set_field'];
    const ctxA = ctxFor('web_editor_set_field', 201);
    const ctxB = ctxFor('web_editor_set_field', 202);

    const snapA = probe.before(ctxA, {});
    const snapB = probe.before(ctxB, {});
    // Neither appended anything.
    const deltaB = probe.after(ctxB, {}, snapB, null);
    const deltaA = probe.after(ctxA, {}, snapA, null);

    expect(deltaB!.noop).toBe(true);
    expect(deltaB!.ambiguous).toBeUndefined();
    expect(deltaA!.noop).toBe(true);
  });

  it('different scopes never interfere — two signals stay unambiguous', () => {
    const values = new Map<string, unknown>([['A', false], ['B', false]]);
    const viewer = { signalStore: { get: (n: string) => values.get(n) } };
    const probe = DELTA_PROBES['web_signal_set_bool'];
    const ctxA = ctxFor('web_signal_set_bool', 301, viewer);
    const ctxB = ctxFor('web_signal_set_bool', 302, viewer);

    const snapA = probe.before(ctxA, { name: 'A' });
    const snapB = probe.before(ctxB, { name: 'B' });
    values.set('A', true);
    values.set('B', true);
    const deltaB = probe.after(ctxB, { name: 'B' }, snapB, null);
    const deltaA = probe.after(ctxA, { name: 'A' }, snapA, null);

    expect(deltaA!.ambiguous).toBeUndefined();
    expect(deltaB!.ambiguous).toBeUndefined();
    expect(deltaA!.changed).toEqual(['A.value: false→true']);
    expect(deltaB!.changed).toEqual(['B.value: false→true']);
  });

  it('a call whose `after` never ran is released anyway', () => {
    // The tool body threw, so the dispatcher jumped to its catch and the probe's
    // own `after` was skipped. Without the `finally` cleanup that call would sit
    // in its scope forever and poison every later delta there.
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_set_field'];

    probe.before(ctxFor('web_editor_set_field', 500), {});   // never completes
    expect(_inFlightCountForTest()).toBe(1);
    releaseCall(500);
    expect(_inFlightCountForTest()).toBe(0);

    // The next call must be clean, not tainted by the abandoned one.
    const delta = runProbe(
      probe, 'web_editor_set_field', {},
      () => doc.append({ kind: 'setField' }), 501,
    );
    expect(delta!.ambiguous).toBeUndefined();
    expect(delta!.changed).toEqual(['setField×1']);
  });

  it('releaseCall is idempotent and ignores unknown ids', () => {
    expect(() => { releaseCall(9999); releaseCall(9999); }).not.toThrow();
    expect(_inFlightCountForTest()).toBe(0);
  });

  it('the registry does not leak: sequential calls stay unambiguous', () => {
    const doc = fakeDoc();
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_set_field'];
    for (let i = 0; i < 3; i++) {
      const delta = runProbe(
        probe, 'web_editor_set_field', {},
        () => doc.append({ kind: 'setField' }), 400 + i,
      );
      expect(delta!.ambiguous, `call ${400 + i} must be unambiguous`).toBeUndefined();
      expect(delta!.changed).toEqual(['setField×1']);
    }
  });
});

// ── Editor lifecycle: the A2 rule ───────────────────────────────────────

describe('T3 — the open probe catches an empty library document (A2)', () => {
  function viewerWithNodes(n: number) {
    return {
      currentModelRoot: n > 0 ? { traverse: (cb: () => void) => { for (let i = 0; i < n; i++) cb(); } } : null,
    };
  }

  it('a libraryGlb that produced no tree is a noop with the re-import advice', () => {
    let current: ReturnType<typeof fakeDoc> | null = null;
    _setActiveDocForTest(() => current as never);
    const probe = DELTA_PROBES['web_editor_open'];
    const viewer = viewerWithNodes(1);
    const ctx = ctxFor('web_editor_open', 1, viewer);

    const snap = probe.before(ctx, { source: 'library' });
    const opened = fakeDoc();
    opened.getSnapshot = () => ({
      id: 'doc-2', name: 'BigAsset', opCount: 0, dirty: false, base: { kind: 'document' },
    });
    current = opened;
    const delta = probe.after(ctx, { source: 'library' }, snap, null);

    expect(delta!.noop).toBe(true);
    expect(delta!.why).toContain('imports/');
  });

  it('a library document that DID open is not a noop', () => {
    let current: ReturnType<typeof fakeDoc> | null = null;
    _setActiveDocForTest(() => current as never);
    const probe = DELTA_PROBES['web_editor_open'];
    const viewer = viewerWithNodes(880);
    const ctx = ctxFor('web_editor_open', 1, viewer);

    const snap = probe.before(ctx, { source: 'library' });
    const opened = fakeDoc();
    opened.getSnapshot = () => ({
      id: 'doc-3', name: 'BigAsset', opCount: 0, dirty: false, base: { kind: 'document' },
    });
    current = opened;
    const delta = probe.after(ctx, { source: 'library' }, snap, null);

    expect(delta!.noop).toBeUndefined();
    expect(delta!.changed[0]).toContain('880 nodes');
  });
});

describe('T3 — the save probe reports persistence, not intent', () => {
  it('a save that cleared dirty reports the transition', () => {
    const doc = fakeDoc();
    doc.append({ kind: 'setField' }); // makes it dirty
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_save'];
    const ctx = ctxFor('web_editor_save');
    const snap = probe.before(ctx, {});
    doc.getSnapshot = () => ({ id: 'doc-1', name: 'Asset', opCount: 1, dirty: false, base: { kind: 'empty' } });
    const delta = probe.after(ctx, {}, snap, null);
    expect(delta!.changed).toContain('dirty: true→false');
  });

  it('a save that left it dirty says so', () => {
    const doc = fakeDoc();
    doc.append({ kind: 'setField' });
    _setActiveDocForTest(() => doc as never);
    const probe = DELTA_PROBES['web_editor_save'];
    const ctx = ctxFor('web_editor_save');
    const snap = probe.before(ctx, {});
    const delta = probe.after(ctx, {}, snap, null);
    expect(delta!.noop).toBe(true);
    expect(delta!.why).toContain('nothing was persisted');
  });
});

describe('makeDelta — shape', () => {
  it('an empty change list is a noop', () => {
    const d = makeDelta([]);
    expect(d.noop).toBe(true);
    expect(d.changed).toEqual([]);
    expect(d.more).toBeUndefined();
  });

  it('a full list is neither noop nor capped', () => {
    const d = makeDelta(['a', 'b']);
    expect(d.noop).toBeUndefined();
    expect(d.more).toBeUndefined();
    expect(d.changed).toHaveLength(2);
  });

  it('caps at DELTA_MAX_ENTRIES and counts the rest', () => {
    const d = makeDelta(Array.from({ length: DELTA_MAX_ENTRIES + 5 }, (_, i) => `x${i}`));
    expect(d.changed).toHaveLength(DELTA_MAX_ENTRIES);
    expect(d.more).toBe(5);
  });
});
