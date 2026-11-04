// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { createSignalWriter, type SignalStore, type SignalWriter } from './rv-signal-store';
import { isSignalLiveControlled, subscribeLiveControl } from './rv-slot-authority';
import { wireValueSignal } from './rv-signal-wiring';
import type { SignalApplyContext } from './rv-signal-reapply-registry';
import { clearProblem, reportProblem, type ProblemSeverity } from '../hmi/problems-store';
import { connectSignalRelays, subscribeConnectSignalRelays, type LegacyRelayEdge } from './rv-signal-connector-link';
import {
  CONNECTOR_SLOTS,
  bitFitsWidth,
  convertValue,
  kindOfPlcType,
  selectSlots,
  setMaskBit,
  slotKind,
  widthBits,
  wordFromMask,
  type ConnectorSlot,
  type IntCondition,
  type RoundingMode,
  type SignalConnectorMode,
  type SourceSlot,
  type TargetSlot,
  type ValueKind,
  type WordWidth,
} from './rv-signal-conversion';

/**
 * RVSignalConnector — couples ONE source signal to ONE target signal with a
 * small explicit conversion (plan-2227). Same name and fields as the Unity
 * `SignalConnector`; the GLB `rv_extras.realvirtual.SignalConnector` block is
 * the single source of truth.
 *
 * ## Slots
 *
 * Six flat, typed `ComponentReference` slots (`SourceBool|Int|Float`,
 * `TargetBool|Int|Float`); the Mode picks the active pair
 * ({@link selectSlots}). A set inactive slot is a WARNING
 * (`signal-connector-slot-mismatch`) — the connector still runs on its active
 * pair. Source = a PLC output, target = a PLC input (signals rule 1).
 *
 * ## Runtime
 *
 * On-change: the active source is subscribed, the value runs through the pure
 * kernel (`rv-signal-conversion.ts`) and is written only when the target does
 * not already hold it. The writer identity is instance-bound —
 * `component:SignalConnector:<occurrence>#<NodeId>` from
 * `NodeRegistry.getAddressForNode` (node-identity rule 5: two placements of the
 * same GLB are two writers; plan-2227 RR2). Live control of the target
 * suppresses writes and resyncs on release (signals rule 5); `context.reapply`
 * re-drives the current level after a reset (signals rule 7).
 *
 * `BitToWord` connectors do not write themselves: every target word has ONE
 * {@link WordAggregator} that owns the word's writer and builds the word from
 * the current bits of its members (bits nobody writes are 0, no
 * read-modify-write).
 *
 * ## Checks
 *
 * Every connector of one SignalStore joins one {@link SignalConnectorNetwork}
 * (with every `ConnectSignal`). It re-checks the whole graph on every init,
 * dispose and configuration change (`reapplyConfig`, which the editor calls on
 * setField / undo / redo): unresolved slots, direction, bit width, fan-in and
 * cycles. A connector with an error writes nothing until it is fixed.
 */
