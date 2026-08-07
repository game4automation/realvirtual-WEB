# realvirtual Open Digital Twin Format (rv-ODT) — Specification v1.0

**Status:** Released
**Format version:** 1.0
**Canonical machine-readable schema:** [`rv-odt.json`](./rv-odt.json) (`$id: https://realvirtual.io/schema/odt/v1/rv-odt.json`)
**License:** This specification and the accompanying `rv-odt.json` are licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/) — see [`../LICENSE`](../LICENSE). The reference implementation (realvirtual WEB) is separately licensed under AGPL-3.0-only.

> **Normative precedence:** Where this document and `rv-odt.json` disagree on field
> names, types, defaults, units, or enum values, **the JSON schema is normative**.
> The prose tables in Section 7 are non-normative and provided for human readability.

---

## 1. Title and Status

This document specifies version 1.0 of the **realvirtual Open Digital Twin Format
(rv-ODT)**: a convention for embedding industrial digital-twin component data —
drives, sensors, transport surfaces, material sources and sinks, grippers, robot
kinematics, PLC signal wiring, and 3D-HMI markers — inside standard
[glTF 2.0 / GLB](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) files.

A single self-describing GLB file carries both the geometry and the complete
behavioral/HMI configuration of a machine or plant. No side-car files, no external
schema registry, no vendor runtime is required to read it.

URL stability commitment: the canonical schema URL
`https://realvirtual.io/schema/odt/v1/rv-odt.json` serves the latest compatible 1.x
schema and changes only through the documented additive release process. Every minor
release is also published under `/schema/odt/v1.N/` as a byte-immutable snapshot.
The canonical and snapshot URLs are committed to remain reachable until at least
2037, in line with the documentation-availability requirements of EU Machinery
Regulation 2023/1230.

## 2. Motivation

Industrial machine documentation and 3D visualization are typically locked into
vendor tools. rv-ODT makes the delivered digital twin an **open artifact**:

- **One file** — geometry plus component semantics in a single GLB.
- **Tool independence** — any glTF-capable tool can read the geometry; any JSON-capable
  tool can read the component data and validate it against `rv-odt.json`.
- **Longevity** — glTF 2.0 is an ISO/IEC 12113 standard; the component layer is plain
  JSON under the standardized `extras` mechanism.
- **Ecosystem** — authoring tools (Unity exporter, Blender add-on, CAD importers) and
  consumers (web viewers, CI validators, documentation generators) can interoperate
  against one published contract.

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

- A **writer** is a tool that produces rv-ODT GLB files (e.g. the realvirtual Unity exporter).
- A **reader** is a tool that consumes rv-ODT GLB files (e.g. realvirtual WEB).
- A **component** is a named block of key/value configuration attached to a glTF node.

## 4. Format Overview

rv-ODT data lives in the standard glTF `extras` object of each node, under the
reserved key `realvirtual`:

```json
{
  "nodes": [
    {
      "name": "ConveyorDrive",
      "extras": {
        "realvirtual": {
          "Drive": {
            "Direction": "LinearX",
            "TargetSpeed": 200
          },
          "TransportSurface": {
            "TransportDirection": { "x": 1, "y": 0, "z": 0 },
            "DriveReference": {
              "type": "ComponentReference",
              "path": "Cell/ConveyorDrive",
              "componentType": "Drive"
            }
          }
        }
      }
    }
  ]
}
```

Rules:

- A node MAY carry zero, one, or several components under `extras.realvirtual`.
- Each key of `extras.realvirtual` that matches a component name in the
  `components` index of `rv-odt.json` MUST validate against that component's `$def`.
- Readers MUST ignore unknown keys (forward compatibility). Writers SHOULD NOT emit
  keys that are not defined in this specification or in a documented extension.
- Fields omitted by the writer take the `default` declared in `rv-odt.json`.
- glTF interoperability is unaffected: `extras` is ignored by standard glTF loaders.

## 5. glTF Binding

- **Container:** glTF 2.0, typically binary (`.glb`). JSON `.gltf` is equally valid.
- **Attachment point:** `node.extras.realvirtual` (object). rv-ODT v1 does not define
  a glTF extension (`extensionsUsed`); it uses only the `extras` mechanism.
- **Node identity:** components reference other nodes by **scene path** — the
  slash-joined chain of node names from the scene root to the node
  (e.g. `"Cell/Conveyor1/Drive"`). Writers MUST produce unique node names within a
  parent so paths are unambiguous.
- **Coordinate systems:** glTF is right-handed (+Y up, +Z forward); Unity is
  left-handed. Scalar positions/speeds are in Unity component conventions
  (millimeters, mm/s) regardless of the glTF unit (meters). Vector-valued fields
  marked with the `unityCoords` keyword are serialized in **Unity** coordinates and
  readers MUST negate the X component when applying them in glTF space (Section 8).
- **Format version:** writers SHOULD stamp `_formatVersion: "1.0"` at the root of
  `extras.realvirtual`. Readers MUST report an incompatibility when the major
  version is greater than the version they implement.

## 6. Data Types

Component fields use the following types. The machine-readable definition in
`rv-odt.json` is normative.

| rv-ODT type | JSON representation | Notes |
|---|---|---|
| number | JSON number | Unit per field via the `unit` keyword (UCUM code), where applicable. |
| boolean | JSON boolean | |
| string | JSON string | |
| enum | JSON string | See "Enum wire format" below. |
| Vector3 | `{ "x": n, "y": n, "z": n }` | `$ref: #/$defs/Vector3`. May carry `unityCoords`. |
| Quaternion | `{ "x": n, "y": n, "z": n, "w": n }` | `$ref: #/$defs/Quaternion`. Reserved for future component fields. |
| ComponentReference | object | `$ref: #/$defs/ComponentReference`, see below. |
| ComponentReference[] | JSON array of ComponentReference | |

### ComponentReference

```json
{
  "type": "ComponentReference",
  "path": "Cell/PLC/StartSignal",
  "componentType": "PLCOutputBool",
  "componentIndex": 0
}
```

- `path` — scene path of the referenced node (Section 5).
- `componentType` — the component (or PLC signal type) expected at that node.
  PLC signal types follow the Unity/PLC convention: `PLCOutputBool|Int|Float` are
  written by the PLC and read by the twin; `PLCInputBool|Int|Float` are written by
  the twin and read by the PLC.
- `componentIndex` — disambiguates multiple components of the same type on one node
  (OPTIONAL, default 0).

### Enum wire format

Enum fields are serialized as **strings**. Writers MUST emit one of the values
listed in the field's `enum` array in `rv-odt.json` (the canonical wire values —
the C# enum member names). Conforming readers MUST accept any string listed in the
`enum` array. The order of values in the `enum` array is documentary only and
carries **no semantics**.

Some enum fields additionally declare an `enumMap` keyword (Section 8): a complete
map of accepted wire strings — including legacy integer indices serialized as
strings (e.g. `"0"`) — to the reader-internal value. Where present, readers SHOULD
accept all `enumMap` keys; writers MUST still emit only canonical `enum` values.

> Reminder (normative precedence): where a prose table below disagrees with
> `rv-odt.json` on names, types, defaults, units, or enum values, the JSON schema
> is normative.

## 7. Component Reference

rv-ODT v1 defines the complete `extras.realvirtual` surface in five groups,
mirroring the index groups in `rv-odt.json`:

| Group | Index key | Contents |
|---|---|---|
| 7a Components | `components` | 34 instantiable simulation/HMI components |
| 7b Logic Steps | `logicSteps` | 26 sequential-logic step types |
| 7c PLC Signals | `signals` | 6 PLC signal types |
| 7d Scene & Structure | `structure` | Groups, kinematic re-parenting, MU, colliders, layout, splats, AAS links |
| 7e Recording | `recording` | Drive recording and replay |

Each subsection gives the field table (non-normative; `rv-odt.json` is normative)
and, for components, a minimal example of the node `extras.realvirtual` payload.
The Default column shows the JSON default value; `-` means the field has no
default. The Description column mirrors the `description` texts maintained in
`rv-odt.json` (informative). Fields listed in a second "Raw field" table are
consumed by the reference implementation outside the schema mapper (custom
`rawFields` keyword, Section 8).

Common serialization metadata emitted by some writers on any component —
`Name`, `Active` (where not explicitly listed), `_fullTypeName`, `_version`,
`_enabled` — is NOT part of the format; readers MUST ignore it (exception:
`_enabled: false` on a `Group` entry disables that group entry).

### 7a. Components

#### 7a.1 Drive

Linear or rotational motion control along a local axis. The base motion component.

