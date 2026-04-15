# WebViewer Industrial Interfaces

Connect the WebViewer to real PLCs and controllers via WebSocket or MQTT — independent of Unity. The interface system provides bidirectional signal exchange synchronized with the drive physics loop at 60 Hz.

## Supported Protocols

| Interface | Protocol | Auth | Status |
|-----------|----------|------|--------|
| **WebSocket Realtime** | WebSocket v2 JSON | None | Implemented |
| **ctrlX (Bosch Rexroth)** | WebSocket v2 JSON | Bearer token (SSL) | Implemented |
| **TwinCAT HMI** | WebSocket JSON | Planned | Planned |
| **MQTT** | MQTT over WebSocket | Username/Password | Planned |
| **KEBA** | WebSocket + REST | HTTP token | Planned |

Only **one interface** can be active at a time (mutex constraint enforced by `InterfaceManager`).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    InterfaceManager                      │
│  - Registry of all interface implementations            │
│  - Mutex: only one active at a time                     │
│  - Forwards plugin lifecycle to active interface        │
└──────────────┬──────────────────────────────────────────┘
               │ activates one of:
   ┌───────────┼───────────┬──────────────┐
   ▼           ▼           ▼              ▼
 WS Realtime  ctrlX    TwinCAT HMI     MQTT
   │           │
   └─────┬─────┘  (ctrlX extends WS Realtime)
         ▼
 BaseIndustrialInterface
   - pendingIncoming buffer
   - dirtyOutgoing buffer
   - Reconnect logic
   - Signal discovery
   - SignalStore integration
```

### Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `BaseIndustrialInterface` | `src/interfaces/base-industrial-interface.ts` | Abstract base with buffer-flush pattern |
| `InterfaceManager` | `src/interfaces/interface-manager.ts` | Mutex, registry, plugin lifecycle forwarding |
| `WebSocketRealtimeInterface` | `src/interfaces/websocket-realtime-interface.ts` | WebSocket Realtime v2 protocol |
| `CtrlXInterface` | `src/interfaces/ctrlx-interface.ts` | Bosch ctrlX (extends WS Realtime) |
| `InterfaceSettings` | `src/interfaces/interface-settings-store.ts` | localStorage persistence |

## Connection Lifecycle

```
User selects interface in Settings
        │
        ▼
  InterfaceManager.activate(id, settings)
        │
        ├─ Deactivate previous (if any)
        │
        ▼
  BaseIndustrialInterface.connect(settings)
        │
        ├─ State → 'connecting'
        │
        ▼
  doConnect(settings)             ← protocol-specific (WebSocket, MQTT, ...)
        │
        ├─ State → 'connected'
        │
        ▼
  doDiscoverSignals()             ← signal discovery
        │
        ├─ Registers signals in SignalStore
        ├─ Subscribes to output signals
        │
        ▼
  Ready for bidirectional data exchange
```

### Reconnect on Failure

If the connection drops or fails, the base class schedules automatic reconnect with exponential backoff:

- Initial delay: **500 ms**
- Factor: **2x** per attempt
- Maximum delay: **30 s**

Reconnect only activates when `autoConnect` is enabled in settings.

## Signal Flow

The core design principle: **never write directly to SignalStore from async callbacks**. Instead, buffer incoming values and flush them synchronously with the fixed-timestep simulation loop.

### Incoming Signals (PLC → WebViewer)

```
PLC / Controller
    │
    │  WebSocket.onmessage / MQTT.on('message')
    │  (async, any time, any rate)
    ▼
bufferIncoming(signals)
    │
    │  Writes to: pendingIncoming Map<string, bool|number>
    │  (deduplication: last value wins if multiple
    │   updates arrive between two ticks)
    ▼
onFixedUpdatePre(dt)              ← called at 60 Hz, BEFORE drive physics
    │
    │  Flushes pendingIncoming → signalStore.setMany(batch)
    │  (batch semantics: all values updated first, then all listeners notified)
    ▼
SignalStore
    │
    │  Notifies subscribers (drives, logic steps, HMI)
    ▼
Drive physics, transport, LogicSteps run with updated signal values
```

### Outgoing Signals (WebViewer → PLC)

```
HMI button press / LogicStep / Drive feedback
    │
    │  signalStore.set(name, value)
    ▼
SignalStore.subscribe() callback
    │
    │  Only for 'output' direction signals
    │  Writes to: dirtyOutgoing Map<string, bool|number>
    ▼
onFixedUpdatePost(dt)             ← called at 60 Hz, AFTER drive physics
    │
    │  Collects all dirty values → sendSignals(outgoing)
    │  (protocol-specific: JSON over WebSocket, MQTT publish, etc.)
    ▼