export class RVSignalConnector implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('SignalConnector');

  readonly node: Object3D;
  isOwner = true;

  // ── Schema fields (resolved slot = signal path string, or null) ──
  Mode: SignalConnectorMode = 'Copy';
  Enabled = true;
  SourceBool: string | null = null;
  SourceInt: string | null = null;
  SourceFloat: string | null = null;
  TargetBool: string | null = null;
  TargetInt: string | null = null;
  TargetFloat: string | null = null;
  Condition: IntCondition = 'NotZero';
  CompareValue = 0;
  TrueValue = 1;
  FalseValue = 0;
  Bit = 0;
  Width: WordWidth = 'Word';
  Signed = true;
  Factor = 1;
  Offset = 0;
  Rounding: RoundingMode = 'Round';
  Invert = false;

  // ── Runtime state ──
  /** Active slots of the current configuration. */
  sourceSlot: SourceSlot | null = null;
  targetSlot: TargetSlot | null = null;
  sourcePath: string | null = null;
  targetPath: string | null = null;
  sourceKind: ValueKind = 'bool';
  targetKind: ValueKind = 'bool';
  /** Full instance address (`<occurrence>#<NodeId>`), or `path:<node path>` without identity. */
  instanceAddress = '';
  /** Set inactive slots of the current configuration (warning only). */
  inactiveSet: ConnectorSlot[] = [];
  /** Network cache: own configuration problems and the graph edge (reset by `_configure`). */
  ownCache: Map<SignalConnectorProblemKey, string> | null = null;
  edge: Edge | null = null;
  /** Raw (unresolved) slot values as authored, for the unresolved report. */
  private _rawSlots: Partial<Record<ConnectorSlot, unknown>> = {};

  /** True while the network found no error — only then does the connector write. */
  private _ok = false;
  private _disposed = false;
  /** The bit this connector contributes (BitToWord). */
  bitOn = false;
  private _aggregator: WordAggregator | null = null;
  private _nonfinite = false;

  private _context: ComponentContext | null = null;
  private _store: SignalStore | null = null;
  private _network: SignalConnectorNetwork | null = null;
  private _writer: SignalWriter | null = null;
  private _unwire: (() => void) | null = null;
  private _liveUnsub: (() => void) | null = null;
  private _targetName: string | null = null;
  private readonly _setter = (value: boolean | number, ctx?: SignalApplyContext): void => {
    this._onSource(value, ctx?.replay === true);
  };

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this._context = context;
    this._store = context.signalStore;
    this.instanceAddress = context.registry.getAddressForNode(this.node)
      ?? `path:${NodeRegistry.computeNodePath(this.node)}`;
    this._writer = createSignalWriter(
      context.signalStore,
      `component:SignalConnector:${this.instanceAddress}`,
      'component',
      { slotContext: NodeRegistry.computeNodePath(this.node) },
    );
    this._network = signalConnectorNetworkFor(context.signalStore, context.registry);
    this._configure();
    this._wire();
    this._network.add(this);
  }

  /** The editor changed a field (setField / undo / redo): rewire and re-check. */
  reapplyConfig(): void {
    const net = this._network;
    if (!net || !this._store) return;
    // One transaction: leaving and re-joining a word publishes only the final word.
    net.batch(() => {
      this._reconfigure(false);
      net.revalidate();
    });
  }

  /**
   * Re-read the configuration and rewire, WITHOUT the network check — the
   * network calls this for every connector after a signal-catalog change and
   * then checks once.
   */
  _reconfigure(resolveEmpty: boolean): void {
    if (!this._network || !this._store || this._disposed) return;
    this._unwireAll();
    // A changed target or mode must not leave this bit in the old word.
    this._leaveAggregator();
    this._ok = false;
    this._dropNonfinite();
    if (resolveEmpty) this._resolveEmptySlots();
    this._configure();
    this._wire();
  }

  /**
   * A slot the loader could not resolve (its signal did not exist yet) stays
   * null; after a catalog change the authored reference is resolved again,
   * through the same registry resolver the loader uses.
   */
  private _resolveEmptySlots(): void {
    const registry = this._context?.registry;
    const raw = (this.node.userData?.realvirtual as Record<string, unknown> | undefined)?.SignalConnector as
      Record<string, unknown> | undefined;
    if (!registry || !raw) return;
    for (const slot of CONNECTOR_SLOTS) {
      if (this[slot] !== null) continue;
      const ref = raw[slot];
      if (!ref || typeof ref !== 'object') continue;
      const res = registry.resolve(ref as Parameters<NodeRegistry['resolve']>[0], registry.enclosingScope(this.node), this.node);
      if (typeof res.signalAddress === 'string' && res.signalAddress) this[slot] = res.signalAddress;
      else if (res.node) this[slot] = registry.getPathForNode(res.node) ?? NodeRegistry.computeNodePath(res.node);
    }
  }

  /** Forget a reported non-finite result (the next one is reported again). */
  _dropNonfinite(): void {
    if (!this._nonfinite) return;
    this._nonfinite = false;
    this._network?.clearOwn(this, 'nonfinite');
  }

  /** The network already cleared the warning; only the flag goes. */
  _forgetNonfinite(): void {
    this._nonfinite = false;
  }

  dispose(): void {
    // Disposed FIRST: a write below can re-enter the network check, which must
    // never hand this connector a verdict (or a word) again.
    this._disposed = true;
    this._ok = false;
    this._unwireAll();
    const net = this._network;
    this._network = null;
    if (net) {
      net.batch(() => {
        this._leaveAggregator();
        net.remove(this);
      });
    } else {
      this._leaveAggregator();
    }
    this._writer = null;
    this._store = null;
    this._context = null;
  }

  /** Path of this connector's node, for problems and diagnostics. */
  get nodePath(): string {
    return this._context?.registry.getPathForNode(this.node) ?? NodeRegistry.computeNodePath(this.node);
  }

  /** True while the connector writes (no error, enabled). */
  get isActive(): boolean {
    return this._ok;
  }

  // ── Configuration ──────────────────────────────────────────────────

  private _configure(): void {
    this.ownCache = null;
    this.edge = null;
    const raw = ((this.node.userData?.realvirtual as Record<string, unknown> | undefined)?.SignalConnector ?? {}) as Record<string, unknown>;
    this._rawSlots = {};
    for (const slot of CONNECTOR_SLOTS) {
      this._rawSlots[slot] = raw[slot];
      // `applySchema` leaves a componentRef the extras no longer carry untouched,
      // so a slot cleared by setField / undo would keep its old resolved path.
      // The authored extras are the truth: no authored reference, no slot.
      if (raw[slot] === undefined || raw[slot] === null || raw[slot] === '') { this[slot] = null; continue; }
      // A reference without `componentType` resolves to the NODE, not to a signal
      // address (`NodeRegistry.resolve`, kind 'node'). The slot is annotated as a
      // signal, so the node's path IS the signal address.
      const v = this[slot] as unknown;
      if (v && typeof v === 'object' && (v as Object3D).isObject3D) {
        const node = v as Object3D;
        this[slot] = this._context?.registry.getPathForNode(node) ?? NodeRegistry.computeNodePath(node);
      }
    }
    const sel = selectSlots(this.Mode, (slot) => this._slotSet(slot));
    this.sourceSlot = sel.source;
    this.targetSlot = sel.target;
    this.inactiveSet = sel.inactiveSet;
    this.sourcePath = sel.source ? this[sel.source] : null;
    this.targetPath = sel.target ? this[sel.target] : null;
    this.sourceKind = sel.source ? slotKind(sel.source) : 'bool';
    this.targetKind = sel.target ? slotKind(sel.target) : 'bool';
    this._targetName = this.targetPath ? this._store?.nameForPath(this.targetPath) ?? null : null;
  }

  /** A slot counts as set when the file authored a reference OR it resolved. */
  private _slotSet(slot: ConnectorSlot): boolean {
    if (typeof this[slot] === 'string' && this[slot]) return true;
    const raw = this._rawSlots[slot];
    if (raw === null || raw === undefined || raw === '') return false;
    if (typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      return Boolean(r.address || r.path || r.unresolvedPath);
    }
    return typeof raw === 'string';
  }

  /** Raw authored text of a slot (address, path or unresolved path), for problem details. */
  rawSlotText(slot: ConnectorSlot): string | null {
    const raw = this._rawSlots[slot];
    if (typeof raw === 'string') return raw || null;
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const v = r.address ?? r.path ?? r.unresolvedPath;
      return typeof v === 'string' && v ? v : null;
    }
    return null;
  }

  private _wire(): void {
    const store = this._store;
    if (!store || !this.Enabled || !this.sourcePath || !this.targetPath) return;
    this._unwire = wireValueSignal(store, this.sourcePath, this._setter, undefined, this._context?.reapply).unsubscribe;
    if (this._targetName && this.Mode !== 'BitToWord') {
      this._liveUnsub = subscribeLiveControl(this._targetName, (controlled) => {
        if (!controlled) this._resync(false);
      });
    }
  }

  private _unwireAll(): void {
    this._unwire?.();
    this._unwire = null;
    this._liveUnsub?.();
    this._liveUnsub = null;
  }

  // ── Runtime ────────────────────────────────────────────────────────

  /** Network verdict for this connector. Called by {@link SignalConnectorNetwork.revalidate}. */
  _applyVerdict(ok: boolean): void {
    if (this._disposed) return;
    const was = this._ok;
    this._ok = ok;
    if (ok && this.Mode === 'BitToWord') {
      this._joinAggregator();
    } else {
      this._leaveAggregator();
    }
    if (ok && !was) this._resync(false);
  }

  private _onSource(value: boolean | number, replay: boolean): void {
    if (!this._ok) return;
    const out = convertValue(value, this.sourceKind, this.targetKind, this);
    if (this.Mode === 'BitToWord') {
      const on = out === true;
      if (on === this.bitOn && !replay) return;
      this.bitOn = on;
      this._aggregator?.update(replay);
      return;
    }
    if (out === undefined) {
      // Only Copy-to-REAL and Scale can produce this once the network accepted the
      // configuration: the result is not finite after the target conversion.
      if (!this._nonfinite) {
        this._nonfinite = true;
        this._network?.reportOwn(this, 'nonfinite', `The converted value of "${this.sourcePath}" is not finite (NaN or beyond the float32 range); nothing was written to "${this.targetPath}".`);
      }
      return;
    }
    if (this._nonfinite) {
      this._nonfinite = false;
      this._network?.clearOwn(this, 'nonfinite');
    }
    const target = this.targetPath as string;
    if (this._targetName !== null && isSignalLiveControlled(this._targetName)) return;
    if (!replay && this._store?.getByPath(target) === out) return;
    this._writer?.setByPath(target, out);
  }

  /** Re-derive from the CURRENT source value (unblock, live-control release). */
  private _resync(replay: boolean): void {
    if (!this._ok || !this.sourcePath) return;
    const current = this._store?.getByPath(this.sourcePath);
    if (current === undefined) return;
    if (this.Mode === 'BitToWord') {
      const out = convertValue(current, this.sourceKind, this.targetKind, this);
      this.bitOn = out === true;
      this._aggregator?.update(replay);
      return;
    }
    this._onSource(current, replay);
  }

  private _joinAggregator(): void {
    if (this._disposed || this._aggregator || !this._network || !this.targetPath) return;
    const current = this.sourcePath ? this._store?.getByPath(this.sourcePath) : undefined;
    this.bitOn = current === undefined ? false : convertValue(current, this.sourceKind, this.targetKind, this) === true;
    this._aggregator = this._network.aggregatorFor(this.targetPath);
    this._aggregator.join(this);
  }

  private _leaveAggregator(): void {
    if (!this._aggregator) return;
    const agg = this._aggregator;
    this._aggregator = null;
    agg.leave(this);
  }
}

