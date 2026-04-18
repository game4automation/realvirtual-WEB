# realvirtual WEB Multiuser System

Technical documentation for the real-time multiuser collaboration system in realvirtual WEB.

## Architecture Overview

The multiuser system enables multiple users to collaborate in a shared 3D digital twin session with full state synchronization. It operates on a **server-authority model** where Unity (or a relay server) is the source of truth for simulation state.

```
                    +-----------+
                    |   Unity   |   (MultiplayerWEB.cs)
                    |  Port 7000|   Host / Source of Truth
                    +-----+-----+
                          |
              +-----------+-----------+
              |                       |
        +-----+-----+          +-----+-----+
        | Browser A  |          | Browser B  |
        | (operator) |          | (observer) |
        +------------+          +------------+

        --- OR via Relay Server ---

        +--------+      +-------+      +--------+
        | Unity  +----->| Relay +----->|Browser |
        | (host) |<-----+Server |<-----|  (N)   |
        +--------+      +-------+      +--------+
                       Port 7000
```

### Connection Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Local** | Browser connects directly to Unity WebSocket server on LAN | Same network, low latency |
| **Relay** | Unity + browsers connect to a relay server | Remote access, firewalls, Teams integration |

### What Gets Synchronized

| Data | Synced? | Rate | Direction | Stored for Late Join? |
|------|---------|------|-----------|-----------------------|
| Drive positions + speed | Yes | 60 Hz | Server -> Clients | Yes (state_snapshot) |
| MU positions + rotations | Yes | 50 Hz | Server -> Clients | No |
| MU lifecycle (spawn/destroy) | Yes | 50 Hz | Server -> Clients | No |
| MU gripping (parent changes) | Yes | 50 Hz | Server -> Clients | No |
| Signal values | Yes | On write | Bidirectional | Yes (state_snapshot) |
| Avatar camera positions | Yes | 20-30 Hz | Bidirectional | No |
| VR controller positions | Yes | 20-30 Hz | Client -> Others | No |
| Cursor rays | Yes | On send | Client -> Others | No |
| Drive jog/stop commands | Yes | On action | Operator -> Server | No |

---

## Protocol Reference

All messages are JSON over WebSocket on port 7000.

### Client -> Server Messages

#### room_join
Sent immediately after WebSocket opens.

