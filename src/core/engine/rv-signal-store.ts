// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalStore - Central signal store for PLC signal communication.
 *
 * Framework-agnostic pub/sub store for boolean, integer, and float signals.
 * Two lookup tables:
 *   1. **By name** — Signal.Name (custom unique name) or node name (GameObject name).
 *      This is the primary addressing method used by plugins and HMI.
 *   2. **By path** — Full hierarchy path (e.g. "DemoCell/Signals/ConveyorStart").
 *      Used internally by the loader and for component-reference resolution.
 *
 * Both tables point to the same underlying value storage.
 * Listeners are only notified on actual value changes (equality check).
 *
 * Foundation for future React HMI binding (useSignal hook).
 */
import { debug } from './rv-debug';
import {
  deriveSignalActivity,
  type SignalActivity,
} from './rv-signal-activity';
import {
  signalProviderKey,
  type SignalSourceRef,
} from './rv-signal-provider';
import {
  channelForSlot,
  getSlotAuthority,
  getSlotWriteRole,
  remoteWriteOverridesForce,
  slotsForChannel,
  SIGNAL_BINDING_RELAY_WRITER_ID,
  type SignalChannelId,
  type SlotId,
} from './rv-slot-authority';

/**
 * Optional descriptive metadata for a signal, surfaced by the HMI (e.g. the
 * SignalBadge hover tooltip). Purely informational — never affects values.
 *   - `address` — protocol address / PLC symbol (e.g. `%I0.0`, `%QW2800`).
 *   - `comment` — free-text comment from the tag table / GLB rv_extras.
 *   - `source`  — origin label (e.g. `MQTT · Data_Q_1`, an interface name).
 */
export interface SignalMeta {
  address?: string;
  comment?: string;
  source?: string;
}

/** Stable classification attached to every named SignalStore writer. */
export type SignalWriterKind =
  | 'hmi'
  | 'plugin'
  | 'behavior'
  | 'component'
  | 'remote'
  | 'replay'
  | 'sdk'
  | 'mcp'
  | 'debug'
  | 'interface';

/** Optional Phase-0 context for a future slot-level authority decision. */
export interface SignalWriterOptions {
  slotContext?: string;
}

/** A SignalStore write façade permanently bound to one writer identity. */
export interface SignalWriter {
  readonly writerId: string;
  readonly writerKind: SignalWriterKind;
  readonly slotContext?: string;
  set(name: string, value: boolean | number, now?: number): void;
  setByPath(path: string, value: boolean | number, now?: number): void;
  setMany(updates: Record<string, boolean | number>, now?: number): void;
}

/** One deduplicated shadow-telemetry row for a (signal, writer) pair. */
export interface WriterInventoryEntry {
  readonly signal: string;
  readonly writerId: string;
  readonly writerKind: SignalWriterKind;
  readonly slotContext?: string;
  readonly firstSeenAt: number;
  writeCount: number;
  /** Development-only hint for an unclassified raw write. */
  readonly stack?: string;
}

interface WriterIdentity {
  readonly writerId: string;
  readonly writerKind: SignalWriterKind;
  readonly slotContext?: string;
}

/** Write-gate mode (plan-320 Phase 4). 'enforce' is prepared but NOT part of
 *  this plan's rollout — activation is a separate follow-up with its own gate. */
export type SignalWriteGateMode = 'shadow' | 'enforce';

/** One deduplicated write-authority conflict — additive to the inventory. */
export interface WriteConflict {
  /** SlotId of the conflicting slot; falls back to the channel (signal name)
   *  when the forced channel has no registered slot. */
  readonly slotId: string;
  readonly writerId: string;
  readonly writerKind: SignalWriterKind;
  /** 'authority-bound' | 'authority-forced' (see canWriteSlot for the taxonomy). */
  readonly reason: string;
  writeCount: number;
}

/** Local-simulation writer kinds — the kinds a live binding displaces. */
function isLocalSimKind(kind: SignalWriterKind): boolean {
  return kind === 'component' || kind === 'behavior' || kind === 'sdk';
}

// ── Write-authority decision codes (plan-353 NFR: allocation-free) ──────────
//
// The gate runs on the write path, so the decision travels as a SCALAR and the
// `{ allowed, reason }` object is built only in `canWriteSlot()`, the UI
// boundary. Codes below `DEC_DENY_BOUND` allow the write; the two above it deny
// it. That ordering is the whole encoding — see {@link decisionAllows}.

/** No authority contests the write. */
const DEC_OK = 0;
/** A binding owns the slot, but this writer still lands (hmi/mcp/debug/…). */
const DEC_ADVISORY_BOUND = 1;
/** The force writer lands, but a strict remote owner overrides it right after. */
const DEC_ALLOW_REMOTE = 2;
/** A live binding owns a command slot on this channel — local sim is displaced. */
const DEC_DENY_BOUND = 3;
/** An operator force pins this channel. */
const DEC_DENY_FORCED = 4;

/** True when the decision lets the write through. */
function decisionAllows(decision: number): boolean {
  return decision < DEC_DENY_BOUND;
}

/**
 * The reason string for a decision — the taxonomy `canWriteSlot()` documents
 * and `_recordConflict()` logs, so a UI hint and a telemetry row that describe
 * the same situation always use the same word.
 */
function decisionReason(decision: number): string {
  switch (decision) {
    case DEC_ADVISORY_BOUND:
    case DEC_DENY_BOUND: return 'authority-bound';
    case DEC_ALLOW_REMOTE: return 'authority-remote';
    case DEC_DENY_FORCED: return 'authority-forced';
    default: return 'ok';
  }
}

const UNKNOWN_WRITER: WriterIdentity = {
  writerId: 'unknown',
  writerKind: 'plugin',
};

const FORCE_WRITER: WriterIdentity = {
  writerId: 'hmi:force',
  writerKind: 'hmi',
};

class SignalWriterHandle implements SignalWriter {
  readonly writerId: string;
  readonly writerKind: SignalWriterKind;
  readonly slotContext?: string;