| Field | Type | Default | Description |
|---|---|---|---|
| `Direction` | enum(LinearX, LinearY, LinearZ, RotationX, RotationY, RotationZ, Virtual) | - | Motion axis of the drive in Unity local coordinates; 'Virtual' drives no transform. |
| `ReverseDirection` | boolean | false | Set to true if the direction needs to be inverted. |
| `Offset` | number | 0 | Start offset of the drive from zero position in millimeters or degrees. |
| `StartPosition` | number | 0 | Start position of the drive in millimeters or degrees. |
| `TargetSpeed` | number | 100 | The target speed of the drive in millimeters per second (degrees per second for rotational drives). |
| `Acceleration` | number | 100 | The acceleration in millimeters per second squared. |
| `UseAcceleration` | boolean | false | If set to true the drive uses the acceleration. |
| `UseLimits` | boolean | false | If set to true the drive motion is limited to the range between LowerLimit and UpperLimit. |
| `LowerLimit` | number | -180 | Lower drive limit in millimeters or degrees. |
| `UpperLimit` | number | 180 | Upper drive limit in millimeters or degrees. |
| `JogForward` | boolean | false | Jog the drive continuously forward at TargetSpeed. |
| `JogBackward` | boolean | false | Jog the drive continuously backward at TargetSpeed. |
| `TargetPosition` | number | 0 | The destination position of the drive in millimeters or degrees. |

```json
{ "Drive": { "Direction": "RotationZ", "TargetSpeed": 90, "UseLimits": true, "LowerLimit": -180, "UpperLimit": 180 } }
```

#### 7a.2 Drive_Simple

Drive behavior: jog control with speed and directional bits plus feedback signals.

| Field | Type | Default | Description |
|---|---|---|---|
| `Speed` | ComponentReference | - | PLC output for the speed of the drive in millimeters per second; can be scaled by ScaleSpeed. |
| `Accelaration` | ComponentReference | - | PLC output for the acceleration of the drive in millimeters per second squared; field name keeps the original C# spelling. |
| `Forward` | ComponentReference | - | Signal to move the drive forward. |
| `Backward` | ComponentReference | - | Signal to move the drive backward. |
| `IsAtPosition` | ComponentReference | - | Signal for the current position of the drive in millimeters. |
| `IsAtSpeed` | ComponentReference | - | Signal for the current speed of the drive in millimeters per second. |
| `IsDriving` | ComponentReference | - | Signal is true while the drive is driving. |
| `ScaleSpeed` | number | 1 | Scale factor for the input and output speed and acceleration. |
| `CurrentPositionScale` | number | 1 | Scale factor for the current position feedback. |
| `CurrentPositionOffset` | number | 0 | Offset applied to the position feedback in millimeters. |
| `ScaleFeedbackPosition` | boolean | true | If true, applies scale and offset to the position feedback. |

```json
{ "Drive_Simple": { "Forward": { "type": "ComponentReference", "path": "PLC/ConveyorStart", "componentType": "PLCOutputBool" } } }
```

#### 7a.3 Drive_Cylinder

Drive behavior: two-position cylinder with in/out command and end-position feedback.

| Field | Type | Default | Description |
|---|---|---|---|
| `MinPos` | number | 0 | Minimum position of the cylinder in millimeters. |
| `MaxPos` | number | 100 | Maximum position of the cylinder in millimeters. |
| `TimeOut` | number | 1 | Time for moving out from minimum to maximum position in seconds. |
| `TimeIn` | number | 1 | Time for moving in from maximum to minimum position in seconds. |
| `OneBitCylinder` | boolean | false | If set to true only one bit controls the cylinder; when Out is false the cylinder moves in. |
| `InvertOutputLogic` | boolean | false | When true, inverts the Out/In signal logic (Out=false extends, Out=true retracts). |
| `Out` | ComponentReference | - | Signal for moving the cylinder out. |
| `In` | ComponentReference | - | Signal for moving the cylinder in. |
| `IsOut` | ComponentReference | - | Signal is true when the cylinder is out or stopped by the Max sensor. |
| `IsIn` | ComponentReference | - | Signal is true when the cylinder is in or stopped by the Min sensor. |
| `IsMax` | ComponentReference | - | Signal is true when the cylinder is at the maximum position. |
| `IsMin` | ComponentReference | - | Signal is true when the cylinder is at the minimum position. |
| `IsMovingOut` | ComponentReference | - | Signal is true while the cylinder is moving out. |
| `IsMovingIn` | ComponentReference | - | Signal is true while the cylinder is moving in. |

```json
{ "Drive_Cylinder": { "MinPos": 0, "MaxPos": 250, "TimeOut": 0.8, "TimeIn": 0.8 } }
```

#### 7a.4 Drive_Speed