// ═══ Word aggregator ═══════════════════════════════════════════════════

/**
 * The ONE writer of a `BitToWord` target word. The word is the bits of its
 * current members — bits no member writes are 0, never read back from the
 * target. Width is the widest member Width; the word is signed only when every
 * member is Signed. Removing the last member writes 0 once.
 */
/** What a word aggregator needs from its network. */
export interface WordAggregatorHost {
  /** True inside a network transaction: writes are collected and published at its end. */
  isBatching(): boolean;
  /** Remember an aggregator whose word must be published at the end of the transaction. */
  defer(agg: WordAggregator): void;
  /** The last member left: the aggregator is no longer the word's writer. */
  onEmpty(agg: WordAggregator): void;
  /** The last member left while the word was live-controlled: a clear is owed. */
  onPendingClear(agg: WordAggregator): void;
  /** The aggregator has finished (no owed clear, no subscription). */
  onRetired(agg: WordAggregator): void;
}

export class WordAggregator {
  readonly members = new Set<RVSignalConnector>();
  private readonly _writer: SignalWriter;
  private readonly _targetName: string | null;
  private _liveUnsub: (() => void) | null = null;
  /** The last member left while the target was live-controlled: write 0 on release. */
  private _pendingZero = false;

  constructor(
    private readonly _store: SignalStore,
    readonly targetPath: string,
    targetInstanceAddress: string,
    private readonly _host: WordAggregatorHost,
  ) {
    this._writer = createSignalWriter(_store, `component:SignalConnector.word:${targetInstanceAddress}`, 'component', { slotContext: targetPath });
    this._targetName = _store.nameForPath(targetPath) ?? null;
    if (this._targetName) {
      this._liveUnsub = subscribeLiveControl(this._targetName, (controlled) => {
        if (controlled) return;
        if (this._pendingZero) {
          // The owed clear, once — and only while the path still names the
          // signal this aggregator wrote (a replacement signal is not ours).
          this._pendingZero = false;
          if (this._store.nameForPath(this.targetPath) === this._targetName) this._writeNow(0, false);
          this._retire();
          return;
        }
        this.update(false);
      });
    }
  }