  constructor(
    private readonly store: SignalStore,
    identity: WriterIdentity,
  ) {
    this.writerId = identity.writerId;
    this.writerKind = identity.writerKind;
    this.slotContext = identity.slotContext;
  }

  set(name: string, value: boolean | number, now?: number): void {
    this.store.set(name, value, now ?? Date.now(), this);
  }

  setByPath(path: string, value: boolean | number, now: number = Date.now()): void {
    this.store.setByPath(path, value, now, this);
  }

  setMany(updates: Record<string, boolean | number>, now: number = Date.now()): void {
    this.store.setMany(updates, now, this);
  }
}

export class SignalStore {
  /** Canonical value store keyed by name (Signal.Name if set, otherwise node name). */
  private byName = new Map<string, boolean | number>();
  /** Path → name mapping for path-based access. */
  private pathToName = new Map<string, string>();
  /** PLC type per signal name (e.g. 'PLCOutputBool', 'PLCInputFloat'). */
  private typeByName = new Map<string, string>();
  /** Optional descriptive metadata (address/comment/source) per signal name. */
  private metaByName = new Map<string, SignalMeta>();
  /** Per-name listener sets. */
  private listeners = new Map<string, Set<(value: boolean | number) => void>>();
  /** Cache for resolved path lookups (avoids repeated suffix scans at runtime). */
  private resolveCache = new Map<string, string | null>();
  /** Monotonic version counter — incremented on every actual value change. */
  private _version = 0;

  /**
   * Forced (pinned) values keyed by name. While a name is in this map its value
   * is locked: incoming `set()` / `setByPath()` / `setMany()` updates from
   * interfaces (MQTT, WebSocket, simulation) are ignored, so the operator's
   * forced value wins — exactly like a PLC force in TIA Portal. Only
   * `forceSignal()` / `unforce()` mutate this map.
   */
  private forced = new Map<string, boolean | number>();
  /** Listeners notified whenever the forced SET changes (force/unforce), not on every value tick. */
  private forceListeners = new Set<() => void>();
  /**
   * Optional write-back sink. When set (e.g. by a CONNECT/PLC adapter), every
   * force/unforce is forwarded so the value can be pushed back to the gateway.
   * `value === null` means "released". Local-only forcing leaves this null.
   */
  private forceSink: ((name: string, value: boolean | number | null) => void) | null = null;

  /**
   * Timestamp (ms) of the last real adapter/sim write per signal name. Stamped
   * only in the genuine write path (`set`/`setByPath`/`setMany`) — **never** in
   * `_apply()`, so `forceSignal()` does NOT mark a dead signal as fresh. Used by
   * {@link getActivity} to derive live/stale/supplied.
   */
  private lastUpdateTs = new Map<string, number>();
  /** Reverse index name → path, populated on registration (mirror of `pathToName`). */
  private nameToPath = new Map<string, string>();
  /**
   * Optional connection provider injected by the interface layer (e.g. CONNECT
   * adapter / InterfaceManager). Given a `SignalMeta.source` label it returns
   * whether the supplying interface is currently connected. Injected exactly
   * like {@link setForceSink} — the store never imports connect-store /
   * interface-manager (keeps the engine decoupled from the HMI).
   */
  private connectionProvider?: (source: string) => boolean;
  /** Full provider identities and their currently discovered signal names. */
  private providerRefs = new Map<string, Omit<SignalSourceRef, 'signal'>>();
  private providerSignals = new Map<string, Set<string>>();
  private providersBySignal = new Map<string, Set<string>>();
  private providerConnected = new Map<string, boolean>();
  /**
   * Phase-0 shadow inventory. Nested maps avoid a composite-key allocation on
   * repeated writes; allocations occur only when a new (signal, writer) pair
   * is observed.
   */
  private writerInventory = new Map<string, Map<string, WriterInventoryEntry>>();
  /**
   * Phase-4 shadow-gate conflict log — same dedup infrastructure as the writer
   * inventory (nested maps slotKey → writerId → reason, no composite-key
   * allocation on repeated conflicting writes). Additive: existing inventory
   * entries and assertions are untouched.
   */
  private writeConflicts = new Map<string, Map<string, Map<string, WriteConflict>>>();
  /**
   * Write-gate mode (plan-320 Phase 4). Default 'shadow': conflicts are only
   * recorded, nothing is rejected. 'enforce' rejects classified writers whose
   * write contradicts the slot authority — `unknown` writers are NEVER
   * rejected, only recorded (raw store API stays legacy-compatible).
   */
  signalWriteGate: SignalWriteGateMode = 'shadow';

  /** Current version — changes only when signal values actually change. */
  get version(): number { return this._version; }

  /**
   * Create a write façade bound to a stable writer identity.
   *
   * This is observation-only in Phase 0: the façade never grants or rejects a
   * write and has exactly the same value semantics as the raw methods.
   */
  createWriter(
    writerId: string,
    writerKind: SignalWriterKind,
    options: SignalWriterOptions = {},
  ): SignalWriter {
    if (!writerId) throw new Error('SignalStore writerId must not be empty');
    return new SignalWriterHandle(this, {
      writerId,
      writerKind,
      slotContext: options.slotContext,
    });
  }

  /** Return a snapshot of the deduplicated runtime writer inventory. */
  getWriterInventory(): WriterInventoryEntry[] {
    const result: WriterInventoryEntry[] = [];
    for (const writers of this.writerInventory.values()) {
      for (const entry of writers.values()) result.push({ ...entry });
    }
    return result;
  }

  /** Reset Phase-0 shadow telemetry without changing any signal values.
   *  Also clears the Phase-4 conflict log (same telemetry infrastructure). */
  resetWriterInventory(): void {
    this.writerInventory.clear();
    this.writeConflicts.clear();
  }

  /** Snapshot of the deduplicated write-authority conflicts (Phase-4 shadow gate). */
  getWriteConflicts(): WriteConflict[] {
    const result: WriteConflict[] = [];
    for (const writers of this.writeConflicts.values()) {
      for (const reasons of writers.values()) {
        for (const entry of reasons.values()) result.push({ ...entry });
      }
    }
    return result;
  }