Drive behavior: speed-controlled motion via PLC target-speed signal with feedback.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalTargetSpeed` | ComponentReference | - | Target (maximum) speed of the drive in millimeters per second. |
| `SignalAcceleration` | ComponentReference | - | Acceleration of the drive in millimeters per second squared. |
| `SignalCurrentSpeed` | ComponentReference | - | Signal for the current drive speed in millimeters per second. |
| `SignalCurrentPosition` | ComponentReference | - | Signal for the current drive position in millimeters. |
| `SignalIsDriving` | ComponentReference | - | Signal is true while the drive is driving. |
| `TargetSpeed` | number | 100 | Default target speed in millimeters per second when no signal is wired. |
| `Acceleration` | number | 100 | Default acceleration in millimeters per second squared when no signal is wired. |
| `CurrentPositionScale` | number | 1 | Scale factor for the current position feedback. |
| `CurrentPositionOffset` | number | 0 | Offset applied to the position feedback in millimeters. |
| `ScaleFeedbackPosition` | boolean | true | If true, applies scale and offset to the position feedback. |

```json
{ "Drive_Speed": { "TargetSpeed": 500 } }
```

#### 7a.5 Drive_Gear

Drive behavior: slaves this node's Drive to a master Drive with gear ratio and offset.

| Field | Type | Default | Description |
|---|---|---|---|
| `MasterDrive` | ComponentReference | - | Master drive which defines the position of this drive. |
| `GearFactor` | number | 1 | Gear factor between master and slave position. |
| `Offset` | number | 0 | Offset of the gear in millimeters. |

```json
{ "Drive_Gear": { "MasterDrive": { "type": "ComponentReference", "path": "Cell/MainAxis", "componentType": "Drive" }, "GearFactor": 2 } }
```

#### 7a.6 Drive_FollowPosition

Drive behavior: directly follows a PLC position signal (no ramping).

| Field | Type | Default | Description |
|---|---|---|---|
| `Position` | ComponentReference | - | Signal (PLC output) for the commanded position of the drive. |
| `CurrentPosition` | ComponentReference | - | PLC input for the current position of the drive (without offset and scaling). |
| `Offset` | number | 0 | Offset in millimeters added to the position signal. |
| `Scale` | number | 1 | Scale factor applied to the position value. |
| `CurrentPositionScale` | number | 1 | Scale factor for the current position feedback. |
| `ScaleFeedbackPosition` | boolean | true | If true, applies scale and offset to the position feedback. |

```json
{ "Drive_FollowPosition": { "Scale": 1000 } }
```

#### 7a.7 Drive_DestinationMotor

Drive behavior: point-to-point positioning motor with destination command and feedback.

| Field | Type | Default | Description |
|---|---|---|---|
| `StartDrive` | ComponentReference | - | Start-to-drive signal; a value change starts motion towards Destination. |
| `Destination` | ComponentReference | - | Destination position of the drive in millimeters. |
| `TargetSpeed` | ComponentReference | - | Target (maximum) speed of the drive in millimeters per second. |
| `Acceleration` | ComponentReference | - | Acceleration of the drive in millimeters per second squared. |
| `IsAtPosition` | ComponentReference | - | Signal for the current position of the drive in millimeters. |
| `IsAtSpeed` | ComponentReference | - | Signal for the current drive speed in millimeters per second. |
| `IsAtDestination` | ComponentReference | - | Signal is true when the drive is at the destination. |
| `IsDriving` | ComponentReference | - | Signal is true while the drive is currently driving. |
| `CurrentPositionScale` | number | 1 | Scale factor for the current position feedback. |
| `CurrentPositionOffset` | number | 0 | Offset applied to the position command and feedback in millimeters. |
| `ScaleFeedbackPosition` | boolean | true | If true, applies scale and offset to the position feedback. |

```json
{ "Drive_DestinationMotor": { "CurrentPositionScale": 1 } }
```

#### 7a.8 Drive_PositionSwitch

Drive behavior: boolean output true while the drive position is inside configured areas.

| Field | Type | Default | Description |
|---|---|---|---|
| `OutputSignal` | ComponentReference | - | Output signal to the PLC; true when the drive position is inside any configured area (inverted when InvertAreas is true). |
| `InvertAreas` | boolean | false | If true, areas define false zones instead of true zones (inverts the output). |
| `PositionOffset` | number | 0 | Global offset in millimeters or degrees applied to the drive position before area checking. |

```json
{ "Drive_PositionSwitch": { "InvertAreas": false } }
```

#### 7a.9 Drive_ErraticPosition

Drive behavior: moves the drive to random (or alternating min/max) positions.

| Field | Type | Default | Description |
|---|---|---|---|
| `MinPos` | number | 0 | Minimum position of the range where the drive is allowed to move to, in millimeters. |
| `MaxPos` | number | 100 | Maximum position of the range where the drive is allowed to move to, in millimeters. |
| `Speed` | number | 100 | Speed of the drive in millimeters per second. |
| `IterateBetweenMaxAndMin` | boolean | false | If true the drive only iterates between MinPos and MaxPos; if false it moves to random positions. |
| `SignalEnable` | ComponentReference | - | While this signal is true the drive moves to erratic positions; when unwired it is always enabled. |

```json
{ "Drive_ErraticPosition": { "MinPos": 0, "MaxPos": 500, "Speed": 250 } }
```

#### 7a.10 Sensor

Presence sensor: AABB overlap (collision mode) or raycast mode.

| Field | Type | Default | Description |
|---|---|---|---|
| `UseRaycast` | boolean | false | If true the sensor uses raycast mode instead of collider (AABB overlap) mode. |
| `RayCastDirection` | Vector3 | - | Raycast direction vector in Unity local coordinates (readers negate X in glTF space). |
| `RayCastLength` | number | 1000 | Raycast length in millimeters. |
| `SensorOccupied` | ComponentReference | - | Boolean PLC input for the sensor signal; true when the sensor is occupied. |
| `SensorNotOccupied` | ComponentReference | - | Boolean PLC input for the sensor; true when the sensor is NOT occupied. |
| `AutoRay` | boolean | false | Derives the ray beam from the node bounding box (naming-convention sensors). |
| `PhysicsMode` | boolean | false | If true and the sensor overlaps a physics zone, the sensor is physics-managed: collision mode uses a physics sensor collider (enter/leave events), raycast mode a physics raycast. Physics-managed sensors detect only physics-owned MUs; sensors that must detect kinematic MUs keep the default false. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `Mode` | string | Legacy 'Raycast'/'Collision'; readers SHOULD convert to `UseRaycast` when `UseRaycast` is absent |

```json
{ "Sensor": { "UseRaycast": true, "RayCastDirection": { "x": 0, "y": -1, "z": 0 }, "RayCastLength": 500 } }
```

#### 7a.11 TransportSurface

Conveyor surface that moves MUs along a direction at the referenced Drive's speed.

| Field | Type | Default | Description |
|---|---|---|---|
| `TransportDirection` | Vector3 | - | Transport direction in Unity local coordinates, set by the Drive component at export (readers negate X in glTF space). |
| `Radial` | boolean | false | If true the surface transports radially around the drive axis (turntables). |
| `TextureScale` | number | 1 | Texture animation speed multiplier in texture units per meter. |
| `HeightOffsetOverride` | number | 0 | Manual override for the transport height offset in millimeters. |
| `AnimateSurface` | boolean | true | Enables texture animation to visualize surface movement. |
| `DriveReference` | ComponentReference | - | Optional drive reference for special cases; normally empty to use the auto-detected parent drive. |
| `Accumulate` | boolean | true | If true MUs on this surface accumulate: each MU clamps its advance to the free distance up to the next MU in move direction (no penetration). Ignored on Radial surfaces. |
| `MinGap` | number | 0 | Minimum front gap in millimeters kept between accumulated MUs. |
| `PhysicsMode` | boolean | false | If true and the surface lies fully inside a physics zone, the surface runs in physics mode: a kinematic conveyor body carries MUs via friction and jams/stacking are simulated physically. Ignored on Radial surfaces (v1 exclusion) and when the deployment switch simulation.physicsSurfaceDefault is false. |

```json
{ "TransportSurface": { "TransportDirection": { "x": 1, "y": 0, "z": 0 }, "DriveReference": { "type": "ComponentReference", "path": "Cell/Conveyor1", "componentType": "Drive" } } }
```

#### 7a.12 Source

Spawns new MU (Movable Unit) instances at intervals or by distance.

| Field | Type | Default | Description |
|---|---|---|---|
| `AutomaticGeneration` | boolean | true | Automatic generation of MUs when the last MU is farther than GenerateIfDistance from the source. |
| `Interval` | number | 0 | Interval in seconds between the generation of MUs; 0 disables interval generation. |
| `GenerateIfDistance` | number | 300 | Distance in millimeters from the source at which new MUs are generated. |
| `PlaceOnTransportSurface` | boolean | true | If true newly spawned MUs are placed onto the transport surface below the source. |
| `ThisObjectAsMU` | string | "" | Name of the GameObject used as the MU prototype; defaults to this node when empty. |
| `CollisionRoleForMUs` | enum(None, Tool, Workpiece, Machine, Robot, Environment) | "None" | Collision role assigned to every MU spawned by this source; `None` keeps spawned MUs out of every collision check. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `Spawn` | string | Legacy spawn-mode hint |

```json
{ "Source": { "AutomaticGeneration": true, "Interval": 5 } }
```

#### 7a.13 Sink

Destroys MUs that touch it. Carries no configuration fields in v1 — the presence of
the (empty) `Sink` object on a node marks the node as a sink.

```json
{ "Sink": {} }
```

#### 7a.14 Grip

Gripper for pick-and-place operations.

| Field | Type | Default | Description |
|---|---|---|---|
| `GripRange` | number | 50 | Search radius in millimeters for automatic MU detection when no sensor is assigned. |
| `OneBitControl` | boolean | true | If true a single signal controls the gripper (rising edge picks, falling edge places). |
| `PlaceMode` | enum(Auto, Static, Physics) | "Auto" | Controls how MUs are released on place: Auto (context-dependent), Static (stays kinematic) or Physics (falls onto surface). |
| `GripTargetSearchRadius` | number | 500 | Search radius in millimeters for finding the nearest GripTarget on place. |
| `SignalPick` | ComponentReference | - | Signal that triggers picking. |
| `SignalPlace` | ComponentReference | - | Signal that triggers placing. |
| `PartToGrip` | ComponentReference | - | Sensor identifying the MU to be gripped; when empty, auto-detection uses GripRange. |

```json
{ "Grip": { "PlaceMode": "Auto", "GripRange": 80 } }
```

#### 7a.15 GripTarget

Placement marker for precise MU positioning during Grip auto-place.

| Field | Type | Default | Description |
|---|---|---|---|
| `AlignPosition` | boolean | true | If true the MU position is snapped to the GripTarget position when placed. |
| `AlignRotation` | boolean | true | If true the MU rotation is aligned to the GripTarget rotation when placed. |

```json
{ "GripTarget": { "AlignPosition": true, "AlignRotation": true } }
```

#### 7a.16 ConnectSignal

One-way signal bridge: copies the referenced source signal onto this node's own signal.

| Field | Type | Default | Description |
|---|---|---|---|
| `ConnectedSignal` | ComponentReference | - | Source signal whose value is copied onto this node's own signal on every change. |

```json
{ "ConnectSignal": { "ConnectedSignal": { "type": "ComponentReference", "path": "PLC/MotorOn", "componentType": "PLCOutputBool" } } }
```

#### 7a.17 Lamp

Signal lamp: drives the emissive color of its first eligible mesh from PLC signals or a static state. `OnColor` is a raw Unity color object and is therefore shown in the JSON example rather than the schema-backed field table.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalLampOn` | ComponentReference | - | Boolean PLC output signal that drives the on state. |
| `SingalLampFlashing` | ComponentReference | - | Boolean PLC output signal that drives flashing; the field name preserves the Unity spelling. |
| `Intensity` | number | 2 | HDR emission intensity multiplier applied to OnColor. |
| `Flashing` | boolean | false | If true, the lamp flashes instead of remaining steadily lit. |
| `Period` | number | 1 | Flashing period in seconds, split evenly between on and off. |
| `LampOn` | boolean | false | Static on state used when no signal is bound. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `OnColor` | object | Unity Color `{r,g,b,a}` with floating-point channels from 0 to 1. |

```json
{ "Lamp": { "OnColor": { "r": 1, "g": 0.1, "b": 0, "a": 1 }, "Intensity": 2, "LampOn": true, "SignalLampOn": { "type": "ComponentReference", "path": "PLC/BeaconOn", "componentType": "PLCOutputBool" } } }
```

#### 7a.18 WebSensor

3D-HMI marker: visualizes a bool or int signal as Low/High/Warning/Error states.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalBool` | ComponentReference | - | Binary input: false = Low, true = High; use for 2-state sensors. |
| `SignalInt` | ComponentReference | - | Integer input: value mapped to a state via IntStateMap; use for sensors with more states. |
| `IntStateMap` | string | "" | Mapping of integer signal values to visual states, e.g. '0=Low;1=High;2=Warning;3=Error'. |
| `Label` | string | "" | Optional label shown in the tooltip and sensor list. |

```json
{ "WebSensor": { "Label": "Light barrier B4", "SignalBool": { "type": "ComponentReference", "path": "PLC/B4", "componentType": "PLCInputBool" } } }
```

#### 7a.19 WebSafetyDoor

3D-HMI marker: safety-door overlay with hazard-zone halo and label.

| Field | Type | Default | Description |
|---|---|---|---|
| `HazardZoneRadius` | number | 1500 | Hazard-zone halo radius in millimeters. |
| `LabelHeight` | number | 200 | Label position above the floor in millimeters. |

```json
{ "WebSafetyDoor": { "HazardZoneRadius": 2000 } }
```

#### 7a.20 WebError

3D-HMI marker: semantic error state bound to a bool signal.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalError` | ComponentReference | - | Error signal: true = error active, false = OK; leave empty for a static hint marker. |
| `ErrorText` | string | "" | Human-readable error message shown as 3D badge and in the message panel. |
| `HighlightStyle` | enum(Auto, FlashObject, Circle) | "Auto" | How the faulty part is highlighted: Auto (by part size), FlashObject or Circle. Writers MUST emit the named string; readers additionally accept the legacy integer index per the enumMap. |