```json
{
  "type": "room_join",
  "name": "Alice",
  "color": "#2196F3",
  "role": "operator",
  "xrMode": "none",
  "joinCode": "ABC123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Display name |
| color | hex string | Yes | Avatar color |
| role | `"operator"` or `"observer"` | Yes | Permission level |
| xrMode | `"none"`, `"vr"`, or `"ar"` | Yes | XR mode for avatar rendering |
| joinCode | string | No | Room code for relay sessions |

#### avatar_update
Sent at 20-30 Hz with camera/controller state.

```json
{
  "type": "avatar_update",
  "headPos": [1.5, 2.0, 3.5],
  "headRot": [0.0, -0.7, 0.0, 0.7],
  "cameraTarget": [0.0, 1.0, 0.0],
  "leftCtrl": { "pos": [0.5, 1.2, 0.3], "rot": [0,0,0,1], "active": true },
  "rightCtrl": { "pos": [-0.5, 1.2, 0.3], "rot": [0,0,0,1], "active": true }
}
```

- `leftCtrl` / `rightCtrl`: Only sent when `xrMode === "vr"`, null otherwise.

#### signal_write (operator only)
```json
{
  "type": "signal_write",
  "signalPath": "Cell/Signals/Start",
  "value": true
}
```

#### drive_jog (operator only)
```json
{
  "type": "drive_jog",
  "drivePath": "Robot/Axis1",
  "forward": true
}
```

#### drive_stop (operator only)
```json
{
  "type": "drive_stop",
  "drivePath": "Robot/Axis1"
}
```

#### cursor_ray (all roles)
```json
{
  "type": "cursor_ray",
  "origin": [0, 1, 0],
  "direction": [0, 0, 1]
}
```

### Server -> Client Messages

#### room_state
Broadcast to all clients when any player joins or leaves.

```json
{
  "type": "room_state",
  "players": [
    {
      "id": "uuid-1234",
      "name": "Alice",
      "color": "#2196F3",
      "role": "operator",
      "xrMode": "none",
      "headPos": [1.5, 2.0, 3.5],
      "headRot": [0.0, -0.7, 0.0, 0.7]
    }
  ]
}
```

#### state_snapshot
Sent only to the newly joined client for late-join recovery.

```json
{
  "type": "state_snapshot",
  "signals": [
    { "path": "Cell/Signals/Start", "type": "bool", "value": true },
    { "path": "Cell/PressureGauge", "type": "float", "value": 42.5 }
  ],
  "drives": [
    { "path": "Robot/Axis1", "position": 150.0, "speed": 100.0 }
  ],
  "players": [
    { "id": "uuid-1234", "name": "Alice", "color": "#2196F3", "role": "operator", "xrMode": "none" }
  ]
}
```

#### drive_sync
Broadcast at 60 Hz (delta-only: only changed drives included).

```json
{
  "type": "drive_sync",
  "drives": [
    { "path": "Robot/Axis1", "position": 45.5, "speed": 10.0 },
    { "path": "Robot/Axis2", "position": 20.0, "speed": 5.0 }
  ]
}
```

#### drive_sync_idx (Opt 7: Path Table)
Indexed variant sent to clients that acknowledged the path table.

```json
{
  "type": "drive_sync_idx",
  "drives": [
    { "i": 0, "p": 45.5, "s": 10.0 },
    { "i": 2, "p": 20.0, "s": 5.0 }
  ]
}
```

#### mu_sync
Broadcast at 50 Hz (delta-only).

```json
{
  "type": "mu_sync",
  "mus": [
    {
      "path": "Created/MU_001",
      "name": "Material_001",
      "source": "Source1",
      "pos": [1.5, 0.8, 3.5],
      "rot": [0, 0, 0, 1]
    },
    {
      "path": "Robot/Gripper/MU_002",
      "name": "Material_002",
      "source": "Source1",
      "pos": [0.1, 0.0, -0.2],
      "rot": [0, 0.5, 0, 0.866],
      "parent": "Robot/Gripper"
    }
  ]
}
```

- Free MUs: `pos`/`rot` in world coordinates, no `parent` field.
- Gripped MUs: `pos`/`rot` in local coordinates relative to `parent`.

#### avatar_broadcast
Relayed avatar updates from other clients.

```json
{
  "type": "avatar_broadcast",
  "id": "uuid-1234",
  "headPos": [1.5, 2.0, 3.5],
  "headRot": [0.0, -0.7, 0.0, 0.7],
  "cameraTarget": [0.0, 1.0, 0.0],
  "leftCtrl": null,
  "rightCtrl": null
}
```

#### error
```json
{
  "type": "error",
  "code": "permission_denied",
  "message": "Only operators can write signals"
}
```

Error codes: `permission_denied`, `invalid_request`, `not_found`, `parse_error`, `not_joined`.

---

## Ownership & Authority Model

When multiuser connects, the server becomes the **sole authority** for simulation state.

### Ownership Transitions

**On Connect (first drive_sync or state_snapshot received):**
1. All drives: `isOwner = false` (skip local physics)
2. All sources: `isOwner = false` (stop spawning MUs)
3. All sinks: `isOwner = false` (stop consuming MUs)
4. DrivesPlayback: stopped (server is authority)

**On Disconnect:**
1. All drives: `isOwner = true` (resume local physics)
2. All sources: `isOwner = true` (resume spawning)
3. All sinks: `isOwner = true` (resume consuming)

### Drive Sync Behavior

| Drive Type | Position Synced? | Speed Synced? | Behavior |
|------------|------------------|---------------|----------|
| Positioning (linear/rotary) | Yes (snap) | Yes | Direct position assignment |
| Transport Surface (conveyor) | No | Yes (speed only) | Speed drives MU transport, mesh stays fixed |

No interpolation or smoothing is applied — at 60 Hz sync rate, direct snapping is imperceptible.

### MU Sync Behavior

The server sends the complete list of all active MUs every frame. The client:
- **Creates** MUs that exist on server but not locally (clones from Source template)
- **Updates** position/rotation of existing MUs
- **Removes** MUs that no longer appear in the server list
- **Reparents** gripped MUs under the grip node (local coordinates)

### Signal Sync

- **State snapshot** on late join: bulk-applies all signal values
- **signal_write** from operators: relayed to all other clients, stored for late joiners
- Sensors remain active locally — they detect server-synced MU positions

---

## Role-Based Permissions

| Action | Observer | Operator |
|--------|:--------:|:--------:|
| View scene & avatars | Yes | Yes |
| Receive drive/MU/signal state | Yes | Yes |
| Send avatar position | Yes | Yes |
| Send cursor ray | Yes | Yes |
| Write signals | No | Yes |
| Jog/stop drives | No | Yes |

Enforcement is on the Unity server side. The relay forwards all messages regardless of role.

---

## Relay Server

A relay server is a Node.js WebSocket multiplexer that enables multiuser sessions when clients cannot reach Unity directly (firewalls, NAT, Teams meetings, public web sessions).

> **The relay server source code lives in a separate repository.** It is no longer bundled with the WebViewer. The settings store ships with a default hosted relay URL (`wss://download.realvirtual.io/relay`) and the WebViewer plugin handles both `local` and `relay` connection modes (see `connectionMode` in [multiuser-settings-store.ts](src/core/hmi/multiuser-settings-store.ts)).