  /**
   * Synchronous UI answer to "may this writer take effect on this slot?"
   * (plan-320 Phase 4) — SEPARATE from the allocation-free internal gate path.
   *
   * `allowed` states whether a write by this writer reaches the store NOW;
   * `reason` names the dominating authority ('ok' when none). The reasons are
   * deliberately distinct from the plan-317 slot-availability reasons (F7/F10,
   * e.g. "no model signal"):
   *  - 'authority-forced' — the slot's channel is operator-forced; the write
   *    would be held (or, for the force writer under an active strict remote
   *    owner, would immediately be overridden).
   *  - 'authority-bound'  — a live binding owns the slot; a local-simulation
   *    write would be displaced by the relay.
   *  - 'authority-remote' — a remote session owner pre-empts this writer.
   */
  canWriteSlot(
    slotId: SlotId,
    writer: Pick<SignalWriter, 'writerId' | 'writerKind'>,
  ): { allowed: boolean; reason: string } {
    // Thin UI wrapper (plan-353 NFR): the DECISION is the allocation-free
    // scalar below; the object is created here, at the UI boundary, and only
    // here. Nothing on the write path may call this method.
    const decision = this._decideAuthority(slotId, channelForSlot(slotId), writer);
    return { allowed: decisionAllows(decision), reason: decisionReason(decision) };
  }

  /**
   * THE write-authority decision, as a scalar (plan-353 F6/F7/F8).
   *
   * One implementation for both callers — `canWriteSlot()` (UI) and
   * `_gateRejects()` (write path) — so the answer the operator reads and the
   * answer the store acts on cannot diverge. Returns a `DEC_*` code; no object
   * is allocated on any branch.
   *
   * `slotId` is optional context (the row the UI asked about); `channel` drives
   * the aggregation. Asking at CHANNEL level is deliberate and matches this
   * method's contract — "does a write by this writer reach the store now?" is a
   * question about the value, and the value is the channel. A slot whose
   * SIBLING on the same channel is forced genuinely cannot land a write.
   *
   * Aggregation (plan-353 §2.4, order-independent by construction):
   *   1. any `forced` slot on the channel — or a channel-level operator force —
   *      decides `forced`, regardless of roles;
   *   2. otherwise, with at least one `bound` slot and a local-sim writer:
   *      every `control`/`unknown` bound slot rejects; the write is allowed only
   *      when ALL bound slots on the channel are `feedback`;
   *   3. otherwise nothing claims the channel → ok.
   *
   * Step 2 is what F6 buys: command authority stays with CONNECT, feedback
   * authority stays with the component, and a fan-out of both kinds onto one
   * channel resolves the same way whichever slot was registered first.
   */
  private _decideAuthority(
    slotId: SlotId | undefined,
    channel: SignalChannelId | undefined,
    writer: Pick<SignalWriter, 'writerId' | 'writerKind'>,
  ): number {
    let hasForced = false;
    let hasBound = false;
    let hasBoundNonFeedback = false;

    // A channel force needs no binding — the store's force map is authoritative
    // at channel level (an operator can pin a signal nothing is bound to).
    if (channel !== undefined && this.forced.has(channel)) hasForced = true;

    if (channel !== undefined) {
      const slots = slotsForChannel(channel);
      // Single pass, NO early return: an early return is exactly the first-hit
      // bug F7 fixes — a `bound` slot registered before a `forced` one used to
      // hide it and mislabel the conflict.
      for (let i = 0; i < slots.length; i++) {
        const authority = getSlotAuthority(slots[i]);
        if (authority === 'forced') { hasForced = true; continue; }
        if (authority === 'bound') {
          hasBound = true;
          if (getSlotWriteRole(slots[i]) !== 'feedback') hasBoundNonFeedback = true;
        }
      }
    }
    if (slotId !== undefined && channel === undefined) {
      // Slot without a channel (direct-property command slots): fall back to
      // the slot's own claim so those rows still get a truthful answer.
      const authority = getSlotAuthority(slotId);
      if (authority === 'forced') hasForced = true;
      else if (authority === 'bound') {
        hasBound = true;
        if (getSlotWriteRole(slotId) !== 'feedback') hasBoundNonFeedback = true;
      }
    }

    if (writer.writerKind === 'remote') {
      // Upstream layer: strict ranking passes through a force, legacy does not.
      if (hasForced && !remoteWriteOverridesForce()) return DEC_DENY_FORCED;
      return DEC_OK;
    }
    if (writer.writerId === FORCE_WRITER.writerId) {
      // Forcing itself always lands — but a strict remote owner overrides it.
      return remoteWriteOverridesForce() ? DEC_ALLOW_REMOTE : DEC_OK;
    }
    if (hasForced) return DEC_DENY_FORCED;
    if (hasBound) {
      if (writer.writerId === SIGNAL_BINDING_RELAY_WRITER_ID) return DEC_OK;
      if (isLocalSimKind(writer.writerKind)) {
        // F6: a bound FEEDBACK slot is still written by its component — the
        // binding reports that value onwards, it does not produce it. Only a
        // command slot (or an underived one) displaces the local writer.
        return hasBoundNonFeedback ? DEC_DENY_BOUND : DEC_OK;
      }
      // Operator-style writers (hmi/mcp/debug/...) land now but the relay stays
      // authoritative — advisory reason, not a rejection.
      return DEC_ADVISORY_BOUND;
    }
    return DEC_OK;
  }

  // ── Name-based access (primary) ──

  /** Get raw value by name (undefined if not registered). */
  get(name: string): boolean | number | undefined {
    return this.byName.get(name);
  }

  /** Get PLC type by signal name (e.g. 'PLCOutputBool'). Returns undefined if unknown. */
  getType(name: string): string | undefined {
    return this.typeByName.get(name);
  }

  // ── Descriptive metadata (address / comment / source) ──

