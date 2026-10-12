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
- **Reserved key `NodeId`:** a **string** (not a component object) directly under
  `extras.realvirtual`, carrying a stable identity for the node it sits on. See
  Section 5a.

### 5a. Stable node identity (`NodeId`)

Scene paths (above) identify a node by the chain of names leading to it. That is
enough inside one file, and not enough across files: renaming a node in a
referenced asset silently invalidates every reference written by whoever
references it. `NodeId` is the second addressing axis and exists for exactly that
case. Both remain valid; a consumer that finds both prefers `NodeId`.

```json
{ "extras": { "realvirtual": { "NodeId": "3f9a1c02b7d4e5f6", "Drive": { "TargetSpeed": 100 } } } }
```

Rules:

- `NodeId` is a **string**, unique **within its own file**. It is deliberately NOT
  globally unique: a file that is referenced ten times contributes ten nodes
  carrying the same `NodeId`, and telling those ten apart is the job of the
  *occurrence address* (Section 5b), not of the id.
- A writer that owns a file (its own scenes and assets) SHOULD stamp a random
  `NodeId` (UUID v4 or equivalent) on every node it writes and MUST carry an
  existing `NodeId` through unchanged on re-save. Regenerating ids on save
  orphans every override anyone wrote against that file.
- A consumer reading a file that carries **no** `NodeId` — every glTF written
  before this section existed — MUST NOT invent a random one. Such a file may be
  read-only (a library asset that must stay untouched), so a generated id could
  never be written back and would differ on the next load. It MUST instead
  **derive** the id deterministically from data that does not change while the
  file does not change: the hex SHA-256 of the file's bytes and the node's index
  in the glTF `nodes[]` array. The derivation is normative so two independent
  consumers agree:

  ```
  NodeId = first 16 hex chars of SHA-256( <file sha256, lowercase hex> ":" <node index, decimal> )
  ```

- When the referenced file changes, its derived ids change with it. This is
  correct and intended: it is the same situation as a renamed node, and it
  surfaces through the orphaned-override report (Section 5b) rather than by
  silently retargeting an override at whatever node inherited the index.
- `NodeId` MUST NOT be written with a leading underscore. Consumers commonly
  strip `_`-prefixed keys on export as runtime bookkeeping; `NodeId` is authored
  data and must survive an export/import round-trip unchanged.

### 5b. Composition: references, overrides and strength ordering

A node carrying an `AssetReference` (Section 7d.8) does not contain its subtree —
it names another asset that does. Resolving those references and grafting the
resulting subtrees into one tree is called **composition**. A consumer MUST
complete composition **before** it interprets the tree in any other way, so that
a referenced subtree is subject to exactly the same processing as the root file's
own nodes.

**Occurrence address.** Because `NodeId` is only file-unique, the full address of
a node in a composed tree is a pair: the chain of `NodeId`s of the reference nodes
traversed from the root, and then the node's own `NodeId`.

```
occurrence address = NodeId(ref₁) "/" NodeId(ref₂) "/" …      (empty for the root file)
full address       = <occurrence address> "#" <NodeId>

example:  a1b2c3/d4e5f6#7890ab
          └ reference node "Press_02" in the plant
                   └ reference node "Gripper" in the press
                            └ target node "Motor" in the gripper
```

Each reference node lives in exactly one file, where its own `NodeId` is unique —
so the chain is globally unique without any file needing to know where it is
installed. The occurrence address is computed during composition and is **never
written into a file**.

**Overrides.** A referencing file changes values in a referenced subtree through
`AssetOverrides` (Section 7d.9) on the reference node. The referenced file is
never modified. Because the overrides sit on the reference node, their `byNodeId`
keys are unambiguous by construction.

**Strength ordering.** When more than one layer sets the same field, the
following order applies, **weakest first**:

1. the value in the referenced file itself;
2. `AssetOverrides` of the inner referencing file;
3. `AssetOverrides` of the outer referencing file;
4. the running session's own edits.

In short: **the outer file always wins.**

**Orphaned overrides.** An override whose target node no longer exists in the
resolved asset MUST be reported to the user and MUST NOT be dropped silently.

**Trust is transitive and per subtree.** Where a consumer gates behaviour on a
file's signature, the gate MUST be evaluated **per referenced file**, and the
status of a subtree is the **weakest** status along its resolution path. A signed
root file MUST NOT cause the logic of an unsigned referenced file to run as
trusted — that would make a reference a privilege escalation. The same rule
applies to any sidecar data a consumer applies next to a file: it is governed by
the signature status of the file it belongs to, not of the root.

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

Signal slots of the drive behaviors declare their component-side unit and the
field that scales them (`signalUnit` / `scaleField`, Section 8; plan-512). The
tables do not repeat these keywords; `rv-odt.json` carries them on
`Drive_FollowPosition` (`Position`, `CurrentPosition` → `Scale`), `Drive_Simple`
(`Speed`, `Accelaration`, `IsAtSpeed` → `ScaleSpeed`; `IsAtPosition` →
`CurrentPositionScale`), `Drive_Speed` (`SignalCurrentPosition`),
`Drive_DestinationMotor` (`Destination`, `IsAtPosition`) and
`Drive_ContinousDestination` (`SignalDestination`, `SignalIsAtPosition`) → each
`CurrentPositionScale`, `Drive_UniDriveMotor` (`SetPosition`, `ActualPosition` →
`PositionScale`; `SetSpeed`, `ActualSpeed` → `SpeedScale`; `SetAcceleration`,
`SetDeceleration` → `AccelerationScale`), `Drive_ProfidrivePos`
(`MdiTargetPosition`, `PositionActual` → `PositionScale`; `MdiVelocity` →
`VelocityScale`) and `Drive_FestoFHPP` (`TargetPosition`, `PositionActual` →
`PositionScale`).

Common serialization metadata emitted by some writers on any component —
`Name`, `Active` (where not explicitly listed), `_fullTypeName`, `_version`,
`_enabled` — is NOT part of the format; readers MUST ignore it (exception:
`_enabled: false` on a `Group` entry disables that group entry).

Some subsections carry usage annotations between their introduction and the
field table, in two clearly separated blocks:

- **Authoring rules:** — normative constraints a writer MUST respect for the
  component to be meaningful (e.g. a drive behavior needs a `Drive` on the same
  node). They add no fields and never contradict `rv-odt.json`.
- **Reference implementation notes (informative):** — how realvirtual WEB, the
  reference implementation, applies the data (coordinate mapping, fallbacks,
  load-time behavior). Informative only; other readers MAY behave differently.

Both blocks are bullet lists; tools (e.g. the realvirtual WEB MCP tool
`web_component_schema`) serve them verbatim to authoring agents.

### 7a. Components

#### 7a.1 Drive

Linear or rotational motion control along a local axis. The base motion component.

**Authoring rules:**
- `Direction` MUST be set: it names the motion axis in the node's local frame in Unity (left-handed) coordinates; `Virtual` moves no transform.
- Position values (`Offset`, `StartPosition`, `LowerLimit`, `UpperLimit`, `TargetPosition`) are millimeters for the `LinearX`/`LinearY`/`LinearZ` directions and degrees for the rotational directions.
- A node carries at most one `Drive`; drive behaviors (`Drive_Cylinder`, `Drive_Simple`, `Drive_Gear`, …) are added to the SAME node and control this drive.
- The drive moves its node together with the whole subtree; parts that must move with the axis belong below the drive node (or are collected there by a `Kinematic`).

**Reference implementation notes (informative):**
- realvirtual WEB works in glTF (right-handed) space: `LinearX` moves along three.js −X, `LinearY` and `LinearZ` along +Y and +Z; `RotationX` turns about +X, `RotationY` and `RotationZ` about −Y and −Z (Unity convention, mirrored).
- The drive's rest pose is the authored node transform; positions are applied relative to it along the axis above.

| Field | Type | Default | Description |
|---|---|---|---|
| `Direction` | enum(LinearX, LinearY, LinearZ, RotationX, RotationY, RotationZ, Virtual) | - | Motion axis of the drive in Unity local coordinates; 'Virtual' drives no transform. |
| `ReverseDirection` | boolean | false | Set to true if the direction needs to be inverted. |
| `Offset` | number | 0 | Start offset of the drive from zero position in millimeters or degrees. |
| `StartPosition` | number | 0 | Start position of the drive in millimeters or degrees. |
| `TargetSpeed` | number | 100 | The target speed of the drive in millimeters per second (degrees per second for rotational drives). |
| `Acceleration` | number | 100 | The acceleration in millimeters per second squared. |
| `UseAcceleration` | boolean | false | If set to true the drive uses the acceleration. |
| `SmoothAcceleration` | boolean | false | If set to true the drive uses a jerk-limited S-curve instead of the trapezoidal ramp; requires UseAcceleration. |
| `Jerk` | number | 1000 | The jerk in millimeters per second cubed (degrees per second cubed for rotational drives); only used with SmoothAcceleration. |
| `SpeedOverride` | number | 1 | Speed override factor for this drive, multiplied with the global speed override. |
| `JumpToLowerLimitOnUpperLimit` | boolean | false | If set to true the drive wraps around at its limits instead of stopping: passing the upper limit continues at the lower limit and vice versa. |
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

**Authoring rules:**
- A `Drive` component MUST exist on the same node; `Drive_Simple` controls that drive.
- `Forward`, `Backward`, `Speed` and the feedback slots are signal references: a `ComponentReference` whose `path` names a PLC signal node and whose `componentType` is its signal type (e.g. `PLCOutputBool`).
- `Speed` and `Accelaration` values are multiplied by `ScaleSpeed` before they reach the drive.
- `Enable` is optional. While it is false the drive stops immediately and ignores `Forward` / `Backward`; when it turns true again the drive follows the current `Forward` / `Backward` levels. Without `Enable` the drive is always enabled.

**Reference implementation notes (informative):**
- Without a `Drive` on the same node the behavior stays inert (logged, no error).

| Field | Type | Default | Description |
|---|---|---|---|
| `Speed` | ComponentReference | - | PLC output for the speed of the drive in millimeters per second; can be scaled by ScaleSpeed. |
| `Accelaration` | ComponentReference | - | PLC output for the acceleration of the drive in millimeters per second squared; field name keeps the original C# spelling. |
| `Forward` | ComponentReference | - | Signal to move the drive forward. |
| `Backward` | ComponentReference | - | Signal to move the drive backward. |
| `IsAtPosition` | ComponentReference | - | Signal for the current position of the drive in millimeters. |
| `IsAtSpeed` | ComponentReference | - | Signal for the current speed of the drive in millimeters per second. |
| `IsDriving` | ComponentReference | - | Signal is true while the drive is driving. |
| `Enable` | ComponentReference | - | Optional motion enable. False stops the drive immediately and ignores Forward/Backward; true follows the current Forward/Backward levels again. Unset means always enabled. |
| `ScaleSpeed` | number | 1 | Scale factor for the input and output speed and acceleration. |
| `CurrentPositionScale` | number | 1 | Scale factor for the current position feedback. |
| `CurrentPositionOffset` | number | 0 | Offset applied to the position feedback in millimeters. |
| `ScaleFeedbackPosition` | boolean | true | If true, applies scale and offset to the position feedback. |

```json
{ "Drive_Simple": { "Forward": { "type": "ComponentReference", "path": "PLC/ConveyorStart", "componentType": "PLCOutputBool" } } }
```

#### 7a.3 Drive_Cylinder

Drive behavior: two-position cylinder with in/out command and end-position feedback.

**Authoring rules:**
- A `Drive` component MUST exist on the same node; the cylinder moves that drive between `MinPos` and `MaxPos`.
- `MinPos` and `MaxPos` are drive positions in millimeters along `Drive.Direction`; `TimeOut` and `TimeIn` are the stroke times in seconds.
- With `OneBitCylinder` only `Out` is evaluated: true moves to `MaxPos`, false moves to `MinPos`; `In` is ignored. `InvertOutputLogic` inverts the command.
- `Out`, `In` and the feedback slots (`IsOut`, `IsIn`, `IsMax`, `IsMin`, …) are signal references (`ComponentReference` to a PLC signal node).
- `Enable` is optional. While it is false the cylinder stops and holds its position; `Out` / `In` commands are latched and executed when `Enable` turns true again (one-bit: the current `Out` level). Without `Enable` the cylinder is always enabled.
- `Mode` selects the valve behaviour (plan-570). `Legacy` (default) is the behaviour described above. `DoubleActing` (5/3 valve, closed centre) moves only while exactly one of `Out` / `In` is true and holds where it stands when both are false or both are true. `SingleActingPositive`: `Out` true moves to `MaxPos`, false returns to `MinPos`. `SingleActingNegative`: `Out` true moves to `MinPos`, false returns to `MaxPos`. The three new modes evaluate the current signal levels (nothing is latched; `Enable` true re-evaluates them) and ignore `OneBitCylinder` and `InvertOutputLogic`.

**Reference implementation notes (informative):**
- At start the drive is placed at `MinPos` — or at `MaxPos` when `Drive.StartPosition` equals `MaxPos`; without a `Drive` on the same node the behavior stays inert.
- The feedback slots (`IsIn`, `IsOut`, `IsMin`, `IsMax`) are written from the actual position right at load, before any logic starts, and again after a simulation reset — not only when the position changes.

| Field | Type | Default | Description |
|---|---|---|---|
| `MinPos` | number | 0 | Minimum position of the cylinder in millimeters. |
| `MaxPos` | number | 100 | Maximum position of the cylinder in millimeters. |
| `TimeOut` | number | 1 | Time for moving out from minimum to maximum position in seconds. |
| `TimeIn` | number | 1 | Time for moving in from maximum to minimum position in seconds. |
| `OneBitCylinder` | boolean | false | If set to true only one bit controls the cylinder; when Out is false the cylinder moves in. |
| `InvertOutputLogic` | boolean | false | When true, inverts the Out/In signal logic (Out=false extends, Out=true retracts). |
| `Mode` | enum(Legacy, DoubleActing, SingleActingPositive, SingleActingNegative) | "Legacy" | Valve mode; see the authoring rules above. |
| `Out` | ComponentReference | - | Signal for moving the cylinder out. |
| `In` | ComponentReference | - | Signal for moving the cylinder in. |
| `IsOut` | ComponentReference | - | Signal is true when the cylinder is out or stopped by the Max sensor. |
| `IsIn` | ComponentReference | - | Signal is true when the cylinder is in or stopped by the Min sensor. |
| `IsMax` | ComponentReference | - | Signal is true when the cylinder is at the maximum position. |
| `IsMin` | ComponentReference | - | Signal is true when the cylinder is at the minimum position. |
| `IsMovingOut` | ComponentReference | - | Signal is true while the cylinder is moving out. |
| `IsMovingIn` | ComponentReference | - | Signal is true while the cylinder is moving in. |
| `Enable` | ComponentReference | - | Optional motion enable. False stops and holds the cylinder; Out/In commands are latched and executed when it turns true again. Unset means always enabled. |

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

#### 7a.52 Drive_SEWMovilink

Drive behavior: SEW-EURODRIVE MOVILINK unit profile. The PLC writes control word 1 and a speed setpoint, the drive returns status word 1 and the actual speed. Note the inverted low-byte bits — bit 0 is the controller inhibit and bits 1/2 are active low, so the enable byte is `0x06`, not `0x07`.

