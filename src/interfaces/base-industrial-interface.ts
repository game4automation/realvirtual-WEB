// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * BaseIndustrialInterface — Abstract base class for all industrial protocol plugins.
 *
 * Provides the common buffer-flush pattern for bidirectional signal exchange:
 *   - Incoming signals (PLC → Viewer) are buffered in `pendingIncoming` and
 *     flushed to `SignalStore.setMany()` in `onFixedUpdatePre` (synchronous
 *     with drive physics, max 60Hz).
 *   - Outgoing signals (Viewer → PLC) are collected from `dirtyOutgoing` and
 *     sent via the protocol-specific `sendSignals()` in `onFixedUpdatePost`.
 *
 * Subclasses implement the actual protocol (WebSocket Realtime, MQTT, KEBA, etc.)
 * by overriding the abstract methods.
 *
 * Usage:
 *   class MyInterface extends BaseIndustrialInterface {
 *     readonly id = 'my-interface';
 *     readonly protocolName = 'My Protocol';
 *     async doConnect(settings) { ... }
 *     doDisconnect() { ... }
 *     sendSignals(signals) { ... }
 *   }
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import {
  createSignalWriter,
  IFACE_PATH_PREFIX,
  type SignalStore,
  type SignalWriter,
} from '../core/engine/rv-signal-store';
import type { InterfaceSettings } from './interface-settings-store';
import { debug } from '../core/engine/rv-debug';
import { reconnectDelay } from './reconnect-policy';

// ── Public Types ─────────────────────────────────────────────────────────

/**
 * Signal direction from the PLC's perspective (same nomenclature as Unity/realvirtual):
 *   'input'  = a PLC input  → the PLC reads it  → the viewer WRITES it (sent to PLC).
 *   'output' = a PLC output → the PLC writes it → the viewer READS it (display only).
 */
export type SignalDirection = 'input' | 'output';

/** Signal type matching Unity PLC signal types. */
export type SignalType = 'bool' | 'int' | 'float';

/** Describes a single discovered signal. */
export interface SignalDescriptor {
  /** Signal name (key in SignalStore). */
  name: string;
  /** Data type. */
  type: SignalType;
  /** Direction (PLC perspective): 'input' = PLC reads it (viewer writes/sends), 'output' = PLC writes it (viewer reads). */
  direction: SignalDirection;
  /** Initial value at discovery time. */
  initialValue: boolean | number;
  /** Optional protocol sub-source; part of provider identity (for example an MQTT topic). */
  topic?: string;
  /**
   * plan-563: the remote has never received a real value for this PLC input — `initialValue` is
   * only its type default. The interface offers the model value instead (`sendInitValues`).
   */
  uninitialized?: boolean;
}

/** Convert a discovered signal descriptor to the canonical SignalStore PLC type. */
export function plcTypeForSignalDescriptor(signal: Pick<SignalDescriptor, 'type' | 'direction'>): string {
  const direction = signal.direction === 'input' ? 'PLCInput' : 'PLCOutput';
  const primitive = signal.type === 'bool' ? 'Bool' : signal.type === 'int' ? 'Int' : 'Float';
  return `${direction}${primitive}`;
}

/** Connection state of an interface. */
export type InterfaceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Event payload emitted on state changes. */
export interface InterfaceStateChange {
  interfaceId: string;
  state: InterfaceConnectionState;
  error?: string;
}

// ── Abstract Base Class ──────────────────────────────────────────────────

export abstract class BaseIndustrialInterface implements RVViewerPlugin {
  /** Unique plugin ID (e.g. 'websocket-realtime', 'mqtt'). */
  abstract readonly id: string;

  /** Human-readable protocol name for UI display. */
  abstract readonly protocolName: string;

  /** Sort order — interface plugins run early to provide signal values before drive physics. */
  readonly order = 10;

  // ── State ──

  protected viewer: RVViewer | null = null;
  /** plan-539 F15: true while this interface is registered with the viewer's Simulation / PLC mode. */
  private _holdsConnectionMode = false;
  protected signalStore: SignalStore | null = null;
  protected signalWriter: SignalWriter | null = null;
  private _connectionState: InterfaceConnectionState = 'disconnected';
  private _discoveredSignals: SignalDescriptor[] = [];
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempt = 0;
  private _settings: InterfaceSettings | null = null;
  private _outgoingSubscriptions: (() => void)[] = [];
  /** Unsubscribe handle of {@link subscribeToCatalog} (plan-589). */
  private _catalogUnsub: (() => void) | null = null;
  /** Unsubscribe handle of the rename-end listener (plan-590). */
  private _renameEndUnsub: (() => void) | null = null;
  /**
   * A discovery answer that arrived while a signal rename was open (plan-590
   * Rename-/Sync-Vertrag (c)): applied only after `endRename`, so the gateway's
   * new name never races the viewer store's own rename.
   */
  private _deferredDiscovery: SignalDescriptor[] | null = null;
  private _providerProvenanceEnabled = true;
  /** The target the current connection ACTUALLY reached (plan-498) — see {@link connectedEndpoint}. */
  private _connectedEndpoint: URL | null = null;

