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

  /** Start model-independent CONNECT discovery and state observation. */
  init(): void {
    this.unsubscribe = subscribeConnectStore(() => this.syncStream());
    const snap = getConnectSnapshot();
    // An explicit Disconnect is remembered across reloads — never probe against the user's will.
    //
    // On a hosted (non-loopback) origin a LOCAL gateway target may only be auto-probed after
    // the user connected explicitly at least once (hasUserConnectedBefore): Chrome's Local
    // Network Access prompt belongs to the explicit Connect click, never to a page load. A
    // stored NON-local gateway URL keeps auto-connecting as before — no browser prompt exists
    // for public targets. canSilentlyProbeGateway() below stays as the second, permission-
    // state-based gate.
    const mayProbe = isLoopbackOrigin()
      || (hasStoredServerUrl()
        && (!isLocalGatewayTarget(snap.serverUrl) || hasUserConnectedBefore()));
    if (snap.state === 'disconnected' && !hasAutoConnectOptOut() && mayProbe) {
      canSilentlyProbeGateway()
        .then((ok) => {
          if (!ok || getConnectSnapshot().state !== 'disconnected') return;
          return connectToServer();
        })
        .catch(() => {
          // Silent fail — the user can connect manually from the CONNECT panel.
        });
    }
  }

  /** Attach the current model to CONNECT's live signal stream. */
  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.detachModel();
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
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachModel();
  }
}