### Architecture
- Express.js HTTP + `ws` WebSocket on a single port (default 7000)
- Room-based session management with alphanumeric join codes
- Heartbeat pings to detect stale connections
- Automatic room cleanup after the last client leaves

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | `{ status: "ok", rooms: N, clients: N }` |
| `/model.glb` | GET | Serves GLB file if `--model` CLI arg provided |

### Rate Limiting

| Role | Limit |
|------|-------|
| Host (operator) | 5000 msg/sec |
| Viewer (observer) | 500 msg/sec |

Sliding-window counter per WebSocket connection.

### State Storage for Late Joiners

| Data | Stored? | Purpose |
|------|---------|---------|
| Signal values | Yes | Bulk-applied on join via state_snapshot |
| Drive jog/stop states | Yes | Drive control recovery |
| Avatar positions | No | Transient, continuous stream |
| Drive positions | No | Continuous stream at 60 Hz |
| MU positions | No | Continuous stream at 50 Hz |

### Self-hosting

If you need to run your own relay (private network, on-prem deployments), check out the relay repo and follow its README. A typical run:

```bash
npm install
npm run build
npm start -- --port 7000

# Docker
docker build -t relay-server .
docker run -p 7000:7000 relay-server
```

Then set `relayUrl` in `multiuser-settings-store.ts` defaults (or via `settings.json`) to your relay endpoint.

---

## Unity Host (MultiplayerWEB.cs)

The Unity-side component that acts as the multiuser host.

### Inspector Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| ConnectionMode | enum | LocalServer | `LocalServer` or `RelayClient` |
| RelayServerUrl | string | (empty) | Relay endpoint for RelayClient mode |
| Port | int | 7000 | WebSocket listen port (LocalServer mode) |
| AvatarPrefab | GameObject | Avatar.prefab | Remote player avatar template |
| AvatarUpdateRate | int | 20 | Hz for avatar broadcast |
| DrivesSyncRate | int | 60 | Hz for drive position broadcast |
| MUSyncRate | int | 50 | Hz for MU position broadcast |
| HandshakeTimeoutSeconds | float | 5 | Disconnect clients that don't send room_join |
| MaxMessagesPerSecond | int | 100 | Per-client rate limit |
| UseDrivePathTable | bool | false | Enable indexed drive_sync (Opt 7) |

### Delta Detection Thresholds

| Component | Threshold | Description |
|-----------|-----------|-------------|
| Avatar position | 0.01 mm (sqr 0.0001) | Skip broadcast if camera barely moved |
| Avatar rotation | dot > 0.9999 | Skip broadcast if rotation barely changed |
| Drive position | 0.001 (1 mm) | Skip drive if position change < 1mm |
| MU position | 0.001 mm (sqr 0.000001) | Skip MU if position change < 0.001mm |

### Coordinate Conversion (Unity -> glTF/Three.js)

Unity is left-handed (Y-up), glTF is right-handed (Y-up):
- **Position**: negate X (`[-x, y, z]`)
- **Rotation**: negate Y and Z (`[qx, -qy, -qz, qw]`)

### Performance Optimizations

| # | Optimization | Impact |
|---|-------------|--------|
| 1 | GameObject path cache | Eliminates O(scene) lookups for signal/drive paths |
| 3 | Pre-computed MU paths (refresh every 2s) | Avoids GetFullPath at 50 Hz |
| 4 | Reusable grip HashSet | Avoids re-allocation every 2 seconds |
| 7 | Path table indexed sync | ~90 KB/s bandwidth savings at 5 browsers |
| - | StringBuilder reuse | Zero GC in hot broadcast paths |
| - | Struct PresenceEvent | Zero GC for main-thread event queue |