  /**
   * Merge descriptive metadata onto a signal. Only the fields actually present
   * (non-undefined) in `meta` overwrite existing values, so repeated
   * registration from different sources (CONNECT, GLB) accumulates instead of
   * clobbering. Optional — signals without metadata behave exactly as before.
   */
  setSignalMeta(name: string, meta: SignalMeta): void {
    if (!name) return;
    const existing = this.metaByName.get(name);
    const merged: SignalMeta = existing ? { ...existing } : {};
    if (meta.address !== undefined) merged.address = meta.address;
    if (meta.comment !== undefined) merged.comment = meta.comment;
    if (meta.source !== undefined) merged.source = meta.source;
    this.metaByName.set(name, merged);
  }

  /** Get descriptive metadata for a signal, or undefined if none was set. */
  getSignalMeta(name: string): SignalMeta | undefined {
    return this.metaByName.get(name);
  }

  /** Get as boolean by name (false if not set). */
  getBool(name: string): boolean {
    const v = this.byName.get(name);
    return typeof v === 'boolean' ? v : false;
  }

  /** Get as float by name (0 if not set). */
  getFloat(name: string): number {
    const v = this.byName.get(name);
    return typeof v === 'number' ? v : 0;
  }

  /** Get as int by name (0 if not set, truncated). */
  getInt(name: string): number {
    const v = this.byName.get(name);
    return typeof v === 'number' ? Math.trunc(v) : 0;
  }

  /**
   * Set value by name — only notifies listeners if value actually changes.
   * If the signal is currently forced, the incoming value is ignored (the
   * forced value is held). Use {@link forceSignal} to change a forced value.
   */
  set(
    name: string,
    value: boolean | number,
    now: number = Date.now(),
    writer: WriterIdentity = UNKNOWN_WRITER,
  ): void {
    this._setFromWriter(writer, name, value, now);
  }

  /** @internal Named-writer entry point used by SignalWriterHandle. */
  _setFromWriter(
    writer: WriterIdentity,
    name: string,
    value: boolean | number,
    now: number,
  ): void {
    this._recordWriter(name, writer, now);
    if (name.includes('/') && !this.byName.has(name)) {
      console.warn(`[SignalStore] set() called with path "${name}" — use setByPath() for hierarchy paths`);
    }
    if (this.forced.has(name)) {
      // Rare branch — the writerKind ranking check lives ONLY here (hot-path
      // rule: no authority lookup on ordinary writes). Under 'strict' ranking
      // with an active remote owner, a remote write passes THROUGH the force
      // (remote > forced): value and pin follow the remote authority.
      if (writer.writerKind === 'remote' && remoteWriteOverridesForce()) {
        this.forced.set(name, value);
        this.lastUpdateTs.set(name, now);
        this._apply(name, value);
        // The force PIN changed — force subscribers (badges) must re-read it.
        // The forceSink is deliberately NOT invoked: the remote authority is
        // not an operator force action towards the gateway.
        this._notifyForce();
        return;
      }
      this._recordConflict(name, writer, 'authority-forced');
      return;  // forced value wins — drop interface update
    }
    if (this._gateRejects(name, writer)) return;
    // Stamp liveness in the genuine write path — NOT in _apply() (forceSignal()
    // also calls _apply(), and a forced dead signal must stay stale/no-source).
    this.lastUpdateTs.set(name, now);
    this._apply(name, value);
  }

  /**
   * Allocation-free internal gate path (plan-320 Phase 4). Records a
   * deduplicated conflict when a LOCAL-SIMULATION writer hits a channel with a
   * bound/forced slot claim, and — only in 'enforce' mode and only for
   * classified (non-unknown) writers — rejects the write. Fan-out rule
   * (documented in doc-signal-architecture.md): a channel write is in conflict
   * as soon as ANY slot indexed against the channel carries a bound/forced
   * claim (most-restrictive-wins).
   *
   * The common case (channel without slot claims, or a non-sim writer) is a
   * single Map lookup / kind check — no allocation, no new telemetry entries
   * on repeated writes (9.5).
   */
  private _gateRejects(name: string, writer: WriterIdentity): boolean {
    if (!isLocalSimKind(writer.writerKind)) return false;
    if (writer.writerId === SIGNAL_BINDING_RELAY_WRITER_ID) return false;
    const channel = name as SignalChannelId;
    const slots = slotsForChannel(channel);
    if (slots.length === 0) return false;

    // Rank the channel in ONE pass without an early return (plan-353 F7). The
    // old first-hit loop returned at the first claimed slot and always logged
    // 'authority-bound', so a `forced` slot registered after a `bound` one was
    // invisible AND misreported. Witnesses are captured per class so the
    // conflict row names the slot that actually decided.
    let forcedWitness: SlotId | undefined;
    let boundWitness: SlotId | undefined;
    let feedbackOnly = true;
    for (let i = 0; i < slots.length; i++) {
      const slotId = slots[i];
      const authority = getSlotAuthority(slotId);
      if (authority === 'forced') { if (forcedWitness === undefined) forcedWitness = slotId; continue; }
      if (authority === 'bound') {
        if (getSlotWriteRole(slotId) === 'feedback') continue;
        feedbackOnly = false;
        if (boundWitness === undefined) boundWitness = slotId;
      }
    }

    let witness: SlotId | undefined;
    let reason: string;
    if (forcedWitness !== undefined) {
      witness = forcedWitness;
      reason = 'authority-forced';
    } else if (!feedbackOnly && boundWitness !== undefined) {
      witness = boundWitness;
      reason = 'authority-bound';
    } else {
      // Nothing contests this write: no claim at all, or every bound slot on
      // the channel is a FEEDBACK slot, which the component legitimately writes
      // (F6). Not a conflict, so nothing is logged either — the shadow log must
      // not fill up with the case the plan just declared correct.
      return false;
    }

    this._recordConflict(witness, writer, reason);
    // Enforce is prepared but never rejects unknown writers (raw legacy API):
    // a classified writer that still carries the legacy id must not vanish
    // silently once the gate goes hot.
    return this.signalWriteGate === 'enforce' && writer.writerId !== UNKNOWN_WRITER.writerId;
  }

