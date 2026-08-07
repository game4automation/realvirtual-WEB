// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSocket Realtime adapter — import_answer registration test (R15, viewer side).
 *
 * Verifies that an `import_answer` carrying both signalTypes AND values registers
 * every signal in the SignalStore with the correct type/direction, and that a
 * subsequent `data` delta updates those signals. This is the viewer-side guard
 * against "import_answer without values → 0 signals registered".
 *
 * Since Phase B4 the WebSocket transport lives in a Web Worker, so this test
 * drives the interface through a mock TransportPort (the worker/main protocol)
 * rather than intercepting the global WebSocket. The `import_answer`/`delta`
 * outbound messages are exactly what the worker posts after parsing the wire.
 */

import { describe, it, expect, vi } from 'vitest';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type {
  TransportInboundMessage,
  TransportOutboundMessage,
} from '../src/interfaces/signal-transport-core';

// ── Mock TransportPort (worker ⇄ main protocol) ──────────────────────────────

class MockPort {
  inbound: TransportInboundMessage[] = [];
  terminated = false;
  private handler: ((msg: TransportOutboundMessage) => void) | null = null;

  postMessage(msg: TransportInboundMessage): void { this.inbound.push(msg); }
  terminate(): void { this.terminated = true; }
  onMessage(cb: (msg: TransportOutboundMessage) => void): void { this.handler = cb; }
  emit(msg: TransportOutboundMessage): void { this.handler?.(msg); }
}

/** Test subclass injecting the mock port instead of a real Worker. */
class TestWsInterface extends WebSocketRealtimeInterface {
  readonly port = new MockPort();
  protected override createPort() { return this.port; }
}

function defaultSettings(): InterfaceSettings {
  return {
    activeType: 'websocket-realtime',
    autoConnect: false,
    reconnectIntervalMs: 3000,
    wsAddress: '127.0.0.1',
    wsPort: 8080,
    wsUseSSL: false,
    wsPath: '/',
    wsAuthToken: '',
    mqttBrokerUrl: '',
    mqttUsername: '',
    mqttPassword: '',
    mqttTopicPrefix: '',
  } as InterfaceSettings;
}

/** Minimal RVViewer stub exposing a real SignalStore. */
function stubViewer(signalStore: SignalStore): RVViewer {
  return {
    signalStore,
    emit: vi.fn(),
    on: vi.fn(),
    setConnectionState: vi.fn(),
  } as unknown as RVViewer;
}

describe('WebSocketRealtimeInterface — import_answer registration', () => {
  it('importAnswerThenData: registers all signals with correct types, then applies data delta', async () => {
    const signalStore = new SignalStore();
    const iface = new TestWsInterface();

    // Wire the viewer/signalStore via the plugin lifecycle.
    iface.onModelLoaded({} as LoadResult, stubViewer(signalStore));

    // Auto-drive the worker: `connect`→open, `discover`→import_answer with
    // TYPES and VALUES (R15). This is what the real worker posts after parsing.
    const origPost = iface.port.postMessage.bind(iface.port);
    iface.port.postMessage = (msg) => {
      origPost(msg);
      if (msg.type === 'connect') {
        queueMicrotask(() => iface.port.emit({ type: 'open' }));
      } else if (msg.type === 'discover') {
        queueMicrotask(() => iface.port.emit({
          type: 'import_answer',
          signalTypes: {
            Motor_Start: 'PLCInputBool',
            ActualTemp: 'PLCInputInt',
            Pressure: 'PLCInputFloat',
          },
          signals: {
            Motor_Start: false,
            ActualTemp: 234,
            Pressure: 1.5,
          },
        }));
      }
    };

    try {
      await iface.connect(defaultSettings());

      // All 3 signals discovered with the correct type + direction.
      const discovered = iface.discoveredSignals;
      expect(discovered).toHaveLength(3);
      const byName = Object.fromEntries(discovered.map(s => [s.name, s]));
      expect(byName['Motor_Start'].type).toBe('bool');
      expect(byName['Motor_Start'].direction).toBe('input');
      expect(byName['ActualTemp'].type).toBe('int');
      expect(byName['Pressure'].type).toBe('float');

      // All 3 registered in the SignalStore with their initial values.
      expect(signalStore.get('Motor_Start')).toBe(false);
      expect(signalStore.get('ActualTemp')).toBe(234);
      expect(signalStore.get('Pressure')).toBe(1.5);

      // A subsequent coalesced delta (posted by the worker) is buffered and
      // flushed to the store in onFixedUpdatePre — the unchanged flush path.
      iface.port.emit({ type: 'delta', signals: { Motor_Start: true, ActualTemp: 240 } });
      iface.onFixedUpdatePre(0.016);

      expect(signalStore.get('Motor_Start')).toBe(true);
      expect(signalStore.get('ActualTemp')).toBe(240);
      // Unchanged signal keeps its value.
      expect(signalStore.get('Pressure')).toBe(1.5);
    } finally {
      iface.disconnect();
    }
  });
});