  get writerId(): string {
    return this._writer.writerId;
  }

  get hasPendingZero(): boolean {
    return this._pendingZero;
  }

  join(c: RVSignalConnector): void {
    this.members.add(c);
    this.update(true);
  }

  leave(c: RVSignalConnector): void {
    if (!this.members.delete(c)) return;
    if (this.members.size === 0) {
      // Inside a transaction the word may be re-joined before it ends: decide then.
      if (this._host.isBatching()) { this._host.defer(this); return; }
      this._finishEmpty();
      return;
    }
    this.update(false);
  }

  /** Publish the word at the end of a transaction (or finish an emptied aggregator). */
  flush(): void {
    if (this.members.size === 0) { this._finishEmpty(); return; }
    this._writeNow(this.computeWord(), false);
  }

  /**
   * A newer aggregator took over this word (a bit connector joined again while
   * this one still owed its clear): the clear is no longer owed.
   */
  cancelPendingZero(): void {
    if (!this._pendingZero) return;
    this._pendingZero = false;
    this._retire();
  }

  /** The word of the current member bits. */
  computeWord(): number {
    let mask = 0;
    let width: WordWidth = 'Byte';
    let signed = true;
    for (const m of this.members) {
      if (widthBits(m.Width) > widthBits(width)) width = m.Width;
      if (!m.Signed) signed = false;
      if (m.bitOn && bitFitsWidth(m.Bit, m.Width)) mask = setMaskBit(mask, m.Bit, true);
    }
    return wordFromMask(mask, width, signed);
  }

  /** Recompute and write when changed (`force`: write even when equal — replay). */
  update(force: boolean): void {
    if (this.members.size === 0) return;
    if (this._host.isBatching()) { this._host.defer(this); return; }
    this._writeNow(this.computeWord(), force);
  }

  private _finishEmpty(): void {
    this._host.onEmpty(this);
    if (this._targetName !== null && isSignalLiveControlled(this._targetName)) {
      // Keep the release subscription: the clear is owed until the release.
      this._pendingZero = true;
      this._host.onPendingClear(this);
      return;
    }
    this._writeNow(0, false);
    this._retire();
  }

  private _writeNow(word: number, force: boolean): void {
    if (this._targetName !== null && isSignalLiveControlled(this._targetName)) return;
    if (!force && this._store.getByPath(this.targetPath) === word) return;
    this._writer.setByPath(this.targetPath, word);
  }

  private _retire(): void {
    this._liveUnsub?.();
    this._liveUnsub = null;
    this._host.onRetired(this);
  }
}

// ═══ Network: fan-in, cycles, problems ════════════════════════════════

/** Stable problem codes (Problems panel + MCP). */
export const SIGNAL_CONNECTOR_PROBLEM_CODES = Object.freeze({
  unresolved: 'signal-connector-unresolved',
  slotMismatch: 'signal-connector-slot-mismatch',
  direction: 'signal-connector-direction',
  fanIn: 'signal-connector-fan-in',
  cycle: 'signal-connector-cycle',
  width: 'signal-connector-width',
  nonfinite: 'signal-connector-nonfinite',
});

export type SignalConnectorProblemKey = keyof typeof SIGNAL_CONNECTOR_PROBLEM_CODES;