| Field | Type | Default | Description |
|---|---|---|---|
| `ControlWord1` | ComponentReference | - | MOVILINK control word 1 (PO1). Bit 0 is the inverted controller inhibit, bits 1 and 2 are active low, bit 6 is the fault reset. |
| `SpeedSetpoint` | ComponentReference | - | MOVILINK speed setpoint (PO2), encoded as selected by Encoding. |
| `StatusWord1` | ComponentReference | - | MOVILINK status word 1 (PI1) written back to the PLC every tick. |
| `SpeedActual` | ComponentReference | - | MOVILINK actual speed (PI2) written back to the PLC every tick. |
| `MaxSpeed` | number | 100 | Drive speed in millimeters per second (or degrees per second) at 100 percent of the maximum speed. |
| `Encoding` | enum(PercentNmax, Rpm) | "PercentNmax" | Speed setpoint encoding: SPEED[%] with 0x4000 = 100 percent, or SPEED with 0.2 rpm per bit. |
| `MaxSpeedRpm` | number | 3000 | Maximum speed in rpm, used to convert the 0.2 rpm per bit encoding to a fraction. |
| `Acceleration` | number | 1000 | Drive acceleration in millimeters per second squared (or degrees per second squared). |
| `SimulateFault` | boolean | false | If true the drive reports a fault in status word bit 5 until the PLC acknowledges with control word bit 6. |
| `FaultCode` | number | 6 | Fault code reported in the status word high byte while a fault is active. |

```json
{ "Drive_SEWMovilink": { "MaxSpeed": 500, "Encoding": "Rpm", "MaxSpeedRpm": 3000 } }
```

#### 7a.59 Drive_ProfidriveSpeed

Drive behavior: PROFIdrive speed-controlled drive (SINAMICS) on standard telegram 1. The PLC writes control word STW1 and the normalized speed setpoint NSOLL_A; the drive runs the PROFIdrive state machine (switching-on inhibited → ready for switching on → ready to operate → operation, driven by STW1.0 ON/OFF1, STW1.1 OFF2, STW1.2 OFF3 and STW1.3 enable operation) and moves only in operation with STW1.4/5/6 set. A fault (`SimulateFault`) is sticky until a rising edge of STW1.7. Status word ZSW1 and the actual speed NIST_A go back.

| Field | Type | Default | Description |
|---|---|---|---|
| `ReferenceSpeed` | number | 100 | Drive speed in mm/s (or °/s) at the full-scale setpoint (100 %), the reference speed p2000. |
| `SetpointScale` | number | 16384 | Raw setpoint value that equals 100 %. PROFIdrive NSOLL_A = 16384 (0x4000); ABB Drives profile REF1 = 20000. |
| `Acceleration` | number | 1000 | Drive acceleration in mm/s² (or °/s²). |
| `SimulateFault` | boolean | false | Reports a fault (ZSW1.3) until the PLC acknowledges with a rising edge of STW1.7. |
| `SimulateWarning` | boolean | false | Reports a warning (ZSW1.7). |
| `ControlWord` | ComponentReference | - | STW1 (PLCOutputInt). |
| `SpeedSetpoint` | ComponentReference | - | NSOLL_A (PLCOutputInt); negative reverses, STW1.11 inverts. |
| `StatusWord` | ComponentReference | - | ZSW1 (PLCInputInt), written every tick. |
| `SpeedActual` | ComponentReference | - | NIST_A (PLCInputInt), same scale as the setpoint. |

```json
{ "Drive_ProfidriveSpeed": { "ReferenceSpeed": 1500, "SetpointScale": 16384 } }
```

#### 7a.60 Drive_ProfidrivePos

Drive behavior: PROFIdrive positioning drive (SINAMICS EPOS) on telegram 111. Same state machine as `Drive_ProfidriveSpeed`; in operation the EPOS cascade applies in this order: reject task (STW1.4 = 0), intermediate stop (STW1.5 = 0), set reference point (POS_STW2.1 rising), homing (STW1.11), jog 1 / jog 2 (STW1.8 / STW1.9 at `JogSpeed`), MDI mode (POS_STW1.15) with setup travel (POS_STW1.14) or positioning on a rising edge of STW1.6 (or continuously with POS_STW1.12), absolute (POS_STW1.8) or relative. Speeds are MDI_VELOCITY · `VelocityScale` · OVERRIDE / 0x4000.

| Field | Type | Default | Description |
|---|---|---|---|
| `PositionScale` | number | 1 | Drive mm (or degrees) per length unit (LU) for MDI_TARPOS and XIST_A. |
| `PositionOffset` | number | 0 | Offset in mm (or degrees) applied to the position command and feedback. |
| `VelocityScale` | number | 1 | Drive speed in mm/s per MDI_VELOCITY unit (1000 LU/min). |
| `ReferenceSpeed` | number | 100 | Drive speed in mm/s at NIST_B = 0x40000000 (100 %). |
| `JogSpeed` | number | 50 | Jog speed in mm/s for jog 1 / jog 2. |
| `Acceleration` | number | 1000 | Drive acceleration in mm/s² at 100 % override. |
| `SimulateFault` | boolean | false | Reports a fault (ZSW1.3) until a rising edge of STW1.7. |
| `SimulateWarning` | boolean | false | Reports a warning (ZSW1.7). |
| `ControlWord` | ComponentReference | - | STW1 (PZD1, PLCOutputInt). |
| `PosControlWord1` | ComponentReference | - | POS_STW1 (PZD2, PLCOutputInt). |
| `PosControlWord2` | ComponentReference | - | POS_STW2 (PZD3, PLCOutputInt). |
| `Override` | ComponentReference | - | OVERRIDE (PZD5, PLCOutputInt), 0x4000 = 100 %. |
| `MdiTargetPosition` | ComponentReference | - | MDI_TARPOS in LU (PZD6+7, PLCOutputInt). |
| `MdiVelocity` | ComponentReference | - | MDI_VELOCITY in 1000 LU/min (PZD8+9, PLCOutputInt). |
| `StatusWord` | ComponentReference | - | ZSW1 (PZD1, PLCInputInt) incl. standstill / accelerates / decelerates bits. |
| `PosStatusWord1` | ComponentReference | - | POS_ZSW1 (PZD2, PLCInputInt); mirrors ZSW1. |
| `PosStatusWord2` | ComponentReference | - | POS_ZSW2 (PZD3, PLCInputInt): traverses forwards / backwards, command active. |
| `PositionActual` | ComponentReference | - | XIST_A in LU (PZD6+7, PLCInputInt). |
| `SpeedActual` | ComponentReference | - | NIST_B (PZD8+9, PLCInputInt), 0x40000000 = 100 %. |

```json
{ "Drive_ProfidrivePos": { "PositionScale": 0.001, "VelocityScale": 16.667, "JogSpeed": 20 } }
```

#### 7a.61 Drive_FestoFHPP

Drive behavior: Festo Handling and Positioning Profile (CMMT / CMMO / CMMP). The PLC writes the 8-byte FHPP output image — CCON (byte 0: ENABLE, STOP active low, RESET, OPM), CPOS (byte 1: HALT active low, START, HOM, JOGP, JOGN), byte 2 (record number in Record Select, CDIR in Direct mode), byte 3 (velocity 0..100 % of `BaseVelocity`) and bytes 4–7 (target position in increments). SCON, SPOS, the byte 2 echo and the actual position go back. Homing sets the position to `PositionOffset`.

| Field | Type | Default | Description |
|---|---|---|---|
| `PositionScale` | number | 1 | Drive mm (or degrees) per position increment. |
| `PositionOffset` | number | 0 | Offset in mm (or degrees) applied to the position command and feedback. |
| `BaseVelocity` | number | 100 | Drive speed in mm/s at 100 % velocity (Direct mode). |
| `JogSpeed` | number | 50 | Jog speed in mm/s for JOGP / JOGN. |
| `Acceleration` | number | 1000 | Drive acceleration in mm/s². |
| `Records` | object[] | [] | Record Select table: `[{ "Position": 0, "Velocity": 100, "Relative": false }, …]`, indexed by byte 2. |
| `SimulateFault` | boolean | false | Reports SCON.FAULT until a rising edge of CCON.RESET. |
| `SimulateWarning` | boolean | false | Reports SCON.WARN. |
| `Ccon` | ComponentReference | - | FHPP control byte CCON (byte 0): ENABLE, STOP, RESET, OPM. (PLCOutputInt) |
| `Cpos` | ComponentReference | - | FHPP control byte CPOS (byte 1): HALT, START, HOM, JOGP, JOGN. (PLCOutputInt) |
| `RecordOrCdir` | ComponentReference | - | Byte 2 - record number (Record Select) or CDIR (Direct mode). (PLCOutputInt) |
| `VelocityPercent` | ComponentReference | - | Byte 3 - velocity 0..100 percent of BaseVelocity (Direct mode). (PLCOutputInt) |
| `TargetPosition` | ComponentReference | - | Bytes 4-7 - target position in increments (Direct mode, 32-bit signed). (PLCOutputInt) |
| `Scon` | ComponentReference | - | FHPP status byte SCON (byte 0) written back to the PLC every tick. (PLCInputInt) |
| `Spos` | ComponentReference | - | FHPP status byte SPOS (byte 1) written back to the PLC every tick. (PLCInputInt) |
| `RecordOrSdir` | ComponentReference | - | Byte 2 - active record number echo (Record Select) or SDIR (Direct mode). (PLCInputInt) |
| `PositionActual` | ComponentReference | - | Bytes 4-7 - actual position in increments (32-bit signed). (PLCInputInt) |

```json
{ "Drive_FestoFHPP": { "BaseVelocity": 250, "Records": [ { "Position": 0, "Velocity": 100, "Relative": false }, { "Position": 400, "Velocity": 200, "Relative": false } ] } }
```

#### 7a.62 Drive_UniDriveMotor

Drive behavior: UniDrive-style positioning controller. `Run` gates all motion (low = held stopped); `JogPlus` / `JogMinus` jog at `SetupSpeed` or, with `SpeedSelection`, at `SetSpeed · SpeedScale`; a rising edge of `StartPositioning` moves to `SetPosition · PositionScale + PositionOffset` at `SetSpeed · SpeedScale` with the ramp `SetAcceleration · AccelerationScale` (the drive brakes symmetrically, `SetDeceleration` is informational). Feedback: `IsReady`, `IsReferenced` (from the two settings), `IsAtPosition1` (at target and not jogging), integer `ActualPosition` and `ActualSpeed`.

| Field | Type | Default | Description |
|---|---|---|---|
| `PositionScale` | number | 1 | Scale between integer position units and drive mm (or degrees). |
| `PositionOffset` | number | 0 | Offset applied to the position command and feedback. |
| `SpeedScale` | number | 1 | Scale between integer speed units and mm/s. |
| `AccelerationScale` | number | 1 | Scale between integer ramp units and mm/s². |
| `SetupSpeed` | number | 50 | Jog speed in mm/s while `SpeedSelection` is false. |
| `Ready` | boolean | true | Drive reports ready; false simulates a not-ready drive. |
| `Referenced` | boolean | true | Drive reports the encoder as referenced. |
| `Run` | ComponentReference | - | General release of the drive - while false the drive is held stopped. (PLCOutputBool) |
| `JogPlus` | ComponentReference | - | Manual jog forward. (PLCOutputBool) |
| `JogMinus` | ComponentReference | - | Manual jog backward. (PLCOutputBool) |
| `StartCalibration` | ComponentReference | - | Start encoder calibration - interface completeness only, no effect in simulation. (PLCOutputBool) |
| `SpeedSelection` | ComponentReference | - | Jog speed selection: false uses SetupSpeed, true uses the commanded SetSpeed. (PLCOutputBool) |
| `StartPositioning` | ComponentReference | - | Start positioning to SetPosition - a rising edge triggers the move. (PLCOutputBool) |
| `ResetFault` | ComponentReference | - | Fault acknowledge - interface completeness only, no effect in simulation. (PLCOutputBool) |
| `SetPosition` | ComponentReference | - | Target position setpoint in integer units, scaled by PositionScale and PositionOffset. (PLCOutputInt) |
| `SetSpeed` | ComponentReference | - | Target speed setpoint in integer units, scaled by SpeedScale. (PLCOutputInt) |
| `SetAcceleration` | ComponentReference | - | Acceleration ramp setpoint in integer units, scaled by AccelerationScale. (PLCOutputInt) |
| `SetDeceleration` | ComponentReference | - | Deceleration ramp setpoint - read for transparency, the drive brakes with the symmetric acceleration ramp. (PLCOutputInt) |
| `IsReady` | ComponentReference | - | Feedback that the drive is ready, driven by the Ready setting. (PLCInputBool) |
| `IsReferenced` | ComponentReference | - | Feedback that the encoder is referenced, driven by the Referenced setting. (PLCInputBool) |
| `IsAtPosition1` | ComponentReference | - | Feedback that the commanded position has been reached (not while jogging). (PLCInputBool) |
| `ActualPosition` | ComponentReference | - | Actual drive position in integer units, scaled from the current position. (PLCInputInt) |
| `ActualSpeed` | ComponentReference | - | Actual drive speed in integer units, scaled from the current speed. (PLCInputInt) |

```json
{ "Drive_UniDriveMotor": { "PositionScale": 0.01, "SpeedScale": 0.1, "SetupSpeed": 20 } }
```

#### 7a.63 Drive_ProportionalValve

Drive behavior: hydraulic (or electric) proportional directional valve. The analog setpoint is scaled to a −1..1 command (`SetpointZero` → 0, `SetpointFull` → 1), passed through the dead band (`Deadband`, rescaled so flow starts smoothly above it), optional hysteresis, the spool response time (full stroke in `ResponseTime` seconds) and the flow characteristic `|spool| ^ FlowExponent`, and applied as a signed drive speed `Flow · MaxSpeed`. `FlowExponent` replaces the Unity `FlowCurve` (an AnimationCurve, which the GLB does not carry): 1 = linear, > 1 = progressive.

| Field | Type | Default | Description |
|---|---|---|---|
| `Setpoint` | number | 0 | Raw analog setpoint when no signal is wired. |
| `SetpointZero` | number | 0 | Raw value for zero flow (e.g. 0 for ±10 V, 12 for 4–20 mA). |
| `SetpointFull` | number | 10 | Raw value for 100 % forward flow (10 for ±10 V, 20 for 4–20 mA, 100 for percent). |
| `Deadband` | number | 0.05 | Dead band as a fraction (0..0.9) of the command. |
| `EnableHysteresis` | boolean | false | Ignore command changes smaller than `Hysteresis`. |
| `Hysteresis` | number | 0.02 | Hysteresis band as a fraction (0..0.5). |
| `FlowExponent` | number | 1 | Flow characteristic exponent (1 linear, > 1 progressive, < 1 degressive). |
| `ResponseTime` | number | 0.1 | Spool travel time in seconds from neutral to full deflection; 0 = instant. |
| `MaxSpeed` | number | 100 | Drive speed in mm/s (or °/s) at 100 % flow. |
| `Acceleration` | number | 1000 | Drive acceleration in mm/s². |
| `SignalSetpoint` | ComponentReference | - | Analog setpoint from the PLC (PLCOutputFloat). |
| `SignalSpoolPosition` | ComponentReference | - | Spool position −1..1 (PLCInputFloat). |
| `SignalCurrentSpeed` | ComponentReference | - | Current drive speed (PLCInputFloat). |
| `SignalCurrentPosition` | ComponentReference | - | Current drive position (PLCInputFloat). |

```json
{ "Drive_ProportionalValve": { "SetpointZero": 12, "SetpointFull": 20, "Deadband": 0.1, "MaxSpeed": 300 } }
```

