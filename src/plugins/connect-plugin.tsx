// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-plugin.tsx — realvirtual CONNECT gateway plugin.
 *
 * Registers an icon button in the TopBar ('toolbar-button' slot) that
 * toggles the ConnectPanel via the LeftPanelManager. A green dot on the
 * Cable icon indicates an active gateway connection.
 */

import { useSyncExternalStore, useCallback } from 'react';
import { Cable } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { modeContext } from '../core/rv-mode-manager';
import { getStoredConnectPanelWidth } from '../core/hmi/layout-constants';
import { WebSocketRealtimeInterface } from '../interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS, type InterfaceSettings } from '../interfaces/interface-settings-store';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  connectToServer,
  canSilentlyProbeGateway,
  hasStoredServerUrl,
  hasAutoConnectOptOut,
  hasUserConnectedBefore,
  isLocalGatewayTarget,
  isLoopbackOrigin,
  isSourceConnectedLive,
  type ConnectInterface,
  type ConnectSnapshot,
} from '../core/hmi/connect-store';
import { isConnectDataStale } from '../core/hmi/connect-staleness';
import { ISA_AMBER } from '../core/hmi/isa-colors';
import { signalProviderKey, type SignalSourceRef } from '../core/engine/rv-signal-provider';
import { Tooltip, IconButton, Box } from '@mui/material';

// ── CONNECT signal metadata → SignalStore ─────────────────────────────

/**
 * Spill CONNECT signal metadata (protocol address, comment, origin) into the
 * viewer SignalStore so the SignalBadge hover tooltip can show it everywhere.
 * Iterates both the top-level interface `signals` (OPC-UA / S7) and every
 * MQTT topic's `signals`. `setSignalMeta` merges, so re-running is harmless.
 */
function mirrorConnectSignalMeta(viewer: RVViewer, interfaces: ConnectInterface[]): void {
  const store = viewer.signalStore;
  if (!store) return;
  for (const iface of interfaces) {
    // Top-level (non-MQTT) signals.
    for (const sig of iface.signals ?? []) {
      store.setSignalMeta(sig.name, {
        address: sig.protocolAddress || undefined,
        comment: sig.comment ?? undefined,
        source: iface.type,
      });
    }
    // MQTT per-topic signals.
    for (const topic of iface.topics ?? []) {
      for (const sig of topic.signals ?? []) {
        store.setSignalMeta(sig.name, {
          address: sig.protocolAddress || undefined,
          comment: sig.comment ?? undefined,
          source: `${iface.type} · ${topic.topic}`,
        });
      }
    }
  }
}

// ── Activity Bar Button Component (opens the CONNECT left window) ─────

function ConnectToolbarButton({ viewer }: UISlotProps) {
  const connectSnap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = panelSnap.activePanel === 'connect';
  const isConnected = connectSnap.state === 'connected';
  // Stale (gateway unreachable / errored) wins over connected: the amber dot on
  // this icon is the ONLY global indicator for lost live data (no banner/chip).
  const isStale = isConnectDataStale(connectSnap, hasStoredServerUrl());

  const handleClick = useCallback(() => {
    // Use the user's persisted resize (falls back to the default) so the viewport
    // shift matches the width the panel will actually render with.
    lpm.toggle('connect', getStoredConnectPanelWidth());
  }, [lpm]);

  const title = isStale
    ? 'CONNECT - live data lost'
    : isConnected ? 'CONNECT (connected)' : 'realvirtual CONNECT';

  return (
    <Tooltip title={title} placement="right">
      <IconButton
        size="small"
        color={isActive ? 'primary' : 'inherit'}
        sx={{ p: 0.75, position: 'relative' }}
        onClick={handleClick}
        aria-label={title}
      >
        <Cable fontSize="small" />
        {/* Status dot: amber = live data lost, green = connected */}
        {(isStale || isConnected) && (
          <Box
            data-testid="connect-status-dot"
            sx={{
              position: 'absolute', top: 4, right: 4, width: 6, height: 6,
              borderRadius: '50%', bgcolor: isStale ? ISA_AMBER : '#66bb6a',
            }}
          />
        )}
      </IconButton>
    </Tooltip>
  );
}

