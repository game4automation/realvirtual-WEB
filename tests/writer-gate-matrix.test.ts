// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * writer-gate-matrix.test.ts — plan-353 §9.5 (F6, F7, F8).
 *
 * The write-authority decision has seven dimensions (authority, writer kind,
 * writer identity, slot role, gate mode, authority ranking, remote ownership)
 * and three entry points (`canWriteSlot`, `set`, `setMany`). plan-320 left
 * behind a "matrix" that covered a handful of them and closed with an ellipsis;
 * this is the real one.
 *
 * Three things are asserted for every case, because they are three DIFFERENT
 * claims and the interesting bugs live in the gaps between them:
 *   1. the DECISION (`canWriteSlot` → allowed + reason) — what the UI says,
 *   2. the VALUE PATH (did the write actually land?) — what the store does,
 *   3. the CONFLICT LOG (is it recorded, and under which reason?) — what
 *      telemetry will show when `enforce` is finally switched on.
 *
 * The oracle is plan-353 §9.5. Its most important asymmetry: a `remote` writer
 * is not a local-simulation kind, so it never reaches `_gateRejects()` at all —
 * `canWriteSlot()` can answer "not allowed" for it while the write still lands.
 * That is intended, and pinning it here is the point: it must not surprise
 * anyone during the enforce rollout.
 *
 * Reduction is by NAMED equivalence class only (see `SIM_KINDS`), never by
 * omission.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SignalStore, type SignalWriterKind } from '../src/core/engine/rv-signal-store';
import {
  claimBound,
  claimForced,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  registerSlotWriteRole,
  resetSlotAuthority,
  setAuthorityRanking,
  setRemoteOwnershipActive,
  type SlotId,
  type SlotWriteRole,
} from '../src/core/engine/rv-slot-authority';

const CHANNEL = 'Conv.Run';
const FREE_CHANNEL = 'Free.Run';

/**
 * The local-simulation kinds. `behavior` and `sdk` are asserted to behave
 * exactly like `component` (own test below), which is what licenses using
 * `component` as their representative in the rest of the matrix.
 */
const SIM_KINDS: SignalWriterKind[] = ['component', 'behavior', 'sdk'];

/** Writer kinds that are NOT local simulation — the gate lets them past. */
const NON_SIM_KINDS: SignalWriterKind[] = [
  'hmi', 'plugin', 'remote', 'replay', 'mcp', 'debug', 'interface',
];

afterEach(() => {
  setAuthorityRanking('strict');
  setRemoteOwnershipActive(false);
  resetSlotAuthority();
});

interface Fixture {
  store: SignalStore;
  /** Add a slot on the shared channel with a claim and a role. */
  addSlot(name: string, claim: 'none' | 'bound' | 'forced', role?: SlotWriteRole): SlotId;
}

function fixture(): Fixture {
  const store = new SignalStore();
  store.register(CHANNEL, 'Conv/Run', false, 'PLCInputBool');
  store.register(FREE_CHANNEL, 'Free/Run', false, 'PLCInputBool');

  return {
    store,
    addSlot(name, claim, role) {
      const slotId = makeSlotId('el1', '.', 'Conveyor', name);
      registerSlotChannel(slotId, makeSignalChannelId(CHANNEL));
      if (role !== undefined) registerSlotWriteRole(slotId, role);
      if (claim === 'bound') claimBound(slotId);
      if (claim === 'forced') claimForced(slotId);
      return slotId;
    },
  };
}

/**
 * Run one oracle row through all three entry points.
 *
 * `landsInEnforce` is checked on a SECOND store configured identically, because
 * switching the gate mid-test would mix a shadow write into the enforce result.
 */