#### 7a.64 Drive_ContinousDestination

Drive behavior: intelligent positioning drive without a start bit — every change of the destination value starts a move to it; speed and acceleration are forwarded every tick. The spelling "Continous" is the Unity class name.

| Field | Type | Default | Description |
|---|---|---|---|
| `Destination` | number | 0 | Destination in mm when no signal is wired. |
| `Acceleration` | number | 100 | Acceleration in mm/s² when no signal is wired. |
| `TargetSpeed` | number | 100 | Maximum speed in mm/s when no signal is wired. |
| `CurrentPositionScale` | number | 1 | Scale applied to the destination command and the position feedback. |
| `CurrentPositionOffset` | number | 0 | Offset applied to the destination command and the position feedback. |
| `ScaleFeedbackPosition` | boolean | true | Apply scale and offset to the position feedback. |
| `SignalDestination` | ComponentReference | - | Destination position of the drive in millimeters; a value change starts the move. (PLCOutputFloat) |
| `SignalAcceleration` | ComponentReference | - | Acceleration of the drive in millimeters per second squared. (PLCOutputFloat) |
| `SignalTargetSpeed` | ComponentReference | - | Target (maximum) speed of the drive in millimeters per second. (PLCOutputFloat) |
| `SignalIsAtPosition` | ComponentReference | - | Signal for the current position of the drive in millimeters. (PLCInputFloat) |
| `SignalIsAtSpeed` | ComponentReference | - | Signal for the current drive speed in millimeters per second. (PLCInputFloat) |
| `SignalIsAtDestination` | ComponentReference | - | Signal is true when the drive is at the destination. (PLCInputBool) |
| `SignalIsDriving` | ComponentReference | - | Signal is true while the drive is currently driving. (PLCInputBool) |

```json
{ "Drive_ContinousDestination": { "TargetSpeed": 400, "Acceleration": 800 } }
```

#### 7a.65 DrivePulseEncoder

Drive add-on (NOT a `Drive_*` behavior — it sits on the drive node next to the one active behavior): an incremental pulse encoder that toggles a bool signal every time the drive position passes another `PulseIntervall`, starting at `Offset`. A `PulseIntervall` of 0 disables the encoder.

| Field | Type | Default | Description |
|---|---|---|---|
| `PulseIntervall` | number | 0 | Distance in mm (or degrees) between two pulses; 0 disables. |
| `Offset` | number | 0 | Position of the first pulse. |
| `PulseEncoderSignal` | ComponentReference | - | Toggled signal (PLCInputBool). |

```json
{ "DrivePulseEncoder": { "PulseIntervall": 10, "Offset": 5 } }
```

#### 7a.5 Drive_Gear

Drive behavior: slaves this node's Drive to a master Drive with gear ratio and offset.

**Authoring rules:**
- A `Drive` component MUST exist on the same node (the slave); `MasterDrive` references ANOTHER node's `Drive` (`componentType` `Drive`).
- The slave position is master position × `GearFactor` + `Offset`; `Offset` is in the slave drive's unit (millimeters or degrees).

**Reference implementation notes (informative):**
- The slave's own speed and limits are not used while the gear is active; an unresolvable `MasterDrive` leaves the behavior inert.

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

**Authoring rules:**
- In collision mode (`UseRaycast` false) the detection volume is the node's geometry; a node without geometry needs a `BoxCollider` entry.
- In raycast mode `RayCastDirection` is given in Unity local coordinates and `RayCastLength` in millimeters.
- `SensorOccupied` / `SensorNotOccupied` are signal references (`ComponentReference` to a `PLCInputBool` node) that the sensor writes.

**Reference implementation notes (informative):**
- realvirtual WEB takes the mesh bounds of the node and its subtree as the collision volume and falls back to `BoxCollider` only when the node draws nothing.
- Only MUs (spawned by a `Source`) are detected; `LimitSensorToTag` narrows that to one tag or name.

| Field | Type | Default | Description |
|---|---|---|---|
| `UseRaycast` | boolean | false | If true the sensor uses raycast mode instead of collider (AABB overlap) mode. |
| `RayCastDirection` | Vector3 | - | Raycast direction vector in Unity local coordinates (readers negate X in glTF space). |
| `RayCastLength` | number | 1000 | Raycast length in millimeters. |
| `SensorOccupied` | ComponentReference | - | Boolean PLC input for the sensor signal; true when the sensor is occupied. |
| `SensorNotOccupied` | ComponentReference | - | Boolean PLC input for the sensor; true when the sensor is NOT occupied. |
| `AutoRay` | boolean | false | Derives the ray beam from the node bounding box (naming-convention sensors). |
| `PhysicsMode` | boolean | false | If true and the sensor overlaps a physics zone, the sensor is physics-managed: collision mode uses a physics sensor collider (enter/leave events), raycast mode a physics raycast. Physics-managed sensors detect only physics-owned MUs; sensors that must detect kinematic MUs keep the default false. |
| `LimitSensorToTag` | string | "" | Detects only MUs with this tag or name. Empty detects all MUs. |
| `ShowGizmo` | boolean | true | Displays the sensor detection volume in the web viewer. Detection stays active when hidden. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `Mode` | string | Legacy 'Raycast'/'Collision'; readers SHOULD convert to `UseRaycast` when `UseRaycast` is absent |

```json
{ "Sensor": { "UseRaycast": true, "RayCastDirection": { "x": 0, "y": -1, "z": 0 }, "RayCastLength": 500 } }
```

#### 7a.11 TransportSurface

Conveyor surface that moves MUs along a direction at the referenced Drive's speed.

**Authoring rules:**
- The surface's extent is the geometry of its node (including the subtree); MUs are carried on top of it.
- `TransportDirection` is a vector in Unity local coordinates of the surface node (X negated relative to glTF).
- The belt speed comes from a `Drive`: either the one named by `DriveReference` (`componentType` `Drive`) or, when that is empty, the nearest `Drive` on the surface node or one of its ancestors.
- Set `DriveReference` whenever the surface sits below a positioning axis (lift, turntable): otherwise the axis drive is taken as the belt drive.

**Reference implementation notes (informative):**
- realvirtual WEB uses the mesh AABB of the surface subtree as the transport footprint, tracks it with the node's current rotation, and resolves the drive as `DriveReference` first, then a `findInParent` walk up the hierarchy.
- The drive that feeds a surface is marked as a belt drive and no longer moves its own node — a lift axis wrongly picked up by the parent walk stops lifting.

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

**Authoring rules:**
- `ThisObjectAsMU` is a node NAME or scene path string (not a `ComponentReference`) of the MU prototype; empty, or the source node's own name, makes the source node itself the prototype.
- A separate prototype node should carry an `MU` marker; it is a template, not a part of the running scene.
- `SourceGenerate` and `SourceGenerateOnDistance` are signal references (`ComponentReference` to a `PLCOutputBool` node).

**Reference implementation notes (informative):**
- A separate prototype is looked up in the source's own asset subtree first, then globally, and is hidden at load; the source shows a ghost preview of it.
- With `PlaceOnTransportSurface` new MUs are dropped onto the `TransportSurface` below the source.

| Field | Type | Default | Description |
|---|---|---|---|
| `AutomaticGeneration` | boolean | true | Automatic generation of MUs when the last MU is farther than GenerateIfDistance from the source. |
| `Interval` | number | 0 | Interval in seconds between the generation of MUs; 0 disables interval generation. |
| `GenerateIfDistance` | number | 300 | Distance in millimeters from the source at which new MUs are generated. |
| `PlaceOnTransportSurface` | boolean | true | If true newly spawned MUs are placed onto the transport surface below the source. |
| `ThisObjectAsMU` | string | "" | Name of the GameObject used as the MU prototype; defaults to this node when empty. |
| `CollisionRoleForMUs` | enum(None, Tool, Workpiece, Machine, Robot, Environment, Cutter) | "None" | Collision role assigned to every MU spawned by this source; `None` keeps spawned MUs out of every collision check. |
| `Enabled` | boolean | true | Enables MU generation. |
| `GenerateMU` | boolean | true | Generates one MU on a false-to-true transition, including an initial true value. |
| `DeleteAllMU` | boolean | false | Deletes this source's MUs on a false-to-true transition. |
| `StartInterval` | number | 0 | Delay before the first interval generation. |
| `RandomDistance` | boolean | false | Randomizes the distance threshold after automatic generation. |
| `RangeDistance` | number | 300 | Plus/minus random distance range. |
| `LimitNumber` | boolean | false | Limits the total number generated by this source. |
| `MaxNumberMUs` | number | 1 | Maximum lifetime generated count when LimitNumber is enabled. |
| `Mass` | number | 1 | Mass of each generated MU. |
| `SourceGenerate` | ComponentReference | - | PLCOutputBool: generates one MU on a rising edge and disables automatic distance generation at startup. |
| `SourceGenerateOnDistance` | ComponentReference | - | PLCOutputBool: controls AutomaticGeneration by signal level. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `Spawn` | string | Legacy spawn-mode hint |

```json
{ "Source": { "AutomaticGeneration": true, "Interval": 5 } }
```

#### 7a.13 Sink

Destroys MUs that touch it. The presence of a `Sink` object on a node marks the node
as a sink; an empty object deletes every MU.

| Field | Type | Default | Description |
|---|---|---|---|
| `DeleteMus` | boolean | true | Enables MU deletion. |
| `DeleteOnlyTag` | string | "" | Only deletes MUs with this tag; empty accepts all tags. |

```json
{ "Sink": {} }
```

#### 7a.14 Grip

Gripper for pick-and-place operations.

**Authoring rules:**
- The `Grip` node is the gripping point: picked MUs are attached to it and move with it (put it below the drive or kinematic that carries the gripper).
- `PartToGrip` references a `Sensor` (`componentType` `Sensor`) whose occupying MU is picked; when empty, the nearest MU within `GripRange` millimeters is picked.
- `SignalPick` / `SignalPlace` are signal references (`ComponentReference` to a PLC signal node); with `OneBitControl` only `SignalPick` is used (rising edge picks, falling edge places).

**Reference implementation notes (informative):**
- The realvirtual WEB asset editor refuses to add a `Grip` below a `TransportSurface`.

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

**Authoring rules:**
- With `LoadOnCarrier` a `Grip` in `PlaceMode` `Auto` aligns the part (with everything it carries) at the target pose and then decides: exactly one `MU` the part rests on (see `LoadSeatDepth`) and no other `MU` in the way → the part becomes that MU's load and the target stays free; an overlap with any other `MU`, or with two MUs it could rest on → the place is refused and the part stays in the `Grip`; nothing below and nothing in the way → the part is placed on the target as without `LoadOnCarrier`.
- A `Zone` releasing onto a target ignores `LoadOnCarrier`.

| Field | Type | Default | Description |
|---|---|---|---|
| `AlignPosition` | boolean | true | If true the MU position is snapped to the GripTarget position when placed. |
| `AlignRotation` | boolean | true | If true the MU rotation is aligned to the GripTarget rotation when placed. |
| `LoadOnCarrier` | boolean | false | If true a Grip places the part at this pose as a load of the MU below it instead of on the target; the target stays free. |

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
| `id` | string | - | Stable path id for graph edges (`successors`) and `Agv.PathId`. Empty or absent = the carrying node's name. |
| `segments` | array | [] | Ordered segment chain in world meters; the segment grammar is detailed below. Unknown kinds are skipped with a warning. |
| `closed` | boolean | false | Circulating path (loop): arc-length addresses wrap modulo length. |
| `successors` | array | [] | Path ids this path continues into (graph edges / switches). Dangling ids are tolerated until the referenced path loads. |
| `align` | array | [0,1,0] | Up vector for the traveler pose, applied as `lookRotation(tangent, align)`. |
| `zone` | string | - | Control-point zone id for mutual exclusion at crossings. Empty or absent = unzoned. |
| `zoneCapacity` | number | - | Explicit zone capacity (>= 0; 0 = never enterable). Absent = the default capacity of 1. |

Structured field shapes — the fields above whose value is a structured JSON
payload, plus the `type` discriminator, which is not a `$def` property. The
shapes are parsed by the TS-SSOT `parsePathExtras()`, not by the JSON schema:

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
| `CollisionRole` | enum(None, Tool, Workpiece, Machine, Robot, Environment, Cutter) | "None" | Collision role of this node's subtree; `None` excludes the node from every collision check. `Cutter` marks a cutting tool — its contact with a workpiece that a `MachiningVolume` is machining with it is suppressed while the spindle runs. |

```json
{ "CollisionRole": { "CollisionRole": "Robot" } }
```

#### 7a.39 MachiningVolume

Workpiece with real-time CSG material removal. The material is an SDF voxel grid
(never the display mesh); every listed `MachiningTool` subtracts its swept volume
from that grid once per tick (`result = max(workpiece, -sweptTool)`), and the
changed 16^3 chunks are re-tessellated into per-chunk meshes. Tools are applied
**in list order** — the order is part of the result. Requires the machining
provider (the `rv_csg` WASM kernel); without it the authored mesh stays untouched
and nothing is machined.

| Field | Type | Default | Description |
|---|---|---|---|
| `gridResolution` | Vector3 | {"x":64,"y":64,"z":64} | Voxel lattice resolution including one padding voxel per side; clamped to 4..256 per axis. |
| `workpieceSize` | Vector3 | {"x":200,"y":100,"z":200} | Stock dimensions in millimeters (an extent, so no coordinate flip). Ignored for `Shape: Mesh`. |
| `Shape` | enum(Box, Cylinder, Mesh) | "Box" | Starting stock shape. `Mesh` voxelizes the node's own render geometry (WYSIWYG). |
| `CylinderAxis` | enum(X, Y, Z) | "X" | Axis a cylinder workpiece lies along (X or Z lying, Y upright). |
| `Tools` | ComponentReference[] | [] | MachiningTool references cutting this volume, in subtraction order. |
| `ToolGroup` | string | "" | Optional group name; every MachiningTool carrying it is registered in addition to `Tools`. |
| `SweepToolMotion` | boolean | true | Subtract the swept volume between two ticks so fast feed cuts a continuous groove. |
| `MaxSweepSubsteps` | number | 16 | Upper bound of tool poses sampled per tick along the motion path, per tool. |
| `Meshing` | enum(MarchingCubes, DualContouring) | "MarchingCubes" | Surface extraction algorithm. |
| `CreaseAngle` | number | 35 | Hard-edge threshold in degrees; 0 disables crease splitting. |
| `GenerateUVs` | boolean | true | Generate triplanar UV coordinates for the machined chunk meshes. |
| `StatisticsInterval` | number | 0.25 | Seconds between material-remaining refreshes. |
| `UpdateCollider` | boolean | false | Unity-only; a web runtime does not rebuild physics colliders for machined chunks. |
| `SignalSpindleOn` | ComponentReference | - | Spindle running; material is only removed while true. Unbound = always cutting. |
| `SignalReset` | ComponentReference | - | Rising edge resets the workpiece to its original state and discards queued cuts. |
| `SignalMachiningActive` | ComponentReference | - | Written by the runtime: true while cuts or mesh rebuilds are outstanding (momentary, not latched). |

```json
{
  "MachiningVolume": {
    "gridResolution": { "x": 64, "y": 64, "z": 64 },
    "workpieceSize": { "x": 200, "y": 100, "z": 200 },
    "Shape": "Box",
    "Tools": [{ "path": "CNC/Spindle/Mill" }],
    "SignalSpindleOn": { "path": "CNC/Signals/SpindleOn" }
  }
}
```