PLC / Controller receives updated values
```

### Complete Tick Cycle

Each simulation tick at 60 Hz follows this exact order:

```
┌──────────────────────────────────────────────────────────────┐
│  SimulationLoop.onFixedUpdate(dt = 1/60)                     │
│                                                              │
│  1. LogicEngine.step()        ← LogicStep sequencing         │
│  2. Playback.advance()        ← Recording playback           │
│  3. Plugins.onFixedUpdatePre  ← Interface flushes incoming   │
│     └─ pendingIncoming → signalStore.setMany()               │
│  4. Drive.fixedUpdate()       ← Drive physics (sorted)       │
│  5. TransportManager.step()   ← Sources → Conveyors → Sinks │
│  6. Plugins.onFixedUpdatePost ← Interface sends outgoing     │
│     └─ dirtyOutgoing → sendSignals()                         │
│                                                              │
│  Result: PLC input values applied before physics,            │
│          PLC output values sent after physics.               │
└──────────────────────────────────────────────────────────────┘
```

This ensures:
- **Input signals** (from PLC) are applied **before** drive physics computes the next position
- **Output signals** (to PLC) reflect the drive state **after** physics computation
- The 60 Hz fixed timestep matches Unity's FixedUpdate

## Signal Discovery

When an interface connects, it runs signal discovery to learn which signals the PLC exposes.

### WebSocket Realtime v2 Protocol

```
Client                              Server (Unity)
  │                                      │
  │──── { type: "init",                  │
  │       version: 2,                    │
  │       name: "WebViewer" }  ─────────►│
  │                                      │
  │──── { type: "import_request",        │
  │       version: 2 }  ───────────────►│
  │                                      │
  │◄──── { type: "import_answer",        │
  │        signals: {                    │
  │          "ConveyorStart": true,      │
  │          "DriveSpeed": 500.0,        │
  │          ...                         │
  │        },                            │
  │        signalTypes: {                │
  │          "ConveyorStart": "PLCInputBool",
  │          "DriveSpeed": "PLCInputFloat",
  │          ...                         │
  │        }                             │
  │      }                               │
  │                                      │
  │──── { type: "subscribe",             │
  │       version: 2,                    │
  │       subscribe: ["ConveyorStart",   │
  │                    "DriveSpeed",     │
  │                    ...] }  ─────────►│
  │                                      │
  │◄──── { type: "snapshot",             │
  │        signals: { ... all values } } │
  │                                      │
  │◄───── { type: "data",               │  (continuous, only changed values)
  │         signals: {                   │
  │           "DriveSpeed": 750.0        │
  │         }                            │
  │       }                              │
  │                                      │
  │──── { type: "data",                  │  (outgoing from WebViewer)
  │       version: 2,                    │
  │       signals: {                     │
  │         "StartButton": true          │
  │       }                              │
  │     } ─────────────────────────────►│
```

### Signal Types

Signal type strings from C# map to:

| C# Type | SignalType | SignalDirection | Example |
|---------|-----------|-----------------|---------|
| `PLCInputBool` | `bool` | `input` | Sensor occupied |
| `PLCOutputBool` | `bool` | `output` | Start button |
| `PLCInputFloat` | `float` | `input` | Drive speed |
| `PLCOutputFloat` | `float` | `output` | Speed setpoint |
| `PLCInputInt` | `int` | `input` | Counter value |
| `PLCOutputInt` | `int` | `output` | Program number |

- **Input** = PLC writes, WebViewer reads (the PLC provides this value)
- **Output** = WebViewer writes, PLC reads (the WebViewer provides this value)

## Integration with Drives

Drives read their control signals from the SignalStore each `fixedUpdate`:

```
PLC sends:  { "DriveSpeed": 500.0, "DriveForward": true }
                │
                ▼
SignalStore:  "DriveSpeed" = 500.0,  "DriveForward" = true
                │
                ▼  (Drive reads in fixedUpdate)
RVDrive:      targetSpeed = 500.0,  jogForward = true
                │
                ▼  (Drive physics computes position)
              currentPosition += acceleration(dt)
                │
                ▼  (Drive writes back)
SignalStore:  "DriveAtTarget" = true,  "DrivePosition" = 1234.5
                │
                ▼  (onFixedUpdatePost collects output signals)
PLC receives: { "DriveAtTarget": true, "DrivePosition": 1234.5 }
```

The drive's `Signal.Name` properties (configured in Unity) become the keys in the SignalStore. The interface doesn't need to know about drives — it only deals with signals.

## SignalStore

The `SignalStore` is the central hub for all signal values:

```typescript
// Read signals
const speed = signalStore.getFloat('DriveSpeed');
const running = signalStore.getBool('ConveyorStart');