const PROBLEM_SEVERITY: Record<SignalConnectorProblemKey, ProblemSeverity> = {
  unresolved: 'error',
  slotMismatch: 'warning',
  direction: 'error',
  fanIn: 'error',
  cycle: 'error',
  width: 'error',
  nonfinite: 'warning',
};

const PROBLEM_TITLE: Record<SignalConnectorProblemKey, string> = {
  unresolved: 'SignalConnector: signal slot not set or not found',
  slotMismatch: 'SignalConnector: slot set that the mode does not use',
  direction: 'SignalConnector: target is not a PLC input',
  fanIn: 'SignalConnector: more than one writer on the same target',
  cycle: 'SignalConnector: connectors form a cycle',
  width: 'SignalConnector: bit outside the word width',
  nonfinite: 'SignalConnector: converted value is not finite',
};

/** Problem id of one connector and code — stable across reloads. */
export function signalConnectorProblemId(instanceAddress: string, key: SignalConnectorProblemKey): string {
  return `${SIGNAL_CONNECTOR_PROBLEM_CODES[key]}:${instanceAddress}`;
}

export type { LegacyRelayEdge } from './rv-signal-connector-link';

/**
 * Where the network reads the CONNECT 1:1 mappings from (`bridge_list.mappings`,
 * R2). Installed by the feature body from `connect-store`; `get()` answers null
 * while CONNECT is not connected or the bridges are not loaded — then nothing is
 * checked against the gateway.
 */
export interface GatewayMappingFeed {
  get(): ReadonlyArray<{ readonly enabled: boolean; readonly sourceSignal: string; readonly destSignal: string }> | null;
  subscribe(onChange: () => void): () => void;
}

let _gatewayFeed: GatewayMappingFeed | null = null;
const _feedListeners = new Set<() => void>();

/** Install (or remove) the CONNECT mapping feed; every network re-checks. */
export function setSignalConnectorGatewayFeed(feed: GatewayMappingFeed | null): void {
  _gatewayFeed = feed;
  for (const cb of [..._feedListeners]) cb();
}

function getSignalConnectorGatewayFeed(): GatewayMappingFeed | null {
  return _gatewayFeed;
}

function onSignalConnectorGatewayFeedChanged(cb: () => void): () => void {
  _feedListeners.add(cb);
  return () => { _feedListeners.delete(cb); };
}

/**
 * A CONNECT 1:1 signal mapping (`bridge_list.mappings`, R2): the gateway writes
 * `destSignal` from `sourceSignal`. Signals are matched BY NAME against the
 * store, as the signal usage index does for bridges.
 */
export interface GatewayMappingEdge {
  readonly gateway: true;
  readonly sourceSignal: string;
  readonly destSignal: string;
}

export interface Edge {
  owner: RVSignalConnector | LegacyRelayEdge | GatewayMappingEdge;
  sourceKey: string;
  targetKey: string;
}

/**
 * All SignalConnectors (and ConnectSignal relays) of one SignalStore. Owns the
 * word aggregators and decides, for every connector, whether it may write.
 */
export class SignalConnectorNetwork {
  readonly connectors = new Set<RVSignalConnector>();
  /** The `ConnectSignal` relays of the store (collected eagerly in rv-signal-connector-link). */
  get relays(): ReadonlySet<LegacyRelayEdge> { return connectSignalRelays(this._store); }
  private readonly _aggregators = new Map<string, WordAggregator>();
  /** Aggregators that lost their last member while the word was live-controlled (clear owed). */
  private readonly _retiring = new Map<string, WordAggregator>();
  /** Reported problems per connector: key → detail. */
  private readonly _reported = new Map<RVSignalConnector, Map<SignalConnectorProblemKey, string>>();
  private _catalogUnsubs: (() => void)[] = [];
  private _revalidateQueued = false;
  private _refreshQueued = false;
  /** Transaction depth: word writes are collected and published at depth 0. */
  private _batch = 0;
  private readonly _deferred = new Set<WordAggregator>();
  /** Bumped by every check; a check whose verdicts went stale stops applying them. */
  private _gen = 0;

  constructor(private readonly _store: SignalStore, private readonly _registry: () => NodeRegistry | null) {}

  add(c: RVSignalConnector): void {
    this.connectors.add(c);
    if (this.connectors.size === 1) this._watchCatalog();
    this.revalidate();
  }

  remove(c: RVSignalConnector): void {
    if (!this.connectors.delete(c)) return;
    for (const key of this._reported.get(c)?.keys() ?? []) clearProblem(signalConnectorProblemId(c.instanceAddress, key));
    this._reported.delete(c);
    if (this.connectors.size === 0) this._unwatchCatalog();
    this.revalidate();
  }

  /**
   * A signal was added, renamed, released or re-typed: every connector reads
   * its slots, keys, types and live-control name again, and the network checks
   * once. Batched per microtask — a placement registers many signals in a row.
   */
  refresh(): void {
    this._refreshQueued = false;
    this.batch(() => {
      for (const c of [...this.connectors]) c._reconfigure(true);
      this.revalidate();
    });
  }