#### 7a.40 MachiningTool

Cutter geometry for CSG material removal, evaluated as an analytic signed
distance function. Pure data: the node's world pose per tick decides where it
cuts, and a `MachiningVolume` must list it (or its group) for it to have any
effect at all.

| Field | Type | Default | Description |
|---|---|---|---|
| `Shape` | enum(Sphere, Cylinder, BallNose, Torus, ConicalEnd) | "Cylinder" | Cutter shape. |
| `ToolDiameter` | number | 10 | Cutter diameter in millimeters. |
| `ToolLength` | number | 50 | Cutter length/height in millimeters (cylindrical shapes). |
| `CornerRadius` | number | 2 | Corner radius in millimeters, used by BallNose and Torus. |
| `TaperAngleDeg` | number | 15 | Taper half-angle in degrees, used by ConicalEnd. |

```json
{ "MachiningTool": { "Shape": "BallNose", "ToolDiameter": 6, "ToolLength": 40 } }
```

#### 7a.41 KinematicMechanism

Container and constraint solver for a closed or open **rigid-body** kinematic
chain built from `KinematicJoint` components. Note the naming carefully: this is
NOT the `Kinematic` component of Section 7d, which is a hierarchy
re-structuring directive for the older axis-group system. A *mechanism* solves a
joint GRAPH — a spanning tree of one-DOF joints plus loop-closure constraints
plus free bodies for links the tree cannot reach.

The mechanism collects every `KinematicJoint` in its own subtree. Joints with a
`DrivenBy` Drive are boundary conditions; every remaining generalized coordinate
is solved once per fixed update by a bounded damped Newton-Raphson iteration.
`Converged`, `ResidualError` and `SolveTimeMs` are written BY the solver and are
diagnosis outputs, never inputs.

| Field | Type | Default | Description |
|---|---|---|---|
| `SolverIterations` | number | 4 | Fixed number of damped Newton-Raphson iterations per tick; constant for determinism. |
| `Damping` | number | 0.01 | Damped-least-squares factor guarding against Jacobian singularities. |
| `Tolerance` | number | 0.001 | Normalized constraint residual tolerance in millimeters for the `Converged` flag. |
| `SignalConverged` | ComponentReference | - | Optional `PLCOutputBool` mirroring `Converged`. |
| `Converged` | boolean | true | Read-only: true when the last solve met `Tolerance`. |
| `ResidualError` | number | 0 | Read-only: max normalized constraint residual of the last solve, in millimeters. |
| `SolveTimeMs` | number | 0 | Read-only: wall-clock duration of the last solve. |

```json
{ "KinematicMechanism": { "SolverIterations": 4, "Damping": 0.01, "Tolerance": 0.001 } }
```

#### 7a.42 KinematicJoint

One declarative constraint edge of a `KinematicMechanism`. Purely kinematic — it
never applies forces. Body A and Body B are explicit node references rather than
a parent relation, which is what makes closed loops expressible at all: a
four-bar coupler satisfies two joints simultaneously and cannot be a hierarchy
child of both.

**`BodyA` carries a normative absence rule.** A MISSING `BodyA` key means the
joint is anchored against world/static space — that is the authored world
anchor, and it is exactly how a null reference serializes (null fields are
omitted entirely). A `BodyA` key that IS present but does not resolve is an
error, never a world anchor. Consumers MUST keep the two cases apart.

Only `Revolute` and `Prismatic` have a single scalar value, so only they can be
spanning-tree edges and only they support limits; `Spherical` and `Universal`
are always loop-closure constraints.

| Field | Type | Default | Description |
|---|---|---|---|
| `JointType` | enum(Revolute, Prismatic, Spherical, Universal) | "Revolute" | Constraint kind enforced between the two links. |
| `BodyA` | ComponentReference | - | First link. ABSENT = anchored against world/static space (see the rule above). |
| `BodyB` | ComponentReference | - | Second link. Required — a joint always needs a moving link on this side. |
| `AnchorA` | Vector3 | - | Anchor point in Body A local space, in millimeters. |
| `AnchorB` | Vector3 | - | Anchor point in Body B local space, in millimeters; should coincide with `AnchorA` in world space. |
| `AxisA` | Vector3 | - | Joint axis in Body A local space (Revolute, Prismatic, Universal); unused by Spherical. |
| `SecondaryAxisB` | Vector3 | - | Second joint axis in Body B local space (Universal / cardan only). |
| `UseLimits` | boolean | false | Clamp the joint value between `LowerLimit` and `UpperLimit`. |
| `LowerLimit` | number | -180 | Lower limit in degrees (Revolute) or millimeters (Prismatic). |
| `UpperLimit` | number | 180 | Upper limit in degrees (Revolute) or millimeters (Prismatic). |
| `DrivenBy` | ComponentReference | - | Drive that actively controls this joint value; ABSENT = passive joint solved by the mechanism. |
| `CurrentValue` | number | 0 | Read-only: current joint value in degrees or millimeters, written by the solver. |

```json
{ "KinematicJoint": { "JointType": "Revolute", "BodyB": { "type": "ComponentReference", "path": "Machine/Arm", "componentType": "UnityEngine.Transform" }, "AnchorA": { "x": 0, "y": 0, "z": 0 }, "AxisA": { "x": 0, "y": 0, "z": 1 } } }
```

#### 7a.43 KinematicTarget

Inverse-mode companion of `KinematicMechanism`: drives the mechanism's actively
driven joints so that `TargetLink` follows this node's own Cartesian world
position.

Position only, deliberately no orientation constraint — the parallel platforms
this primarily serves (Delta above all) have no independent orientation degree
of freedom, so an orientation residual would over-constrain a solve that
position alone already determines.

| Field | Type | Default | Description |
|---|---|---|---|
| `Mechanism` | ComponentReference | - | The `KinematicMechanism` whose driven joints are solved for this target. |
| `TargetLink` | ComponentReference | - | The mechanism's own link (e.g. a Delta platform) that should track this node. |
| `TrackingActive` | boolean | false | While true an inverse solve runs each tick and takes over the mechanism's Drives. |
| `Reachable` | boolean | true | Read-only: false when the target lies outside the workspace or a limit was hit; the mechanism still moves to the closest achievable pose. |

```json
{ "KinematicTarget": { "TrackingActive": true } }
```

#### 7a.44 MechanismBody

Rigid-body mass properties of ONE link of a `KinematicMechanism`, consumed by the
inverse-dynamics force analysis (drive sizing and joint reaction loads). Place it
on a link node.

Mass, centre of mass and the inertia tensor are computed from the geometry the
link **owns** — its own subtree minus the subtree of any other link of the same
mechanism, because links need not be nested and "everything below me" would
otherwise count a child link's mass twice. The computed values are not stored in
the document: a cached number goes stale the moment the geometry changes, and a
stale mass is a wrong drive size with no warning attached. Only the density and
the optional overrides are authored.

A link **without** this component switches the force analysis off for its whole
mechanism (with a warning naming the link). The kinematic solve is unaffected —
a missing mass is an analysis gap, not a broken mechanism.

Distinct from `JTData.Mass`, which is read-only CAD provenance whose unit is not
recorded in the file; it is offered as a suggestion in the editor and never
applied automatically.

| Field | Type | Default | Description |
|---|---|---|---|
| `DensityPreset` | enum(steel, stainless, aluminum, pa, pom, custom) | "steel" | Material preset the density comes from. Choose `custom` to enter `DensityKgM3` directly. |
| `DensityKgM3` | number | 7850 | Effective density in kilograms per cubic metre, applied to the computed volume. Follows `DensityPreset` unless that is `custom`. |
| `MassOverrideKg` | number | - | Optional: replaces the computed mass, in kilograms. The inertia tensor is scaled with it, so the part keeps its shape and only its density is corrected. |
| `ComOverrideLocalMm` | Vector3 | - | Optional: replaces the computed centre of mass, in the link's local space, in millimeters. |
| `InertiaOverrideLocalKgMm2` | number[] | - | Optional (plan-501): `[Ixx, Iyy, Izz, Ixy, Ixz, Iyz]` about the centre of mass, link-local axes, kg·mm². Replaces the computed tensor after the mass override scaled it. An invalid value (not 6 finite numbers, not positive definite) is a hard finding — the link is withheld from the force analysis, never silently replaced by the computed tensor. |
| `MassSource` | string | "mesh" | Read-only diagnosis: `mesh`, `convex-hull`, `bounds`, `override` or `none`. |

```json
{ "MechanismBody": { "DensityPreset": "aluminum", "DensityKgM3": 2700 } }
```

#### 7a.45 SceneButtonBase

Click/hover state machine of a 3D scene button. It sits on the node that carries
the collider (in Unity the node whose `OnMouseDown` fires) and drives the
`SceneButtonMoveable` cap referenced by `moveable`. A wrapper component
(`PushButton3D`, `EmergencyButton3D`, `HandleSwitch3D`) supplies the PLC signal
and, for push buttons, overrides `isToggle` / `simpleClickTime` / `autoLight`.
The field names keep the Unity camelCase spelling.

| Field | Type | Default | Description |
|---|---|---|---|
| `moveable` | ComponentReference | - | The `SceneButtonMoveable` cap this state machine animates and lights. |
| `autoLight` | boolean | true | Light follows the button's own active state; a wrapper clears it when a `lightSignal` drives the light instead. |
| `isToggle` | boolean | false | Button latches on click instead of releasing after `simpleClickTime`. |
| `simpleClickTime` | number | 0.5 | Hold time in seconds of a momentary click before the button releases again. |

```json
{ "SceneButtonBase": { "moveable": { "type": "ComponentReference", "path": "Cell/Button/Cap", "componentType": "SceneButtonMoveable" }, "autoLight": true, "isToggle": false, "simpleClickTime": 0.3 } }
```

#### 7a.46 SceneButtonMoveable

Animated cap of a 3D scene button: the pressed / rotated offset along `axis`
plus the lit and unlit material state. Consumers animate the cap towards its
offset target with an exponential approach at `moveSpeed` per second, and must
keep the cap mesh out of static batching — it moves and swaps material at
runtime. `baseMaterial` / `activeMaterial` are Unity material DESCRIPTORS, not
material data: equal names mean the button has no light, only movement.

| Field | Type | Default | Description |
|---|---|---|---|
| `axis` | Vector3 | - | Local movement axis of the cap: translation direction, or rotation axis when `angularMovement` is set. |
| `moveSpeed` | number | 30 | Exponential approach rate of the cap towards its offset target, per second. |
| `hoverOffset` | number | 0.1 | Extra offset while the pointer hovers the button, in metres, or degrees when `angularMovement` is set. |
| `activeOffset` | number | 0.05 | Offset the cap holds while the button is active, in metres, or degrees when `angularMovement` is set. |
| `mirrorHoverOffset` | boolean | false | Invert the hover offset while the button is active, for handle switches that flip the other way. |
| `angularMovement` | boolean | false | Rotate the cap around `axis` by the offset in degrees instead of translating it. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `baseMaterial` | object | Unity material descriptor `{name, assetPath, shader}` of the unlit state; only `name` is interpreted. |
| `activeMaterial` | object | Unity material descriptor `{name, assetPath, shader}` of the lit state; only `name` is interpreted. |
| `renderer` | object | Unity `MeshRenderer` reference of the cap; consumers find the mesh by traversing the node instead. |
| `currentOffset` | number | Unity runtime state; consumers keep their own animation state. |

```json
{ "SceneButtonMoveable": { "axis": { "x": 0, "y": 0, "z": 1 }, "moveSpeed": 30, "hoverOffset": 0.002, "activeOffset": -0.007, "mirrorHoverOffset": false, "angularMovement": false } }
```

#### 7a.47 PushButton3D

3D push button. A click writes `stateSignal` (a PLC INPUT — the operator drives
it) either momentarily for `timer` seconds or latching when `toggle` is set. The
cap light follows `lightSignal` when one is wired, otherwise the button's own
state.

| Field | Type | Default | Description |
|---|---|---|---|
| `stateSignal` | ComponentReference | - | Boolean PLC input signal written by the operator click. |
| `lightSignal` | ComponentReference | - | Boolean PLC output signal driving the button light; unset means the light follows the button state. |
| `label` | string | - | Button caption. Rendered where the model carries a text mesh, otherwise informational. |
| `timer` | number | 0.5 | Hold time in seconds of a momentary click; ignored when `toggle` is set. |
| `toggle` | boolean | false | Button latches on click instead of releasing after `timer`. |
| `activeOnStart` | boolean | false | Button clicks itself once when the scene is ready. |

```json
{ "PushButton3D": { "stateSignal": { "type": "ComponentReference", "path": "PLC/StartButton", "componentType": "PLCInputBool" }, "label": "Start", "timer": 0.3, "toggle": false, "activeOnStart": false } }
```

#### 7a.48 EmergencyButton3D

3D emergency-stop button: a latching mushroom head writing `stateSignal`. A
virtual emergency stop is a comfort trigger and a status display — never a
substitute for a hard-wired safety function.

| Field | Type | Default | Description |
|---|---|---|---|
| `stateSignal` | ComponentReference | - | Boolean PLC input signal written by the operator click. |
| `activeOnStart` | boolean | false | Button clicks itself once when the scene is ready. |
| `NormallyClosed` | boolean | false | If true the signal is true while the button is released (OK) and false while it is pressed, like a normally-closed emergency-stop contact. |

With `NormallyClosed` the released (OK) value is written when the scene starts,
so a PLC sees "no emergency stop" without a first click; the pressed / released
visuals are unchanged.

```json
{ "EmergencyButton3D": { "stateSignal": { "type": "ComponentReference", "path": "PLC/Emergency", "componentType": "PLCInputBool" }, "activeOnStart": false } }
```

#### 7a.49 HandleSwitch3D

3D handle switch: a latching lever writing `stateSignal`.

| Field | Type | Default | Description |
|---|---|---|---|
| `stateSignal` | ComponentReference | - | Boolean PLC input signal written by the operator click. |
| `activeOnStart` | boolean | false | Switch clicks itself once when the scene is ready. |

```json
{ "HandleSwitch3D": { "stateSignal": { "type": "ComponentReference", "path": "PLC/OnSwitch", "componentType": "PLCInputBool" }, "activeOnStart": true } }
```

#### 7a.50 Chain

Continuous chain transport — N identical elements riding a spline, all moved by
one `Drive` (chain conveyors, bucket elevators, overhead power-and-free lines).
The curve is **baked at export time**: `Spline.samples` is an arc-length
equidistant table of position, tangent and up vector, so a reader interpolates
instead of re-implementing Unity's spline mathematics, and the frames come from
Unity rather than from a reader-side parallel transport.

The reader builds the elements itself: it clones the `ChainElement` template
`NumberOfElements` times and drops any pre-existing child named
`<NameChainElement>_<n>` first, so a scene exported with Unity's edit-mode
preview does not deliver a second, stale set. Element `i` sits at
`StartPosition + i * delta`, where `delta` is `Length / NumberOfElements` while
`CalculatedDeltaPosition` is set and `DeltaPosition` otherwise.

Positions and lengths are **millimetres**; `Spline.length` and `Spline.samples`
are **metres in the chain node's local frame** (glTF convention). The position
of an element is `drivePosition + start + OffsetToDrivePosition`, converted to an
arc-length fraction over `ScaledOnFixedLength ? FixedLength : Length` — wrapping
by modulo on OPEN and closed splines alike, with the negative branch
`1 - |p| / length` (Unity `ChainElement.SetPosition()`, reproduced verbatim).
A missing `Spline` block, fewer than two samples, or an unresolvable
`ChainElement` makes the component inert with a warning; an unresolvable
`ConnectedDrive` places the elements but never moves them.