  /** Dedup-record one (slotKey, writer, reason) conflict — nested maps, no
   *  composite-key allocation on repeated conflicting writes. */
  private _recordConflict(
    slotKey: string,
    writer: WriterIdentity,
    reason: string,
  ): void {
    let writers = this.writeConflicts.get(slotKey);
    if (!writers) {
      writers = new Map();
      this.writeConflicts.set(slotKey, writers);
    }
    let reasons = writers.get(writer.writerId);
    if (!reasons) {
      reasons = new Map();
      writers.set(writer.writerId, reasons);
    }
    const existing = reasons.get(reason);
    if (existing) {
      existing.writeCount++;
      return;
    }
    reasons.set(reason, {
      slotId: slotKey,
      writerId: writer.writerId,
      writerKind: writer.writerKind,
      reason,
      writeCount: 1,
    });
  }

  /** Write a value + notify listeners (force-bypass). Returns true if the value actually changed. */
  private _apply(name: string, value: boolean | number): boolean {
    const old = this.byName.get(name);
    if (old === value) return false;
    this.byName.set(name, value);
    this._version++;
    debug('signal', `set "${name}" = ${value} (was ${old})`);
    const subs = this.listeners.get(name);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
    return true;
  }

  /**
   * Re-notify subscribers without changing the value, version or liveness
   * timestamp. The forced value wins over the stored value, so this bypasses
   * only equality suppression and remains safe during an operator force.
   */
  redispatch(name: string): boolean {
    const value = this.forced.get(name) ?? this.byName.get(name);
    if (value === undefined) return false;
    const subs = this.listeners.get(name);
    if (subs) {
      for (const cb of subs) cb(value);
    }
    return true;
  }

  /** Subscribe to value changes by name. Returns unsubscribe function. */
  subscribe(name: string, cb: (value: boolean | number) => void): () => void {
    let subs = this.listeners.get(name);
    if (!subs) {
      subs = new Set();
      this.listeners.set(name, subs);
    }
    subs.add(cb);
    return () => {
      subs!.delete(cb);
      if (subs!.size === 0) {
        this.listeners.delete(name);
      }
    };
  }

  // ── Force / override (operator pin) ──

  /**
   * Force (pin) a signal to a value. The value is applied immediately and held:
   * subsequent interface updates via `set`/`setMany`/`setByPath` are ignored
   * until {@link unforce} is called. Works for any signal regardless of PLC
   * direction (In/Out) — forcing is an operator override, not a sim wire.
   */
  forceSignal(name: string, value: boolean | number): void {
    this._recordWriter(name, FORCE_WRITER, Date.now());
    this.forced.set(name, value);
    this._apply(name, value);
    this.forceSink?.(name, value);
    this._notifyForce();
  }

  /** Release a forced signal so interface updates flow again. No-op if not forced. */
  unforce(name: string): void {
    if (!this.forced.delete(name)) return;
    this.forceSink?.(name, null);
    this._notifyForce();
  }

  /** Release all forced signals. */
  unforceAll(): void {
    if (this.forced.size === 0) return;
    const names = [...this.forced.keys()];
    this.forced.clear();
    for (const n of names) this.forceSink?.(n, null);
    this._notifyForce();
  }

  /** True if the signal is currently forced. */
  isForced(name: string): boolean {
    return this.forced.has(name);
  }

  /** The forced value for a signal, or undefined if not forced. */
  getForcedValue(name: string): boolean | number | undefined {
    return this.forced.get(name);
  }

  /** Number of currently forced signals. */
  get forcedCount(): number {
    return this.forced.size;
  }

  /** Snapshot of all forced signals (name → forced value). */
  getForced(): Map<string, boolean | number> {
    return new Map(this.forced);
  }

  /**
   * Subscribe to changes of the forced SET (a signal forced or released).
   * Fires on force/unforce/unforceAll — not on ordinary value ticks.
   * Returns an unsubscribe function.
   */
  subscribeForce(cb: () => void): () => void {
    this.forceListeners.add(cb);
    return () => { this.forceListeners.delete(cb); };
  }

  /**
   * Register a write-back sink invoked on every force/unforce
   * (`value === null` = released). Adapters (CONNECT/PLC) use this to push the
   * forced value back to the gateway. Pass null to detach. Local-only forcing
   * needs no sink.
   */
  setForceSink(sink: ((name: string, value: boolean | number | null) => void) | null): void {
    this.forceSink = sink;
  }

  private _notifyForce(): void {
    for (const cb of this.forceListeners) cb();
  }

  // ── Activity / liveness ──

  /**
   * Register a connection provider that maps a `SignalMeta.source` label to the
   * connection state of its supplying interface. Injected by the interface layer
   * (analogous to {@link setForceSink}) so the engine stays decoupled — the store
   * never imports connect-store / interface-manager. Pass a fresh function to
   * replace, no-op if never set.
   */
  setConnectionProvider(fn: (source: string) => boolean): void {
    this.connectionProvider = fn;
  }

  /**
   * Derive the current {@link SignalActivity} of a signal from its source
   * metadata and the injected connection provider. Purely connection-based:
   * `stale` means the supplying interface is disconnected, never a stalled
   * value. `now` is accepted as the evaluation timestamp for a stable, testable
   * signature but is not needed by the connection-based derivation.
   */
  getActivity(
    name: string,
    now: number,
    mode: 'standalone' | 'live' | 'direct',
  ): SignalActivity {
    void now;
    const source = this.metaByName.get(name)?.source;
    const hasSource = !!source;
    const sourceConnected = source ? (this.connectionProvider?.(source) ?? false) : false;
    const lastUpdateTs = this.lastUpdateTs.get(name);
    return deriveSignalActivity({ hasSource, sourceConnected, lastUpdateTs, mode });
  }

  /**
   * Timestamp (ms) of the last real adapter/sim write for a signal, or undefined
   * if it has never been written. Used by the HMI to render the "stale Ns" age.
   */
  getLastUpdateTs(name: string): number | undefined {
    return this.lastUpdateTs.get(name);
  }