  /**
   * Run `fn` as one transaction: aggregators leaving and re-joining their word
   * inside it publish only the final word (no transient 1 → 0 → 1 for
   * downstream subscribers).
   */
  batch(fn: () => void): void {
    this._batch++;
    try {
      fn();
    } finally {
      this._batch--;
      if (this._batch === 0) this._flush();
    }
  }

  private _flush(): void {
    while (this._deferred.size > 0) {
      const list = [...this._deferred];
      this._deferred.clear();
      for (const agg of list) agg.flush();
    }
  }

  private _watchCatalog(): void {
    const schedule = (): void => {
      if (this._refreshQueued) return;
      this._refreshQueued = true;
      queueMicrotask(() => { if (this._refreshQueued) this.refresh(); });
    };
    const store = this._store as Partial<Pick<SignalStore, 'onCatalogChanged' | 'onSignalAdded'>>;
    if (typeof store.onCatalogChanged === 'function') this._catalogUnsubs.push(store.onCatalogChanged.call(this._store, schedule));
    if (typeof store.onSignalAdded === 'function') this._catalogUnsubs.push(store.onSignalAdded.call(this._store, schedule));
    // R2: the CONNECT mappings — a changed feed (installed, connected, bridges
    // edited) re-checks once per microtask.
    let feedUnsub: (() => void) | null = null;
    const subscribeFeed = (): void => {
      feedUnsub?.();
      const feed = getSignalConnectorGatewayFeed();
      feedUnsub = feed ? feed.subscribe(() => this._queueRevalidate()) : null;
    };
    const offFeedChanged = onSignalConnectorGatewayFeedChanged(() => { subscribeFeed(); this._queueRevalidate(); });
    subscribeFeed();
    // ConnectSignal relays come and go with their own components.
    const offRelays = subscribeConnectSignalRelays(this._store, () => this.revalidate());
    this._catalogUnsubs.push(() => { offFeedChanged(); offRelays(); feedUnsub?.(); feedUnsub = null; });
  }

  private _queueRevalidate(): void {
    if (this._revalidateQueued) return;
    this._revalidateQueued = true;
    queueMicrotask(() => {
      if (!this._revalidateQueued) return;
      this._revalidateQueued = false;
      this.batch(() => this.revalidate());
    });
  }

  private _unwatchCatalog(): void {
    for (const u of this._catalogUnsubs) u();
    this._catalogUnsubs = [];
    this._refreshQueued = false;
    this._revalidateQueued = false;
  }

  /** The aggregator of a target word (created on first use). */
  aggregatorFor(targetPath: string): WordAggregator {
    const key = this._key(targetPath);
    let agg = this._aggregators.get(key);
    if (!agg) {
      // A bit joins a word whose previous aggregator still owes its clear: the
      // new word replaces that clear.
      this._retiring.get(key)?.cancelPendingZero();
      this._retiring.delete(key);
      const reg = this._registry();
      const node = reg?.getNode(targetPath) ?? null;
      const address = (node && reg?.getAddressForNode(node)) ?? `path:${targetPath}`;
      agg = new WordAggregator(this._store, targetPath, address, {
        isBatching: () => this._batch > 0,
        defer: (a) => { this._deferred.add(a); },
        onEmpty: (a) => { if (this._aggregators.get(key) === a) this._aggregators.delete(key); },
        onPendingClear: (a) => { this._retiring.set(key, a); },
        onRetired: (a) => { if (this._retiring.get(key) === a) this._retiring.delete(key); },
      });
      this._aggregators.set(key, agg);
    }
    return agg;
  }

  /** The aggregator of a target word, if one exists (tests, diagnostics). */
  getAggregator(targetPath: string): WordAggregator | undefined {
    return this._aggregators.get(this._key(targetPath));
  }

  /** Report a runtime problem of one connector (nonfinite). */
  reportOwn(c: RVSignalConnector, key: SignalConnectorProblemKey, detail: string): void {
    let mine = this._reported.get(c);
    if (!mine) { mine = new Map(); this._reported.set(c, mine); }
    mine.set(key, detail);
    this._emit(c, key, detail);
  }

  clearOwn(c: RVSignalConnector, key: SignalConnectorProblemKey): void {
    if (this._reported.get(c)?.delete(key)) clearProblem(signalConnectorProblemId(c.instanceAddress, key));
  }