| Field | Type | Default | Description |
|---|---|---|---|
| `ConnectedDrive` | ComponentReference | - | Drive that moves the whole chain; unresolvable places the elements at their start positions without motion. |
| `chainOrientation` | enum(Horizontal, Vertical) | "Horizontal" | Vertical applies Unity's tangent-side flip of the element up vector. |
| `NumberOfElements` | number | 0 | Number of elements built from the template; 0 builds nothing. |
| `StartPosition` | number | 0 | Position of the first element along the chain, in millimeters. |
| `CalculatedDeltaPosition` | boolean | true | Derive the spacing from chain length divided by `NumberOfElements` instead of using `DeltaPosition`. |
| `DeltaPosition` | number | 0 | Manual spacing between two elements in millimeters; ignored while `CalculatedDeltaPosition` is set. |
| `ScaledOnFixedLength` | boolean | false | Scale the position fraction over `FixedLength` while the sample table stays tied to the real arc length. |
| `FixedLength` | number | 1500 | The length in millimeters the fraction is scaled over while `ScaledOnFixedLength` is set. |
| `ChainElement` | ComponentReference | - | The element template node (wire `componentType` `UnityEngine.Transform`); unresolvable makes the chain inert. |
| `NameChainElement` | string | "" | Base name of the generated elements; empty falls back to the template's node name. |
| `Spline` | object | - | Baked curve `{ closed, length, samples }` — `samples` flat `[px,py,pz, tx,ty,tz, ux,uy,uz]` per sample, arc-length equidistant, chain-node local, metres. |

```json
{ "Chain": { "ConnectedDrive": { "type": "ComponentReference", "path": "Line/ChainDrive", "componentType": "realvirtual.Drive" }, "NumberOfElements": 24, "CalculatedDeltaPosition": true, "ChainElement": { "type": "ComponentReference", "path": "Line/Chain/Carrier", "componentType": "UnityEngine.Transform" }, "NameChainElement": "Carrier", "Spline": { "closed": true, "length": 6.4, "samples": [0, 0, 0, 0, 0, 1, 0, 1, 0] } } }
```

#### 7a.51 ChainElement

Per-element configuration of a `Chain`, authored on the element **template**
node. It carries no behaviour of its own in a reader: the owning `Chain` reads
these fields and poses every clone, mirroring Unity's batch update
(`UseBatchUpdate`, which disables the per-element drive subscription).

| Field | Type | Default | Description |
|---|---|---|---|
| `AlignWithChain` | boolean | true | Align the element with the chain tangent; off writes only the position and leaves the template rotation. |
| `AlignVector` | Vector3 | - | Additional up reference in Unity local coordinates; unused on the Unity-spline path, where the baked up vectors are authoritative. |
| `InitialPosition` | number | 0 | Initial position of the element along the chain in millimeters; set by the `Chain` for generated elements. |
| `OffsetToDrivePosition` | number | 0 | Position offset of every element relative to the drive position, in millimeters. |

```json
{ "ChainElement": { "AlignWithChain": true, "OffsetToDrivePosition": 0 } }
```

#### 7a.53 RibbonRoller

A roller an endless web runs over — paper, film, foil, textile, sheet coil. It is
purely geometric: a contact radius, a rotation axis and the side the web lies on.
The reader turns it at `omega = v / r`, so a small idler visibly spins faster than
a large one, which is the cheapest and most convincing motion cue a converting
machine has.

Every roller of one `RibbonPath` must have a **parallel axis** (2 deg tolerance).
That is what makes the path a planar two-circle tangent problem rather than a
3D spline fit, and it is the reason turn bars and angled web guides are out of
scope for this component. `RadiusMm = 0` measures the radius from the mesh bounds
in the plane perpendicular to `Axis`, in the node's OWN local frame, so a scaled
parent cannot distort it.

`RibbonSide` is the wrap orientation seen along `+Axis`: `Left` wraps
counter-clockwise, `Right` clockwise. Two neighbouring rollers with the SAME side
are joined by an outer tangent, two with DIFFERENT sides by a crossed one — which
is precisely how an S-wrap is authored.

| Field | Type | Default | Description |
|---|---|---|---|
| `RadiusMm` | number | 0 | Contact radius in millimeters; 0 measures it from the mesh bounds perpendicular to `Axis` in the node's own local frame. |
| `Axis` | enum(X, Y, Z) | "X" | Local rotation axis of the roller and the common axis of the web path. |
| `RibbonSide` | enum(Auto, Left, Right) | "Auto" | Which side of the roller the web runs on. Leave it on `Auto`: for every normal machine `Auto` picks the short wrap, the only one a real web can take (on an end roller it means `Left`). Set `Left` or `Right` by hand only for an S-wrap or a wrap of more than 180 degrees. `Left` and `Right` are the turning sense seen along `+Axis` — `Left` counter-clockwise, `Right` clockwise. |
| `RotationDirection` | number | 1 | Deprecated and ignored. The resolved wrap and roller axis determine rotation automatically. |
| `SpinMode` | enum(Transform, Texture) | "Transform" | How the roller shows that it is turning. `Transform` turns the roller object. `Texture` leaves it standing still and scrolls the pattern on its barrel instead — the same at a glance, and free of per-frame work, which is worth having on a machine with many idlers. Only effective on a roller WITHOUT a drive. |
| `MantleMesh` | ComponentReference | - | Which part scrolls in `SpinMode: Texture` — normally the barrel. Leave it empty: the roller's own mesh is used, or the largest textured part under it outside a `Faces` node, so the end discs stay still. Wire `componentType` `UnityEngine.Transform` (the schema convention for a node reference). |
| `MantleMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to the barrel only while `OverrideMaterials` is true. |
| `FaceMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to every renderer under a child named `Faces`, only while `OverrideMaterials` is true. |
| `OverrideMaterials` | boolean | false | Overrides the CAD materials of `MantleMesh` (`MantleMaterialName`) and of every renderer under a `Faces` child (`FaceMaterialName`) at simulation start; restored at stop. An empty name leaves that part unchanged. |

**Driven or follower.** A roller is **driven** when a ROTATIONAL `Drive` sits on
the SAME node with an axis parallel or antiparallel to `Axis`. Its surface speed
`v = omega * pi / 180 * r * dot(driveAxis, rollerAxis) * contactSign` — with `omega` taken from
the drive POSITION difference of the tick, so it is signed for jog, `DriveTo`,
playback and `positionOverwrite` alike — is the web speed of its section. Every
other roller is a **follower** the path turns at `v / r * contactSign`. A linear drive, or one
whose axis is not parallel to the roller axis, warns once and leaves the roller a
follower. `contactSign` combines the resolved wrap side (including Auto) with the orientation of the roller axis relative to the path axis. The driven shaft remains controlled by its Drive; the winder controller uses the inverse of the same conversion. `RotationDirection` is ignored. Existing development models must have their shaft commands aligned with their contact direction; there is no version switch.

```json
{ "RibbonRoller": { "RadiusMm": 60, "Axis": "X", "RibbonSide": "Left", "SpinMode": "Transform" } }
```

#### 7a.54 RibbonWinder

An unwinder or rewinder at one END of a `RibbonPath`. It is a `RibbonRoller` whose
radius follows the wound length,

```
R(L) = sqrt(CoreRadiusMm^2 + L * RibbonThicknessMm / pi)
```

the standard integration-technology roll build-up written in radii. The length is
integrated and the radius derived from it (never the other way round), so a
rewinder run backwards returns exactly to its authored radius instead of drifting.

A `RibbonWinder` must be the **first or the last** entry of the path's `Rollers` list;
in the middle the path is inert with a warning. The growing roll is shown by
scaling the roll node radially in the two axes perpendicular to `Axis` — a CAD roll
needs no remodelling and no geometry is rebuilt per tick. The authored scale of
that node is remembered and restored on export, so a non-unit CAD scale survives a
round trip.

The roll node is **the winder node itself** whenever it carries geometry: the roll
IS the mesh, and its core is a `_Core` SIBLING, never a child — a child would scale
with the roll and the core would visibly grow. `RollMesh` exists for the two cases
that structure does not cover: an empty parent node with mesh children (the
plan-459 shape) and a separately modelled CAD roll. A winder with no geometry at
all gets a procedural cylinder, so it is never invisible.

`CoreRadiusMm` and `RibbonThicknessMm` must both be `> 0`; otherwise the winder is
inert with a warning and nothing in the scene ever sees a NaN. An empty unwinder
or a full rewinder stops every section and drive of the connected line and reports
an error. Brake faults and torn fabric use the same latched stop. Repair alone
never restarts the drives; simulation Reset clears the stop and restores the authored
roll supply. An initially empty rewinder can still collect fabric normally.

| Field | Type | Default | Description |
|---|---|---|---|
| `SpeedControl` | enum(None, LineSpeed, Dancer) | "None" | Hold web speed at the changing roll radius; Dancer adds position feedback. |
| `DancerGainPerMm` | number | 2 | Surface-speed trim in mm/s per millimeter of dancer error. |
| `MaxTrimPercent` | number | 20 | Maximum dancer trim as a percentage of line speed. |
| `RadiusMm` | number | 0 | Measured outer radius of the authored roll in millimeters; 0 measures it from the mesh bounds. |
| `Axis` | enum(X, Y, Z) | "X" | Local winding axis; must be parallel to every other roller axis of the path. |
| `RibbonSide` | enum(Auto, Left, Right) | "Left" | Side the web leaves or enters the roll on, as the wrap orientation seen along `+Axis`. |
| `WrapDeg` | number | 0 | How far the web is shown wrapping the roll in degrees, BEFORE it reaches the running tangent on an unwinder and AFTER it leaves it on a rewinder, so the band starts and ends visibly on the roll surface instead of at the tangent point in mid-air. 0 = the plan-459/460 geometry, unchanged. The sweep is used as given and is NOT folded into `[0, 2pi)`, so a value above 360 really is more than one lap. Read only on a winder that is the first or last entry of a path. |
| `RotationDirection` | number | 1 | Deprecated and ignored. The resolved wrap and roller axis determine rotation automatically. |
| `SpinMode` | enum(Transform, Texture) | "Transform" | How the winder shows that it is turning; see `RibbonRoller.SpinMode`. A winder that carries a drive is always turned by it, so `Texture` only applies to a dragged reel. |
| `MantleMesh` | ComponentReference | - | Which part scrolls in `SpinMode: Texture`; see `RibbonRoller.MantleMesh`. Leave it empty to use the winder's own mesh. Wire `componentType` `UnityEngine.Transform` (the schema convention for a node reference). |
| `MantleMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to the barrel only while `OverrideMaterials` is true. |
| `FaceMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to every renderer under a child named `Faces`, only while `OverrideMaterials` is true. |
| `OverrideMaterials` | boolean | false | Overrides the CAD materials of `MantleMesh` (`MantleMaterialName`) and of every renderer under a `Faces` child (`FaceMaterialName`) at simulation start; restored at stop. An empty name leaves that part unchanged. |
| `CoreRadiusMm` | number | 76.2 | Radius of the bare core in millimeters; must be `> 0`. The default is the 3 inch core of the converting industry. |
| `RibbonThicknessMm` | number | 0.1 | Thickness of one wound layer in millimeters (the caliper). With the core radius it decides how fast the roll grows and shrinks. Must be the SAME value as `RibbonPath.RibbonThicknessMm` — it is the same material — and `> 0`. |
| `InitialWoundLengthMm` | number | -1 | How much material is on the roll at load and after a reset. `-1` = a full roll exactly as modelled (derived from the modelled outer radius), `0` = an empty core, any other value = that many millimeters on the roll. |
| `MaxDiameterMm` | number | 0 | Diameter in millimeters at which the roll counts as full and the group stops; 0 = no limit. |
| `RollMesh` | ComponentReference | - | Which part grows and shrinks with the roll. Leave it empty: the winder object IS the roll and is scaled directly. Model the core as a SIBLING, never a child. Set it only for a separately modelled roll or a winder object without geometry of its own (which then gets a plain cylinder). Wire `componentType` `UnityEngine.Transform` (the schema convention for a node reference). |
| `DiameterMm` | ComponentReference | - | Signal carrying the current roll diameter in millimeters; written only on a change of more than 0.1 mm. |
| `WoundLengthMm` | ComponentReference | - | Signal carrying the currently wound web length in millimeters. |
| `Empty` | ComponentReference | - | Signal is true while the roll is down to its bare core; an empty winder stops its whole path group. |
| `Full` | ComponentReference | - | Signal is true once `MaxDiameterMm` is reached; a full winder stops its whole path group. |

```json
{ "RibbonWinder": { "CoreRadiusMm": 76.2, "RibbonThicknessMm": 0.1, "InitialWoundLengthMm": -1, "MaxDiameterMm": 800, "RollMesh": { "type": "ComponentReference", "path": "Slitter/Unwinder/Roll", "componentType": "UnityEngine.Transform" } } }
```

#### 7a.55 RibbonPath

One taut web running over an ordered, **OPEN** chain of rollers — from the first
entry of `Rollers` to the last, both usually winders. Nothing about the path
geometry is exported: the reader computes the tangents and wrap arcs from the
roller poses and radii itself, and rebuilds them only when a winder radius or a
roller transform actually changed. Plain motion costs a texture offset and one
rotation per roller.

By default the web is **taut**: the path is exactly the tangents plus the wrap
arcs. Lengths, radii and thicknesses are **millimeters**, speeds **millimeters
per second**; the only conversion to glTF metres happens where the band mesh is
written.

**Tension.** Setting `TensileStiffnessNPerMmWidth > 0` turns the taut web into a
strained one. The path is then partitioned into **zones** between consecutive
BOUNDARY rollers — the first roller, the last roller, every driven roller and the
dancer — and each zone carries one signed strain `eps`, integrated from the
standard span model of web handling,

```
L * d(eps)/dt = (v_B - v_A) + eps_in * v_A - eps * v_B
```

with `L` the mechanical length of the zone (its line segments plus the wrap arcs
of the idlers inside it, never the arcs at its own boundaries). A driven boundary
contributes its OWN surface speed, even where its section is led by a roller
further downstream — that difference is the only thing that ever builds tension.
An end roller WITHOUT a drive is dragged by the nearest driven roller in the
direction the web reaches it from (the first one downstream for the unwinder, the
first one upstream for the rewinder), and falls back to its section speed when
that side has none. Tension follows
from the strain as `T = K * w * eps`, and a slack zone (`eps < 0`) carries none —
its excess length `|eps| * L` visibly sags instead. `eps = 0` reproduces the taut
geometry exactly, and a stiffness of `0` never builds the partition at all, so a
document without tension is bit-identical to a pre-tension reader.

A dancer with `LoadN > 0` is a tension SETTER: it imposes `T = LoadN / Strands`
on both of its neighbouring zones algebraically and immediately, while its
carriage keeps following the speed difference alone. Tension is not supported on
slit paths (`SlitAtRoller` / `FullWidthMm`) in this revision — the strips share a
web before the cut and would have to share a strain; such a path reports it once
and runs untensioned.

A slitter is modelled as N `RibbonPath`s that share one unwinder (and the rollers up to the cutter, which is their `SlitAtRoller`). Paths sharing a
roller form ONE group, so an empty or full roll anywhere in the group stops every
strip in the same tick, and each winder's length is integrated exactly once.