// ── Auto WS stream ────────────────────────────────────────────────────

/** Build WebSocket-Realtime settings targeting a CONNECT gateway's /ws from its REST URL. */
function buildConnectWsSettings(serverUrl: string): InterfaceSettings {
  let host = 'localhost';
  let port = 5100;
  let ssl = false;
  try {
    const u = new URL(serverUrl);
    host = u.hostname || host;
    ssl = u.protocol === 'https:';
    port = u.port ? parseInt(u.port, 10) : (ssl ? 443 : 80);
  } catch {
    // keep defaults
  }
  return {
    ...INTERFACE_DEFAULTS,
    activeType: 'websocket-realtime',
    autoConnect: true,
    wsAddress: host,
    wsPort: port,
    wsUseSSL: ssl,
    wsPath: '/ws',
  };
}

// ── Boot auto-reconnect (plan-421 F1) ────────────────────────────────

/**
 * Backoff ladder of the page-load auto-probe, in milliseconds. The LAST entry
 * repeats forever: after the fast opening chain the plugin keeps probing at
 * most once per 60 s, so a CONNECT that is started minutes AFTER the page still
 * gets picked up without any user action. A finite chain would have missed
 * exactly the case the user reported (plan-421 F1 / SOL-R1-4).
 */
const BOOT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * Minimum spacing between two wake-triggered probes (visibility/online). Those
 * events are user/OS driven and may arrive in bursts (alt-tabbing); the spacing
 * keeps a burst from turning into a burst of gateway requests.
 */
const WAKE_MIN_SPACING_MS = 1_000;

// ── Plugin Class ─────────────────────────────────────────────────────

export class ConnectPlugin implements RVViewerPlugin {
  readonly id = 'connect';
  readonly order = 55;

  readonly slots: UISlotEntry[] = [
    // Opens a left-docked window → lives in the activity bar.
    //
    // The ActivityBar shows entries WITHOUT a rule unconditionally (unlike the
    // ButtonPanel, which hides ruleless entries outside hmi), so the Viewer
    // needs an explicit rule here (plan-387 F4). It is a plain `hiddenIn` rather
    // than a `modes` declaration on the plugin: the CONNECT gateway connection
    // must keep running in the Viewer, only its window-opener disappears.
    {
      slot: 'activity-bar', component: ConnectToolbarButton, order: 60,
      visibilityRule: { hiddenIn: [modeContext('viewer')] },
    },
  ];

  /**
   * Embedded WebSocket-Realtime client that streams live signal values from the connected
   * CONNECT gateway (ws://…/ws) into the viewer SignalStore. Owned here — not registered with the
   * InterfaceManager — so it never consumes the single-interface mutex of the Interfaces tab.
   */
  private wsStream: WebSocketRealtimeInterface | null = null;
  private viewer: RVViewer | null = null;
  private unsubscribe: (() => void) | null = null;
  private streaming = false;
  /** Last `interfaces` array mirrored into the SignalStore — skip the walk when unchanged. */
  private lastMirroredInterfaces: ConnectInterface[] | null = null;
  private readonly registeredProviders = new Map<string, Pick<SignalSourceRef, 'interfaceId' | 'topic'>>();

  // ── Boot auto-reconnect state (plan-421 F1) ──
  /** Loop is running: a timer is pending or an attempt is in flight. */
  private retryArmed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Index into {@link BOOT_RETRY_DELAYS_MS}; saturates on the last (60 s) entry. */
  private retryStep = 0;
  /**
   * Cancellation token. Every cancel point — dispose, re-init, a manual Connect,
   * a URL change — bumps it, so an attempt whose async steps resolve afterwards
   * writes no state and schedules nothing.
   */
  private retryGeneration = 0;
  /** At most ONE probe in flight; a firing timer never stacks a second one. */
  private retryInFlight = false;
  /** `Date.now()` of the last started probe — wake-trigger spacing only. */
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private lastSeenServerUrl = '';
  private lastSeenState: ConnectSnapshot['state'] = 'disconnected';