  /**
   * Re-check every connector: own configuration, fan-in per target, cycles over
   * all edges. Reports only what changed; hands each connector its verdict.
   */
  revalidate(): void {
    // Relays alone are never checked: a model with ConnectSignals and no
    // SignalConnector pays nothing (old behaviour, no new problems).
    if (this.connectors.size === 0) return;
    // Own problems depend on one connector's configuration only: computed once per
    // configuration (`ownCache`, reset by `_configure`), so a load of N connectors
    // does not rebuild N problem texts N times.
    const edges: Edge[] = [];
    for (const c of this.connectors) {
      if (!c.Enabled) continue;
      const own = this._ownProblems(c);
      if (!hasError(own) && c.edge) edges.push(c.edge);
    }
    for (const r of this.relays) edges.push({ owner: r, sourceKey: this._key(r.sourcePath), targetKey: this._key(r.targetPath) });
    // R2: enabled CONNECT mappings are writers too (keys are store names).
    for (const m of getSignalConnectorGatewayFeed()?.get() ?? []) {
      if (!m.enabled || !m.sourceSignal || !m.destSignal) continue;
      edges.push({ owner: { gateway: true, sourceSignal: m.sourceSignal, destSignal: m.destSignal }, sourceKey: m.sourceSignal, targetKey: m.destSignal });
    }

    const global = new Map<RVSignalConnector, Map<SignalConnectorProblemKey, string>>();
    const addGlobal = (c: RVSignalConnector, key: SignalConnectorProblemKey, detail: string): void => {
      let m = global.get(c);
      if (!m) { m = new Map(); global.set(c, m); }
      m.set(key, detail);
    };

    // Fan-in: more than one writer on one target. Allowed only for BitToWord
    // connectors with pairwise different bits AND pairwise different sources.
    const byTarget = new Map<string, Edge | Edge[]>();
    const sources = new Set<string>();
    for (const e of edges) {
      sources.add(e.sourceKey);
      const prev = byTarget.get(e.targetKey);
      if (prev === undefined) byTarget.set(e.targetKey, e);
      else if (Array.isArray(prev)) prev.push(e);
      else byTarget.set(e.targetKey, [prev, e]);
    }
    for (const [target, entry] of byTarget) {
      if (!Array.isArray(entry) || bitWritersCompatible(entry)) continue;
      const names = entry.map((e) => writerLabel(e.owner));
      for (const e of entry) {
        if (e.owner instanceof RVSignalConnector) {
          addGlobal(e.owner, 'fanIn', `Target "${target}" has ${entry.length} writers: ${names.join(', ')}. One target takes one writer; BitToWord connectors may share a word only with different bits and different sources.`);
        }
      }
    }

    // Cycles: any edge inside a strongly connected component (or a self loop).
    // Without a target that is also a source there is no cycle to look for.
    let chained = false;
    for (const target of byTarget.keys()) if (sources.has(target)) { chained = true; break; }
    if (chained) {
      for (const e of edgesInCycles(edges)) {
        if (e.owner instanceof RVSignalConnector) {
          addGlobal(e.owner, 'cycle', `"${e.sourceKey}" → "${e.targetKey}" is part of a signal cycle; break it, a connector couples one way only.`);
        }
      }
    }

    // Emit the differences, keep runtime-only problems (nonfinite) of healthy connectors.
    const gen = ++this._gen;
    const verdicts: [RVSignalConnector, boolean][] = [];
    for (const c of this.connectors) {
      const prev = this._reported.get(c);
      let found: Map<SignalConnectorProblemKey, string> | null = null;
      if (c.Enabled) {
        const own = this._ownProblems(c);
        const g = global.get(c);
        if (own.size > 0 || g) {
          found = new Map(own);
          if (g) for (const [k, v] of g) found.set(k, v);
        }
        const runtime = prev?.get('nonfinite');
        if (runtime !== undefined && !(found && hasError(found))) {
          if (!found) found = new Map();
          found.set('nonfinite', runtime);
        }
      }
      if (prev) {
        for (const key of prev.keys()) {
          if (found?.has(key)) continue;
          clearProblem(signalConnectorProblemId(c.instanceAddress, key));
          // The runtime warning goes with an error; the next overflow reports again.
          if (key === 'nonfinite') c._forgetNonfinite();
        }
      }
      if (found) {
        for (const [key, detail] of found) {
          if (prev?.get(key) !== detail) this._emit(c, key, detail);
        }
        this._reported.set(c, found);
      } else if (prev) {
        this._reported.delete(c);
      }
      verdicts.push([c, c.Enabled && !(found !== null && hasError(found))]);
    }
    // Applying a verdict writes signals; a subscriber may change the document and
    // run a newer check, which applies its own verdicts — these are stale then.
    for (const [c, ok] of verdicts) {
      if (gen !== this._gen) return;
      c._applyVerdict(ok);
    }
  }