// Write signals
signalStore.set('StartButton', true);

// Subscribe to changes
const unsub = signalStore.subscribe('SensorOccupied', (value) => {
  console.log('Sensor changed:', value);
});

// Bulk update (used by interface flush)
signalStore.setMany({
  'DriveSpeed': 500.0,
  'ConveyorStart': true,
  'SensorOccupied': false,
});
```

Two lookup modes:
- **By name** (primary): `signalStore.get('DriveSpeed')` — used by interfaces and HMI
- **By path** (secondary): `signalStore.getByPath('DemoCell/Signals/DriveSpeed')` — used by GLB component references

## Events

The interface system emits events on the `RVViewer` event bus:

| Event | Payload | When |
|-------|---------|------|
| `interface-connected` | `{ interfaceId, type }` | Connection established |
| `interface-disconnected` | `{ interfaceId, reason }` | Connection lost |
| `interface-error` | `{ interfaceId, error }` | Protocol or connection error |
| `interface-data` | `{ interfaceId, signals }` | Raw data received (before buffer flush) |

Use the `useInterfaceStatus` React hook for UI integration:

```typescript
import { useInterfaceStatus } from '../hooks/use-interface-status';

function StatusIndicator() {
  const { connected, interfaceId, error } = useInterfaceStatus();
  return <span>{connected ? 'Connected' : 'Disconnected'}</span>;
}
```

## Settings Persistence

Interface settings are stored in `localStorage` under key `rv-interface-settings`:

```typescript
interface InterfaceSettings {
  activeType: 'none' | 'websocket-realtime' | 'ctrlx' | 'twincat-hmi' | 'mqtt' | 'keba';
  autoConnect: boolean;
  reconnectIntervalMs: number;

  // WebSocket-based protocols
  wsAddress: string;    // default: 'localhost'
  wsPort: number;       // default: 7000
  wsUseSSL: boolean;    // default: false
  wsPath: string;       // default: '/'
  wsAuthToken: string;  // for ctrlX SSL

  // MQTT
  mqttBrokerUrl: string;    // default: 'ws://localhost:8080/mqtt'
  mqttUsername: string;
  mqttPassword: string;
  mqttTopicPrefix: string;  // default: 'rv/'
}
```

## Implementing a New Interface

Extend `BaseIndustrialInterface` and implement four abstract methods:

```typescript
import { BaseIndustrialInterface, type SignalDescriptor } from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';

export class MyInterface extends BaseIndustrialInterface {
  readonly id = 'my-protocol';
  readonly protocolName = 'My Protocol';

  protected async doConnect(settings: InterfaceSettings): Promise<void> {
    // Establish connection (WebSocket, MQTT client, etc.)
    // Resolve when connection is open, reject on failure.
  }

  protected doDisconnect(): void {
    // Close connection. Must be synchronous and idempotent.
  }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    // Request signal list from the endpoint.
    // Return array of { name, type, direction, initialValue }.
  }

  protected sendSignals(signals: Record<string, boolean | number>): void {
    // Send outgoing values to the PLC/controller.
    // Called from onFixedUpdatePost — only changed values.
  }
}
```

In your `doConnect`/message handler, use `bufferIncoming()` to safely queue incoming data:

```typescript
this.ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'data' && msg.signals) {
    this.bufferIncoming(msg.signals);  // Queued, flushed at next fixedUpdate
  }
};
```

Register the implementation:

```typescript
const manager = new InterfaceManager();
manager.register(new WebSocketRealtimeInterface());
manager.register(new CtrlXInterface());
manager.register(new MyInterface());
viewer.use(manager);
```

## ctrlX Specifics

The `CtrlXInterface` extends `WebSocketRealtimeInterface` — same protocol, different URL:

| Mode | URL | Auth |
|------|-----|------|
| SSL (via reverse proxy) | `wss://address:443/ctrlx-rv-bridge/ws?access_token=TOKEN` | Bearer token |
| Direct (bridge snap) | `ws://address:8080/` | None |

The wire protocol (init, import, subscribe, data) is identical to WebSocket Realtime v2.

## Unity-Side Setup

On the Unity side, use the **WebSocket Realtime Interface** component (`WebsocketRealtimeInterface.cs`). All signals defined in the Unity scene (drives, sensors, custom signals) are automatically exposed through the interface.

The Unity server:
1. Listens for WebSocket connections
2. Responds to `import_request` with all registered PLC signals
3. Sends delta `data` messages when signal values change
4. Receives `data` messages from the WebViewer and applies them to PLC signals

No special configuration is needed per signal — the interface discovers and exchanges all defined signals automatically.