  // ── Initial-sync marker (plan-427 F2) ──
  //
  // `setConnectionState('connected')` fires BEFORE discovery, and the values
  // discovery brings in land in `pendingIncoming` — the SignalStore only sees
  // them at the next flush. The moment a re-apply of signal LEVELS onto
  // components is safe is therefore "first incoming snapshot committed", not
  // "connected". This flag marks the window between the two.
  private _awaitingInitialSync = false;
  /** Covers a silent PLC that sends nothing at all after connecting. */
  private _initialSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long to wait for a first message before declaring the store in sync. */
  private static readonly INITIAL_SYNC_TIMEOUT_MS = 2000;

  // ── Incoming buffer (WS callback → Map → flush in onFixedUpdatePre) ──

  /**
   * Buffer for incoming signal updates received from the protocol callback.
   * Written asynchronously from WebSocket/MQTT onMessage handlers.
   * Flushed synchronously in onFixedUpdatePre.
   * Map ensures automatic dedup — last value wins if multiple updates
   * arrive between two ticks.
   */
  protected readonly pendingIncoming = new Map<string, boolean | number>();
  /** True while onFixedUpdatePre commits received values — the echo guard of the outgoing subscriptions. */
  private _applyingIncoming = false;

  /**
   * Buffer for outgoing signal values that have changed in the Viewer.
   * Populated by SignalStore subscriptions on signals the viewer writes
   * (direction 'input' = PLC inputs). Drained and sent via sendSignals() in onFixedUpdatePost.
   */
  protected readonly dirtyOutgoing = new Map<string, boolean | number>();

  // ── Public Getters ──

  get connectionState(): InterfaceConnectionState { return this._connectionState; }

  /**
   * The endpoint the CURRENT connection actually uses (plan-498 "Transport-
   * Erkennung"): set by the subclass from the target it really opened (after
   * redirects / fallbacks), without credentials or query. `null` whenever the
   * interface is not `connected` — a configured-but-unreached address is never
   * reported, so a caller cannot provision against a host it is not talking to.
   */
  get connectedEndpoint(): URL | null {
    return this._connectionState === 'connected' ? this._connectedEndpoint : null;
  }
  get discoveredSignals(): ReadonlyArray<SignalDescriptor> { return this._discoveredSignals; }
  get isConnected(): boolean { return this._connectionState === 'connected'; }

  /** Let an embedding owner provide finer-grained provider keys itself. */
  setProviderProvenanceEnabled(enabled: boolean): void {
    this._providerProvenanceEnabled = enabled;
  }

  // ── Abstract Methods (protocol-specific) ──

  /**
   * Establish the protocol connection.
   * Called by `connect()` after state transitions.
   * Must resolve when the connection is established (or reject on failure).
   */
  protected abstract doConnect(settings: InterfaceSettings): Promise<void>;

  /**
   * Tear down the protocol connection.
   * Called by `disconnect()`. Must be synchronous and idempotent.
   */
  protected abstract doDisconnect(): void;

  /**
   * Send outgoing signal values to the PLC/controller.
   * Called from `onFixedUpdatePost` with all signals that changed since last tick.
   * @param signals Map of signal name → new value
   */
  protected abstract sendSignals(signals: Record<string, boolean | number>): void;

  /**
   * Request signal discovery from the remote endpoint.
   * Called after successful connection. Must resolve with the list of available signals.
   * For WebSocket Realtime this sends `import_request` and waits for `import_answer`.
   * For MQTT this subscribes to wildcard and waits for retained messages.
   */
  protected abstract doDiscoverSignals(): Promise<SignalDescriptor[]>;

  /**
   * Offer start values for PLC inputs the remote listed as never set (plan-563 F8). The remote
   * takes each value only while the input is still unset — the first real value wins. Protocols
   * without such a message keep this no-op.
   */
  protected sendInitValues(_signals: Record<string, boolean | number>): void {
    // default: protocol has no init-status support
  }

  // ── RVViewerPlugin Lifecycle ──

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.unsubscribeFromOutgoingSignals();
    this.unsubscribeFromCatalog();
    this.viewer = viewer;
    this.signalStore = viewer.signalStore ?? null;
    this.signalWriter = this.signalStore
      ? createSignalWriter(this.signalStore, `interface:${this.id}`, 'interface')
      : null;
    this.subscribeToCatalog();