**Where the cut is.** The slit sits at the **arrival** tangent point of
`SlitAtRoller` — where the web first touches the cutting roller, which is where
the blade sits. It is deliberately not the departure point: two strips cut at one
roller LEAVE it at different angles, because their next rollers differ, so a cut
at the departure point made the strip that draws the shared full-width web cover
an arc its sibling was already drawing in its own lane, and the two z-fought on
the roller. Cutting on arrival gives every strip the same slit sample, and each
of them draws only itself from there on.

That only holds because the band's samples sit on an **absolute** arc-length
grid: sample `i` at `i * 1000 / SamplesPerMeter` mm, with the last sample on the
path end and therefore a shorter final interval. A grid derived from the total
length instead would put the same physical point at different arc positions for
two strips that end at different rewinders, and the cut would drift by up to one
sample between them. Strips slit at one roller must share `SamplesPerMeter`.

Up to the cut the strips are ONE web, so their wrap **side** at every shared
roller must agree. With `RibbonSide: Auto` the side is resolved per PATH, and two
strips that leave the cutter in different directions can resolve a shared roller
differently — which would put the shared part on two different tangent lines. The
reader reports that once per document and keeps drawing; the fix is to move the
offending roller or to pin `RibbonSide` on the shared rollers.

**Sections.** Each `RibbonDancer` in `Rollers` splits the path into sections at its
own departure tangent point. A section runs at the surface speed of its **last**
driven roller in running direction (the pulling one); several driven rollers in one
section that differ by more than 1 % warn once, because slip is not simulated. A
section without a driven roller takes the next driven section in running direction,
and a trailing one the previous; a path with no driven roller at all stands still
with a warning. Each section scrolls its own band material, so the two sides of a
dancer visibly run at different speeds.

An unresolvable roller, a winder in the middle of the list, a roller axis
deviating by more than 2 deg, or two rollers whose circles admit no tangent all
make the path inert with a named warning; the rollers then simply stand still.

| Field | Type | Default | Description |
|---|---|---|---|
| `Rollers` | ComponentReference[] | - | Rollers in running order; first and last entry are the ends of the open path and are usually winders. |
| `ConnectedDrive` | ComponentReference | - | **Deprecated and ignored** since plan-460; kept so a plan-459 document still validates (`deprecated: true`, so the inspector hides the row while it is empty). The web is moved by rotational drives on the rollers instead. Loading a document that still sets it logs one warning. |
| `SpeedSource` | enum(Drive, RibbonWinder) | "Drive" | **Deprecated and ignored** since plan-460 (`deprecated: true`); see `ConnectedDrive`. The speed source is always the driven rollers of the path. |
| `RibbonWidthMm` | number | 500 | Width of the web in millimeters, extruded along the common roller axis. |
| `RibbonThicknessMm` | number | 0.1 | Thickness of the material in millimeters; half of it lifts the web off the roller surface so the two do not intersect. Must be the SAME value as `RibbonWinder.RibbonThicknessMm` on the winders of this path. |
| `TextureLengthMm` | number | 1000 | How much web one repetition of the surface pattern covers, in millimeters. It is what makes a running web look like it is running; a larger value gives a coarser pattern that appears to move more slowly. |
| `SamplesPerMeter` | number | 64 | How finely the web strip is subdivided, in points per meter of path. Raise it when a tight wrap looks angular, lower it on a very long run. Samples sit on an ABSOLUTE grid of one point every `1000 / SamplesPerMeter` mm, so strips slit at one roller must share the value to be cut at the same place. A path that outgrows its sample buffer has its density reduced automatically (with a console message); it is then on a coarser grid than its siblings and its cut moves by a fraction of a sample, which the reader reports naming both webs. |
| `Material` | ComponentReference | - | Optional LEGACY node reference. A NODE whose material the web copies — a printed pattern, a coloured film. It points at an object in the scene, not at a material asset; the web takes the first textured material found on it, copies ALL of its maps (colour, normal, roughness, …) and owns the copies, so scaling and scrolling the web never touches the donor part. `MaterialName` takes PRECEDENCE over it. Both empty = a plain paper-white surface with a pattern. Wire `componentType` `UnityEngine.Transform`. |
| `MaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. It takes precedence over `Material`. |
| `SlitAtRoller` | ComponentReference | - | Optional inner roller (the cutter) at which the full web is slit into this strip. The cut sits where the web MEETS that roller (its **arrival** tangent point), which is where the blade is: full web (`FullWidthMm`, centred on the first roller) before it, this strip (`RibbonWidthMm`) in its own lane at the last roller's axial offset from it on. Every strip cut at the same roller therefore reports the same slit point. Only the first strip (by node path) of those slit at one roller draws the shared part. |
| `FullWidthMm` | number | 0 | Width of the full web before `SlitAtRoller`; 0 = not a slit strip. |
| `BasisWeightGsm` | number | 20 | Basis weight in grams per square metre. It normalises the tension into a specific tenacity (N*m/kg) so two webs of different grammage become comparable. Display only — it changes no force. |
| `TensileStiffnessNPerMmWidth` | number | 0 | Secant tensile stiffness in MD, newtons per millimetre of width at 100 % strain, read off the strip tensile curve (EDANA/INDA NWSP 110.4) as a secant at the working point. **This is the switch for the whole tension model**: `0` (the default) means no tension, no strain, no sag, no colouring, and the web behaves exactly as it did before. `E*A` is deliberately not the input — the caliper of a nonwoven is compressible and not uniquely defined. |
| `MinStrainPercent` | number | 0 | Strain below which the web counts as SLACK, in percent. Raises an alarm and colours the web cyan; clamps nothing. |
| `MaxStrainPercent` | number | 2 | Strain above which the web counts as OVERSTRETCHED, in percent. Raises an alarm and colours the web magenta; clamps nothing. A working limit, not the breaking point. |
| `BreakForceNPer50mm` | number | 35 | MD strip tensile force at break, newtons per 50 mm of width — the number on the data sheet. Reaching the strain it implies sets `IsBroken` and FREEZES that zone's strain until a reset; it is the only threshold that clamps anything. `0` disables breaking. |
| `TargetTensionNPerM` | number | 100 | Set-point tension per unit width in newtons per metre: the entry strain the unwinder pays out at, the start and reset value of every zone, and the centre of the tolerance band. 0.3 to 3.0 PLI covers 80 % of all webs (1 PLI = 175.1 N/m). |
| `ToleranceBandPercent` | number | 10 | Half-width of the good band around `TargetTensionNPerM`, in percent of it. Inside the band the web is not tinted at all, with a hard edge at the limit. |
| `EnableSag` | boolean | true | Whether a slack web visibly hangs through. Off leaves the geometry taut while strain, signals and colouring keep reporting the slackness. |
| `TensionColoring` | boolean | true | Whether the band is tinted by its tension state. Off leaves the material untouched and reports through signals and readout only. |
| `TintStrength` | number | 0.7 | How strongly the tint is mixed into the band material, 0 to 1. The good band is never tinted whatever this is. |
| `DeformationScale` | number | 1 | Visual exaggeration of the sag DEPTH only. At realistic strains the sag is a fraction of a millimetre; raising this makes it visible for a demonstration without touching tension, strain, signals or the band. |
| `ShowTensionLabels` | boolean | false | Whether the tension overlay is drawn: a readout per zone (N/m, PLI, strain, trend arrow) and, on a loaded dancer, a force arrow with the carriage travel bar. |
| `TensionN` | ComponentReference | - | Signal carrying the web tension of the LAST zone in newtons; written only on a real change. |
| `SpecificTensionNPerM` | ComponentReference | - | Signal carrying the tension of the LAST zone per unit width in newtons per metre — the regulated variable; written only on a change of more than 0.5 N/m. |
| `StrainPercent` | ComponentReference | - | Signal carrying the strain of the LAST zone in percent; written only on a change of more than 0.01 %. |
| `IsSlack` | ComponentReference | - | Signal is true while ANY zone is below `MinStrainPercent`. |
| `IsOverstretched` | ComponentReference | - | Signal is true while ANY zone is above `MaxStrainPercent`. |
| `IsBroken` | ComponentReference | - | Signal is true once ANY zone reached the break strain. That zone's strain is frozen from then on; only a simulation reset clears it. |

```json
{ "RibbonPath": { "Rollers": [ { "type": "ComponentReference", "path": "Slitter/Unwinder", "componentType": "UnityEngine.Transform" }, { "type": "ComponentReference", "path": "Slitter/Idler_01", "componentType": "UnityEngine.Transform" }, { "type": "ComponentReference", "path": "Slitter/Rewinder_A", "componentType": "UnityEngine.Transform" } ], "RibbonWidthMm": 500, "TextureLengthMm": 1000 } }
```

#### 7a.56 RibbonDancer

A dancer roller: a `RibbonRoller` that also **travels** along an axis and thereby
stores web. It is the component that lets two drives of one machine run at slightly
different surface speeds without the web going slack or tearing — the store takes
up the difference, and the PLC regulates on the carriage position.

The dancer splits its `RibbonPath` into an upstream and a downstream section at its
own departure tangent point, and integrates the difference of the two section
speeds:

```
L = L + (v_up - v_down) * dt          position = HomeMm + L / Strands
```

It is an **integrator with anti-windup**, not a spring: when the carriage is
clamped at a stop, `L` is recomputed from the clamped position, so a reversal takes
effect immediately instead of first running out a length the machine never had.

The limits are **directional and never stop a drive**. At `TravelMaxMm` only further
filling is prevented (`v_up` is held at `v_down`); at `TravelMinMm` only further
emptying (`v_down` is held at `v_up`). The web keeps running at the slower side and
the opposite delta always frees the carriage again — a symmetric stop would deadlock
at zero. Winder `Empty` / `Full`, by contrast, still stop every section of the group.

A jammed carriage stores no fabric and no longer imposes load-balanced tension.
Its roller can still rotate, but both contacts use one transport speed; a speed
mismatch therefore changes the span strain. A jam at matching speeds need not
tear the fabric. If the fabric does tear, the connected-line stop latches.

Exactly **one** dancer per path is supported; a second is ignored with a warning, and
so is a dancer at the first or last position of `Rollers` (it would have no section on
one side). A dancer shared by several strips is only legal when both of its
neighbouring sections resolve to the same driven roller for every strip — in practice,
when it sits before the slit; otherwise it is held at `HomeMm` for the whole group with
one warning.

| Field | Type | Default | Description |
|---|---|---|---|
| `ShowTravel` | boolean | false | Show carriage track, stops and position marker. |
| `ShowValues` | boolean | false | Show dancer force, tension and position readouts. |
| `RadiusMm` | number | 0 | Contact radius in millimeters; 0 measures it from the mesh bounds perpendicular to `Axis`. |
| `Axis` | enum(X, Y, Z) | "X" | Local rotation axis; must be parallel to every other roller axis of the path. |
| `RibbonSide` | enum(Auto, Left, Right) | "Auto" | Which side of the dancer roller the web runs on. Leave it on `Auto`: the carriage moves, and `Auto` follows it by always picking the short wrap. `Left` / `Right` (the turning sense along `+Axis`) only for an S-wrap or a wrap over 180 degrees. |
| `RotationDirection` | number | 1 | Deprecated and ignored. The resolved wrap and roller axis determine rotation automatically. |
| `SpinMode` | enum(Transform, Texture) | "Transform" | How the dancer roller shows its rotation; see `RibbonRoller.SpinMode`. |
| `MantleMesh` | ComponentReference | - | Mesh scrolled in `SpinMode: Texture`; see `RibbonRoller.MantleMesh`. |
| `MantleMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to the barrel only while `OverrideMaterials` is true. |
| `FaceMaterialName` | string | "" | Name of a material of the ribbon material library (Unity: `Resources/realvirtual/RibbonMaterialLibrary`). In the browser the name is resolved against the materials of the LOADED document — exactly, then ignoring case, first match wins. Unity writes the library material into the exported GLB under exactly this name, so a document exported from Unity always resolves. Empty = not used. Applied to every renderer under a child named `Faces`, only while `OverrideMaterials` is true. |
| `OverrideMaterials` | boolean | false | Overrides the CAD materials of `MantleMesh` (`MantleMaterialName`) and of every renderer under a `Faces` child (`FaceMaterialName`) at simulation start; restored at stop. An empty name leaves that part unchanged. |
| `TravelAxis` | enum(X, Y, Z) | "Y" | The direction the carriage runs in, in the frame of the object the dancer hangs under — the same axis letters as `RibbonRoller.Axis`. Place the dancer so that moving along the POSITIVE axis lengthens the web path. |
| `TravelMinMm` | number | -200 | Lower stop in millimeters relative to `HomeMm`; must be `<= 0`. Reaching it sets `AtMin`. |
| `TravelMaxMm` | number | 200 | Upper stop in millimeters relative to `HomeMm`; must be `>= 0`. Reaching it sets `AtMax`. |
| `HomeMm` | number | 0 | Rest position in millimeters along `TravelAxis`, relative to the authored node position; 0 starts and resets exactly where it was modelled. |
| `Strands` | number | 2 | How many runs of web pass through the carriage. `1` = a single pass over the roller, `2` (default) = the usual loop down to the carriage and back up. 1 mm of travel then stores `Strands` mm of web; must be at least 1. |
| `PositionMm` | ComponentReference | - | Signal carrying the carriage position in millimeters; written only on a change of more than 0.1 mm. This is the variable a tension controller regulates. |
| `AtMin` | ComponentReference | - | Signal is true while the carriage sits at `TravelMinMm` (the store is empty). |
| `AtMax` | ComponentReference | - | Signal is true while the carriage sits at `TravelMaxMm` (the store is full). |
| `LoadN` | number | 0 | Force the loaded carriage presses into the web, in newtons. The dancer as a tension SETTER: the force balance at the carriage gives `T = LoadN / Strands`, which becomes the tension of both neighbouring zones immediately and algebraically. The carriage POSITION keeps following the speed difference alone, so changing the load at equal speeds moves nothing. `0` is the purely kinematic dancer. Needs `RibbonPath.TensileStiffnessNPerMmWidth > 0` to have any effect. |
| `TensionN` | ComponentReference | - | Signal carrying the tension this dancer imposes, in newtons (`LoadN / Strands`); written only on a real change. |

```json
{ "RibbonDancer": { "Axis": "Z", "TravelAxis": "Y", "TravelMinMm": -150, "TravelMaxMm": 150, "Strands": 2, "PositionMm": { "type": "ComponentReference", "path": "Slitter/Signals/DancerPos", "componentType": "realvirtual.PLCInputFloat" } } }
```

#### 7a.57 TransportStopper

Box collider for contact stopping on accumulating linear transport surfaces. The collider follows its node and axis; lifting it clear releases the MU while the belt may continue running. Applies to kinematic transport, not physics-owned MUs or radial surfaces. Rotated colliders use conservative world-axis bounds.

| Field | Type | Default | Description |
|---|---|---|---|
| `Enabled` | boolean | true | Enables contact blocking. |
| `Center` | Vector3 | {"x":0,"y":0,"z":0} | Local glTF collider center in mm. |
| `Size` | Vector3 | {"x":100,"y":100,"z":100} | Positive local collider dimensions in mm. |

#### 7a.66 Zone

Web-authored effect box on a node (plan-521). The box (`Center`/`Size`, local glTF millimetres) moves with its node and carries any combination of three effects on MUs: **Detect** (occupied/free), **Block** (stop kinematically transported MUs at contact, same contact rule as `TransportStopper`) and **Hold** (take MUs off the transport and carry them with the node). An activation switches the effects on and off: `Always`, a bool signal (`Signal`) or a drive standing inside a position window (`Axis`). A Unity counterpart is not defined yet; a Unity round trip keeps the extras unchanged.