```json
{ "WebError": { "ErrorText": "Motor overtemperature", "SignalError": { "type": "ComponentReference", "path": "PLC/MotorFault", "componentType": "PLCOutputBool" } } }
```

#### 7a.21 WebVisibility

3D-HMI marker: shows/hides the node (and additional targets) from a bool signal;
optionally carries an error state.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalVisible` | ComponentReference | - | Visibility signal: true = visible, false = hidden; leave empty to use DefaultVisible. |
| `InvertSignal` | boolean | false | If true the visibility signal logic is inverted (signal false = visible). |
| `DefaultVisible` | boolean | true | Visibility used when no visibility signal is bound. |
| `AdditionalTargets` | ComponentReference[] | [] | Optional additional objects (node references) that are shown/hidden together with this object. |
| `SignalError` | ComponentReference | - | Error signal: true = error active (red, flashing), false = OK; leave empty for no error state. |
| `ErrorText` | string | "" | Human-readable error message shown as 3D badge and in the message panel. |
| `HighlightStyle` | enum(Auto, FlashObject, Circle) | "Auto" | How the faulty part is highlighted: Auto (by part size), FlashObject or Circle. Writers MUST emit the named string; readers additionally accept the legacy integer index per the enumMap. |
| `BlinkSpeed` | number | 2 | Blink speed of the error highlight in Hz; higher is faster. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `ErrorColor` | object | Unity Color {r,g,b,a}, floats 0..1 |

```json
{ "WebVisibility": { "DefaultVisible": false, "SignalVisible": { "type": "ComponentReference", "path": "PLC/ShowGuard", "componentType": "PLCOutputBool" } } }
```

#### 7a.22 CustomRuntimeInstruction

3D-HMI marker: operator instruction bound to an activation signal.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | enum(Info, Maintenance, Warning, Error, Success) | "Info" | Instruction category (Info, Maintenance, Warning, Error, Success). Writers MUST emit the C# enum name; readers map it to the lowercase internal value and additionally accept the legacy integer index per the enumMap. |
| `dismissible` | boolean | true | If true the operator can dismiss the instruction via an OK/close button (offered on the last step only); once dismissed it reappears only on the next rising signal edge. |
| `Isolate` | boolean | false | realvirtual WEB only: when the operator clicks the message, the step's target objects are additionally isolated (rest of the scene dimmed) on top of the camera focus and highlight. |
| `signal` | ComponentReference | - | Activation signal; the instruction is shown while the signal is true. |
| `BlinkSpeed` | number | 2 | Blink speed of the attention highlight in Hz. 0 = no blinking, the part is only highlighted; higher = faster. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `steps` | array | Array of { instruction, targetObject (node path), url } |
| `UseCustomErrorColor` | boolean | Enables `ErrorColor` |
| `ErrorColor` | object | Unity Color {r,g,b,a}, floats 0..1 |

```json
{ "CustomRuntimeInstruction": { "type": "Maintenance", "dismissible": true } }
```

#### 7a.23 RuntimeMetadata

Tooltip/annotation content for an object.

| Field | Type | Default | Description |
|---|---|---|---|
| `content` | string | "" | XML-like annotation markup shown as tooltip content for the object. |

```json
{ "RuntimeMetadata": { "content": "<b>SEW motor</b> KA77 DRN90L4" } }
```

#### 7a.24 IKPath

Robot inverse-kinematics path: ordered IKTarget references with start/end signals.

| Field | Type | Default | Description |
|---|---|---|---|
| `SpeedOverride` | number | 1 | Speed override factor for this path. |
| `SetNewTCP` | boolean | false | Sets a new TCP (tool center point) for this path. |
| `DrawPath` | boolean | true | Draws the path in the scene view. |
| `DrawTargets` | boolean | true | Draws the targets in the scene view. |
| `DebugPath` | boolean | false | Debugs the path by drawing points. |
| `DebugBlending` | boolean | false | Logs detailed blending state transitions for debugging. |
| `StartPath` | boolean | false | Starts the path on simulation start. |
| `LoopPath` | boolean | false | Loops the path after it has ended. |
| `SignalStart` | ComponentReference | - | Signal to start the path. |
| `SignalIsStarted` | ComponentReference | - | Signal that the path is started. |
| `SignalEnded` | ComponentReference | - | Signal that the path has ended. |
| `Path` | ComponentReference[] | - | Ordered list of IKTarget references forming the path. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `StartNextPath` | object | ComponentReference to the IKPath started when this path ends |

```json
{ "IKPath": { "LoopPath": true, "Path": [ { "type": "ComponentReference", "path": "Robot/Targets/Pick", "componentType": "IKTarget" } ] } }
```

#### 7a.25 IKTarget

Robot inverse-kinematics target: pose, interpolation, blending and pick/place settings.

| Field | Type | Default | Description |
|---|---|---|---|
| `FollowInEditMode` | boolean | true | If true the target follows the robot in edit mode. |
| `SpeedToTarget` | number | 1 | Speed to target as a factor of the axis speeds. |
| `LinearAcceleration` | number | 100 | Linear acceleration in millimeters per second squared. |
| `InterpolationToTarget` | enum(PointToPoint, PointToPointUnsynced, Linear) | "PointToPoint" | Interpolation to the target: PointToPoint, PointToPointUnsynced or Linear. |
| `LinearSpeedToTarget` | number | 500 | Linear speed to the target in millimeters per second. |
| `TurnCorrection` | boolean | false | If true the robot applies the 180-degree turn correction of axes 4 and 6. |
| `SetSignalDuration` | number | 0.5 | Duration of the set signal in seconds. |
| `WaitForSeconds` | number | 0 | Wait time in seconds after the target is reached. |
| `PickAndPlace` | boolean | false | Enables pick/place handling at this target. |
| `Pick` | boolean | false | Picks with the assigned grip when the target is reached. |
| `Place` | boolean | false | Places with the assigned grip when the target is reached. |
| `EnableBlending` | boolean | false | Enables zone blending: the robot transitions to the next target at BlendRadius distance instead of stopping exactly at this target. |
| `BlendRadius` | number | 25 | Radius in millimeters of the blending zone around this target. |
| `SetSignal` | ComponentReference | - | Signal set when the target is reached. |
| `WaitForSignal` | ComponentReference | - | Signal to wait for after the target is reached. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `AxisPos` | array | Pre-computed joint-angle solution (number[6], degrees) |
| `gripTarget` | object | ComponentReference to the Grip used for pick/place |
| `fixer` | object | ComponentReference to a Fixer (fallback when `gripTarget` absent) |

```json
{ "IKTarget": { "InterpolationToTarget": "Linear", "LinearSpeedToTarget": 300, "EnableBlending": true, "BlendRadius": 50 } }
```

#### 7a.26 RobotIK

Robot inverse-kinematics solver configuration on the robot root node.

| Field | Type | Default | Description |
|---|---|---|---|
| `WristType` | enum(Spherical, NonSpherical) | "Spherical" | Wrist topology: Spherical (standard industrial robot, analytical solution) or NonSpherical (cobot with wrist offsets). |
| `ElbowInUnityX` | boolean | false | If true the elbow axis is oriented along Unity X. |
| `DrawGizmos` | boolean | true | Draws IK debug gizmos. |

```json
{ "RobotIK": { "WristType": "Spherical" } }
```

#### 7a.27 CADLink

Pure metadata on an imported CAD root: original file reference plus import parameters.

| Field | Type | Default | Description |
|---|---|---|---|
| `File` | string | "" | Original CAD file name this subtree was imported from. |
| `Sha256` | string | "" | Content hash of the original CAD file. |
| `Quality` | string | "standard" | Tessellation quality preset used at import. |
| `ImportScaleFactor` | number | 0.001 | Scale factor applied at import (CAD units to meters). |
| `ZIsUpVector` | boolean | true | If true the CAD source used Z-up orientation. |

```json
{ "CADLink": { "File": "gripper-v3.step", "Sha256": "9f2c...", "Quality": "standard" } }
```

#### 7a.36 JTData

CAD metadata read from a JT file by the rv-jt reader. Pure import provenance: read-only, never
hand-edited, and replaced (not merged) on CAD re-import. Every field is optional — the reader
omits what the source file does not provide rather than emitting `0` or `null`, so a block
carrying only `ContractVersion` and `Layer` is normal.

| Field | Type | Default | Description |
|---|---|---|---|
| `ContractVersion` | number | - | Version of the JTData contract this block was written with. |
| `PartName` | string | - | Part name from the CAD system (CAD_PARTNAME). |
| `Mass` | number | - | Mass of the part. The unit is not recorded in JT files and is therefore unknown. |
| `MassSource` | string | - | Where the mass came from: 'asserted' (user-set, assembly level) or 'cad' (computed, part level). These describe different objects and must not be summed. |
| `SourceUnits` | string | - | Length unit of the source model, raw - before the mm to m conversion the reader applies. |
| `Layer` | string | - | CAD layer of the part. |
| `BodyUid` | string | - | Stable per-body CAD uid, suitable for matching a part across revisions. |

```json
{ "JTData": { "ContractVersion": 1, "PartName": "3-linear unit", "Mass": 210.944769, "MassSource": "cad", "SourceUnits": "millimeters", "Layer": "1" } }
```

#### 7a.28 Pipe

Process-industry pipe segment for the 3D-HMI tooltip and fluid-network topology.

| Field | Type | Default | Description |
|---|---|---|---|
| `resourceName` | string | "" | Name of the fluid/resource flowing through the pipe. |
| `flowRate` | number | 0 | Current flow rate through the pipe. |
| `source` | ComponentReference | - | Reference to the upstream component (tank, pump or pipe). |
| `destination` | ComponentReference | - | Reference to the downstream component (tank, pump or pipe). |
| `uvDirection` | number | 1 | Texture flow-animation direction (+1/-1). |
| `circuitId` | number | -1 | Fluid-circuit grouping id; -1 = unassigned. |
| `pressure` | number | 0 | Gauge pressure in bar. |
| `temperatureC` | number | 0 | Fluid temperature in degrees Celsius. |
| `velocityMs` | number | 0 | Flow velocity in meters per second. |
| `dnSize` | number | 0 | Nominal pipe diameter (DN), e.g. 50, 100, 200. |

```json
{ "Pipe": { "resourceName": "Cooling water", "flowRate": 12.5, "dnSize": 50 } }
```

#### 7a.29 Pump

Process-industry pump with instrumentation values for the 3D-HMI tooltip.

| Field | Type | Default | Description |
|---|---|---|---|
| `flowRate` | number | 0 | Current flow rate delivered by the pump. |
| `pipe` | ComponentReference | - | Reference to the connected pipe. |
| `circuitId` | number | -1 | Fluid-circuit grouping id; -1 = unassigned. |
| `resourceName` | string | "" | Medium currently flowing through the pump. |
| `state` | string | "ok" | Pump state: 'ok', 'warning' or 'fault'. |
| `suctionPressure` | number | 0 | Suction-side gauge pressure in bar. |
| `dischargePressure` | number | 0 | Discharge-side gauge pressure in bar. |
| `speedRpm` | number | 0 | Motor speed in revolutions per minute. |
| `speedPercent` | number | 0 | VFD speed command in percent (0..100). |
| `powerKw` | number | 0 | Shaft power in kilowatts. |
| `currentA` | number | 0 | Motor current in amperes. |
| `bearingTempC` | number | 0 | Bearing temperature in degrees Celsius. |
| `motorTempC` | number | 0 | Motor temperature in degrees Celsius. |
| `vibrationMmS` | number | 0 | Vibration velocity in mm/s RMS (ISO 10816). |
| `npshAvailable` | number | 0 | Net positive suction head available in meters. |
| `npshRequired` | number | 0 | Net positive suction head required in meters. |
| `runHours` | number | 0 | Total operating hours. |

```json
{ "Pump": { "state": "ok", "speedRpm": 1450, "powerKw": 7.5 } }
```

#### 7a.30 ResourceTank

Process-industry tank with fill level and instrumentation values.

| Field | Type | Default | Description |
|---|---|---|---|
| `resourceName` | string | "" | Name of the stored fluid/resource. |
| `capacity` | number | 0 | Tank capacity. |
| `amount` | number | 0 | Current fill amount. |
| `pressure` | number | 0 | Gauge pressure in bar. |
| `temperature` | number | 0 | Fluid temperature in degrees Celsius. |
| `density` | number | 0 | Fluid density in kilograms per cubic meter. |
| `ph` | number | 0 | pH value; 0 = not measured. |
| `agitatorOn` | boolean | false | True while the mixer/agitator is running. |
| `heatingOn` | boolean | false | True while the jacket heater is on. |
| `tempHighLimit` | number | 0 | High temperature alarm limit in degrees Celsius; 0 = no alarm. |
| `tempLowLimit` | number | 0 | Low temperature alarm limit in degrees Celsius; 0 = no alarm. |
| `pressureHighLimit` | number | 0 | High pressure alarm limit in bar; 0 = no alarm. |

```json
{ "ResourceTank": { "resourceName": "Base resin", "capacity": 5000, "amount": 3250 } }
```

#### 7a.31 ProcessingUnit

Production machine/station with OEE and production telemetry.

| Field | Type | Default | Description |
|---|---|---|---|
| `connections` | ComponentReference[] | - | References to connected upstream/downstream components. |
| `state` | string | "idle" | Machine state: 'running', 'idle', 'down', 'setup' or 'maintenance'. |
| `availability` | number | 0 | OEE availability factor (0..1). |
| `performance` | number | 0 | OEE performance factor (0..1). |
| `quality` | number | 0 | OEE quality factor (0..1). |
| `cycleTimeS` | number | 0 | Current actual cycle time in seconds. |
| `cycleTargetS` | number | 0 | Target (ideal) cycle time in seconds. |
| `throughputPerHour` | number | 0 | Throughput in units per hour. |
| `goodCount` | number | 0 | Good units produced shift-to-date. |
| `scrapCount` | number | 0 | Scrap units produced shift-to-date. |
| `mtbfHours` | number | 0 | Mean time between failures in hours. |
| `mttrMinutes` | number | 0 | Mean time to repair in minutes. |
| `runHours` | number | 0 | Run time in hours this period. |
| `downHours` | number | 0 | Down time in hours this period. |
| `lastFault` | string | "" | Description of the last fault. |

```json
{ "ProcessingUnit": { "state": "running", "availability": 0.92, "performance": 0.88, "quality": 0.99 } }
```

#### 7a.32 WebComponent

JavaScript behavior component stored in the GLB: sandboxed script following the
global `setup(self)` contract, executed by the viewer's QuickJS runtime. Script
execution is gated per model (trust gate): a conforming viewer MUST NOT execute
`Code` from an untrusted file without explicit user consent. An empty `Code`
creates no VM; the component stays inactive but remains editable.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | boolean | true | If false the component is parsed but never executed. |
| `ApiVersion` | number | 1 | Component-SDK contract version the code was written against. |
| `Language` | string | "js" | Source language of Code; stored code is always conservative JavaScript. |
| `DesSafe` | boolean | false | Author claim that the script uses only event-driven primitives (checked by the DES lint). |
| `TypeId` | string | "" | Library/type identity for reuse, inspector display and statistics. |
| `Code` | string | "" | JavaScript source following the global setup(self) contract; empty means no VM is created. |

```json
{ "WebComponent": { "Active": true, "ApiVersion": 1, "TypeId": "Gate", "Code": "function setup(self){ return { continuous: {} }; }" } }
```

#### 7a.33 WebDiagnostics

3D-HMI marker: couples a PLC error signal to the AI error diagnosis. A rising
edge of `SignalBool` (or a change of `SignalInt` to a non-zero value) raises a
diagnose request for this node; the falling edge (or `SignalInt` returning to
0) clears it. Without a bound signal the marker is inactive.

| Field | Type | Default | Description |
|---|---|---|---|
| `SignalBool` | ComponentReference | - | Error signal: rising edge (false to true) triggers the diagnosis; falling edge clears it. |
| `SignalInt` | ComponentReference | - | Error-code signal: any change to a non-zero value triggers the diagnosis with that code; 0 clears it. |
| `DocFilter` | string | "" | Metadata filter passed to the diagnosis backend (machine, component or error-code range). |
| `ErrorId` | string | "" | Stable error ID used as the key for the shared operator comment store; defaults to the node path. |
| `Label` | string | "" | Optional human-readable label shown on the diagnosis card. |
| `AutoOpen` | boolean | true | If true the diagnosis dialog opens automatically on a rising edge; if false only the card is shown. |

```json
{ "WebDiagnostics": { "Label": "Axis 2 overload", "ErrorId": "SYST-320", "DocFilter": "crx-manual", "SignalInt": { "type": "ComponentReference", "path": "PLC/ErrorCode", "componentType": "PLCOutputInt" } } }
```

#### 7a.34 Path

WebViewer-native arc-length-parametrised path (plan-268) for path-based
movement (AGV/FTS, overhead conveyors): an ordered chain of line/arc segments
plus id-based graph chaining. Detection is coupled to this payload (`type`
`"Path"` or absent), never to node names. The structured fields are parsed by
`parsePathExtras()` in `src/core/engine/rv-path.ts` — that module is the
executable TS-SSOT for the segment grammar; the JSON spec lists the scalar
fields and documents the structure here.

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | number | 1 | Path schema version (migration anchor). Unknown versions parse best-effort with a warning. |
| `closed` | boolean | false | Circulating path (loop): arc-length addresses wrap modulo length. |

Structured fields (parsed by the TS-SSOT, not part of the scalar $def
properties above):

| Structured field | Shape | Default | Description |
|---|---|---|---|
| `type` | string | "Path" | Payload discriminator; a foreign value rejects the payload. |
| `id` | string | node name | Stable path id used by `successors` graph edges. |
| `segments` | array | [] | Segment chain: `{ "kind": "line", "from": [x,y,z], "to": [x,y,z] }` or `{ "kind": "arc", "center": [x,y,z], "radius": r, "startAngle": deg, "degrees": deg, "clockwise": bool?, "plane": "XZ"\|"XY"\|"YZ"? }`. Unknown kinds are skipped; unknown planes fall back to `"XZ"`. |
| `successors` | string[] | [] | Ids of successor paths (junction candidates); dangling ids are tolerated. |
| `align` | [x,y,z] | [0,1,0] | Up vector for the carrier pose (`lookRotation(tangent, align)`). |

```json
{ "Path": { "type": "Path", "version": 1, "segments": [ { "kind": "line", "from": [0,0,0], "to": [0,0,5] }, { "kind": "arc", "center": [-2,0,5], "radius": 2, "startAngle": 0, "degrees": 90, "plane": "XZ" } ], "closed": false, "successors": ["Route-B"], "align": [0,1,0] } }
```

#### 7a.35 WebPhysicsZone

Physics zone: 3D box volume inside which MUs are simulated as free dynamic
rigid bodies (falling, sliding, tipping, stacking in bins). Strictly opt-in —
without this component no physics engine is loaded. The zone volume comes from
the node's `BoxCollider` extras (Section 7d.4); with `WholeScene` the scene
bounding box is used instead. Not to be confused with AGV path zones
(`Path.zone`, routing capacity) — a physics zone is a spatial 3D volume.

| Field | Type | Default | Description |
|---|---|---|---|
| `ZoneEnabled` | boolean | true | Enables physics simulation inside this zone. |
| `WholeScene` | boolean | false | If true the box volume is ignored and the whole scene bounding box becomes the physics zone. |
| `Friction` | number | 0.8 | Default friction coefficient for MUs inside the zone. |
| `Restitution` | number | 0 | Bounciness of MUs inside the zone (0 = none). |
| `RemoveBelowY` | number | -10 | MUs falling below this world Y (meters) are removed. |
| `ShowGizmo` | boolean | true | Shows the zone as a wireframe box in the viewer. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `StaticColliders` | array | Node paths (strings) of additional static collision geometry (chutes, bins, machine frames); resolved via the node registry, read raw |

```json
{ "WebPhysicsZone": { "ZoneEnabled": true, "Friction": 0.8, "StaticColliders": ["Container/WallLeft"] }, "BoxCollider": { "center": { "x": 0, "y": 0, "z": 0 }, "size": { "x": 1.5, "y": 1.5, "z": 2.5 } } }
```

#### 7a.37 EnergyChain

Energy chain (cable carrier / drag chain): turns a rigid CAD chain mesh into an
animated one — straight strand, half-circle bend, straight strand, with the bend
travelling at exactly half the follower speed and the chain length constant.
Drive axis, bend radius, link height and chain length are MEASURED from the CAD
rest pose; every numeric field left at `0` keeps auto-calibrating. `Anchor` and
`Follower` are node references: Unity `public Transform` fields, so their wire
`componentType` is `UnityEngine.Transform` (a missing/empty `componentType` is
accepted for legacy exports; any other non-empty value stays unresolved).
If calibration or the follower assignment fails, the chain holds its rest pose
and reports the reason — it is never worse than an unrigged part.

| Field | Type | Default | Description |
|---|---|---|---|
| `Anchor` | ComponentReference | - | Node the fixed chain end is attached to; empty = auto. Read-only in the inspector, corrected via `web_editor_set_field`. |
| `Follower` | ComponentReference | - | Node the moving chain end (the carrier) is attached to; empty = auto. Same correction path as `Anchor`. |
| `BendRadius` | number | 0 | Centerline bend radius in millimeters; 0 measures it from the rest pose. |
| `ChainLength` | number | 0 | Total centerline length in millimeters; 0 measures it from the rest pose. |
| `Axis` | enum(Auto, X, Y, Z) | "Auto" | Travel axis in the chain-local frame; Auto takes the longest AABB extent. |
| `BendUp` | boolean | true | Moving strand runs above the fixed one; flip when the measured assignment is upside down. |
| `Bones` | number | 24 | Bone count of the runtime rig, clamped up to the minimum derived from the 15 degree per-joint linear-blend-skinning limit (21). |
| `Enabled` | boolean | true | Animates the chain; off leaves it in the CAD rest pose. |

```json
{ "EnergyChain": { "Follower": { "type": "ComponentReference", "path": "Portal/AxisLeft_Z", "componentType": "UnityEngine.Transform" }, "BendRadius": 0, "ChainLength": 0, "Axis": "Auto", "Bones": 24 } }
```

#### 7a.38 CollisionRole

Assigns a collision role to a node. The role covers the node's whole subtree
down to the next descendant that carries a role of its own (a robot's role ends
at its gripper). While the simulation runs, bodies of **different** roles are
checked against each other — first by their per-tick world AABB, then exactly
triangle against triangle. Identical roles never collide, `None` takes part in
no check at all, and a body is never checked against a body nested inside it.

| Field | Type | Default | Description |
|---|---|---|---|
| `CollisionRole` | enum(None, Tool, Workpiece, Machine, Robot, Environment) | "None" | Collision role of this node's subtree; `None` excludes the node from every collision check. |

```json
{ "CollisionRole": { "CollisionRole": "Robot" } }
```

### 7b. Logic Steps

Logic steps describe sequential control logic. A node carrying a `LogicStep_*`
component is one step; **hierarchy order defines execution order** inside a
container. The top-level `LogicStep_SerialContainer` loops automatically. The
`Active` field on every step is an `ActiveOnly` gate (Section 7c table footnote):
`enum(Always, Connected, Disconnected, Never, DontChange)`, default `"Always"`.

Steps marked "MAY be a no-op" have Unity-only semantics; a web runtime is
conforming when it treats them as zero-duration steps.

#### 7b.1 LogicStep_SerialContainer

Sequential container — children execute one after another.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.2 LogicStep_ParallelContainer

Parallel container — children execute concurrently; ends when all children ended.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.3 LogicStep_SetSignalBool

| Field | Type | Default | Description |
|---|---|---|---|
| `Signal` | ComponentReference | - | Bool signal to set. |
| `SetToTrue` | boolean | true | Value written to the signal. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.4 LogicStep_WaitForSignalBool

| Field | Type | Default | Description |
|---|---|---|---|
| `Signal` | ComponentReference | - | Bool signal to wait for. |
| `WaitForTrue` | boolean | true | Expected signal value. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.5 LogicStep_WaitForSensor

| Field | Type | Default | Description |
|---|---|---|---|
| `Sensor` | ComponentReference | - | Sensor to wait for. |
| `WaitForOccupied` | boolean | true | If true waits for occupied, otherwise for not occupied. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.6 LogicStep_Delay

| Field | Type | Default | Description |
|---|---|---|---|
| `Duration` | number | 1 | Wait duration in seconds. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.7 LogicStep_DriveToPosition

Drives a Drive to a destination and waits for arrival.

| Field | Type | Default | Description |
|---|---|---|---|
| `drive` | ComponentReference | - | Drive to move. |
| `Destination` | number | 0 | Destination position in millimeters or degrees. |
| `Relative` | boolean | false | If true Destination is relative to the current position. |
| `Direction` | string | - | Reserved; consumed for parity, not evaluated by the v1 reference implementation. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.8 LogicStep_DriveTo

Same semantics as LogicStep_DriveToPosition.

| Field | Type | Default | Description |
|---|---|---|---|
| `drive` | ComponentReference | - | Drive to move. |
| `Destination` | number | 0 | Destination position in millimeters or degrees. |
| `Relative` | boolean | false | If true Destination is relative to the current position. |
| `Direction` | string | - | Reserved; consumed for parity, not evaluated by the v1 reference implementation. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.9 LogicStep_StartDriveTo

Starts the motion without waiting for arrival.

| Field | Type | Default | Description |
|---|---|---|---|
| `drive` | ComponentReference | - | Drive to start. |
| `Destination` | number | 0 | Destination position in millimeters or degrees. |
| `Relative` | boolean | false | If true Destination is relative to the current position. |
| `Direction` | string | - | Reserved; consumed for parity, not evaluated by the v1 reference implementation. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.10 LogicStep_SetDriveSpeed

| Field | Type | Default | Description |
|---|---|---|---|
| `drive` | ComponentReference | - | Drive whose target speed is set. |
| `Speed` | number | 100 | Target speed in millimeters per second. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.11 LogicStep_StartDriveSpeed

| Field | Type | Default | Description |
|---|---|---|---|
| `drive` | ComponentReference | - | Drive to start. |
| `Speed` | number | 100 | Target speed in millimeters per second. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.12 LogicStep_WaitForDrivesAtTarget

| Field | Type | Default | Description |
|---|---|---|---|
| `Drives` | ComponentReference[] | - | Drives that must all reach their targets. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.13 LogicStep_Enable

Shows/hides a target object.

| Field | Type | Default | Description |
|---|---|---|---|
| `Target` | string | "" | Scene path of the object to enable/disable. |
| `Enable` | boolean | true | If true the target is enabled (shown), otherwise disabled (hidden). |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.14 LogicStep_Pause

Debugging breakpoint. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.15 LogicStep_SetSignalFloat

| Field | Type | Default | Description |
|---|---|---|---|
| `Signal` | ComponentReference | - | Float signal to set. |
| `Value` | number | 0 | Value written to the signal. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.16 LogicStep_WaitForSignalFloat

| Field | Type | Default | Description |
|---|---|---|---|
| `Signal` | ComponentReference | - | Float signal to wait for. |
| `Comparison` | string | "Equals" | Comparison operator name (e.g. Equals, Greater, Smaller). |
| `Value` | number | 0 | Comparison value. |
| `Tolerance` | number | 0.0001 | Tolerance for the Equals comparison. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.17 LogicStep_GripPick

| Field | Type | Default | Description |
|---|---|---|---|
| `Grip` | ComponentReference | - | Grip that picks. |
| `Blocking` | boolean | false | If true the step waits until the pick completed. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.18 LogicStep_GripPlace

| Field | Type | Default | Description |
|---|---|---|---|
| `Grip` | ComponentReference | - | Grip that places. |
| `Blocking` | boolean | false | If true the step waits until the place completed. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.19 LogicStep_JumpOnSignal

Jumps to a named step in the parent container when the signal matches.

| Field | Type | Default | Description |
|---|---|---|---|
| `Signal` | ComponentReference | - | Bool signal evaluated for the jump. |
| `JumpOn` | boolean | true | Signal value that triggers the jump. |
| `JumpToStep` | string | "" | Step (node) name inside the parent container to jump to. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.20 LogicStep_IKPath

Starts an IKPath and waits until it ended.

| Field | Type | Default | Description |
|---|---|---|---|
| `IKPath` | ComponentReference | - | IKPath to start; the step waits until the path ended. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.21 LogicStep_SetActiveOnly

MAY be a no-op in web runtimes.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.22 LogicStep_CinemachineCamera

Unity-only camera activation. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.23 LogicStep_StatStartCycle

Statistics cycle start. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.24 LogicStep_StatEndCycle

Statistics cycle end. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.25 LogicStep_StatState

Statistics state set. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.26 LogicStep_StatOutput

Statistics output increment. MAY be a no-op.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

### 7c. PLC Signals

Signal nodes carry exactly one of the six PLC signal types. The signal's identity
is its scene path; `Name` (when non-empty) is the display/logical name. All six
types share the same field set. Signal direction follows the PLC convention:
`PLCOutput*` is written by the PLC and read by the twin, `PLCInput*` is written by
the twin and read by the PLC.

`ActiveOnly` (the type of every `Active` field in this specification) is
`enum(Always, Connected, Disconnected, Never, DontChange)` with default `"Always"`
— see `#/$defs/ActiveOnly`.

