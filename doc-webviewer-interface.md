# realvirtual WEB Industrial Interfaces

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

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

Through a CONNECT gateway this last step has a gate: an interface with `allowWebToPlc = false`
drops every viewer write instead of forwarding it, and CONNECT defaults that flag to `false`. The
viewer makes the drop visible and offers the one-click fix — see
[Write gate and silent-PLC prompts](#write-gate-and-silent-plc-prompts-connect).

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
│  Result: Incoming PLC values (step 5) applied before physics,            │
│          Outgoing feedback (step 15) sent after physics.              │
└──────────────────────────────────────────────────────────────────────┘
```

This ensures:
- **Incoming to WEB** (`PLCOutput*`, written by the PLC) are applied **before** drive physics computes the next position
- **Outgoing from WEB** (`PLCInput*`, read by the PLC) reflect the drive state **after** physics computation
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
| `PLCOutputBool` | `bool` | `output` | Motor run command |
| `PLCInputFloat` | `float` | `input` | Simulated drive speed feedback |
| `PLCOutputFloat` | `float` | `output` | Speed setpoint |
| `PLCInputInt` | `int` | `input` | Counter value |
| `PLCOutputInt` | `int` | `output` | Program number |

Direction is named from the **PLC's** point of view, exactly as in Unity:

- **Input** = the PLC reads it, realvirtual writes it (simulated sensor feedback; in a live-machine HMI, a start button)
- **Output** = the PLC writes it, realvirtual reads it (a simulated drive command; in a live-machine HMI, PLC-reported position)

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

## PLC binding: the model signal and its address

A model signal is identified by its **symbol name**, and that name is the only thing the two sides
share. The **address** belongs to the gateway alone — it is `SignalConfig.ProtocolAddress` in
CONNECT and is never stored in the GLB. Binding a model signal therefore means: give the gateway an
entry of the same name, and tell it where that name lives on the wire.

The unit of a binding is a **signal place**, not just a name — an interface, optionally a topic and
its mode, and the signal's own fields (`IfaceSignalSlot`, `src/core/import/rv-iface-signal-slots.ts`).
That distinction is what makes MQTT work at all: the same name can exist in two topics, and a
topic's own `signals[]` is a different container from the interface-level `signals[]`. Reads and
writes both go through the slot, so a topic signal is editable like any other.

Where the address is mandatory is **the gateway's statement, not the UI's guess**. Each
`GET /interface-types` entry carries `addressRule` per container and, for MQTT, per topic mode:

| Rule | The signal dialog |
|------|-------------------|
| `required` | demands an address (S7 DB address, Modbus register, OPC-UA NodeId, ADS symbol, MQTT ProcessImage offset, the legacy MQTT `signals` list where the topic *is* the address) |
| `name-fallback` | address optional — the worker uses the signal name as the wire name (PLCSIM Advanced, SHM, ABB RobotStudio, WebSocket Realtime, WINMOD Y200, PVI) |
| `container-topic` | address optional — an MQTT `Single` topic publishes on the topic itself |
| `none` | no address exists in this mode — an MQTT `Json` topic keys its flat object by the signal name |

**An older gateway that does not send `addressRule` keeps working unchanged:** an absent rule means
"never said", so nothing is demanded and nothing is warned about. ProcessImage addresses are checked
for Siemens symbolic syntax (`%IW13`, `%I3.1`) in the browser, because `POST /signals/validate`
validates an MQTT address as a *topic*.

Two inspector sections do the editing on a PLC signal node: **Signal** (name, type/direction,
`OriginDataType`, `Comment`) and **PLC binding** (one row per interface, for MQTT per topic, with
status plus set / change / remove). Without a CONNECT connection the binding section is disabled and
says why. The name is no inline field: its row opens the rename dialog (`editor.signalRename`,
plan-590), which previews every by-name reference, the CONNECT changes and the wire effects and
renames model, overlay, planner, historian and CONNECT together — see `doc-signal-architecture.md`
§2.6.

## The reconcile report

The report answers, continuously and for every interface, which model signal is bound to what. It is
**read-only**: it never changes the model and never changes CONNECT — every repair is an action the
user clicks.

| Category | Meaning |
|----------|---------|
| `mapped` | identical name on both sides, compatible type, address where required |
| `name-variant` | only a quoting variant matches (`"DB".Member` against `DB.Member`) — a suggestion, never a coupling |
| `missing-in-plc` | a model signal this interface does not carry |
| `plc-only` | an interface signal no model signal claims |
| `type-mismatch` | same name, incompatible direction, value kind or data type |
| `no-address` | same name, but the gateway requires an address this place has not got |

`mapped` means the runtime name equals `SignalConfig.Name` character for character. Nothing is
matched through a normalisation, because the gateway couples by that exact string — a normalised
"match" would show a data flow that does not exist. `no-address` appears only where `addressRule` is
`required`, so an older gateway never produces that warning.

Runs are triggered by model load, placement (`layout-content-added`), CONNECT store changes and
signal-catalog changes, debounced 250 ms and limited to the interfaces that changed. The output is a
badge on the interface card, `connect-store.reconcileReports`, and Problems entries under the code
`signal-reconcile` — one per (interface, category), with the signal list in the detail. From there:
**Create model signals** for `plc-only` rows (the CONNECT name is taken verbatim, so the result is
exactly `mapped`; a Text/String signal the model cannot register is shown as `unsupported type`),
and **Adopt legacy addresses** as a merge-only proposal from a `Comment` prefix or the Unity
`Metadata`, which never overwrites an existing CONNECT address.

The same report is available read-only over MCP as `web_signal_reconcile`. Architecture and the
naming rule behind it: [`doc-signal-architecture.md`](doc-signal-architecture.md) §2.4–2.5 and §6.5.

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

## Write gate and silent-PLC prompts (CONNECT)

Two failures used to be completely silent. An interface with `allowWebToPlc = false` — CONNECT's
default — swallows every viewer write and logs it once; and an interface can report `Connected`
while not a single PLC output ever arrives, because signals whose tag was never found are
registered with their default value and the viewer keeps simulating happily. Both are now surfaced,
and the write gate can be opened from where the operator notices it.

Everything below is driven by `GET /status`. The poll has exactly **one** owner,
`ConnectStatusPoll` in `connect-plugin.tsx`: it runs every 2 s for as long as the gateway is
connected — **also while the CONNECT panel is closed**, which is where both prompts live — with a
5 s abort deadline per request, and answers that arrive after the gateway target moved are
discarded. The CONNECT panel keeps no timer of its own and only reads the same store.

Both prompts are plugin `overlay` slots with the visibility ids `connect-write-gate-notice` and
`connect-no-data-notice`, so a deploy can switch either off without a code change. Both are
non-modal (`role="status"`, no autofocus, Escape dismisses): a modal would block the 3D scene, and
the viewer stays perfectly usable read-only.

### Write-gate overlay

Appears for an interface when **all** of these hold: the gateway is connected and reachable, the
interface's `allowWebToPlc` is not `true`, `/status` reports `writesBlockedByGate > 0` for it — i.e.
a viewer write was really dropped, not merely possible — no "Read only" decision is stored for it,
and the overlay was not closed for it in this session. At most **one** card is shown (the first
affected interface); further ones are counted as "+N more interfaces", because answering the first
usually answers the cause for all of them.

```
┌──────────────────────────────────────────────────────────────────┐
│ ⚠ PLCSIM_1 does not accept values from the viewer.                │
│   BT2_OpMode and 3 more inputs were not sent to the PLC.          │
│   Allowing writes sends the current input values (42 signals)     │
│   to PLCSIM Advanced · 192.168.0.10 now.                          │
│   [Allow writes]  [Read only, don't ask again]                ✕   │
└──────────────────────────────────────────────────────────────────┘
```

The second line counts the **distinct** signal names CONNECT remembers (one signal written 400
times is one lost input, not 400) and falls back to the raw attempt count when a gateway reports
only that. The third line is the effect line and it is not decoration: opening the gate restarts
the CONNECT workers, and the affected worker then writes the viewer's *current* input values to the
target as part of its connect. That seed is intended — the operator's switch position is supposed
to arrive — so the target and the number of signals are named **before** the click. There is no
second confirmation.

Two actions, both commands (`connect.allowWrites`, `connect.readOnly`), so the overlay, the
interface card and any later surface cannot drift apart on what they mean. Neither has an MCP
mirror: letting an agent open a PLC write gate on its own is exactly the silent write this feature
exists to prevent.

- **Allow writes** calls `PUT /config/interfaces/{id}/allow-web-to-plc` with the `configRevision`
  of the status snapshot **on screen** — never a freshly read one, since the whole point of the
  comparison is that the gateway refuses the flip when the interface moved since that sentence was
  written. There is deliberately no fallback to `PUT /config/interfaces/{id}`, which would replace
  the whole interface from a cached copy and silently revert another client's edits.

  | Outcome | What the overlay does |
  |---------|-----------------------|
  | `200` | the gate is open, the interface list is re-read, the card disappears |
  | `409 revision-mismatch` | "The interface changed - review it first"; `/status` is re-read and the card shows the new state |
  | `404 interface-not-found` | the question is void — the card closes without an error |
  | no `configRevision` in the snapshot, `405`, or `404` without a code | "Update CONNECT to allow writes from here" plus an **Open interface settings** button; the request is not even sent when the revision is missing |
  | network / transport failure | the message, and the card stays |

- **Read only, don't ask again** stores the decision and hides the card for good.

**"Read only" persistence.** The decision is keyed by **gateway and interface** —
`<serverUrl>|<interfaceId>` — in `localStorage` under `rv-connect-writegate-readonly` (owned by
`connect-write-gate-store.ts`, listed in the storage reset list). The map holds only the
*exception* (`true`), so an unknown key reads as "not decided yet" and the overlay still asks once.
The same id on another CONNECT is another machine and is unaffected. A browser that refuses
`localStorage` keeps the answer for the session instead of re-asking on every render.

The ✕ and Escape are **not** that decision: they put the question down for this session only, and
the next session asks again.

**The way back.** A decision without a return path is a trap, so an interface with a stored "Read
only" and a still-closed gate carries a **"Writes blocked"** chip on its card in the CONNECT panel.
Clicking it clears the stored decision *and* opens the interface's Edit dialog — leaving the
decision in place would silence the overlay again the moment the gate stays closed.

### The write-permission question when adding an interface

`AddInterfaceDialog` asks in a second step, after the type was picked:

```
Add interface → Siemens PLCSIM Advanced →
  ☑ Allow realvirtual WEB to write inputs to the PLC?
    Leave on for virtual commissioning. Turn off if the target is a live machine.
  [Back]  [Create]
```

The checkbox is **preselected on** — virtual commissioning is what nearly every new interface is
for, and a viewer that cannot write is the very failure this feature is about — and the answer goes
into the `addInterface` body as `allowWebToPlc`. CONNECT's own default stays `false`, so the API and
hand-edited configuration files are unchanged.

Only this path asks. The one-click mirror, the MQTT quick-connect and the tag-table import create
interfaces too, but none of them is a moment where the user decides what a new PLC link may do:
they inherit CONNECT's `false` and the write-gate overlay catches them the first time a value is
actually dropped.

### "Connected, but no PLC outputs received"

The verdict is computed in `connect-no-data-watch.ts` from the `readHealth` block of `/status`
(`boundReadTags`, `tagsWithValidValue`, `progress`, `workerGeneration`, `progressIsPeriodic`). An
interface whose worker reports **no** read health — `readHealth` is `null` for every type other
than PLCSIM Advanced, S7, TwinCAT and OPC UA — is never judged: a wrong "no data" is worse than
none.

The clock is **`viewer.simTime`, not wall-clock**. A paused simulation produces no viewer writes
and expects no PLC traffic, so a wall-clock window would accuse the PLC of a silence that is the
viewer's. The window is **10 s of sim time** (`NO_DATA_WINDOW_S`), per interface **and** per
`workerGeneration`, starting with the first poll that sees that generation `Connected`.

Two rules:

- **A — "no valid data":** after the window has elapsed, `boundReadTags === 0` → *no readable tags
  bound*; otherwise `tagsWithValidValue === 0` → *no valid values received*.
- **B — "data stopped":** progress was observed and then stood still for the window.
  **Only when `progressIsPeriodic === true`.** On a pure on-change path (TwinCAT `OnChange`, and
  OPC UA without a single polled signal — there is no OPC-UA keep-alive) a standing value is normal
  operation, so rule B does not apply there and only rule A can fire.

A PLC in STOP delivers valid constant values and therefore triggers nothing, which is intended.

```
┌──────────────────────────────────────────────────────────────────┐
│ ⓘ Connected, but no PLC outputs received.                         │
│   PLCSIM_1 · no readable tags bound · 12 signal issues            │
│   [Open log]                                                  ✕   │
└──────────────────────────────────────────────────────────────────┘
```

One line per silent interface, with the reason and — as context, not as cause — how many configured
signals the gateway already knows can never decode. **Open log** is the command
`connect.openLog`, and it does two things in one step: open the CONNECT panel *and* set the log
flag, because the log dialog only renders inside an open panel while the notice itself appears over
the 3D view. The log is where the worker already wrote down *why* nothing arrives.

The verdict is recomputed from scratch on every poll, so the notice **disappears by itself** as
soon as data flows again. ✕ and Escape dismiss it once per interface and worker generation; a
worker restart (a new `workerGeneration`), a sim reset (`simTime` jumping back), leaving
`Connected` or a gateway disconnect all start a fresh observation window, and a late-connecting
second interface gets its own.

## Viewer surface picks and scene scale (plan-515)

Two viewer-side APIs that HMI code and interfaces reading the 3D view can use
(both exist in `RVViewer` and `RVEmbedViewer`):

- `viewer.raycastManager.raycastSurface(clientX, clientY, out)` — "what surface is
  under this pixel": same visibility / isolation / allow gates as a selection pick but
  no hover-type gate; an unselectable opaque blocker counts as a surface
  (`out.blocked = true`), transparent segments and hidden nodes pass. Writes into a
  caller-owned `SurfaceHit` (`point`, `distance`, `blocked`, `path`, optional `ray`);
  `false` = background. Changes no hover state.
- `viewer.sceneScale.get()` — the one source of the content bounds (`center`,
  `radius` ≥ 0.5 mm, `maxDim`, `empty`), recomputed after content events and, while the
  simulation runs, grow-only for moving content every 500 ms; `onChange(cb)` notifies
  after a change. Navigation near/far and the scale-derived constants (gizmo, ground
  checker, FPV, shadows) read it — see `doc-webviewer.md` § Camera Controls.

## Render mode (plan-761)

The viewer's shading is ONE command with three views — the toolbar pill, the Visual tab
dropdown and the MCP tool — all implemented by one core setter:

- `setRenderMode(viewer, mode)` (`src/core/hmi/render-mode-controller.ts`), `mode` =
  `'simple' | 'default' | 'toon'` (labels Unlit / Shaded / Toon from `RENDER_MODES`). Order:
  an *applied* editor wireframe is switched off first, the per-mode lighting values are
  pushed, `renderMode` is persisted (Visual settings), then `viewer.renderMode` is set — which
  emits `render-mode-changed`. The same mode without an applied wireframe is a true no-op
  (no material recompile); the same mode with wireframe applied only leaves the wireframe.
  `wireframe` itself is never persisted.
- Command `view.renderMode { mode }` (`src/core/hmi/view-commands.ts`, open and eager;
  `ensureViewCommandsRegistered()`), button key `view.renderMode:<mode>`. It refuses with a
  reason when the deployment locks the Visual settings (`lockSettings` or
  `lockedTabs: ['visual']`) and for any other value — `'wireframe'` included: the editor's
  wireframe view stays with `editor.wireframe` (Shift+Z, `web_editor_shortcut`).
- MCP: `web_view_render_mode(mode)` is bound to that command (origin `mcp`, afterglow on the
  matching pill segment); `web_status` reports `renderMode` and `wireframe` (the applied
  editor view).
- The pill (`RenderModeGroup`, `src/core/hmi/RenderModeBar.tsx`) sits first in the
  bottom-right view cluster: three radio segments, plus a Wireframe segment with divider
  that exists only in the editor workspace. Its active value is
  `wireframeActive ? 'wireframe' : renderMode` — a UI single axis over the two viewer fields;
  it re-renders on `render-mode-changed`, `wireframe-changed` and `mode-changed`. With
  locked Visual settings the pill is not rendered at all.

## Visual quality preset (plan-591)

The SECOND axis of the same menu, and a separate command: shading is *how* the scene is lit,
the quality preset is *how much* is computed (resolution, antialias, shadow-map size, AO,
reflection, UI blur). Folding the dials into `setRenderMode` was rejected on purpose — that
setter stays limited to mode plus lighting.

- `applyVisualPresetByName(viewer, name, source)` (`src/core/hmi/visual-presets.ts`) is the one
  entry point: it drops an *applied* editor wireframe first (otherwise the per-frame
  suppression switches shadows / AO / reflection straight back off), bumps the apply epoch,
  merges the preset over the live settings, persists, and pushes the result through
  `viewer.applyVisualSettings`. It returns `{ name, source, antialiasNeedsReload }`, or `null`
  when the name does not exist in that tier.
- `source` is `'shipped'` (only `public/presets`) or `'any'` (published + browser-local, the
  default). It travels in the command ARGUMENT all the way to the apply: `listPresets()` lets
  a local preset win a name clash, so dispatching on the bare name would let a local
  "Default" hijack the Max Quality row. There is **no fallback** between the tiers — a missing
  shipped preset is a refusal with a reason, never a silent substitution.
- Command `view.visualPreset { name, source? }` (`src/core/hmi/view-commands.ts`, open and
  eager), button key `view.visualPreset:<name>`. `enabled()` and `run()` resolve through the
  same `presetsForSource(source)`, so the refusal text names exactly the set that would be
  applied. It refuses on the same lock as `view.renderMode`.
- MCP: `web_view_visual_preset(name, source?)` is bound to that command. `web_status` reports
  `visualPreset` (the matching preset name, `null` on "Custom") and `antialiasActive` — the
  latter is the only observable that proves a reload took effect, since `antialias` is a
  renderer *constructor* parameter.
- Views: the two action rows "Max Quality" / "Fast" at the end of the render-mode menu
  (`source: 'shipped'`, active marking from `matchPreset(listShippedPresets())` — the same
  list they resolve against) and the Visual tab's preset dropdown (`source: 'any'`).
- `applyVisualSettings` applies `maxDpr` too, and pushes the renderer's new pixel ratio onto
  an EXISTING `EffectComposer` (`PostProcessingManager.syncPixelRatio()`): without that the
  beauty pass turns sharp while the AO / bloom buffers stay coarse. No-op on WebGPU, which
  has no composer.
- `subscribeVisualSettings(cb)` (`visual-settings-store.ts`) is notified by every
  `saveVisualSettings`. It is what keeps the active marking correct after a single slider
  move (which walks the state to "Custom" without emitting `render-mode-changed`) and what
  makes the reload hint reactive. Listeners must return PRIMITIVE snapshots.
- Reload hint: `ReloadHintHost` (`src/core/hmi/reload-hint-store.tsx`), registered in
  `App.tsx`. Pure derived state (`settings.antialias !== viewer.antialiasActive`) plus a
  dismiss epoch, so a dismiss lasts exactly until the next apply and a stale hint is
  impossible. It is **suppressed on touch devices** at both display paths (this host and the
  Visual tab's own "Reload required"), because `main.ts` vetoes antialias there on every boot
  and a reload could not resolve the mismatch — plan-592 removes that gate.

## Unity-Side Setup

On the Unity side, use the **WebSocket Realtime Interface** component (`WebsocketRealtimeInterface.cs`). All signals defined in the Unity scene (drives, sensors, custom signals) are automatically exposed through the interface.

The Unity server:
1. Listens for WebSocket connections
2. Responds to `import_request` with all registered PLC signals
3. Sends delta `data` messages when signal values change
4. Receives `data` messages from realvirtual WEB and applies them to PLC signals

No special configuration is needed per signal — the interface discovers and exchanges all defined signals automatically.