    // A model reload replaces the SignalStore. Preserve the independent
    // interface connection while rebuilding discovery, metadata and outgoing
    // subscriptions against the new store.
    if (this._discoveredSignals.length > 0) {
      this.registerDiscoveredSignals(this._discoveredSignals);
      this.subscribeToOutgoingSignals(this._discoveredSignals);
      // plan-563: a model loaded after the discovery now has the values the remote still lacks.
      if (this.isConnected) this.offerInitialValues(this._discoveredSignals);
    }

    // Auto-connect if settings say so and we're not already connected
    if (this._settings?.autoConnect && this._connectionState === 'disconnected') {
      this.connect(this._settings).catch(() => {});
    }
  }

  onModelCleared(): void {
    // Don't disconnect on model clear — interface connection is independent
  }

  /**
   * Flush incoming buffer → SignalStore (synchronous with drive physics).
   * Called at 60Hz BEFORE drive physics computation.
   */
  onFixedUpdatePre(_dt: number): void {
    if (this.pendingIncoming.size === 0 || !this.signalStore) return;

    const store = this.signalStore;
    const renaming = store.hasPendingRename;
    const batch: Record<string, boolean | number> = {};
    for (const [name, value] of this.pendingIncoming) {
      // plan-590: a value for a name the open rename already moved away would
      // re-create the old name (the store registers on set) — drop it.
      if (renaming && store.pendingRenameOf(name) !== undefined && store.get(name) === undefined) continue;
      batch[name] = value;
    }
    this.pendingIncoming.clear();
    // plan-539 F15b: the first write to a model PLC output takes the
    // Simulation / PLC mode over — the virtual PLC is switched off BEFORE this
    // batch lands, so its deactivation cannot overwrite the PLC's values.
    if (this._holdsConnectionMode) this.viewer?.connectionMode?.interfaceWrites(this.id, Object.keys(batch));
    // The store notifies synchronously, and pendingIncoming is already empty here —
    // without this flag the outgoing subscription saw every received PLC input as a
    // local change and echoed it straight back to the remote.
    this._applyingIncoming = true;
    try {
      this.signalWriter?.setMany(batch);
    } finally {
      this._applyingIncoming = false;
    }

    // plan-427 F2: this was the FIRST commit after a (re)connect — the store now
    // holds the remote's current state, including anything that changed while we
    // were away. Only now may the viewer re-apply signal levels onto components.
    this.completeInitialSync();
  }

  /**
   * Collect dirty outgoing signals and send them.
   * Called at 60Hz AFTER drive physics + transport.
   */
  onFixedUpdatePost(_dt: number): void {
    if (this.dirtyOutgoing.size === 0 || !this.isConnected) return;

    const outgoing: Record<string, boolean | number> = {};
    for (const [name, value] of this.dirtyOutgoing) {
      outgoing[name] = value;
    }
    this.dirtyOutgoing.clear();

    try {
      this.sendSignals(outgoing);
    } catch (err) {
      console.warn(`[${this.id}] sendSignals error:`, err);
    }
  }

  dispose(): void {
    this.disconnect();
    this.unsubscribeFromCatalog();
    this.viewer = null;
    this.signalStore = null;
    this.signalWriter = null;
  }

  // ── Editor catalog changes (plan-589) ──

  /**
   * Follow `SignalStore.onCatalogChanged`: an editor mutation can create,
   * remove or re-key a model signal at any time, with no model reload in
   * sight. The interface then REBUILDS its registrations and its outgoing
   * subscriptions from `_discoveredSignals` — the same work `onModelLoaded`
   * does — instead of trying to move individual listeners: a listener moved to
   * a name that no longer exists is a silent dead end, and a name that came
   * back needs a subscription nobody would re-create.
   *
   * Removed names are also purged from both buffers: a queued incoming value
   * would otherwise re-create the signal on the next flush (the store
   * registers on `set`), and a queued outgoing value would be sent for a
   * signal the model no longer has.
   */
  private subscribeToCatalog(): void {
    const store = this.signalStore;
    if (!store) return;
    // plan-590: a discovery deferred during a rename runs once the rename ends;
    // without one, a rename of a name this interface lists asks the remote for
    // its list again (the gateway renamed it first, so the answer carries the
    // new name and drops the old one — see applyDiscovery).
    this._renameEndUnsub = store.onRenameEnded((end) => {
      if (store.hasPendingRename) return;
      const deferred = this._deferredDiscovery;
      if (deferred) {
        this._deferredDiscovery = null;
        if (this.isConnected) this.applyDiscovery(deferred);
        return;
      }
      if (this._knownSignalNames.has(end.oldName) || this._knownSignalNames.has(end.newName)) {
        if (this.isConnected) this.requestRediscovery('catalog');
      }
    });
    this._catalogUnsub = store.onCatalogChanged((change) => {
      // A rename moved values under another name: whatever is still queued under
      // the OLD name belongs to a signal that no longer exists (plan-590 F4).
      for (const name of change.removed) {
        this.pendingIncoming.delete(name);
        this.dirtyOutgoing.delete(name);
      }
      // Nothing registered or removed → only descriptive metadata moved
      // (`metaChanged`), which no subscription depends on.
      if (change.registered.length === 0 && change.removed.length === 0
        && change.released.length === 0) return;
      if (this._discoveredSignals.length === 0) return;
      this.registerDiscoveredSignals(this._discoveredSignals);
      this.subscribeToOutgoingSignals(this._discoveredSignals);
    });
  }

  private unsubscribeFromCatalog(): void {
    this._catalogUnsub?.();
    this._catalogUnsub = null;
    this._renameEndUnsub?.();
    this._renameEndUnsub = null;
  }

  // ── Public API ──

  /**
   * Connect to the remote endpoint with the given settings.
   * Handles state transitions, discovery, and reconnect setup.
   */
  async connect(settings: InterfaceSettings): Promise<void> {
    this._settings = settings;
    this._reconnectAttempt = 0;
    this.cancelReconnect();
    this.resetRediscovery();

    this.setConnectionState('connecting');

    try {
      await this.doConnect(settings);
      this.setConnectionState('connected');

      // Run signal discovery
      try {
        const signals = await this.doDiscoverSignals();
        this.applyDiscovery(signals);
        // plan-427 F2: discovery succeeded, so a first incoming snapshot is now
        // expected. Arm the marker; the flush in onFixedUpdatePre resolves it.
        this.beginInitialSync();
      } catch (discErr) {
        console.warn(`[${this.id}] Signal discovery failed:`, discErr);
        // Connection succeeded even if discovery failed — user can retry.
        // Deliberately NO sync marker: without a signal list there is nothing
        // trustworthy in the store, and replaying stale pre-disconnect levels
        // onto the plant would be worse than doing nothing (behaviour as before).
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.setConnectionState('error', errorMsg);
      this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Record the target this connection really opened (plan-498). Called by the
   * subclass once its transport is open; query string and user info are
   * stripped (an `apikey=` must never travel onwards). `null` clears it.
   */
  protected setConnectedEndpoint(target: URL | string | null): void {
    if (target === null) {
      this._connectedEndpoint = null;
      return;
    }
    try {
      const url = new URL(typeof target === 'string' ? target : target.href);
      url.search = '';
      url.hash = '';
      url.username = '';
      url.password = '';
      this._connectedEndpoint = url;
    } catch {
      this._connectedEndpoint = null;
    }
  }

  /** Disconnect and stop reconnect attempts. */
  disconnect(): void {
    this._connectedEndpoint = null;
    // Fix 4: Set state first — prevents onConnectionLost from triggering reconnect
    this._connectionState = 'disconnected'; // direct assignment, skip event for now

    this.unsubscribeFromOutgoingSignals();
    this.resetRediscovery();
    this.pendingIncoming.clear();
    this.dirtyOutgoing.clear();
    // plan-427: a pending sync window dies with the connection — never emit a
    // sync (and thus a level re-apply) for a link that is already gone.
    this._awaitingInitialSync = false;
    this.cancelInitialSyncTimer();
    this.setProviderConnectionState(false);

    try {
      this.doDisconnect();
    } catch (err) {
      console.warn(`[${this.id}] doDisconnect error:`, err);
    }

    this.cancelReconnect(); // AFTER doDisconnect — catches any timer set during close
    // plan-539 F15: an explicit disconnect releases the Simulation / PLC mode
    // too (the state was set directly above, so setConnectionState is a no-op).
    if (this._holdsConnectionMode) {
      this._holdsConnectionMode = false;
      this.viewer?.connectionMode?.interfaceDisconnected(this.id);
    }
    this.setConnectionState('disconnected'); // emit events now (no-op if already disconnected)
  }

  /**
   * Re-run signal discovery without reconnecting.
   * Useful when the PLC program has changed.
   */
  async rediscover(): Promise<SignalDescriptor[]> {
    if (!this.isConnected) {
      throw new Error(`Cannot discover signals: ${this.id} is not connected`);
    }
    // plan-563 F14: single flight — a second caller while a request is pending shares it instead
    // of sending a second import_request whose answer would race the first.
    if (this._rediscoverPromise) return this._rediscoverPromise;
    const pending = this.discoverAndApply();
    this._rediscoverPromise = pending;
    const clear = (): void => {
      if (this._rediscoverPromise === pending) this._rediscoverPromise = null;
    };
    pending.then(clear, clear);
    return pending;
  }

  private async discoverAndApply(): Promise<SignalDescriptor[]> {
    // The old outgoing subscriptions stay active while the answer is pending —
    // subscribeToOutgoingSignals() swaps them — so a viewer write made meanwhile
    // is still sent instead of being dropped.
    const generation = this._connectionGeneration;
    const signals = await this.doDiscoverSignals();
    // A disconnect (or a disconnect + reconnect) while the answer was pending:
    // the list belongs to a connection that no longer exists — apply nothing.
    if (generation !== this._connectionGeneration || !this.isConnected) return signals;
    this.applyDiscovery(signals);
    return signals;
  }

  /**
   * Take over one discovery answer: list, store registration, outgoing subscriptions, init offer.
   *
   * plan-590: while a signal rename is open the answer is parked and applied
   * after `endRename` (Rename-/Sync-Vertrag (c)). Names the previous answer
   * listed and this one no longer does are withdrawn (F4): the provider entry,
   * the interface placeholder `__iface__/<name>` (the name itself goes only
   * when nothing else owns it) and anything still queued under it.
   */
  private applyDiscovery(signals: SignalDescriptor[]): void {
    if (this.signalStore?.hasPendingRename) {
      this._deferredDiscovery = signals;
      return;
    }
    this._deferredDiscovery = null;
    const previous = this._discoveredSignals;
    this.setDiscoveredSignals(signals);
    this.withdrawVanishedSignals(previous, signals);
    this.registerDiscoveredSignals(signals);
    this.subscribeToOutgoingSignals(signals);
    this.offerInitialValues(signals);
  }

  /** Withdraw what `previous` listed and `next` does not (plan-590 F4). */
  private withdrawVanishedSignals(
    previous: ReadonlyArray<SignalDescriptor>,
    next: ReadonlyArray<SignalDescriptor>,
  ): void {
    if (previous.length === 0) return;
    const keep = new Set<string>();
    for (const sig of next) keep.add(sig.name);
    const store = this.signalStore;
    for (const sig of previous) {
      if (keep.has(sig.name)) continue;
      this.pendingIncoming.delete(sig.name);
      this.dirtyOutgoing.delete(sig.name);
      if (!store) continue;
      if (this._providerProvenanceEnabled) {
        store.unregisterSignalProviderSignal({
          interfaceId: this.id,
          ...(sig.topic !== undefined ? { topic: sig.topic } : {}),
          signal: sig.name,
        });
      }
      const placeholder = `${IFACE_PATH_PREFIX}${sig.name}`;
      if (store.registeredPaths(sig.name).includes(placeholder)) {
        store.unregisterPath(placeholder, sig.name);
      }
    }
  }

  /**
   * Opt-in (the CONNECT gateway): an incoming value for a signal the last
   * discovery did not list means the remote's signal list grew — e.g. an
   * interface was added or "PLC auto-map → Apply" created signals while this
   * viewer stayed connected. Such signals were applied incoming but never sent
   * outgoing, so a PLC input set in the viewer silently never reached the PLC
   * until the page was reloaded. With this flag the list is re-read.
   *
   * Since plan-563 CONNECT also says so explicitly (`catalog_changed` →
   * {@link requestRediscovery}) — needed for inputs, which it no longer
   * broadcasts before they have a value. The unknown-name path stays as the
   * fallback for older gateways; both feed the SAME scheduler.
   */
  protected rediscoverOnUnknownSignal = false;
  /** Bumped on every connect/disconnect — an answer from an older connection is discarded. */
  private _connectionGeneration = 0;
  private _knownSignalNames = new Set<string>();
  private _discoveryComplete = false;
  /** Incoming names the current list does not contain, waiting for a re-read. */
  private readonly _unknownSeen = new Set<string>();
  /** Names a SUCCESSFUL re-read still did not list — never asked for again (no loop). */
  private readonly _unknownGivenUp = new Set<string>();
  /** plan-563 F14: the remote announced a catalog change that no run has picked up yet ("pending again"). */
  private _catalogDirty = false;
  private _rediscoverTimer: ReturnType<typeof setTimeout> | null = null;
  private _rediscoverInFlight = false;
  /** plan-563 F14: the one discovery request currently pending (shared by every caller). */
  private _rediscoverPromise: Promise<SignalDescriptor[]> | null = null;
  private _rediscoverFailures = 0;
  private static readonly REDISCOVER_DEBOUNCE_MS = 250;
  private static readonly REDISCOVER_MAX_FAILURES = 3;

  private setDiscoveredSignals(signals: SignalDescriptor[]): void {
    this._discoveredSignals = signals;
    this._knownSignalNames = new Set(signals.map((s) => s.name));
    this._discoveryComplete = true;
    for (const name of this._unknownSeen) if (this._knownSignalNames.has(name)) this._unknownSeen.delete(name);
    // Names / catalog changes that arrived while this discovery was running are handled now.
    if (this.hasRediscoveryWork()) this.scheduleRediscovery();
  }

  private noteIncomingName(name: string): void {
    if (this._knownSignalNames.has(name) || this._unknownGivenUp.has(name)) return;
    this._unknownSeen.add(name);
    this.scheduleRediscovery();
  }

  /**
   * Ask the shared discovery scheduler for a re-read (plan-563 F14). `'catalog'` = the remote
   * announced that its signal list changed; it is remembered until a run STARTED after it has
   * completed, so a change during a running discovery triggers exactly one follow-up.
   */
  protected requestRediscovery(reason: 'catalog'): void {
    if (reason === 'catalog') this._catalogDirty = true;
    this.scheduleRediscovery();
  }

  private hasRediscoveryWork(): boolean {
    return this._catalogDirty || (this.rediscoverOnUnknownSignal && this._unknownSeen.size > 0);
  }

  /** Single flight: one re-read at a time; names / catalog changes seen meanwhile trigger the next one. */
  private scheduleRediscovery(): void {
    if (!this._discoveryComplete || this._rediscoverInFlight || this._rediscoverTimer !== null) return;
    this._rediscoverTimer = setTimeout(() => {
      this._rediscoverTimer = null;
      void this.runRediscovery();
    }, BaseIndustrialInterface.REDISCOVER_DEBOUNCE_MS);
  }

  private async runRediscovery(): Promise<void> {
    if (!this.isConnected || !this.hasRediscoveryWork()) return;
    const generation = this._connectionGeneration;
    const asked = [...this._unknownSeen];
    const catalog = this._catalogDirty;
    // Taken by THIS run; a catalog_changed arriving while it is in flight sets it again.
    this._catalogDirty = false;
    this._rediscoverInFlight = true;
    debug('interface', catalog
      ? `[${this.id}] Remote signal catalog changed — re-reading it`
      : `[${this.id}] Remote signal list grew (${asked.join(', ')}) — re-reading it`);
    let ok = false;
    try {
      // A request somebody else started BEFORE this run may predate the change it handles — let it
      // finish, then ask once more (single flight still holds: never two requests at a time).
      const earlier = this._rediscoverPromise;
      if (earlier) await earlier.catch(() => {});
      if (generation !== this._connectionGeneration) return;
      await this.rediscover();
      ok = true;
    } catch (err) {
      console.warn(`[${this.id}] Rediscovery failed:`, err);
    } finally {
      this._rediscoverInFlight = false;
    }
    if (generation !== this._connectionGeneration) return; // reset by disconnect/connect meanwhile
    if (ok) {
      this._rediscoverFailures = 0;
      for (const name of asked) {
        if (!this._knownSignalNames.has(name)) this._unknownGivenUp.add(name);
        this._unknownSeen.delete(name);
      }
    } else if (++this._rediscoverFailures >= BaseIndustrialInterface.REDISCOVER_MAX_FAILURES) {
      for (const name of asked) { this._unknownGivenUp.add(name); this._unknownSeen.delete(name); }
      this._rediscoverFailures = 0;
    } else if (catalog) {
      this._catalogDirty = true; // failed run: the catalog change is still unhandled — retry
    }
    if (this.hasRediscoveryWork()) this.scheduleRediscovery();
  }

  private resetRediscovery(): void {
    this._connectionGeneration++;
    this._discoveryComplete = false;
    this._knownSignalNames.clear();
    this._unknownSeen.clear();
    this._unknownGivenUp.clear();
    this._catalogDirty = false;
    this._rediscoverInFlight = false;
    this._rediscoverPromise = null;
    this._rediscoverFailures = 0;
    if (this._rediscoverTimer !== null) {
      clearTimeout(this._rediscoverTimer);
      this._rediscoverTimer = null;
    }
  }

  /**
   * plan-563 F8: offer the model's current value for every PLC input the remote listed as never
   * set. Only signals that exist in the MODEL count (a scene path, not the `__iface__/` placeholder
   * an interface-only symbol gets) — an interface-only symbol has no model value to offer, only the
   * remote's own default. Offering again after a later discovery is harmless: the remote keeps the
   * first value and lists only names that are still unset.
   */
  private offerInitialValues(signals: ReadonlyArray<SignalDescriptor>): void {
    const store = this.signalStore;
    if (!store) return;
    const offer: Record<string, boolean | number> = {};
    let count = 0;
    for (const sig of signals) {
      if (!sig.uninitialized || sig.direction !== 'input') continue;
      const path = store.getPath(sig.name);
      if (path === undefined || path.startsWith('__iface__/')) continue;
      const value = store.get(sig.name);
      if (typeof value !== 'boolean' && typeof value !== 'number') continue;
      offer[sig.name] = value;
      count++;
    }
    if (count === 0) return;
    debug('interface', `[${this.id}] Offering ${count} model value(s) for unset PLC inputs: ${Object.keys(offer).join(', ')}`);
    try {
      this.sendInitValues(offer);
    } catch (err) {
      console.warn(`[${this.id}] sendInitValues error:`, err);
    }
  }

  // ── Helpers for Subclasses ──

  /**
   * Called by subclass protocol handlers when incoming data arrives.
   * Writes to the pendingIncoming buffer — NOT directly to SignalStore.
   * Safe to call from async callbacks (WebSocket.onmessage, MQTT.on('message')).
   */
  protected bufferIncoming(signals: Record<string, boolean | number>): void {
    for (const name in signals) {
      this.pendingIncoming.set(name, signals[name]);
      if (this.rediscoverOnUnknownSignal) this.noteIncomingName(name);
    }
    // Also emit interface-data event for plugins that want raw data
    this.viewer?.emit('interface-data', {
      interfaceId: this.id,
      signals,
    });
  }

  /**
   * Called by subclass when the protocol connection is lost unexpectedly.
   * Triggers state change and schedules reconnect.
   */
  protected onConnectionLost(reason?: string): void {
    if (this._connectionState === 'disconnected') return; // Already handled
    this.setConnectionState('disconnected');
    this.viewer?.emit('interface-disconnected', {
      interfaceId: this.id,
      reason: reason ?? 'Connection lost',
    });
    this.scheduleReconnect();
  }

  /**
   * Called by subclass when a protocol-level error occurs.
   */
  protected onProtocolError(error: string): void {
    console.error(`[${this.id}] Protocol error: ${error}`);
    this.viewer?.emit('interface-error', {
      interfaceId: this.id,
      error,
    });
  }

  /**
   * Calculate reconnect delay with exponential backoff.
   * @param attempt Zero-based attempt number
   * @returns Delay in milliseconds (capped at RECONNECT_MAX_MS)
   */
  getReconnectDelay(attempt: number): number {
    return reconnectDelay(attempt);
  }

  // ── Initial-sync marker (plan-427 F2) ──

  /**
   * Arm the "waiting for the first incoming snapshot" window. Called after a
   * successful discovery; resolved by the first `pendingIncoming` flush.
   *
   * The timeout is the fallback for a silent endpoint (a PLC whose outputs
   * simply do not change, an MQTT broker without retained messages): the store
   * values are then unchanged and the re-apply is a harmless idempotent pass.
   */
  protected beginInitialSync(): void {
    this.cancelInitialSyncTimer();
    this._awaitingInitialSync = true;
    this._initialSyncTimer = setTimeout(() => {
      this._initialSyncTimer = null;
      this.completeInitialSync();
    }, BaseIndustrialInterface.INITIAL_SYNC_TIMEOUT_MS);
  }

  /**
   * Resolve the sync window exactly once and tell the viewer. Idempotent: the
   * flush path and the timeout race deliberately, and whoever wins clears the
   * flag for the other.
   */
  protected completeInitialSync(): void {
    if (!this._awaitingInitialSync) return;
    this._awaitingInitialSync = false;
    this.cancelInitialSyncTimer();
    this.viewer?.emit('interface-signals-synced', { interfaceId: this.id });
  }

  private cancelInitialSyncTimer(): void {
    if (this._initialSyncTimer !== null) {
      clearTimeout(this._initialSyncTimer);
      this._initialSyncTimer = null;
    }
  }

  // ── Internal Helpers ──

  private setConnectionState(state: InterfaceConnectionState, error?: string): void {
    const previous = this._connectionState;
    if (previous === state) return;

    this._connectionState = state;
    this.setProviderConnectionState(state === 'connected');

    // Update viewer's global connection state. plan-539 F15/F15b: through the
    // Simulation / PLC controller — a connection alone changes nothing; the
    // interface takes over only once it writes a model PLC output (see
    // onFixedUpdatePre); its disconnect returns to the saved StartMode.
    const mode = this.viewer?.connectionMode;
    if (state === 'connected') {
      if (mode) {
        // Counted once per interface, also across reconnects via 'error'.
        if (!this._holdsConnectionMode) mode.interfaceConnected(this.id);
        this._holdsConnectionMode = true;
      } else {
        this.viewer?.setConnectionState?.('Connected');
      }
      this.viewer?.emit('interface-connected', {
        interfaceId: this.id,
        type: this.protocolName,
      });
    } else if (state === 'disconnected' && (previous === 'connected' || this._holdsConnectionMode)) {
      if (mode) {
        if (this._holdsConnectionMode) mode.interfaceDisconnected(this.id);
        this._holdsConnectionMode = false;
      } else {
        this.viewer?.setConnectionState?.('Disconnected');
      }
    }

    if (state === 'error' && error) {
      this.viewer?.emit('interface-error', {
        interfaceId: this.id,
        error,
      });
    }
  }

  /** Register discovered signals in the SignalStore. */
  private registerDiscoveredSignals(signals: SignalDescriptor[]): void {
    // plan-539 F15b: a takeover ends when the interface no longer sources any model output.
    if (this._holdsConnectionMode) this.viewer?.connectionMode?.interfaceSources(this.id, signals.map((sig) => sig.name));
    if (!this.signalStore) return;

    const store = this.signalStore;
    const renaming = store.hasPendingRename;
    let registered = 0;
    for (const sig of signals) {
      // plan-590 Rename-/Sync-Vertrag (b): neither side of an open rename is
      // (re-)registered here — the store rename moves it, endRename re-applies.
      if (renaming && store.isRenamePending(sig.name)) continue;
      // If a signal with this name is already registered — most importantly a GLB
      // MODEL signal carrying its real scene path — do NOT re-register it under the
      // synthetic __iface__ placeholder. register() overwrites nameToPath, so doing
      // so would clobber getPath()/path resolution for the model signal (it would
      // resolve to "__iface__/<name>" instead of its scene node). The interface only
      // needs the value in the store, which the model signal already provides; live
      // values still flow through set(). A pure interface-only symbol (no model node)
      // has no path yet and is registered with the __iface__ placeholder as before.
      if (this.signalStore.getPath(sig.name) !== undefined) continue;
      // Fix 6: Use prefixed path to avoid collision with GLB model paths
      this.signalStore.register(
        sig.name,
        `__iface__/${sig.name}`,
        sig.initialValue,
        plcTypeForSignalDescriptor(sig),
      );
      registered++;
    }
    if (!this._providerProvenanceEnabled) return;
    for (const sig of signals) {
      if (renaming && store.isRenamePending(sig.name)) continue;
      this.signalStore.registerSignalProvider({
        interfaceId: this.id,
        ...(sig.topic !== undefined ? { topic: sig.topic } : {}),
        signal: sig.name,
      }, this.isConnected);
    }
    debug('interface', `[${this.id}] Registered ${registered}/${signals.length} signals in SignalStore (skipped already-known model signals)`);
  }

  /**
   * Subscribe to the outgoing signals (Viewer → PLC) in the SignalStore.
   * These are PLC inputs (direction 'input' = the PLC reads them, the viewer writes them).
   * When a UI element or logic changes such a signal, it gets queued
   * in dirtyOutgoing for the next onFixedUpdatePost cycle.
   */
  private subscribeToOutgoingSignals(signals: SignalDescriptor[]): void {
    this.unsubscribeFromOutgoingSignals();
    if (!this.signalStore) return; // Fix 1: null guard

    for (const sig of signals) {
      // Only signals the viewer WRITES are sent to the PLC = PLC inputs ('input').
      if (sig.direction !== 'input') continue;

      const unsub = this.signalStore.subscribe(sig.name, (value) => {
        // Fix 7: Don't echo back values we just received from the remote
        if (this._applyingIncoming || this.pendingIncoming.has(sig.name)) return;
        this.dirtyOutgoing.set(sig.name, value);
      });
      this._outgoingSubscriptions.push(unsub);
    }
  }

  private unsubscribeFromOutgoingSignals(): void {
    for (const unsub of this._outgoingSubscriptions) unsub();
    this._outgoingSubscriptions = [];
  }

  private setProviderConnectionState(connected: boolean): void {
    if (!this.signalStore || !this._providerProvenanceEnabled) return;
    if (this._discoveredSignals.length === 0) {
      this.signalStore.setSignalProviderConnected({ interfaceId: this.id }, connected);
      return;
    }
    for (const sig of this._discoveredSignals) {
      this.signalStore.setSignalProviderConnected({
        interfaceId: this.id,
        ...(sig.topic !== undefined ? { topic: sig.topic } : {}),
      }, connected);
    }
  }

  private scheduleReconnect(): void {
    if (!this._settings?.autoConnect) return;
    this.cancelReconnect();

    const delay = this.getReconnectDelay(this._reconnectAttempt);
    this._reconnectAttempt++;

    debug('interface', `[${this.id}] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);

    this._reconnectTimer = setTimeout(async () => {
      if (this._connectionState !== 'disconnected' && this._connectionState !== 'error') return;
      try {
        await this.connect(this._settings!);
      } catch {
        // connect() already calls scheduleReconnect on failure
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// ── Utility: Parse signal type string from C# ───────────────────────────

/**
 * Converts a C# PLC signal type string to SignalDescriptor fields.
 * Same nomenclature as Unity: a "PLCOutput*" is a PLC output (PLC writes, viewer reads) → 'output';
 * a "PLCInput*" is a PLC input (PLC reads, viewer writes) → 'input'.
 * @param plcType e.g. "PLCInputBool", "PLCOutputFloat", "PLCInputInt"
 */
export function parseSignalType(plcType: string): { type: SignalType; direction: SignalDirection } {
  const lower = plcType.toLowerCase();

  const direction: SignalDirection = lower.includes('output') ? 'output' : 'input';

  let type: SignalType = 'float';
  if (lower.includes('bool')) type = 'bool';
  else if (lower.includes('int')) type = 'int';

  return { type, direction };
}

/**
 * Returns the appropriate default value for a signal type.
 */
export function defaultValueForType(type: SignalType): boolean | number {
  return type === 'bool' ? false : 0;
}