#### 7c.1 PLCOutputBool

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

#### 7c.2 PLCInputBool

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

#### 7c.3 PLCOutputFloat

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

#### 7c.4 PLCInputFloat

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

#### 7c.5 PLCOutputInt

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

#### 7c.6 PLCInputInt

| Field | Type | Default | Description |
|---|---|---|---|
| `Name` | string | "" | Signal name; falls back to the node name when empty. |
| `Comment` | string | "" | Human-readable comment shown in signal tooltips. |
| `OriginDataType` | string | "" | Original PLC data type of the signal (e.g. BOOL, DINT, REAL). |
| `Settings` | object | - | Writer-specific signal settings object (e.g. { Active, Override }). |
| `Metadata` | object | - | Free-form protocol metadata object. |
| `Active` | ActiveOnly | - | Connection-state gate for the signal. |
| `Status` | object | - | Runtime status object; Status.Value seeds the initial signal value. |

### 7d. Scene & Structure

#### 7d.1 Group

Named group membership. A node MAY belong to several groups; writers serialize
additional memberships under the keys `Group1`, `Group2`, ... with the same shape.

| Field | Type | Default | Description |
|---|---|---|---|
| `GroupName` | string | "Group" | Name of the group this node belongs to. |
| `GroupNamePrefix` | string | - | Scene path of a node whose name prefixes GroupName (resolved group name = prefixNode.name + GroupName). Shown when present in the GLB, never stamped on newly authored components. |