  /** Problems of one connector's own configuration (cached until it changes). */
  private _ownProblems(c: RVSignalConnector): Map<SignalConnectorProblemKey, string> {
    if (c.ownCache) return c.ownCache;
    const found = new Map<SignalConnectorProblemKey, string>();
    if (c.inactiveSet.length > 0) {
      found.set('slotMismatch', `Mode ${c.Mode} uses ${c.sourceSlot} and ${c.targetSlot}; ${c.inactiveSet.join(', ')} ${c.inactiveSet.length === 1 ? 'is' : 'are'} set but ignored.`);
    }
    const missing: string[] = [];
    for (const slot of [c.sourceSlot, c.targetSlot]) {
      if (!slot) continue;
      const path = c[slot];
      if (typeof path === 'string' && path) {
        // Resolved to a node — it must also BE a signal of the slot's kind.
        const name = this._store.nameForPath?.(path);
        if (name === undefined) {
          if (typeof this._store.nameForPath === 'function') missing.push(`${slot} "${path}" is not a registered signal`);
          continue;
        }
        const type = this._store.getType?.(name);
        const kind = kindOfPlcType(type);
        if (kind && kind !== slotKind(slot)) missing.push(`${slot} "${path}" is a ${type}, the slot takes a ${slotKind(slot).toUpperCase()} signal`);
        continue;
      }
      const raw = c.rawSlotText(slot);
      missing.push(raw ? `${slot} "${raw}" does not resolve to a signal` : `${slot} is empty`);
    }
    if (missing.length > 0) found.set('unresolved', `Mode ${c.Mode}: ${missing.join('; ')}.`);
    if ((c.Mode === 'BitFromWord' || c.Mode === 'BitToWord') && !bitFitsWidth(c.Bit, c.Width)) {
      found.set('width', `Bit ${c.Bit} does not fit a ${c.Width} (${widthBits(c.Width)} bits, valid 0..${widthBits(c.Width) - 1}).`);
    }
    if (c.targetPath) {
      const type = this._store.getType?.(this._key(c.targetPath));
      if (type && type.startsWith('PLCOutput')) {
        found.set('direction', `Target "${c.targetPath}" is a ${type}; a connector writes PLC inputs only (the PLC writes its outputs).`);
      }
    }
    c.ownCache = found;
    c.edge = c.sourcePath && c.targetPath
      ? { owner: c, sourceKey: this._key(c.sourcePath), targetKey: this._key(c.targetPath) }
      : null;
    return found;
  }

  private _emit(c: RVSignalConnector, key: SignalConnectorProblemKey, detail: string): void {
    reportProblem({
      id: signalConnectorProblemId(c.instanceAddress, key),
      severity: PROBLEM_SEVERITY[key],
      code: SIGNAL_CONNECTOR_PROBLEM_CODES[key],
      title: PROBLEM_TITLE[key],
      detail,
      nodePath: c.nodePath,
    });
  }

  /** Graph key of a signal: its store name, else the path. */
  private _key(path: string): string {
    return this._store.nameForPath?.(path) ?? path;
  }
}

function hasError(found: Map<SignalConnectorProblemKey, string>): boolean {
  for (const key of found.keys()) if (PROBLEM_SEVERITY[key] === 'error') return true;
  return false;
}

function writerLabel(owner: Edge['owner']): string {
  if (owner instanceof RVSignalConnector) {
    return `SignalConnector ${owner.nodePath}${owner.Mode === 'BitToWord' ? ` (bit ${owner.Bit})` : ''}`;
  }
  if ('gateway' in owner) return `CONNECT mapping ${owner.sourceSignal} → ${owner.destSignal}`;
  return `ConnectSignal ${owner.targetPath}`;
}

function bitWritersCompatible(list: Edge[]): boolean {
  const bits = new Set<number>();
  const sources = new Set<string>();
  for (const e of list) {
    if (!(e.owner instanceof RVSignalConnector) || e.owner.Mode !== 'BitToWord') return false;
    if (bits.has(e.owner.Bit) || sources.has(e.sourceKey)) return false;
    bits.add(e.owner.Bit);
    sources.add(e.sourceKey);
  }
  return true;
}

/** Edges whose both ends lie in one strongly connected component (Tarjan, iterative). */
function edgesInCycles(edges: Edge[]): Edge[] {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    let l = out.get(e.sourceKey);
    if (!l) { l = []; out.set(e.sourceKey, l); }
    l.push(e.targetKey);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let next = 0;
  let compId = 0;
  for (const start of out.keys()) {
    if (index.has(start)) continue;
    const work: [string, number][] = [[start, 0]];
    index.set(start, next); low.set(start, next); next++;
    stack.push(start); onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const succ = out.get(v) ?? [];
      if (i < succ.length) {
        frame[1]++;
        const w = succ[i];
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next); next++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
      }
      if (low.get(v) === index.get(v)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.set(w, compId);
        } while (w !== v);
        compId++;
      }
    }
  }
  const size = new Map<number, number>();
  for (const id of comp.values()) size.set(id, (size.get(id) ?? 0) + 1);
  return edges.filter((e) => e.sourceKey === e.targetKey
    || (comp.get(e.sourceKey) !== undefined && comp.get(e.sourceKey) === comp.get(e.targetKey) && (size.get(comp.get(e.sourceKey)!) ?? 0) > 1));
}

// ── One network per SignalStore ──

const _networks = new WeakMap<SignalStore, SignalConnectorNetwork>();
const _registries = new WeakMap<SignalStore, NodeRegistry>();

/** The connector network of a SignalStore (created on first use). */
export function signalConnectorNetworkFor(store: SignalStore, registry?: NodeRegistry): SignalConnectorNetwork {
  if (registry) _registries.set(store, registry);
  let net = _networks.get(store);
  if (!net) {
    net = new SignalConnectorNetwork(store, () => _registries.get(store) ?? null);
    _networks.set(store, net);
  }
  return net;
}

// Self-register for auto-discovery by the scene loader.
registerComponent({
  type: 'SignalConnector',
  schema: RVSignalConnector.schema,
  capabilities: {
    authorable: true,
    carriesToPlacementRoot: true,
  },
  create: (node) => new RVSignalConnector(node),
});