### Thread Safety

All WebSocket callbacks enqueue events to a `ConcurrentQueue<PresenceEvent>`. The main thread drains the queue in `Update()`. No Unity API calls are made from WebSocket threads.

---

## WebViewer Client (multiuser-plugin.ts)

### Drive Map Building

On first `drive_sync` or `state_snapshot`, the plugin builds an O(1) lookup map:

```
_driveMap entries:
  "GLTF_Root/Robot/Axis1" -> drive    (full Three.js path)
  "Robot/Axis1"            -> drive    (Unity-compatible path, prefix stripped)
  "Axis1"                  -> drive    (name-only fallback)
```

Lookup: try full path first, fallback to last path segment.

### MU Sync Application

1. Index incoming MUs by path segment + name
2. Index local MUs by name
3. **Match**: update position/rotation, handle grip reparenting
4. **Create**: clone from Source template, add to scene
5. **Remove**: mark unmatched local MUs for removal

### Buffering Strategy

Drive and MU sync messages are buffered (latest-only). Applied in `onPreFixedUpdate()` **before** `drive.update()` runs, so interpolation starts from the correct position in the same frame.

### Avatar Rendering

- **Billboard**: Sprite with CanvasTexture (player icon + name + color border)
- **VR Controllers**: SphereGeometry (0.05m radius) shared across all VR avatars
- **Cursor Ray**: THREE.Line from origin to 50m along direction, auto-hides after 500ms
- **LOD**: Controllers hidden if avatar > 10m from camera
- **Lerp**: Frame-rate independent: `t = 1 - pow(1 - 0.25, dt * 60)` (identical at 30/60/120 fps)

### Reconnection

Fixed 2-second delay retry (not exponential). On disconnect:
1. Set status to `error`
2. Show "Connection lost -- reconnecting..." message
3. Schedule reconnect after 2 seconds
4. On reconnect: send `room_join`, receive `state_snapshot`

---

## Configuration & URL Parameters

### URL Parameters (Auto-Connect)

When these parameters are present, the multiuser plugin auto-joins on model load:

| Parameter | Aliases | Example | Description |
|-----------|---------|---------|-------------|
| `server` | `relay`, `multiuserServer` | `ws://192.168.1.5:7000` | Server/relay URL |
| `name` | `multiuserName` | `Alice` | Display name |
| `role` | `multiuserRole` | `operator` | User role |
| `joinCode` | `code` | `ABC123` | Room join code |
| `multiuserColor` | - | `#FF5722` | Avatar color |

**Priority**: URL params > localStorage settings > defaults.

### Persisted Settings (localStorage)

Key: `rv-multiuser-settings`

```json
{
  "enabled": true,
  "connectionMode": "local",
  "serverUrl": "",
  "relayUrl": "wss://download.realvirtual.io/relay",
  "displayName": "Browser",
  "role": "observer",
  "joinCode": ""
}
```

### Share Session Link

When connected, the MultiuserPanel shows a "Share Session Link" button that copies a URL containing:
- `?server=` (current server/relay URL)
- `?joinCode=` (current room code)
- `?name=Guest` (default name for recipient)
- `?model=` (current model URL, if any)

Recipients clicking this link auto-join the same session.

---

## Microsoft Teams Integration

### Tab Configuration

When adding realvirtual WEB as a Teams tab, the admin configures:
1. **Model URL** -- GLB file to load (optional)
2. **Tab Name** -- Header text in Teams
3. **Relay Server URL** -- For automatic multiuser (optional)
4. **Join Code** -- Shared room code (optional)

The configuration page generates a `contentUrl` with all parameters. When team members open the tab, multiuser auto-joins if relay URL and join code are configured.

### Automatic User Name

In Teams context, the user's principal name (email prefix, e.g., `thomas` from `thomas@company.com`) is automatically injected as the display name via `?name=` URL parameter.

### Deployment

1. Edit `teams-app/manifest.json` with your domain and app ID
2. Create `color.png` (192x192) and `outline.png` (32x32) icons
3. ZIP the manifest directory
4. Upload to Teams (sideload or admin center)
5. Configure CSP headers on CDN: `frame-ancestors https://teams.microsoft.com https://*.microsoft.com`

---

## Bandwidth & Performance

### Typical Bandwidth (5 concurrent browsers, 300 drives, 50 MUs)