#### 7d.2 Kinematic

Post-load re-structuring directive from the Unity Kinematic tool.

| Field | Type | Default | Description |
|---|---|---|---|
| `IntegrateGroupEnable` | boolean | false | If true, top-level members of the named group are re-parented under this node after load. |
| `GroupName` | string | "" | Group whose members are re-parented under this node. |
| `GroupNamePrefix` | string | "" | Scene path of a prefix node (resolved group name = prefixNode.name + GroupName). |
| `SimplifyHierarchy` | boolean | false | If true only mesh nodes of the group are re-parented. |
| `KinematicParentEnable` | boolean | false | If true this node is re-parented under Parent after load. |
| `Parent` | string | "" | Scene path of the new parent node. |

#### 7d.3 MU

Movable Unit template marker: the marked node is the template that `Source`
components clone. Carries no consumed configuration fields in v1.

#### 7d.4 BoxCollider

Axis-aligned collider volume in node-local space (sensors, transport surfaces,
sources, sinks).

| Field | Type | Default | Description |
|---|---|---|---|
| `center` | Vector3 | - | Collider center in Unity node-local coordinates (readers negate X in glTF space). |
| `size` | Vector3 | - | Absolute box dimensions in node-local units (no coordinate flip). |

#### 7d.5 LayoutObject