  // â”€â”€ Provider provenance / liveness â”€â”€

  /** Register that one full provider key exposes a signal name. */
  registerSignalProvider(source: SignalSourceRef, connected?: boolean): void {
    const key = signalProviderKey(source);
    this.providerRefs.set(key, { interfaceId: source.interfaceId, topic: source.topic });
    let signals = this.providerSignals.get(key);
    if (!signals) { signals = new Set(); this.providerSignals.set(key, signals); }
    signals.add(source.signal);
    let providers = this.providersBySignal.get(source.signal);
    if (!providers) { providers = new Set(); this.providersBySignal.set(source.signal, providers); }
    providers.add(key);
    if (connected !== undefined) this.providerConnected.set(key, connected);
    else if (!this.providerConnected.has(key)) this.providerConnected.set(key, false);
  }

  /** Update connection state without removing discovery metadata. */
  setSignalProviderConnected(
    provider: Pick<SignalSourceRef, 'interfaceId' | 'topic'>,
    connected: boolean,
  ): void {
    const key = signalProviderKey(provider);
    this.providerRefs.set(key, { interfaceId: provider.interfaceId, topic: provider.topic });
    this.providerConnected.set(key, connected);
  }

  /** Remove one provider key and all reverse-index entries it owns. */
  unregisterSignalProvider(provider: Pick<SignalSourceRef, 'interfaceId' | 'topic'>): void {
    const key = signalProviderKey(provider);
    const signals = this.providerSignals.get(key);
    if (signals) {
      for (const signal of signals) {
        const providers = this.providersBySignal.get(signal);
        providers?.delete(key);
        if (providers?.size === 0) this.providersBySignal.delete(signal);
      }
    }
    this.providerSignals.delete(key);
    this.providerRefs.delete(key);
    this.providerConnected.delete(key);
  }

  /** Provider keys currently advertising a signal (full topic identity retained). */
  getSignalProviders(signal: string): SignalSourceRef[] {
    const result: SignalSourceRef[] = [];
    for (const key of this.providersBySignal.get(signal) ?? []) {
      const provider = this.providerRefs.get(key);
      if (provider) result.push({ ...provider, signal });
    }
    return result;
  }

  /** Allocation-free provider count for simulation hot paths. */
  getSignalProviderCount(signal: string): number {
    return this.providersBySignal.get(signal)?.size ?? 0;
  }

  /** Allocation-free exact provider lookup for simulation hot paths. */
  hasSignalProviderByParts(interfaceId: string, topic: string | undefined, signal: string): boolean {
    const key = `${interfaceId}\u0000${topic ?? ''}`;
    return this.providerSignals.get(key)?.has(signal) ?? false;
  }

  /** Allocation-free exact connection lookup for simulation hot paths. */
  isSignalProviderConnectedByParts(interfaceId: string, topic?: string): boolean {
    return this.providerConnected.get(`${interfaceId}\u0000${topic ?? ''}`) ?? false;
  }

  hasSignalProvider(source: SignalSourceRef): boolean {
    return this.providerSignals.get(signalProviderKey(source))?.has(source.signal) ?? false;
  }

  isSignalProviderConnected(source: Pick<SignalSourceRef, 'interfaceId' | 'topic'>): boolean {
    return this.providerConnected.get(signalProviderKey(source)) ?? false;
  }

  /** Number of known full provider keys (test aid + legacy compatibility gate). */
  get signalProviderCount(): number {
    return this.providerRefs.size;
  }

  // ── Path-based access (secondary) ──

  /**
   * Resolve a path to its registered signal name, handling:
   * - Exact match (fast path)
   * - Space→underscore normalization (Three.js GLTF loader sanitizes names)
   * - Suffix matching (C# paths omit GLB root node prefix)
   * Results are cached so suffix scans only happen once per unique path.
   */
  private _resolvePath(path: string): string | undefined {
    // Fast path: exact match (covers pre-resolved paths from NodeRegistry.resolve())
    const direct = this.pathToName.get(path);
    if (direct !== undefined) return direct;

    // Check cache (avoids repeated suffix scans at runtime)
    if (this.resolveCache.has(path)) {
      return this.resolveCache.get(path) ?? undefined;
    }

    // Normalize spaces → underscores (Three.js GLTF sanitization)
    const normalized = path.replace(/ /g, '_');
    if (normalized !== path) {
      const normResult = this.pathToName.get(normalized);
      if (normResult !== undefined) {
        this.resolveCache.set(path, normResult);
        return normResult;
      }
    }

    // Suffix match: C# paths may omit root node prefix
    const searchPath = normalized !== path ? normalized : path;
    for (const [registeredPath, name] of this.pathToName) {
      if (registeredPath.endsWith('/' + searchPath)) {
        this.resolveCache.set(path, name);
        return name;
      }
    }

    this.resolveCache.set(path, null);
    return undefined;
  }

  /** Get raw value by hierarchy path (undefined if not registered). */
  getByPath(path: string): boolean | number | undefined {
    const name = this._resolvePath(path);
    return name !== undefined ? this.byName.get(name) : undefined;
  }

  /** Get as boolean by path (false if not set). */
  getBoolByPath(path: string): boolean {
    const v = this.getByPath(path);
    return typeof v === 'boolean' ? v : false;
  }

  /** Get as float by path (0 if not set). */
  getFloatByPath(path: string): number {
    const v = this.getByPath(path);
    return typeof v === 'number' ? v : 0;
  }

  /** Get as int by path (0 if not set, truncated). */
  getIntByPath(path: string): number {
    const v = this.getByPath(path);
    return typeof v === 'number' ? Math.trunc(v) : 0;
  }

  /** Set value by hierarchy path. */
  setByPath(
    path: string,
    value: boolean | number,
    now: number = Date.now(),
    writer: WriterIdentity = UNKNOWN_WRITER,
  ): void {
    this._setByPathFromWriter(writer, path, value, now);
  }