function checkRow(options: {
  build: (f: Fixture) => SlotId;
  writer: { writerId: string; writerKind: SignalWriterKind };
  allowed: boolean;
  reason: string;
  landsInShadow: boolean;
  landsInEnforce: boolean;
  conflictReason: string | null;
}): void {
  const { build, writer, allowed, reason, landsInShadow, landsInEnforce, conflictReason } = options;

  // ── 1. the decision (UI answer) ──
  const decisionFixture = fixture();
  const slotId = build(decisionFixture);
  expect(decisionFixture.store.canWriteSlot(slotId, writer)).toEqual({ allowed, reason });

  // ── 2a. value path via set(), shadow ──
  const shadow = fixture();
  build(shadow);
  const shadowWriter = shadow.store.createWriter(writer.writerId, writer.writerKind);
  shadowWriter.set(CHANNEL, true);
  expect(shadow.store.get(CHANNEL)).toBe(landsInShadow);

  // ── 3. the conflict log (recorded off the same shadow run) ──
  const conflicts = shadow.store.getWriteConflicts();
  if (conflictReason === null) {
    expect(conflicts).toHaveLength(0);
  } else {
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      writerId: writer.writerId,
      writerKind: writer.writerKind,
      reason: conflictReason,
    });
  }

  // ── 2b. value path via set(), enforce ──
  const enforced = fixture();
  build(enforced);
  enforced.store.signalWriteGate = 'enforce';
  const enforceWriter = enforced.store.createWriter(writer.writerId, writer.writerKind);
  enforceWriter.set(CHANNEL, true);
  expect(enforced.store.get(CHANNEL)).toBe(landsInEnforce);

  // ── 2c. value path via setMany(), enforce — same rule inside a batch, and
  //        an unclaimed channel in the same batch must still get through ──
  const batch = fixture();
  build(batch);
  batch.store.signalWriteGate = 'enforce';
  const batchWriter = batch.store.createWriter(writer.writerId, writer.writerKind);
  batchWriter.setMany({ [CHANNEL]: true, [FREE_CHANNEL]: true });
  expect(batch.store.get(CHANNEL)).toBe(landsInEnforce);
  expect(batch.store.get(FREE_CHANNEL)).toBe(true);
}

const SIM = { writerId: 'component:Conveyor', writerKind: 'component' as const };
const RELAY = { writerId: 'component:signal-binding-manager', writerKind: 'component' as const };
const FORCE = { writerId: 'hmi:force', writerKind: 'hmi' as const };
const REMOTE = { writerId: 'multiuser', writerKind: 'remote' as const };
const HMI = { writerId: 'hmi:panel', writerKind: 'hmi' as const };
const RAW_UNKNOWN = { writerId: 'unknown', writerKind: 'plugin' as const };
const CLASSIFIED_UNKNOWN = { writerId: 'unknown', writerKind: 'component' as const };

// ── The oracle, row by row (plan-353 §9.5) ─────────────────────────────────

describe('write-authority matrix — no claim on the channel', () => {
  it('anything writes an unclaimed channel', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'none'),
      writer: SIM,
      allowed: true, reason: 'ok',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });
});

describe('write-authority matrix — bound channel', () => {
  it('the relay is never in conflict with its own claim', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
      writer: RELAY,
      allowed: true, reason: 'ok',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });

  it('F6: a local writer MAY write a bound FEEDBACK slot', () => {
    // Command authority CONNECT, feedback authority the component. This is the
    // one behaviour change of plan-353 — before it, the write was rejected.
    checkRow({
      build: (f) => f.addSlot('Occupied', 'bound', 'feedback'),
      writer: SIM,
      allowed: true, reason: 'ok',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });

  it('a local writer may NOT write a bound CONTROL slot', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
      writer: SIM,
      allowed: false, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-bound',
    });
  });

  it("an UNKNOWN role is treated like control — no silent new write right", () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'unknown'),
      writer: SIM,
      allowed: false, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-bound',
    });
  });

  it('an UNREGISTERED role defaults to control (pre-plan-353 behaviour)', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound'),   // no role registered
      writer: SIM,
      allowed: false, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-bound',
    });
  });

  it('operator-style writers land, with an advisory reason and no conflict row', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
      writer: HMI,
      allowed: true, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });

  it('raw legacy (unknown id, kind plugin) never reaches the gate', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
      writer: RAW_UNKNOWN,
      allowed: true, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });

  it('F8: a classified writer with the legacy id is recorded but never rejected', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
      writer: CLASSIFIED_UNKNOWN,
      allowed: false, reason: 'authority-bound',
      landsInShadow: true, landsInEnforce: true, conflictReason: 'authority-bound',
    });
  });
});