Layout-planner marker on a placed library object.

| Field | Type | Default | Description |
|---|---|---|---|
| `Label` | string | "" | Display label of the placed object. |
| `CatalogId` | string | "" | Library catalog id the object was placed from. |
| `Locked` | boolean | false | If true the object is locked against layout edits. |
| `Visible` | boolean | true | Visibility of the placed object. |

#### 7d.6 Splat

Gaussian-splat placement settings.

| Field | Type | Default | Description |
|---|---|---|---|
| `InvertX` | boolean | false | Inverts the splat along X. |
| `InvertY` | boolean | false | Inverts the splat along Y. |
| `InvertZ` | boolean | false | Inverts the splat along Z. |
| `CropMinX` | number | -1000 | Local-frame crop box minimum X; splats outside the box are culled. |
| `CropMaxX` | number | 1000 | Local-frame crop box maximum X. |
| `CropMinY` | number | -1000 | Local-frame crop box minimum Y (raise to hide floor noise). |
| `CropMaxY` | number | 1000 | Local-frame crop box maximum Y (lower to hide ceilings). |
| `CropMinZ` | number | -1000 | Local-frame crop box minimum Z. |
| `CropMaxZ` | number | 1000 | Local-frame crop box maximum Z. |

#### 7d.7 AASLink

Asset Administration Shell link.

| Field | Type | Default | Description |
|---|---|---|---|
| `AASId` | string | "" | AAS identifier (e.g. 'http://smart.festo.com/aas/9992020...'). |
| `Description` | string | "" | Optional description shown in the tooltip header. |
| `ServerUrl` | string | "" | Optional AAS server URL; when empty the AASX is loaded from the local aasx/ folder. |

### 7e. Recording

#### 7e.1 DrivesRecorder

Playback settings for a recorded drive sequence.

| Field | Type | Default | Description |
|---|---|---|---|
| `PlayOnStart` | boolean | true | If true playback starts automatically on simulation start. |
| `ReplayStartFrame` | number | 0 | First frame of the replay range. |
| `ReplayEndFrame` | number | 0 | Last frame of the replay range; 0 = to end. |
| `Loop` | boolean | false | If true the replay loops. |
| `DrivesRecording` | object | - | Inline recording data (Unity ScriptableObject serialization). |
| `Active` | ActiveOnly | - | Connection-state gate: controls playback in connected/disconnected mode. |

#### 7e.2 DrivesRecording_compact

Compact drive recording: `positions[frame * driveCount + driveIndex]`.

| Field | Type | Default | Description |
|---|---|---|---|
| `fixedDeltaTime` | number | 0.02 | Fixed timestep of the recording in seconds. |
| `numberFrames` | number | 0 | Number of recorded frames. |
| `driveCount` | number | 0 | Number of recorded drives. |
| `drives` | object[] | - | Array of { id, path } drive descriptors. |
| `sequences` | object[] | - | Optional array of { name, startFrame, endFrame } named sequences. |
| `positions` | number[] | - | Flat drive positions array indexed as positions[frame * driveCount + driveIndex]. |