  /** @internal Named-writer path entry point used by SignalWriterHandle. */
  _setByPathFromWriter(
    writer: WriterIdentity,
    path: string,
    value: boolean | number,
    now: number,
  ): void {
    const name = this._resolvePath(path);
    if (name !== undefined) {
      this.set(name, value, now, writer);
    } else {
      debug('signal', `setByPath: path NOT found "${path}"`);
    }
  }

  /** Subscribe to value changes by path. Returns unsubscribe function. */
  subscribeByPath(path: string, cb: (value: boolean | number) => void): () => void {
    const name = this._resolvePath(path);
    if (name !== undefined) {
      return this.subscribe(name, cb);
    }
    // Path not yet registered — return no-op unsubscribe
    debug('signal', `subscribeByPath: path NOT found "${path}" — subscription will be no-op`);
    return () => {};
  }

  /** Resolve a path to its signal name (or undefined if not registered). */
  nameForPath(path: string): string | undefined {
    return this._resolvePath(path);
  }

  /**
   * Signal name registered for EXACTLY this path — no space normalization, no
   * suffix scan, no cache write.
   *
   * For callers that hold a node's canonical registration path and only need to
   * know "is there a signal here?". `nameForPath()` would answer the same for
   * those, but by way of an O(#signals) suffix scan plus a negative cache entry
   * for every plain geometry node it is asked about — which is exactly what
   * alias registration would do to a whole renamed subtree (plan-381 F5).
   */
  exactNameForPath(path: string): string | undefined {
    return this.pathToName.get(path);
  }

  /** Resolve a signal name to its registered path (or undefined if unknown). */
  getPath(name: string): string | undefined {
    return this.nameToPath.get(name);
  }

  // ── Bulk operations ──

  /**
   * Bulk set by name — all values are updated first, then all listeners are notified.
   * This ensures that a listener for signal A can see signal B's new value
   * (batch semantics: all values are consistent before any notification fires).
   */
  setMany(
    updates: Record<string, boolean | number>,
    now: number = Date.now(),
    writer: WriterIdentity = UNKNOWN_WRITER,
  ): void {
    this._setManyFromWriter(writer, updates, now);
  }

  /** @internal Named-writer bulk entry point used by SignalWriterHandle. */
  _setManyFromWriter(
    writer: WriterIdentity,
    updates: Record<string, boolean | number>,
    now: number,
  ): void {
    // Scratch arrays instead of per-batch `{name,value}` objects — this is the
    // adapter flush path (runs up to per-tick under CONNECT push). A re-entrant
    // setMany (from a listener) falls back to fresh local arrays.
    const reentrant = this._setManyActive;
    const changedNames: string[] = reentrant ? [] : this._setManyNames;
    const changedValues: (boolean | number)[] = reentrant ? [] : this._setManyValues;
    changedNames.length = 0;
    changedValues.length = 0;
    let forcePinsChanged = false;
    this._setManyActive = true;
    try {
      for (const name in updates) {
        this._recordWriter(name, writer, now);
        if (this.forced.has(name)) {
          // Same rare-branch ranking as _setFromWriter: strict remote passes
          // through the force (remote > forced), everything else is dropped.
          if (writer.writerKind === 'remote' && remoteWriteOverridesForce()) {
            const remoteValue = updates[name];
            this.forced.set(name, remoteValue);
            this.lastUpdateTs.set(name, now);
            forcePinsChanged = true;
            const oldValue = this.byName.get(name);
            if (oldValue !== remoteValue) {
              this.byName.set(name, remoteValue);
              changedNames.push(name);
              changedValues.push(remoteValue);
            }
            continue;
          }
          this._recordConflict(name, writer, 'authority-forced');
          continue;  // forced value wins — drop interface update
        }
        if (this._gateRejects(name, writer)) continue;
        const value = updates[name];
        // Stamp liveness even if the value did not change — the adapter still
        // supplied it this tick. `now` is computed once per batch (no per-entry
        // Date.now() in the hot path).
        this.lastUpdateTs.set(name, now);
        const old = this.byName.get(name);
        if (old === value) continue;
        this.byName.set(name, value);
        changedNames.push(name);
        changedValues.push(value);
      }
      if (changedNames.length > 0) this._version++;
      for (let i = 0; i < changedNames.length; i++) {
        const subs = this.listeners.get(changedNames[i]);
        if (subs) {
          for (const cb of subs) {
            cb(changedValues[i]);
          }
        }
      }
      // Remote write-through moved force pins — notify force subscribers once
      // per batch (badges re-read the pinned value).
      if (forcePinsChanged) this._notifyForce();
    } finally {
      if (!reentrant) this._setManyActive = false;
    }
  }

  /** Scratch state for setMany (see above). */
  private _setManyActive = false;
  private readonly _setManyNames: string[] = [];
  private readonly _setManyValues: (boolean | number)[] = [];

  private _recordWriter(name: string, writer: WriterIdentity, now: number): void {
    let writers = this.writerInventory.get(name);
    if (!writers) {
      writers = new Map();
      this.writerInventory.set(name, writers);
    }
    const existing = writers.get(writer.writerId);
    if (existing) {
      existing.writeCount++;
      return;
    }
    const entry: WriterInventoryEntry = {
      signal: name,
      writerId: writer.writerId,
      writerKind: writer.writerKind,
      slotContext: writer.slotContext,
      firstSeenAt: now,
      writeCount: 1,
    };
    if (writer.writerId === 'unknown' && import.meta.env.DEV) {
      const stack = new Error('[SignalStore] unclassified raw write').stack;
      if (stack) Object.defineProperty(entry, 'stack', { value: stack, enumerable: true });
    }
    writers.set(writer.writerId, entry);
  }

  // ── Registration ──

  /**
   * Register a signal with initial value (does not trigger listeners).
   * @param name Signal name (Signal.Name if set, otherwise node name)
   * @param path Full hierarchy path
   * @param initialValue Default value
   */
  register(name: string, path: string, initialValue: boolean | number, plcType?: string): void {
    if (!this.byName.has(name)) {
      this.byName.set(name, initialValue);
    }
    this.pathToName.set(path, name);
    this.nameToPath.set(name, path);
    if (plcType) this.typeByName.set(name, plcType);
    debug('signal', `register "${name}" path="${path}" initial=${initialValue}`);
  }