| Stream | Per Client | Total (5 clients) | Notes |
|--------|-----------|-------------------|-------|
| drive_sync (60 Hz) | ~30-60 KB/s | ~150-300 KB/s | Delta detection saves 80-90% |
| mu_sync (50 Hz) | ~4 KB/s | ~20 KB/s | Delta detection saves 90-95% |
| avatar_broadcast (20 Hz) | ~0.4 KB/s | ~2 KB/s | Per-client overhead |
| state_snapshot | ~50-200 KB | Once per join | Signals + drives + players |
| **Total** | ~35-65 KB/s | ~175-325 KB/s | |

With Path Table optimization (Opt 7): saves ~90 KB/s at 5 browsers.

### Zero-GC Hot Path

Unity side: reusable StringBuilder, struct PresenceEvent, pre-computed path caches.
Browser side: reusable Vector3/Quaternion temps, latest-only message buffering, cached player arrays.

---

## Sequence Diagrams

### Normal Session Flow

```
Browser A          Unity (Host)         Browser B
    |                   |                    |
    |--- room_join ---->|                    |
    |<-- room_state ----|                    |
    |<-- state_snapshot-|                    |
    |                   |                    |
    |<-- drive_sync ----|--- drive_sync ---->|
    |<-- mu_sync -------|--- mu_sync ------->|
    |                   |                    |
    |-- avatar_update ->|-- avatar_bcast --->|
    |<- avatar_bcast ---|<- avatar_update ---|
    |                   |                    |
    |-- signal_write -->|-- signal_write --->|  (operator only)
    |                   |                    |
    |-- room_leave ---->|                    |
    |                   |-- room_leave ----->|
```

### Late Joiner Recovery

```
Browser C              Unity (Host)
    |                       |
    |---- room_join ------->|
    |<--- state_snapshot ---|  (all signals, all drives, all players)
    |<--- room_state -------|  (updated player list)
    |<--- drive_sync -------|  (continuous from here)
    |<--- mu_sync ----------|  (continuous from here)
```

### Relay Mode Flow

```
Unity (Host)        Relay Server        Browser A        Browser B
    |                    |                  |                |
    |-- room_join ------>|                  |                |
    |<- room_state ------|                  |                |
    |                    |<-- room_join ----|                |
    |                    |--- room_state -->|                |
    |                    |--- state_snap -->|                |
    |                    |                  |                |
    |-- drive_sync ----->|-- drive_sync --->|                |
    |                    |-- drive_sync --->|--------------->|
    |-- mu_sync -------->|-- mu_sync ------>|                |
    |                    |-- mu_sync ------>|--------------->|
```

---

## File Reference

### Unity Side
| File | Purpose |
|------|---------|
| `Packages/io.realvirtual.professional/Runtime/MultiplayerWEB/MultiplayerWEB.cs` | WebSocket host, drive/MU/signal broadcast |
| `Packages/io.realvirtual.professional/Runtime/MultiplayerWEB/Avatar.prefab` | Remote player avatar template |
| `Packages/io.realvirtual.professional/Runtime/MultiplayerWEB/MultiplayerWeb.prefab` | Pre-configured MultiplayerWEB instance |

### WebViewer Side
| File | Purpose |
|------|---------|
| `src/plugins/multiuser-plugin.ts` | Core multiuser logic, message handling, ownership |
| `src/core/engine/rv-avatar-manager.ts` | 3D avatar rendering, lerp, VR controllers |
| `src/core/hmi/MultiuserPanel.tsx` | Join/disconnect UI, player list, share link |
| `src/core/hmi/multiuser-settings-store.ts` | Settings persistence in localStorage |
| `src/core/hmi/settings/MultiuserTab.tsx` | Settings panel (enable, server, name, role) |
| `src/hooks/use-multiuser.ts` | React hook for multiuser state |
| `src/core/types/plugin-types.ts` | MultiuserPluginAPI interface |

### Relay Server
The relay server lives in its own repository (not in this WebViewer repo). The hosted endpoint defaults to `wss://download.realvirtual.io/relay`.

### Teams Integration
| File | Purpose |
|------|---------|
| `public/teams-config.html` | Tab configuration page |
| `teams-app/manifest.json` | Teams app manifest |
| `src/main.ts` | Teams SDK init, user name extraction |

### Tests
| File | Coverage |
|------|----------|
| `tests/rv-multiuser.test.ts` | Avatar manager, message handling |
| `tests/rv-multiuser-perf.test.ts` | 15-avatar performance, cache behavior |
| `tests/rv-multiuser-relay.test.ts` | Settings persistence, relay config |