#### 7e.3 ReplayRecording

Signal-triggered replay of a named sequence.

| Field | Type | Default | Description |
|---|---|---|---|
| `Sequence` | string | "" | Name of the sequence inside the recording to replay. |
| `StartOnSignal` | ComponentReference | - | Bool signal that starts the replay on a rising edge. |
| `IsReplayingSignal` | ComponentReference | - | Bool signal set true while the replay is running. |
| `Active` | ActiveOnly | - | Connection-state gate: controls replay in connected/disconnected mode. |

### 7f. Reserved

- **`Drive_CAM`** — present in Unity exports; not yet consumed by the reference
  implementation. Reserved for a future minor version; readers MUST ignore it.

### 7g. Connections

Typed, directed connections between components. A connection is a named
**bidirectional call**: the source invokes the target with request parameters,
the target answers — usually deferred through a reply handle — with response
parameters. Edges are stored as a flat list (serialization truth); readers
build any adjacency index at runtime. Readers MUST ignore a missing
`Connections` block (older assets load unchanged) and MUST treat edges whose
`source`/`target` paths do not resolve as inactive.

Built-in, engine-semantic types (currently `StopOnExit`) are registered in
reader code and need no `connectionTypes` entry. `StopOnExit` links a sensor
(source) to a station (target): an MU reaching the sensor is stopped — on an
accumulating transport surface as a single-MU hold (the belt keeps running),
otherwise (or for instanced MUs) by stopping the surface's drive — handed to
the station as a reference (`onArrival(mu)`) and released with `mu.release()`.

Note: the top-level `Connections` block is distinct from the
`ProcessingUnit.connections` component property (pipe network fan-in/out) —
the names collide, the data does not.

#### 7g.1 Connections

Scene-level container, typically carried on the root node.

| Field | Type | Default | Description |
|---|---|---|---|
| `connections` | array | - | Flat edge list (RvConnection records). 1:n fan-out/fan-in via repeated source/target paths. |
| `connectionTypes` | array | - | User-defined connection type signatures (ConnectionType records). |

#### 7g.2 RvConnection

One directed connection edge.

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | - | Stable edge id, unique within the scene. |
| `source` | string | - | Slash-separated node path of the source (caller) end. |
| `target` | string | - | Slash-separated node path of the target (callee) end. |
| `type` | string | - | Connection type name — built-in (StopOnExit) or user-defined via connectionTypes. |
| `config` | object | - | Type-specific per-edge configuration, e.g. `{ "ProcessTime": 3.0 }` for StopOnExit. |

#### 7g.3 ConnectionType

User-defined connection type signature — makes a GLB self-describing: the
viewer renders typed inspector fields and validates call parameters without
any code. Parameter wire types are `bool`, `int`, `float`, `string`.

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | string | - | Type name referenced by RvConnection.type. |
| `request` | object | - | Request parameter schema: parameter name to wire type (bool, int, float, string). |
| `response` | object | - | Response parameter schema: parameter name to wire type (bool, int, float, string). |

## 8. Vocabulary (Custom Keywords)

`rv-odt.json` uses the following custom keywords beyond JSON Schema 2020-12.
Generic JSON Schema validators MUST ignore unknown keywords, so rv-odt.json remains
a valid 2020-12 schema.

Property `description` texts are **informative**: they are maintained in
`rv-odt.json` (the single source for inspector tooltips, add-ons and third-party
tools) and mirrored into the Section-7 tables of this document.

- **`unit`** *(string, OPTIONAL, on number properties)* — [UCUM](https://ucum.org/)-conformant
  unit code (e.g. `mm`, `mm/s`, `s`, `Hz`, `bar`, `Cel`). Documentation-only;
  validators MUST ignore it. Readers MUST NOT perform unit conversion based on it.
- **`unityCoords`** *(boolean, OPTIONAL, on properties with `$ref: "#/$defs/Vector3"`)* —
  When `true`, the vector is serialized in Unity left-handed coordinates and a
  conforming reader operating in glTF right-handed space MUST negate the X
  component when applying the value.
- **`aliases`** *(object, OPTIONAL, top-level on a component `$def`)* — Maps a primary
  field name to an array of legacy field names. When the primary field is absent in
  the data but a legacy alias is present, a conforming reader SHOULD read the value
  from the alias. Writers MUST emit only the primary field name.
- **`enumMap`** *(object, OPTIONAL, on enum properties)* — Complete map of accepted
  wire strings to reader-internal values, including legacy integer indices
  serialized as strings. When absent, the mapping is the identity over the `enum`
  array. Writers MUST emit only canonical `enum` values.
- **`signal`** *(string, OPTIONAL, on ComponentReference properties)* — Declares the
  slot as a standard PLC signal of the given type (`PLCOutputBool`, `PLCInputFloat`,
  ...). A conforming runtime SHOULD auto-provision an unwired slot as a signal named
  `<node>/Signals/<slot>`.
- **`readonly`** *(boolean, OPTIONAL)* — The field is informational; interactive
  tools SHOULD display it but MUST NOT offer editing.
- **`rawFields`** *(object, OPTIONAL, top-level on a component `$def`)* — Documents
  fields that the reference implementation consumes OUTSIDE the schema mapper
  (e.g. nested object lists, colors, pre-computed solver arrays, legacy hints).
  They are part of the wire format but carry no `default`/coercion semantics;
  readers MAY consume them and MUST tolerate their absence. Documentation-only for
  validators.
- **`deprecated`** *(object, OPTIONAL, on properties)* — `{ "since": "<semver>",
  "replacedBy": "<fieldName>" }`. Documentation-only; for actual field migration use
  `aliases`. (No field is deprecated in v1.0.)

## 9. Conformance

### 9.1 Conforming writer

A conforming writer:

1. MUST emit component data only under `node.extras.realvirtual`.
2. MUST emit field values that validate against the component `$def` in `rv-odt.json`.
3. MUST emit enum values as canonical strings from the `enum` array.
4. MUST emit primary field names (never aliases).
5. SHOULD stamp `_formatVersion: "1.0"` at the root of `extras.realvirtual`.
6. SHOULD omit fields whose value equals the declared default.

### 9.2 Conforming reader

A conforming reader:

1. MUST apply declared defaults for absent fields.
2. MUST ignore unknown components and unknown fields.
3. MUST accept every canonical enum value; SHOULD accept all `enumMap` keys.
4. SHOULD read legacy aliases when the primary field is absent.
5. MUST negate the X component of `unityCoords` vectors when operating in glTF space.
6. MUST report an incompatibility when `_formatVersion` has a greater major version
   than the reader implements.

### 9.3 Conformance suite

The directory [`conformance/`](./conformance/) contains test GLB files with
`*.expected.json` fixtures describing the exact component state a conforming reader
must produce after loading (defaults applied, aliases resolved, enums mapped).
realvirtual WEB is the reference implementation and runs this suite in CI
(`tests/conformance.test.ts`).

## 10. Versioning

- The format uses semantic versioning; this document specifies **1.0**.
- **Minor versions** (1.x) are additive only: new components, new OPTIONAL fields,
  new enum values. A 1.0 reader remains conforming when reading 1.x data (unknown
  keys are ignored).
- **Major versions** change or remove existing semantics and get a new URL prefix
  (`/schema/odt/v2/`). `/v1/rv-odt.json` serves the latest compatible 1.x schema;
  each `/v1.N/rv-odt.json` release snapshot is byte-immutable.
- Component schema changes require a matching update of the reference
  implementation's frozen baseline test in the same change set (drift protection).

## 11. Governance

- The specification is maintained by **realvirtual GmbH** in the realvirtual WEB
  repository (`schema/` subtree).
- Proposals for new components or fields are accepted via issues/pull requests on
  the public repository. Acceptance criteria: implementable by at least the
  reference implementation, no breaking change within a major version, complete
  field documentation (type, default, unit).
- The spec text and `rv-odt.json` are CC BY 4.0; anyone may implement readers and
  writers, commercially or otherwise, with attribution.
- Out of scope for v1 (explicitly): DES (discrete-event simulation) plugin
  components (`DES*`) and dynamically registered library behavior schemas
  (`ConveyorBehavior`, `TurntableBehavior`, `SourceBehavior`, `SinkBehavior`,
  `ChainTransferBehavior`, and the material-flow types `Conveyor`, `Turntable`,
  `ChainTransfer`). These are realvirtual WEB runtime concerns, not part of the
  interchange format. `Drive_CAM` is reserved (Section 7f).

## 12. References

- glTF 2.0 Specification — https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
- JSON Schema 2020-12 — https://json-schema.org/specification
- RFC 2119, Key words for use in RFCs — https://www.rfc-editor.org/rfc/rfc2119
- UCUM, Unified Code for Units of Measure — https://ucum.org/
- EU Machinery Regulation 2023/1230 — https://eur-lex.europa.eu/eli/reg/2023/1230/oj
- realvirtual WEB (reference implementation) — https://github.com/game4automation/realvirtual-WEB
- realvirtual documentation — https://doc.realvirtual.io
