# realvirtual WEB Industrial Interfaces

Connect realvirtual WEB to real PLCs and controllers via WebSocket or MQTT — independent of Unity. The interface system provides bidirectional signal exchange synchronized with the drive physics loop at 60 Hz.

## Supported Protocols

| Interface | Protocol | Auth | Status |
|-----------|----------|------|--------|
| **WebSocket Realtime** | WebSocket v2 JSON | None | Implemented |
| **ctrlX (Bosch Rexroth)** | WebSocket v2 JSON | Bearer token (SSL) | Implemented |
| **TwinCAT HMI** | WebSocket JSON | Token (`?cid=`) | Implemented |
| **MQTT** | MQTT over WebSocket | Username/Password | Implemented |
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
| `MqttInterface` | `src/interfaces/mqtt-interface.ts` | MQTT over WebSocket (mqtt.js) |
| `TwinCatHmiInterface` | `src/interfaces/twincat-hmi-interface.ts` | Beckhoff TwinCAT HMI (WebSocket JSON, `?cid=` token) |
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

### Incoming Signals (PLC → realvirtual WEB)

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

### Outgoing Signals (realvirtual WEB → PLC)

```
HMI button press / LogicStep / Drive feedback
    │
    │  signalStore.set(name, value)
    ▼
SignalStore.subscribe() callback
    │
    │  Only for 'input' direction signals (PLC inputs — realvirtual writes them)
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
┌──────────────────────────────────────────────────────────────────────┐
│  SimulationLoop fixed tick (dt = 1/60)                                 │
│                                                                        │
│  PRE-DRIVE                                                             │
│   1. Playback.update(dt)            ← recording playback              │
│   2. LogicEngine.fixedUpdate(dt)    ← LogicStep sequencing            │
│   3. IKPath.fixedUpdate(dt) [loop]  ← robot path replay               │
│   4. ReplayRecording.fixedUpdate(dt) [loop] ← signal replay          │
│   5. Plugins.onFixedUpdatePre()     ← interface flushes incoming      │
│      └─ pendingIncoming → signalStore.setMany()                       │
│   6. TickStage.PRE callbacks                                          │
│                                                                        │
│  CORE PHYSICS & TRANSPORT                                             │
│   7. Drive.update(dt) [loop]        ← drive motion (sorted)           │
│   8. TransportManager.update(dt)    ← conveyors, MUs, routing         │
│   9. TransportManager.updateTextureAnimations(dt) ← belt skins        │
│  10. TankFillManager.update()       ← tank fill clip planes           │
│  11. GizmoManager.tick(dt)          ← gizmo overlay blink             │
│  12. PipeFlowManager.update(dt)     ← pipe flow rings                 │
│                                                                        │
│  POST-PHYSICS                                                         │
│  13. TickStage.SIM callbacks        ← plugin readback                 │
│  14. Behavior.tick(dt)              ← discrete material flow          │
│                                        (skipped when unified kernel   │
│                                         active)                       │
│  15. Plugins.onFixedUpdatePost()    ← interface sends outgoing        │
│      └─ dirtyOutgoing → sendSignals()                                 │
│  16. TickStage.POST callbacks       ← recorders, stats               │
│                                                                        │
│  Result: PLC input values (step 5) applied before physics,            │
│          PLC output values (step 15) sent after physics.              │
└──────────────────────────────────────────────────────────────────────┘
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
  │──── { type: "data",                  │  (outgoing from realvirtual WEB)
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
| `PLCOutputBool` | `bool` | `output` | Motor running feedback |
| `PLCInputFloat` | `float` | `input` | Drive speed |
| `PLCOutputFloat` | `float` | `output` | Speed setpoint |
| `PLCInputInt` | `int` | `input` | Counter value |
| `PLCOutputInt` | `int` | `output` | Program number |

Direction is named from the **PLC's** point of view, exactly as in Unity:

- **Input** = the PLC reads it, realvirtual writes it (an HMI start button, a setpoint)
- **Output** = the PLC writes it, realvirtual reads it (an encoder position, a program number)

Source of truth: `plcTypeForSignalDescriptor()` in `src/interfaces/base-industrial-interface.ts`
(`direction === 'input' ? 'PLCInput' : 'PLCOutput'`).

### MQTT: direction is user configuration

MQTT carries no direction. A topic is just a name, so nothing in the protocol says whether a
value is produced by the machine or written to it — and realvirtual deliberately does **not**
guess one from the topic text.

- **Via CONNECT** (MQTT interface in the Connect window): the direction is chosen by hand per
  signal — *Edit signal → Direction* — and persisted into the CONNECT interface config, so it
  survives a reconnect. A signal switched to *Write to PLC* (`PLCInput…`) publishes to its own
  concrete topic. Publishing additionally requires **Allow Web → PLC writes**, which is an
  **interface-wide** switch, not a per-signal one.
- Changing only the direction never changes the data type: the dialog keeps the signal's
  `dataType`, and derives it from the wire type (`…Float` → `Float`, `…Text` → `String`) when the
  stored value is missing or blank, before falling back to the schema default.
- The **browser-direct** `MqttInterface` (`src/interfaces/mqtt-interface.ts`) is a different code
  path with a different rule: it derives the direction from an `in/` / `out/` segment in the topic.
  That convention applies only to that plugin's own topic prefix and is intentionally not shared
  with the CONNECT path.

### MQTT signal list: derived topic tree

Single-topic MQTT signals (one topic per signal, as opposed to the ProcessImage byte arrays) live
in the interface's flat `signals[]` list. The Connect signal list derives a **topic tree** from
their addresses — `rv/demo/out/OpenDoor` renders as `rv` > `demo` > `out` > signal.

- The tree is derived only, never configured: no wildcard groups enter the interface config, so
  receive path, publish path and address validation are unchanged.
- Every level is its own collapsible node and shows the number of signals in its subtree; the
  collapse state is persisted per interface.
- Filtering keeps matching leaves, opens all their ancestor levels, and hides branches that hold
  no match.
- Applies to MQTT interfaces and to addresses that contain `/`. Configured topic entries
  (`ProcessImage` **and** `Single` mode) stay single-level groups, and other protocols (S7,
  Modbus, …) render flat as before.

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

Document lifecycle events on the same bus:

| Event | Payload | When |
|-------|---------|------|
| `document-saved` | `{ documentId, relPath }` | After EVERY successful document write, whatever the path. `relPath` is project-relative, and the empty string for a slot-addressed document. Subscribe to drop anything cached against a document's bytes — this is the path-agnostic replacement for reaching into a plugin and matching `library/**` (plan-719 F8). |

Use the `useInterfaceStatus` React hook for UI integration:

```typescript
import { useInterfaceStatus } from '../hooks/use-interface-status';

function StatusIndicator() {
  const connected = useInterfaceStatus('websocket-realtime');
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

Extend `BaseIndustrialInterface` and implement four abstract methods.
`BaseIndustrialInterface` extends `BaseViewerPlugin`, so you have access
to `this.context.signals` as an alternative to `this.viewer.signalStore` — both
reference the same `SignalStore` after model load. Prefer `this.context.signals`
as it makes the null-before-load contract explicit.

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

## CONNECT gateway endpoints

Besides the signal protocols above, the viewer talks to a local realvirtual CONNECT gateway over
plain HTTP. Three of those endpoints describe the gateway itself and drive the CONNECT options
window.

### `GET /health`

Always reachable, never behind the API key. Two fields were added for the self-update and both are
**additive** — `version`, `build`, `buildDate` and `appVersion` are unchanged, so an older viewer
against a newer gateway and a newer viewer against an older gateway both keep working.

```json
{
  "status": "ok",
  "version": "0.2.0", "build": 26, "buildDate": "2026-07-30",
  "release": { "semver": "0.4.0-beta2", "channel": "beta", "build": 26 },
  "updateSupported": true,
  "stepImport": true, "jtImport": true
}
```

| Field | Meaning |
|-------|---------|
| `release.semver` | Full SemVer **including a prerelease suffix**. `version` cannot express one, which is why this field exists: a beta could otherwise not be confirmed after a restart. |
| `release.channel` | `stable` or `beta`. Any prerelease means `beta`. |
| `release.build` | Build number, same value as `build`. |
| `updateSupported` | Whether this installation offers a self-update at all. |

`updateSupported` is the feature flag: a viewer that does not find it shows no update surface,
which is how older gateways stay silent instead of showing a control that cannot work. It is
`false` for a build carrying its customer project inside the executable, without a configured API
key, when the program directory cannot be renamed within, when the update is switched off in the
configuration, and on Linux.

### `GET /update/status`

Requires the API key. Reports what is on offer and what an operation in flight is doing.

```json
{
  "updateSupported": true,
  "reason": null,
  "current": { "semver": "0.2.0", "channel": "stable", "build": 26 },
  "selectedChannel": "stable",
  "channels": {
    "stable": {
      "candidate": { "channel": "stable", "semver": "0.3.0", "build": 31,
                     "sha256": "…", "url": "https://…/download/versions/…exe" },
      "sizeBytes": 248261120,
      "isDowngrade": false,
      "isChannelSwitch": false
    }
  },
  "state": "idle",
  "progress": null,
  "jobReason": null,
  "pinWillChange": false,
  "pinPath": null
}
```

- A channel is present only when its manifest resolves. A missing beta manifest is a normal state,
  not an error, and produces no entry and no message.
- `sizeBytes` is `null` when the server does not report a content length; the dialog then says the
  size is unknown.
- `pinWillChange` is always `false` on current gateways: the download-only update never touches
  `connect.lock.json`. The field stays on the wire for older gateways that still announce a pin
  rewrite.
- `state` runs `idle → checking → available → downloading → verifying` and ends in `downloaded`
  (success: the verified file lies beside the running program, `downloadedPath` names it) or
  `failed`. Older gateways that still perform the background swap additionally use `staging →
  restarting → verifying-health` ending in `succeeded` or `rolled-back`.
- When `updateSupported` is false, `reason` says why. The viewer shows a sentence only for
  `no-api-key` and `no-write-permission`, which the operator can act on, and stays silent otherwise.

### `POST /update/apply`

Requires the API key and, from a browser, an allowed origin. The body is the **complete candidate**
taken from `/update/status`, not just a version number:

```json
{ "candidate": { "channel": "stable", "semver": "0.3.0", "build": 31,
                 "sha256": "…", "url": "https://…" } }
```

The gateway re-reads the manifest and compares the whole candidate against it. Any difference —
including the same version with a different build or hash — is rejected with `manifest-changed`
rather than downloading something other than what was confirmed. A second call while an operation
is running answers `409` with `update-in-progress`.

Authentication is the global access rule (loopback peer or valid key); `/update/apply`
additionally keeps its browser gate on Origin and Host.

### Reading the result

The operation is successful when `/update/status` reports the terminal state `downloaded` and
names the file in `downloadedPath`. The gateway keeps running unchanged; installing the new
version is the operator's move — stop CONNECT, start the downloaded file. On gateways older than
this build the swap flow applies instead: success there is the terminal `succeeded`, and a
reachable `/health` after their restart means only that the connection is back.

## Unity-Side Setup

On the Unity side, use the **WebSocket Realtime Interface** component (`WebsocketRealtimeInterface.cs`). All signals defined in the Unity scene (drives, sensors, custom signals) are automatically exposed through the interface.

The Unity server:
1. Listens for WebSocket connections
2. Responds to `import_request` with all registered PLC signals
3. Sends delta `data` messages when signal values change
4. Receives `data` messages from realvirtual WEB and applies them to PLC signals

No special configuration is needed per signal — the interface discovers and exchanges all defined signals automatically.