  /**
   * Register an ADDITIONAL path under which an already-registered signal
   * resolves — e.g. the pre-dedup glTF path of a node that Three.js renamed
   * (`Kinematics_MC07/Pusher/vertical` for a node now living at
   * `Kinematics_MC07/Pusher_1/vertical`).
   *
   * Deliberately additive, and the reason this is NOT `register()` (plan-381
   * F11): `register()` writes `nameToPath` unconditionally, so aliasing through
   * it would repoint the CANONICAL name→path mapping at the alias — every
   * consumer of `getPath(name)` (property inspector, signal binding, MCP tools)
   * would then be handed a path that is merely a historical spelling.
   *
   * Rules:
   *   - the signal must already exist (`register()` first) — otherwise no-op,
   *     an alias for an unknown signal would only mask the real problem;
   *   - a path already claimed by some signal is never overwritten (first wins,
   *     same policy as `NodeRegistry.registerAlias` and `buildIndex`);
   *   - `nameToPath` is left untouched.
   */
  registerPathAlias(name: string, aliasPath: string): boolean {
    if (!aliasPath || !this.byName.has(name)) return false;
    if (this.pathToName.has(aliasPath)) return false;
    this.pathToName.set(aliasPath, name);
    // The alias path may have been probed (and cached as "unknown") before it
    // existed — drop that negative entry so the alias resolves immediately.
    this.resolveCache.delete(aliasPath);
    debug('signal', `registerPathAlias "${name}" alias="${aliasPath}"`);
    return true;
  }

  // ── Indexing ──

  /**
   * Pre-build path index after all signals are registered.
   * Registers all proper suffix variants of each path into `pathToName`,
   * so `_resolvePath()` always hits on the direct `Map.get()` call
   * without needing runtime suffix scans.
   * Call once after loading completes.
   */
  buildIndex(): void {
    const additions = new Map<string, string>();
    for (const [registeredPath, name] of this.pathToName) {
      const parts = registeredPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join('/');
        // First-wins: skip if suffix already claimed by another signal
        if (!this.pathToName.has(suffix) && !additions.has(suffix)) {
          additions.set(suffix, name);
        }
      }
    }
    for (const [path, name] of additions) {
      this.pathToName.set(path, name);
    }
    this.resolveCache.clear();
    if (additions.size > 0) {
      debug('signal', `buildIndex: added ${additions.size} suffix entries (${this.pathToName.size} total path mappings)`);
    }
  }

  /**
   * Update pathToName entries using an oldPath→newPath remap.
   * Call after kinematic re-parenting recomputes registry paths.
   */
  remapPaths(remap: Map<string, string>): number {
    let updated = 0;
    for (const [oldPath, newPath] of remap) {
      const name = this.pathToName.get(oldPath);
      if (name !== undefined) {
        this.pathToName.delete(oldPath);
        this.pathToName.set(newPath, name);
        // Keep the reverse index in sync — but only when the remapped entry is
        // the canonical registration (pathToName also holds suffix aliases).
        if (this.nameToPath.get(name) === oldPath) {
          this.nameToPath.set(name, newPath);
        }
        updated++;
      }
    }
    this.resolveCache.clear();
    if (updated > 0) {
      debug('signal', `remapPaths: updated ${updated} signal paths`);
    }
    return updated;
  }

  // ── Utility ──

  /** Get all values by name (for debugging/sync). */
  getAll(): Map<string, boolean | number> {
    return new Map(this.byName);
  }

  /** Get number of registered signals. */
  get size(): number {
    return this.byName.size;
  }

  /** Get all registered path→name mappings (for debugging). */
  getAllPaths(): Map<string, string> {
    return new Map(this.pathToName);
  }

  /** Clear all signals and listeners. */
  clear(): void {
    this.byName.clear();
    this.pathToName.clear();
    this.nameToPath.clear();
    this.typeByName.clear();
    this.metaByName.clear();
    this.listeners.clear();
    this.resolveCache.clear();
    this.forced.clear();
    this.lastUpdateTs.clear();
    this.providerRefs.clear();
    this.providerSignals.clear();
    this.providersBySignal.clear();
    this.providerConnected.clear();
    this.writerInventory.clear();
    this.writeConflicts.clear();
    // forceListeners / forceSink / connectionProvider persist across model reloads (owned by UI/adapters).
  }
}

/**
 * Bind a writer against SignalStore-compatible test/legacy surfaces.
 *
 * Production SignalStore instances always take the native branch. The fallback
 * preserves compatibility for existing narrow plugin/component test doubles.
 */
export function createSignalWriter(
  store: {
    createWriter?: SignalStore['createWriter'];
    set(name: string, value: boolean | number, now?: number): void;
    setByPath?(path: string, value: boolean | number, now?: number): void;
    setMany?(updates: Record<string, boolean | number>, now?: number): void;
  },
  writerId: string,
  writerKind: SignalWriterKind,
  options: SignalWriterOptions = {},
): SignalWriter {
  if (typeof store.createWriter === 'function') {
    return store.createWriter(writerId, writerKind, options);
  }
  return {
    writerId,
    writerKind,
    slotContext: options.slotContext,
    set: (name, value, now) => {
      if (now === undefined) store.set(name, value);
      else store.set(name, value, now);
    },
    setByPath: (path, value, now) => {
      if (store.setByPath) {
        if (now === undefined) store.setByPath(path, value);
        else store.setByPath(path, value, now);
      } else if (now === undefined) {
        store.set(path, value);
      } else {
        store.set(path, value, now);
      }
    },
    setMany: (updates, now) => {
      if (store.setMany) {
        if (now === undefined) store.setMany(updates);
        else store.setMany(updates, now);
        return;
      }
      for (const name in updates) {
        if (now === undefined) store.set(name, updates[name]);
        else store.set(name, updates[name], now);
      }
    },
  };
}