**Authoring rules:**
- Set at least one of `Detect`, `Block`, `Hold`; a zone without an effect does nothing and is reported by the reader.
- `Activation` `Signal` needs `ActivationSignal` (a bool signal reference); `InvertSignal` makes the zone active while that signal is false.
- `Activation` `Axis` needs `ActivationDrive` (`componentType` `Drive`). The zone is active only while the drive position lies inside `AxisFrom`..`AxisTo` (inclusive, in the drive's millimetres or degrees) AND the drive stands still — any motion (running, jogging, behaviour-driven) deactivates it.
- Put the zone on the node that carries the effect: a stopper plate, a lift, a clamp. The box follows that node's axis; with `Always` a moving box blocks as soon as it crosses the path.
- `Hold` attaches contained MUs to the zone node. `HoldAcquire` `OnActivate` takes the MUs inside the box at the moment the zone becomes active, `WhileActive` also takes MUs that enter later; `HoldCount` `One` holds at most one MU in total (the one nearest the box center).
- `SingleRelease` (plan-530) needs `Block` and is meant for zones on stoppers: each lowering releases exactly one MU — the one waiting at the stopper face, or, if none waits, the first one that arrives — and every following MU is caught at the face of the raised (home) box, even when it touches the released one (belt MinGap 0 on the `TransportSurface`). The stopper must START raised: the home box is the box at load time. Lowered means the box left the home box by more than 1 mm (a geometric departure only); a zone on a carrier that moves for other reasons (a lift) would release on every move. A zone made inactive by its activation (`Signal` / `Axis` false) is completely off: it blocks nothing — also not at the home face —, detects nothing, drops its release token and is armed again for the next activation (plan-539). It is ignored while `Hold` is on; the reader reports `SingleRelease` without `Block` and with `Hold`.

**Reference implementation notes (informative):**
- Detect with `Block` tests against the box grown by 1 mm on each side, so a part stopped in front of the box stays reported as occupied.
- On deactivation a held MU is put back onto a transport surface below it (lowered onto its top), otherwise onto the nearest free `GripTarget` within `GripTargetSearchRadius`, otherwise it stays where it is.
- An MU held by a `Grip` or a connection hold is never taken by a zone, and a zone never releases an MU it does not hold.

| Field | Type | Default | Description |
|---|---|---|---|
| `Center` | Vector3 | {"x":0,"y":0,"z":0} | Box center in local glTF coordinates, in millimetres. |
| `Size` | Vector3 | {"x":100,"y":100,"z":100} | Positive box dimensions along the local axes, in millimetres. |
| `Detect` | boolean | true | Reports whether an MU occupies the box (or is held by it) while the zone is active. |
| `Block` | boolean | false | Stops kinematically transported MUs at contact with the box while the zone is active. |
| `Hold` | boolean | false | Takes MUs inside the box off the transport and carries them with the node while the zone is active. |
| `Activation` | enum(Always, Signal, Axis) | "Always" | When the effects act. |
| `ActivationSignal` | ComponentReference | - | Bool signal that activates the zone when `Activation` is `Signal`. |
| `InvertSignal` | boolean | false | If true the zone is active while `ActivationSignal` is false. |
| `ActivationDrive` | ComponentReference | - | Drive whose position activates the zone when `Activation` is `Axis`. |
| `AxisFrom` | number | 0 | Lower end of the activation window (drive millimetres or degrees, inclusive). |
| `AxisTo` | number | 0 | Upper end of the activation window (drive millimetres or degrees, inclusive). |
| `SignalOccupied` | ComponentReference | - | Optional bool signal written with the Detect result on every change. |
| `HoldAcquire` | enum(OnActivate, WhileActive) | "OnActivate" | When contained MUs are taken. |
| `HoldCount` | enum(All, One) | "All" | All contained MUs, or at most one in total. |
| `GripTargetSearchRadius` | number | 500 | Search radius in millimetres for a free GripTarget on release. |
| `ShowGizmo` | boolean | true | Shows the box in the editor and during a test run. |
| `SingleRelease` | boolean | false | With `Block` on a stopper: one MU per lowering, the follower is caught at the raised face. |

```json
{ "Zone": { "Center": { "x": 0, "y": -97.5, "z": 0 }, "Size": { "x": 10, "y": 295, "z": 150 }, "Detect": true, "Block": true, "Activation": "Axis", "ActivationDrive": { "type": "ComponentReference", "path": "Station/Stopper05", "componentType": "realvirtual.Drive" }, "AxisFrom": -15, "AxisTo": -15 } }
```

#### 7a.58 Fmu

FMI 2.0 Co-Simulation unit attached to a node in the web asset editor. The `.fmu` package is embedded in the same GLB as a standard glTF `bufferView` (one per SHA-256); the file-level list of those views is `asset.extras.realvirtual.fmuBufferViews`. A reader creates one signal child per supported variable (`<node>/Signals/<variable>`, signal name `<node>.<variable>`) — these children are never stored. v1 maps Real → Float, Integer/Enumeration → Int, Boolean → Bool; String variables have no signal. The FMU runs only in realvirtual CONNECT.

| Field | Type | Default | Description |
|---|---|---|---|
| `StepSize` | number | 0.01 | Communication step size in seconds. |
| `Tolerance` | number | 0.000001 | Relative tolerance handed to the FMU solver. |
| `AllowViewerToFmu` | boolean | true | If true the viewer may write the FMU inputs (CONNECT AllowWebToPlc). |
| `FmuEmbed` | object | {} | Package metadata (fileName, sha256, guid, modelName, fmiVersion, generationTool, generationDateAndTime, byteLength) and the `bufferView` holding the bytes; -1 = saved without bytes. |
| `FmuVariables` | object[] | [] | Model variables from modelDescription.xml: name, valueReference, causality, variability, type, start, unit, description; since plan-502 optionally initial, min, max, declaredType and enumItems (`[{name, value}]`). |
| `FmuStartOverrides` | object | {} | Start-value overrides by variable name, value as string (`{"e": "0.95"}`). Allowed for inputs and non-constant parameters; applied by CONNECT when the instance starts. A name that matches no allowed variable is kept but not applied. |
| `RestartOnReset` | boolean | true | If true a simulation reset (Play/Reset) restarts the running FMU instance. |
| `FmuUnits` | object | {} | `UnitDefinitions` of modelDescription.xml: unit name → FMI `BaseUnit` (`{"m": 1, "s": -1, "factor": 1, "offset": 0}`; exponents m, s, rad, kg, K, A, mol, cd). A reader resolves the unit of each FMU signal through it before its own table (plan-512); absent in packages attached before that. |

```json
{ "Fmu": { "StepSize": 0.01, "AllowViewerToFmu": true, "FmuEmbed": { "fileName": "Feedthrough.fmu", "sha256": "9c1e…", "guid": "{37B954F1-…}", "modelName": "Feedthrough", "fmiVersion": "2.0", "byteLength": 194352, "bufferView": 12 }, "FmuVariables": [ { "name": "Float64_continuous_input", "valueReference": 7, "causality": "input", "variability": "continuous", "type": "Real", "start": "0" } ] } }
```

#### 7a.59 MechanismTarget

Waypoint of a `MechanismPath`: the node's own world position is the position the
path's `TargetLink` origin moves to (the `IKTarget` / `KinematicTarget`
convention — authored by moving the node, there is no position field).

| Field | Type | Default | Description |
|---|---|---|---|
| `Mechanism` | ComponentReference | - | Optional `KinematicMechanism` this waypoint belongs to; absent = inherited from the path. |
| `InterpolationToTarget` | enum(Linear, PointToPoint) | "Linear" | Linear = straight Cartesian line with a trapezoid profile; PointToPoint = joint space with synchronised arrival of all driving Drives. |
| `SpeedToTarget` | number | - | Optional override. Linear: path speed in mm/s. PointToPoint: factor on the Drives' own speeds. Absent = path default. |
| `WaitForSeconds` | number | 0 | Dwell time in seconds after the waypoint is reached. |
| `SetSignal` | ComponentReference | - | Bool signal set when the waypoint is reached and reset when the path leaves it. |
| `WaitForSignal` | ComponentReference | - | Bool signal the path waits for (true) after the waypoint is reached. |

```json
{ "MechanismTarget": { "InterpolationToTarget": "PointToPoint", "WaitForSeconds": 0.2 } }
```

#### 7a.60 MechanismPath

Cartesian path for a `KinematicMechanism` (Delta and any other inversely
solvable mechanism): moves the `TargetLink` origin through an ordered list of
`MechanismTarget` waypoints using the mechanism's inverse solve. A waypoint that
cannot be reached stops the path — `SignalEnded` stays low; the path is never
silently clamped onto the closest reachable pose.

| Field | Type | Default | Description |
|---|---|---|---|
| `Mechanism` | ComponentReference | - | The `KinematicMechanism` whose driving Drives the path moves. |
| `TargetLink` | ComponentReference | - | The mechanism's own link (e.g. a Delta platform) whose origin follows the path. |
| `Path` | ComponentReference[] | - | Ordered list of MechanismTarget references forming the path. |
| `SignalStart` | ComponentReference | - | Bool signal whose rising edge starts the path. |
| `SignalIsStarted` | ComponentReference | - | Bool signal that is true while the path runs. |
| `SignalEnded` | ComponentReference | - | Bool signal set when the path ended regularly. |
| `LoopPath` | boolean | false | Restarts the path after it has ended. |
| `SpeedOverride` | number | 1 | Speed factor for the whole path. |
| `LinearSpeedToTarget` | number | 500 | Linear path speed in millimeters per second. |
| `LinearAcceleration` | number | 1000 | Linear path acceleration and deceleration in millimeters per second squared. |
| `Trajectory` | ComponentReference | - | Optional `MechanismTrajectory` (plan-501). Set = the path plays the trajectory's samples back on the simulation clock instead of its waypoint list. |
| `ShowPath` | boolean | false | Always draws the path in the viewer, not only while the mechanism is selected (plan-511): the waypoints, or the trajectory the path plays. |

Raw fields (`rawFields`):

| Raw field | Type | Notes |
|---|---|---|
| `StartNextPath` | object | ComponentReference to the MechanismPath started when this path ends |

```json
{ "MechanismPath": { "LoopPath": true, "TargetLink": { "type": "ComponentReference", "path": "Delta/Platform", "componentType": "UnityEngine.Transform" }, "Path": [ { "type": "ComponentReference", "path": "Delta/Paths/WP_Pick", "componentType": "MechanismTarget" } ] } }
```

#### 7a.61 MechanismTrajectory

A sampled Cartesian TCP path of a `KinematicMechanism` plus a payload — one
drive-sizing case (plan-501). A sizing run pushes every sample through the
inverse solve, the forward solve and the inverse dynamics in the trajectory's
own raster (not the 60 Hz simulation tick) and exports velocity, acceleration
and drive torque per driven axis. `Samples` is validated on every input path
(CSV import, GLB load, field edit, run, playback): 2 to 20000 finite triples,
positive raster, output raster a whole multiple of it — a violation marks the
component invalid and refuses run and playback.

| Field | Type | Default | Description |
|---|---|---|---|
| `Mechanism` | ComponentReference | - | The `KinematicMechanism` the trajectory is sized for. Required. |
| `TargetLink` | ComponentReference | - | The mechanism link carrying the TCP (a Delta: the platform). Required. |
| `Name` | string | "trajectory" | Name of the sizing case; prefix of the exported axis files. |
| `Samples` | number[] | - | Flat `[x0, y0, z0, x1, …]` TCP positions in millimeters in the mechanism root frame, uniform raster. |
| `SampleIntervalMs` | number | 2 | Raster of the samples in milliseconds. |
| `Frame` | enum(z-up, y-up) | "z-up" | Axis convention of the samples. `z-up` is converted to the viewer's y-up as `(x, z, −y)`. |
| `TcpOffsetMm` | Vector3 | - | TCP relative to the `TargetLink` origin, link-local millimeters — the point the samples describe. |
| `PayloadMassKg` | number | 0 | Payload carried by the `TargetLink`, modelled as a point mass, in kilograms. |
| `PayloadOffsetMm` | Vector3 | - | Payload centre of mass in the `TargetLink`'s local frame, millimeters. |
| `OutputIntervalMs` | number | 4 | Row raster of the exported axis files in milliseconds; a whole multiple of `SampleIntervalMs`. |
| `ShowPath` | boolean | false | Always draws the path in the viewer, not only while the mechanism is selected (plan-511). |

```json
{ "MechanismTrajectory": { "Name": "cycle_404_260", "Samples": [-190, 0, -280, -190, 0, -280], "SampleIntervalMs": 2, "Frame": "z-up", "TcpOffsetMm": { "x": 0, "y": 0, "z": -19 }, "PayloadMassKg": 0.26, "OutputIntervalMs": 4 } }
```

### 7b. Logic Steps

Logic steps describe sequential control logic. A node carrying a `LogicStep_*`
component is one step; **hierarchy order defines execution order** inside a
container. The top-level `LogicStep_SerialContainer` loops automatically. The
`Active` field on every step is an `ActiveOnly` gate (Section 7c table footnote):
`enum(Always, Connected, Disconnected, Never, DontChange)`, default `"Always"`.

`Active` is evaluated on every **top-level** logic root (a step node whose parent
is no step node — also inside a placed asset), each root on its own; `DontChange`
counts as `Always`. A root runs only while it is active for the current
connection state: it does not start (and writes nothing) while inactive — also
when the connection already exists before the model loads. On a change of the
connection state all deactivations complete before any activation starts. A
deactivated root cancels its running steps, stops the motion its steps started
and still command, and writes the output signals its set-signal steps write back
to their start value — except signals another active root writes and signals
that are bound, forced or remote-owned. A reactivated root starts again at its
first step. A simulation reset resets the outputs of the active roots the same
way, re-initialises component feedback from the plant state and then starts the
roots that are active for the current state. A runtime warns at load when an
output or a drive is shared between roots with different `Active`.

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
| `Edge` | enum(Level, Rising, Falling) | "Level" | Level waits for the expected value; Rising/Falling wait for the first false-to-true/true-to-false change after the step started (WaitForTrue is then ignored). |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

With `Edge` = `Rising` / `Falling` the signal value is sampled when the step
starts; a level that is already high (low) does not finish the step.

#### 7b.5 LogicStep_WaitForSensor

| Field | Type | Default | Description |
|---|---|---|---|
| `Sensor` | ComponentReference | - | Sensor to wait for. |
| `WaitForOccupied` | boolean | true | If true waits for occupied, otherwise for not occupied. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |
| `WaitForStopped` | boolean | false | Also requires the detected MU to be blocked by accumulation or a transport stopper. Ignored when waiting for the sensor to clear. |


#### 7b.29 LogicStep_WaitForZone

Waits until a `Zone` reports occupied (or free). The zone's Detect result is read; a zone without the Detect effect never reports occupied.

| Field | Type | Default | Description |
|---|---|---|---|
| `Zone` | ComponentReference | - | Zone to wait for. |
| `WaitForOccupied` | boolean | true | If true waits for occupied, otherwise for free. |
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

#### 7b.27 LogicStep_MechanismPath

Starts a MechanismPath and waits until it ended. A path stopped on an
unreachable waypoint does not end, so the step keeps waiting.