  /** Start model-independent CONNECT discovery and state observation. */
  init(): void {
    // A re-init supersedes whatever the previous one left running.
    this.cancelRetries();
    this.disposed = false;
    const snap = getConnectSnapshot();
    this.lastSeenServerUrl = snap.serverUrl;
    this.lastSeenState = snap.state;
    this.unsubscribe = subscribeConnectStore(() => this.onConnectStoreChanged());
    // Coming back to the tab or regaining the network is the moment a gateway is
    // most likely to have appeared — probe then instead of waiting out the 60 s.
    if (typeof window !== 'undefined') window.addEventListener('online', this.handleWake);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleWake);
    }
    this.maybeStartRetries();
  }

  /**
   * May a page-load probe touch the gateway at all?
   *
   * An explicit Disconnect is remembered across reloads — never probe against the user's will
   * (checked by the caller). On a hosted (non-loopback) origin a LOCAL gateway target may only
   * be auto-probed after the user connected explicitly at least once (hasUserConnectedBefore):
   * Chrome's Local Network Access prompt belongs to the explicit Connect click, never to a page
   * load. A stored NON-local gateway URL keeps auto-connecting as before — no browser prompt
   * exists for public targets. canSilentlyProbeGateway() stays as the second, permission-state-
   * based gate inside {@link attemptAutoConnect}.
   */
  private mayProbe(snap: ConnectSnapshot): boolean {
    return isLoopbackOrigin()
      || (hasStoredServerUrl()
        && (!isLocalGatewayTarget(snap.serverUrl) || hasUserConnectedBefore()));
  }

  /**
   * Last logged idle reason — every guard that silences the auto-reconnect logs WHY, but only
   * on a reason change, never per tick (debug-026: four agents of archaeology because all
   * gates failed without a trace).
   */
  private lastIdleReason: string | null = null;

  private logIdle(reason: string): void {
    if (this.lastIdleReason === reason) return;
    this.lastIdleReason = reason;
    console.info(`[connect] auto-reconnect idle: ${reason}`);
  }

  /** Arm the loop and fire the first probe, unless a guard forbids it right now. */
  private maybeStartRetries(): void {
    if (this.retryArmed || this.disposed) return;
    const snap = getConnectSnapshot();
    // `error` is a retryable state, not a dead end: connectToServer() leaves it
    // behind after every failed attempt (connect-store.ts:959), so a loop that
    // only retried on `disconnected` would run exactly once (SOL-R1-1).
    if (snap.state !== 'disconnected' && snap.state !== 'error') return;
    if (hasAutoConnectOptOut()) {
      this.logIdle('user disconnected explicitly - click Connect to re-enable');
      return;
    }
    if (!this.mayProbe(snap)) {
      this.logIdle('silent probing needs one successful explicit Connect on this origin first');
      return;
    }
    this.retryArmed = true;
    this.retryStep = 0;
    this.scheduleAttempt(0);
  }

  /** Disarm the loop. An in-flight attempt settles quietly (it re-checks `retryArmed`). */
  private stopRetries(): void {
    this.retryArmed = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Disarm AND invalidate the in-flight attempt — nothing of it may land anymore. */
  private cancelRetries(): void {
    this.retryGeneration++;
    this.retryInFlight = false;
    this.stopRetries();
  }

  private scheduleAttempt(delayMs: number): void {
    if (!this.retryArmed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const generation = this.retryGeneration;
    if (delayMs <= 0) {
      void this.attemptAutoConnect(generation);
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attemptAutoConnect(generation);
    }, delayMs);
  }

  /** Queue the next probe, advancing the backoff ladder (last step repeats forever). */
  private rearm(generation: number): void {
    if (generation !== this.retryGeneration || !this.retryArmed || this.disposed) return;
    const last = BOOT_RETRY_DELAYS_MS.length - 1;
    const delay = BOOT_RETRY_DELAYS_MS[Math.min(this.retryStep, last)];
    this.retryStep = Math.min(this.retryStep + 1, last);
    this.scheduleAttempt(delay);
  }

  /**
   * One silent probe. EVERY guard is re-evaluated here, not once at boot: an
   * explicit Disconnect (opt-out) or a revoked LNA permission has to stop the
   * loop at the next attempt, not only at the next page load.
   */
  private async attemptAutoConnect(generation: number): Promise<void> {
    if (generation !== this.retryGeneration || !this.retryArmed || this.retryInFlight) return;

    if (hasAutoConnectOptOut()) {
      this.logIdle('user disconnected explicitly - click Connect to re-enable');
      this.stopRetries();
      return;
    }
    const snap = getConnectSnapshot();
    if (snap.state === 'connected') { this.stopRetries(); return; }
    if (snap.state !== 'disconnected' && snap.state !== 'error') { this.rearm(generation); return; }
    if (!this.mayProbe(snap)) {
      this.logIdle('silent probing needs one successful explicit Connect on this origin first');
      this.stopRetries();
      return;
    }

    this.retryInFlight = true;
    this.lastAttemptAt = Date.now();
    try {
      const ok = await canSilentlyProbeGateway();
      if (generation !== this.retryGeneration) return;
      if (!ok) {
        // The loop keeps ticking but never fetches: Chrome's local-network-access permission
        // is not 'granted', and only an explicit Connect (user gesture) may surface the prompt.
        this.logIdle('browser local-network-access permission not granted - click Connect once to allow');
      } else {
        this.lastIdleReason = null;
      }
      const state = getConnectSnapshot().state;
      if (ok && (state === 'disconnected' || state === 'error')) await connectToServer();
    } catch {
      // Silent fail — the user can always connect manually from the CONNECT panel.
    } finally {
      // A cancel point already cleared the flag and moved the generation on; the
      // superseded attempt must not resurrect it.
      if (generation === this.retryGeneration) this.retryInFlight = false;
    }

    if (generation !== this.retryGeneration || this.disposed) return;
    if (getConnectSnapshot().state === 'connected') { this.stopRetries(); return; }
    this.rearm(generation);
  }

  /** Tab became visible / network came back → pull the next probe forward. */
  private readonly handleWake = (): void => {
    if (!this.retryArmed || this.retryInFlight || this.disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const since = Date.now() - this.lastAttemptAt;
    this.retryStep = 0;
    this.scheduleAttempt(since >= WAKE_MIN_SPACING_MS ? 0 : WAKE_MIN_SPACING_MS - since);
  };

  /** Store observer: keep the retry loop in step with what the user/gateway did. */
  private onConnectStoreChanged(): void {
    const snap = getConnectSnapshot();
    const previousState = this.lastSeenState;
    const previousUrl = this.lastSeenServerUrl;
    this.lastSeenState = snap.state;
    this.lastSeenServerUrl = snap.serverUrl;

    if (snap.serverUrl !== previousUrl) {
      // The target moved — a probe in flight belongs to the old gateway.
      this.cancelRetries();
    } else if (snap.state === 'connecting' && previousState !== 'connecting' && !this.retryInFlight) {
      // A Connect the user asked for; ours never reaches here (retryInFlight).
      this.cancelRetries();
    } else if (snap.state === 'connected') {
      this.stopRetries();
    }
    this.maybeStartRetries();
    this.syncStream();
  }

  /** Attach the current model to CONNECT's live signal stream. */
  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.detachModel();
    // plan-386 F17: a shared GLB gets no live stream. Everything below opens a
    // WebSocket to the CONNECT gateway and starts pushing this model's signal
    // names into it — a foreign file must not be able to trigger that just by
    // being linked. The REST connection state itself is model-independent and
    // stays exactly as the user left it.
    if (!viewer.loadTrust.trusted) return;
    this.viewer = viewer;
    this.lastMirroredInterfaces = null;
    this.registeredProviders.clear();
    this.wsStream = new WebSocketRealtimeInterface();
    this.wsStream.setProviderProvenanceEnabled(false);
    this.wsStream.onModelLoaded(result, viewer);

    // Wire the source→connected provider so SignalStore.getActivity() can derive
    // "supplied vs. dead" from a signal's CONNECT source label. The provider reads
    // the LIVE snapshot on every call (no stale capture); the engine never imports
    // connect-store — injection mirrors setForceSink (plan-234 §10-B).
    viewer.signalStore?.setConnectionProvider((source) => isSourceConnectedLive(source));

    this.syncStream();
  }

  /** Detach model-scoped streaming while preserving the REST connection state. */
  onModelCleared(_viewer: RVViewer): void {
    this.detachModel();
  }

  /**
   * plan-435: switching the plugin off must stop the live signal stream — that
   * IS its visible effect. Declared explicitly rather than leaning on the
   * `onModelCleared` fallback so the model bookkeeping stays intact: the model
   * has not gone anywhere, only this plugin has, and a later real
   * `clearModel()` must still reach `onModelCleared` (invariant 3 —
   * `detachModel()` is idempotent, so running it twice is safe).
   */
  onDeactivate(): void {
    this.detachModel();
  }

  /** Re-attach the stream to the model that is still loaded. */
  onActivate(viewer: RVViewer): void {
    const result = viewer.lastLoadResult;
    if (result) this.onModelLoaded(result, viewer);
  }

  /** Open/close the live value stream so it follows the CONNECT REST connection state. */
  private syncStream(): void {
    if (!this.viewer || !this.wsStream) return;
    const snap = getConnectSnapshot();

    // Mirror CONNECT signal metadata (address/comment/source) into the SignalStore
    // so the SignalBadge hover tooltip can surface it app-wide. The store only
    // replaces `interfaces` on a genuine change, so a reference check skips the
    // O(all signals) walk on unrelated ticks (status/log polls).
    if (snap.interfaces !== this.lastMirroredInterfaces) {
      this.lastMirroredInterfaces = snap.interfaces;
      mirrorConnectSignalMeta(this.viewer, snap.interfaces);
    }
    this.syncProviders(snap);

    const shouldStream = snap.state === 'connected';

    if (shouldStream && !this.streaming) {
      this.streaming = true;
      this.wsStream.connect(buildConnectWsSettings(snap.serverUrl)).catch(() => {
        this.streaming = false;
      });
    } else if (!shouldStream && this.streaming) {
      this.streaming = false;
      this.wsStream.disconnect();
    }
  }

  private syncProviders(snap: ConnectSnapshot): void {
    const store = this.viewer?.signalStore;
    if (!store) return;
    const desired = new Map<string, Pick<SignalSourceRef, 'interfaceId' | 'topic'>>();
    for (const iface of snap.interfaces) {
      const status = snap.interfaceStatus[iface.id]?.status;
      const connected = snap.state === 'connected' && !snap.gatewayUnreachable
        && iface.enabled !== false && (status === undefined || status === 'Connected');
      const register = (signal: string, topic?: string): void => {
        const source = {
          interfaceId: iface.id,
          ...(topic !== undefined ? { topic } : {}),
          signal,
        };
        const key = signalProviderKey(source);
        desired.set(key, source);
        store.registerSignalProvider(source, connected);
      };
      for (const sig of iface.signals ?? []) register(sig.name);
      for (const topic of iface.topics ?? []) {
        for (const sig of topic.signals ?? []) register(sig.name, topic.topic);
      }
    }
    for (const [key, provider] of this.registeredProviders) {
      if (!desired.has(key)) store.unregisterSignalProvider(provider);
    }
    this.registeredProviders.clear();
    for (const [key, provider] of desired) this.registeredProviders.set(key, provider);
  }

  // Forward the fixed-step ticks so the embedded interface flushes incoming values into the
  // SignalStore (onFixedUpdatePre) and pushes outgoing writes back to the gateway (onFixedUpdatePost).
  onFixedUpdatePre(dt: number): void {
    this.wsStream?.onFixedUpdatePre(dt);
  }

  onFixedUpdatePost(dt: number): void {
    this.wsStream?.onFixedUpdatePost(dt);
  }

  private detachModel(): void {
    const store = this.viewer?.signalStore;
    if (store) {
      for (const provider of this.registeredProviders.values()) {
        store.unregisterSignalProvider(provider);
      }
      store.setConnectionProvider(() => false);
    }
    this.registeredProviders.clear();
    this.wsStream?.dispose();
    this.wsStream = null;
    this.streaming = false;
    this.lastMirroredInterfaces = null;
    this.viewer = null;
  }

  dispose(): void {
    // Order matters: `disposed` first, so an attempt resolving during teardown
    // finds the flag set and writes nothing back into a dead plugin.
    this.disposed = true;
    this.cancelRetries();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.handleWake);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleWake);
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachModel();
  }
}