describe('write-authority matrix — forced channel', () => {
  it('a local writer is denied by a forced slot claim', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'forced', 'control'),
      writer: SIM,
      allowed: false, reason: 'authority-forced',
      landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-forced',
    });
  });

  it('a forced FEEDBACK slot still denies — the force outranks every role', () => {
    checkRow({
      build: (f) => f.addSlot('Occupied', 'forced', 'feedback'),
      writer: SIM,
      allowed: false, reason: 'authority-forced',
      landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-forced',
    });
  });

  it('the force writer lands (no remote owner)', () => {
    checkRow({
      build: (f) => f.addSlot('Flow.Run', 'forced', 'control'),
      writer: FORCE,
      allowed: true, reason: 'ok',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });
});

describe('write-authority matrix — remote ownership × ranking', () => {
  it('force writer under a strict remote owner is flagged as overridden', () => {
    setRemoteOwnershipActive(true);
    setAuthorityRanking('strict');
    const f = fixture();
    const slotId = f.addSlot('Flow.Run', 'forced', 'control');
    expect(f.store.canWriteSlot(slotId, FORCE)).toEqual({ allowed: true, reason: 'authority-remote' });
  });

  it('remote writer passes a force under strict ranking with an active owner', () => {
    setRemoteOwnershipActive(true);
    setAuthorityRanking('strict');
    const f = fixture();
    const slotId = f.addSlot('Flow.Run', 'forced', 'control');
    expect(f.store.canWriteSlot(slotId, REMOTE)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('remote writer is refused under legacy ranking, or without an owner', () => {
    const f = fixture();
    const slotId = f.addSlot('Flow.Run', 'forced', 'control');

    setRemoteOwnershipActive(true);
    setAuthorityRanking('legacy');
    expect(f.store.canWriteSlot(slotId, REMOTE)).toEqual({ allowed: false, reason: 'authority-forced' });

    setAuthorityRanking('strict');
    setRemoteOwnershipActive(false);
    expect(f.store.canWriteSlot(slotId, REMOTE)).toEqual({ allowed: false, reason: 'authority-forced' });
  });

  it('the remote asymmetry: refused by canWriteSlot, yet the write is not gated', () => {
    // `remote` is not a local-sim kind, so `_gateRejects()` returns before it
    // ever looks at the claim. Only the store's own FORCE map stops the value —
    // which is a different mechanism with a different (unchanged) rule. This
    // must stay visible; it is the one place where the UI answer and the store
    // behaviour legitimately differ.
    const f = fixture();
    const slotId = f.addSlot('Flow.Run', 'forced', 'control');
    f.store.signalWriteGate = 'enforce';
    expect(f.store.canWriteSlot(slotId, REMOTE).allowed).toBe(false);

    // No store-level force → the claim alone does not stop a remote write.
    const remote = f.store.createWriter(REMOTE.writerId, REMOTE.writerKind);
    remote.set(CHANNEL, true);
    expect(f.store.get(CHANNEL)).toBe(true);
  });
});

describe('write-authority matrix — channel fan-out (F7)', () => {
  // The bug this closes: `_gateRejects()` returned at the FIRST claimed slot and
  // hard-coded 'authority-bound', so a forced slot registered second was both
  // invisible and mislabelled.
  for (const order of ['bound-then-forced', 'forced-then-bound'] as const) {
    it(`forced dominates bound regardless of registration order (${order})`, () => {
      checkRow({
        build: (f) => {
          if (order === 'bound-then-forced') {
            const bound = f.addSlot('Flow.Run', 'bound', 'control');
            f.addSlot('Flow.Stop', 'forced', 'control');
            return bound;
          }
          f.addSlot('Flow.Stop', 'forced', 'control');
          return f.addSlot('Flow.Run', 'bound', 'control');
        },
        writer: SIM,
        allowed: false, reason: 'authority-forced',
        landsInShadow: true, landsInEnforce: false,
        conflictReason: 'authority-forced',
      });
    });
  }

  for (const order of ['feedback-first', 'control-first'] as const) {
    it(`a single CONTROL slot on the channel rejects, whatever the order (${order})`, () => {
      // §2.4 rule 2: allowed only when ALL bound slots are feedback. One command
      // slot is enough to keep the local writer out, and the answer may not
      // depend on which slot happened to be registered first.
      checkRow({
        build: (f) => {
          if (order === 'feedback-first') {
            const fb = f.addSlot('Occupied', 'bound', 'feedback');
            f.addSlot('Flow.Run', 'bound', 'control');
            return fb;
          }
          f.addSlot('Flow.Run', 'bound', 'control');
          return f.addSlot('Occupied', 'bound', 'feedback');
        },
        writer: SIM,
        allowed: false, reason: 'authority-bound',
        landsInShadow: true, landsInEnforce: false,
        conflictReason: 'authority-bound',
      });
    });
  }

  it('two FEEDBACK slots on one channel still allow the local writer', () => {
    checkRow({
      build: (f) => {
        const a = f.addSlot('Occupied', 'bound', 'feedback');
        f.addSlot('AtTarget', 'bound', 'feedback');
        return a;
      },
      writer: SIM,
      allowed: true, reason: 'ok',
      landsInShadow: true, landsInEnforce: true, conflictReason: null,
    });
  });

  it('the conflict names the slot of the DECIDING authority, not the first one', () => {
    const f = fixture();
    f.addSlot('Flow.Run', 'bound', 'control');
    const forced = f.addSlot('Flow.Stop', 'forced', 'control');
    const sim = f.store.createWriter(SIM.writerId, SIM.writerKind);
    sim.set(CHANNEL, true);

    const conflicts = f.store.getWriteConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].slotId).toBe(forced);
    expect(conflicts[0].reason).toBe('authority-forced');
  });
});

describe('write-authority matrix — writer-kind equivalence classes', () => {
  it('behavior and sdk behave exactly like component on a bound control slot', () => {
    // The named equivalence class that licenses using `component` as the
    // representative everywhere above.
    for (const kind of SIM_KINDS) {
      checkRow({
        build: (f) => f.addSlot('Flow.Run', 'bound', 'control'),
        writer: { writerId: `${kind}:X`, writerKind: kind },
        allowed: false, reason: 'authority-bound',
        landsInShadow: true, landsInEnforce: false, conflictReason: 'authority-bound',
      });
    }
  });

  it('behavior and sdk also gain the feedback exemption', () => {
    for (const kind of SIM_KINDS) {
      checkRow({
        build: (f) => f.addSlot('Occupied', 'bound', 'feedback'),
        writer: { writerId: `${kind}:X`, writerKind: kind },
        allowed: true, reason: 'ok',
        landsInShadow: true, landsInEnforce: true, conflictReason: null,
      });
    }
  });

  it('every non-sim kind passes the gate on a bound control slot', () => {
    for (const kind of NON_SIM_KINDS) {
      const f = fixture();
      f.addSlot('Flow.Run', 'bound', 'control');
      f.store.signalWriteGate = 'enforce';
      const writer = f.store.createWriter(`${kind}:X`, kind);
      writer.set(CHANNEL, true);
      expect(f.store.get(CHANNEL), `kind ${kind} must not be gated`).toBe(true);
      expect(f.store.getWriteConflicts(), `kind ${kind} must not be logged`).toHaveLength(0);
    }
  });
});

describe('write-authority matrix — the gate default stays shadow (F9)', () => {
  it('a fresh store never enforces', () => {
    expect(new SignalStore().signalWriteGate).toBe('shadow');
  });
});