| Field | Type | Default | Description |
|---|---|---|---|
| `MechanismPath` | ComponentReference | - | MechanismPath to start; the step waits until the path ended. |
| `Active` | ActiveOnly | - | Connection-state gate: whether this step participates depending on the live-connection state. |

#### 7b.28 LogicStep_JavaScript

Web-only sequence step. A `WebComponent` script on the node completes it with
`self.logicStep(self.path).complete()`.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | boolean | true | If false the step is skipped. |

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
additional memberships under the keys `Group_1`, `Group_2`, ... with the same shape.

**Authoring rules:**
- The first membership is the key `Group`; every further membership of the same node uses `Group_N` (`Group_1`, `Group_2`, …) with the same fields. Keys without the underscore (`Group1`) are not group memberships.
- A `Kinematic` with `IntegrateGroupEnable` collects every node whose `GroupName` matches its own `GroupName`; to put a node on an axis, give it a `Group` with that axis' group name.
- A group entry whose `_enabled` is false is ignored; the node's other entries stay valid.

**Reference implementation notes (informative):**
- Group-only nodes carry no geometry of their own after the realvirtual WEB bake: their meshes become a partition of the enclosing chunk, which the Groups panel hides and isolates by group name.

| Field | Type | Default | Description |
|---|---|---|---|
| `GroupName` | string | "Group" | Name of the group this node belongs to. |
| `GroupNamePrefix` | string | - | Scene path of a node whose name prefixes GroupName (resolved group name = prefixNode.name + GroupName). Shown when present in the GLB, never stamped on newly authored components. |

#### 7d.2 Kinematic

Post-load re-structuring directive from the Unity Kinematic tool.

**Authoring rules:**
- With `IntegrateGroupEnable` the top-level nodes of the group `GroupName` (nodes carrying a `Group` or `Group_N` entry with that name) are re-parented under this node, keeping their world pose; a member below another member moves with its parent.
- `Parent` is a plain scene-path STRING (not a `ComponentReference`); it is used only with `KinematicParentEnable`, which re-parents THIS node under `Parent`.
- Axes nest in one of two ways: give the child axis node a `Group` whose `GroupName` is the parent axis' `GroupName` (it becomes a member of the parent), or set `KinematicParentEnable` and `Parent` on the child axis.
- The motion itself comes from a `Drive` on the same node; `Kinematic` only builds the hierarchy.

**Reference implementation notes (informative):**
- realvirtual WEB applies the re-parenting once, before the bake (group integration first, then `KinematicParentEnable`); cycles are skipped.
- `Kinematic` is not added with `web_editor_add_component`: create it with `web_editor_kinematize` or `web_editor_create_kinematic` and assign parts with `web_editor_assign_to_kinematic`.

| Field | Type | Default | Description |
|---|---|---|---|
| `IntegrateGroupEnable` | boolean | false | If true, top-level members of the named group are re-parented under this node after load. |
| `GroupName` | string | "" | Group whose members are re-parented under this node. |
| `GroupNamePrefix` | string | "" | Scene path of a prefix node (resolved group name = prefixNode.name + GroupName). |
| `SimplifyHierarchy` | boolean | false | If true only mesh nodes of the group are re-parented. |
| `KinematicParentEnable` | boolean | false | If true this node is re-parented under Parent after load. |
| `Parent` | string | "" | Scene path of the new parent node. |

#### 7d.3 MU

Movable Unit marker: the marked node is the template that `Source`
components clone, or a pre-placed part that is live from simulation start.

**Authoring rules:**
- An `MU` node that a `Source` refers to (by name through `ThisObjectAsMU`, or the `Source` node itself) is a prototype: the `Source` spawns copies of it.
- An `MU` node no `Source` refers to is a pre-placed part: it is live in the running scene from simulation start.
- An `MU` whose collider rests on top of another `MU` is that MU's load and moves with it; one carrier can hold several loads.
- `LoadSeatDepth` is set on the carrier: a load whose collider bottom lies up to this depth below the carrier's collider top still rests on it (a part in a jig, a cap over a valve end). The load's bottom must not lie below the carrier's bottom, and its collider centre must lie inside the carrier's footprint. 0 keeps the plain contact rule.

**Reference implementation notes (informative):**
- realvirtual WEB hides `MU` template nodes at load; only the spawned copies (and the source's ghost preview) are visible.
- Pre-placed MUs stay visible, are registered at simulation start and restored to their authored pose on reset. Loads are passive (no per-tick cost) until a `Grip` takes them off.
- realvirtual WEB limits `LoadSeatDepth` to 80 % of the carrier's collider height and reads it at load and at every simulation reset (Web only so far; the Unity component has no such field).

| Field | Type | Default | Description |
|---|---|---|---|
| `LoadSeatDepth` | number | 0 | How deep a load may sit below this MU's collider top and still be its load, in millimetres. |

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

#### 7d.8 AssetReference

Marks the node as a **reference node**: its subtree lives in another asset and is
grafted in during composition (Section 5b). `assetId` is the resolution key,
`path` the fallback — resolved relative to the file the reference is written in,
never relative to the root of the composition. `sha256` only detects that the
referenced asset changed; it is never a resolution key, because a corrected
library asset must reach every file referencing it.

| Field | Type | Default | Description |
|---|---|---|---|
| `assetId` | string | "" | Primary, location-independent identity of the referenced asset. Survives moving and renaming the file. |
| `providerId` | string | "" | Optional id of the provider/resolver the assetId belongs to (library, project, catalog). |
| `sourceId` | string | "" | Optional id of the source within the provider (a specific library source). |
| `path` | string | "" | Fallback locator, relative to the file this reference is written in. Used only when assetId does not resolve. |
| `sha256` | string | "" | Hex SHA-256 of the referenced bytes as of the last save. Change detection only, never a resolution key. |
| `embedded` | boolean | false | True when a flat export inlined the referenced subtree into this file; the reference is then provenance only and MUST NOT be resolved again. |

#### 7d.9 AssetOverrides

Sits on the same node as an `AssetReference` and carries what **this** file
changes in the referenced subtree — the referenced file itself is never modified.
Each patch is an RFC 7396 JSON Merge Patch over the target node's
`extras.realvirtual` (`null` deletes a field). Strength ordering and orphan
reporting are specified in Section 5b.

| Field | Type | Default | Description |
|---|---|---|---|
| `byNodeId` | object | - | NodeId of a node in the referenced subtree → merge patch over that node's extras.realvirtual. |
| `byPath` | object | - | Fallback addressing: node path relative to the reference node → the same merge-patch shape. Consulted only after byNodeId misses. |

#### 7d.10 SceneCamera

Authored camera start preset, written on the scene root node. Field-identical to
the per-model camera preset a viewer keeps outside the file, so moving a preset
into the file (or back out) is lossless.

| Field | Type | Default | Description |
|---|---|---|---|
| `px` | number | - | Camera position X. |
| `py` | number | - | Camera position Y. |
| `pz` | number | - | Camera position Z. |
| `tx` | number | - | Orbit target X. |
| `ty` | number | - | Orbit target Y. |
| `tz` | number | - | Orbit target Z. |
| `duration` | number | 1 | Tween duration when moving to the preset, in seconds; consumers clamp to [0.05, 60]. |
| `savedAt` | number | - | Wall-clock timestamp (milliseconds since the Unix epoch) the preset was saved, for display only. |
| `source` | enum(user, author) | "author" | Origin of the preset: 'author' when it came with the file, 'user' when a viewer user saved it. |

#### 7d.11 PlacementMeta

Marks the node as a **layout placement** and carries the placement data an
`AssetReference` cannot express. Its *presence* is normative: a node carrying
`PlacementMeta` is a placement of the containing scene, and a reference node
without it is not — that is how a placement is told apart from a reference an
author wrote by hand. A placement node also carries the reserved `NodeId` key as
its stable identity, and a writer re-saving the scene MUST update the node with
the matching `NodeId` in place rather than append a second one.

A Gaussian-splat placement carries **no** `AssetReference` at all — a reference
points at a glTF asset by definition — and puts its catalog identity in
`catalogId` instead. `visible` lives here because glTF has no visibility flag, so
a hidden placement would otherwise come back visible on the next load.

| Field | Type | Default | Description |
|---|---|---|---|
| `catalogId` | string | "" | Catalog entry id of the placed asset. Written only when the node carries no AssetReference to hold it (the splat case). |
| `splatUrl` | string | "" | Source of the Gaussian splat this placement renders. When set, the placement has no glTF asset. |
| `visible` | boolean | true | False when the user hid the placement. Absent means visible. |
| `signalMappings` | object[] | - | Live-signal bindings of this placement, stored verbatim; unknown members of an entry MUST round-trip unchanged. |

#### 7d.12 SceneSettings

Workspace settings of a scene, written on the scene root node. These belong to
the scene as a whole rather than to any node: the library catalogues its
placements are drawn from, and the layout grid it was laid out on. A consumer
that finds no `SceneSettings` block falls back to its own defaults; an **absent**
field means "the file has no opinion" and MUST NOT be confused with a field
carrying the default value, because only the former may be overridden by a user
preference.

| Field | Type | Default | Description |
|---|---|---|---|
| `catalogUrls` | string[] | - | Library catalogue URLs the scene draws its placements from. |
| `gridSizeMm` | number | 500 | Layout grid and translation snap step, in millimetres. |
| `physicsEnabled` | boolean | - | Opts this scene into zone physics in an internal viewer; absent keeps the viewer preference. |

#### 7d.13 ConnectionMode

Simulation / PLC start mode of a model, on a dedicated node (one per model). It
decides the connection state the viewer starts in, which gates every logic root
with `Active: Connected` / `Disconnected`: `Simulation` starts **disconnected**,
so a virtual PLC (roots with `Active: Disconnected`) runs; `PLC` starts
**connected**, so a real PLC owns the outputs.

**Authoring rules:**
- At most one `ConnectionMode` per model; a reader uses the first one it finds.
- Without the component the viewer keeps its default (connected) — existing models are unchanged.

**Reference implementation notes (informative):**
- The viewer applies `StartMode` at load, before the logic starts. A Simulation / PLC toggle next to the simulation controls switches the state and writes `StartMode` back into the document, so the next save keeps it.
- A live industrial interface connection overrides the mode (shown as "PLC (interface)", toggle locked); on disconnect the viewer returns to `StartMode`.

| Field | Type | Default | Description |
|---|---|---|---|
| `StartMode` | enum(Simulation, PLC) | "Simulation" | Mode at load: Simulation = connection state Disconnected (virtual PLC runs), PLC = Connected (a real PLC owns the outputs). |

#### 7d.14 WebOperatorPanel

3D-HMI marker: an operator panel window described as JSON. Every
`WebOperatorPanel` of a model (main model and placements) opens one window with
IEC control-box devices: illuminated push buttons, two-position selector
switches, emergency stops, a stack light, title-bar chips and a status line.
Buttons, selectors and E-stops write PLC inputs; lamps show PLC outputs. The
whole panel is the `Config` string — no code. Pure UI metadata, no Unity
runtime function.

The `Config` JSON (format version 1) carries `version`, `id`, `title`, optional
`width` / `position` / `columns`, the device lists `buttons`, `selectors`,
`estops`, `stackLight`, optional `chips`, the ordered `status` rules and an
optional `restart` sequence. Devices sit on a grid (1-based `row` / `col`);
devices sharing a cell stack. Conditions are data:
`{ "signal": "S", "is": true }`, `{ "all": [ ... ] }`, `{ "any": [ ... ] }`,
`{ "not": { ... } }`. The full field list, the IEC colour rules and examples
are served by the MCP guide `web_help("operator-panel")`.

**Authoring rules:**
- `Config` must parse as JSON and validate; a reader reports each problem with its JSON path (for example buttons[3].signal 'BT9' not found in model) and renders the window disabled with the messages instead of working controls.
- Every signal `Config` names must exist in the model; a button writes true while held and false on release, a selector writes the value of its position, an E-stop is normally closed (pressed writes false).
- Several `WebOperatorPanel` components per model are allowed, one window each; `Dock` places a window only when `Config` has no position, windows in one corner stack.

**Reference implementation notes (informative):**
- Authoring by MCP: `web_editor_add_component` adds the component, `web_editor_set_field` sets `Config` (valueJson = the JSON as a JSON string), `web_editor_save` stores it in the GLB; a field edit re-renders the window without a reload.
- The inspector edits `Config` as a monospace JSON field, validated on blur; text that is not JSON is never applied. An unusable panel is also listed in the Problems panel.

| Field | Type | Default | Description |
|---|---|---|---|
| `Title` | string | "" | Window title; empty uses the title in Config. |
| `Config` | string | "" | The operator panel as a JSON string (version, id, title, buttons, selectors, estops, stackLight, chips, status, restart). Must parse and validate; every signal it names must exist in the model. |
| `Dock` | enum(top-left, top-right, bottom-left, bottom-right) | "top-left" | Screen corner the window first appears in when Config has no position; several panels in one corner stack. |
| `StartCollapsed` | boolean | false | If true the window starts collapsed to its title bar (chips, stack light and the E-stop stay reachable). |

```json
{ "WebOperatorPanel": { "Title": "Operator panel", "Dock": "top-left", "StartCollapsed": false, "Config": "{\"version\":1,\"id\":\"cell-panel\",\"title\":\"Cell\",\"buttons\":[{\"label\":\"Start\",\"signal\":\"S_Start\",\"capColor\":\"green\",\"row\":1,\"col\":1}],\"selectors\":[],\"estops\":[],\"stackLight\":[],\"status\":[{\"kind\":\"idle\",\"tone\":\"neutral\",\"text\":\"READY\"}]}" } }
```

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
  unit code (e.g. `mm`, `mm/s`, `s`, `Hz`, `bar`, `Cel`). Validators MUST ignore it.
  Readers MUST NOT convert the stored VALUE based on it; interactive tools MAY show it
  as the field's unit (the reference implementation's inspector suffix reads it first).
- **`signalUnit`** *(string, OPTIONAL, on ComponentReference properties with `signal`)* —
  Unit of the slot's value on the COMPONENT side: a unit code (`mm`) or a quantity token
  resolved through `Drive.Direction` of the carrying node — `@drive-position` (`mm` | `deg`),
  `@drive-speed` (`mm/s` | `deg/s`), `@drive-acceleration` (`mm/s2` | `deg/s2`); a token
  without a drive (or on a `Virtual` drive) resolves to nothing. Always paired with `scaleField`.
- **`scaleField`** *(string, OPTIONAL, on ComponentReference properties with `signal`)* — Name
  of the sibling number field that scales this slot (`Drive_FollowPosition.Position` →
  `Scale`). When a signal whose source declares a unit is bound, an interactive tool MAY write
  `factor(signal unit → signalUnit)` into that field as an ordinary, undoable field value —
  one rule for command and feedback slots (command `target = signal × S`, feedback
  `signal = target / S`). Several slots may share one `scaleField`; the stored value is never
  converted at read time (plan-512).
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
- **`refType`** *(string, OPTIONAL, on ComponentReference properties without `signal`)* —
  Names the component type the reference targets (the name of another `$def`,
  e.g. `TransportSurface.DriveReference` → `Drive`, `Drive_Gear.MasterDrive` → `Drive`,
  `Grip.PartToGrip` → `Sensor`). A writer SHOULD emit that type as the reference's
  `componentType`. Documentation metadata for authoring tools; validators MUST ignore
  it and readers MUST NOT reject a reference because of it. Plain string node paths
  (e.g. `Kinematic.Parent`, `Source.ThisObjectAsMU`) never carry it.
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
