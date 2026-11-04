# AGV Stacker — SolidCraft model

`agv-stacker.solidcraft` is a parametric SolidCraft design of a driverless pallet stacker,
intended as the visual model for the DES AGV simulation (plan-612 PalletYard).
`agv-stacker.step` is its export (one solid per part, 62 bodies). It is a second source
next to the Blender build script in `../../blender/agv-stacker/`, which still produces the
library model `public/library/MobileRobots/AGVStacker.glb` with its realvirtual components.
This design carries geometry and appearances only — no components, no `rv_extras`.

## Reference

Own geometry, modelled after the published views and figures of a 1.4 t narrow-aisle AGV
stacker (vendor page `agv-forklift.com/products/1-4ton-agv-narrow-aisle-electric-stacker.html`):
overall 1687 × 855 × 1798 mm, fork 1150 × 180 mm, fork outside 680 mm. Further dimensions
(pod, mast, scanner, carriage) were measured from the vendor dimension drawing
(≈ 7.1 mm per pixel). No third-party CAD is imported. The vendor's logo is deliberately
not reproduced.

## Frame

Millimetres, Z up, X symmetric. +Y is the fork direction: fork heel plane at y = 0,
fork tip at y = 1150, rear of the skid at y = −537. Floor at z = 0.

## Parameter

| Name | Meaning |
|---|---|
| `lift` | Fork lift in mm, 0…1200. Drives the `Lift` body, the guide rollers and the 2:1 chain reeving: sprocket and piston rod rise by `lift/2`, the carriage strand shortens and the fixed strand lengthens by `lift/2`. |

Checked with SolidCraft `inspect.interference` at lift 0, 600 and 1200 mm: no collisions
between moving and fixed parts (only intended mounting overlaps remain).

## Main bodies

| Body | Content |
|---|---|
| `Chassis` | Skid (z 30…80) with wheel wells |
| `WheelArms` | Two arms under the forks carrying the load rollers (functional deviation, see the Blender README) |
| `PodBase`, `Pod` | Grey base (to z 321) and white shell (to z 1343, sloped rear top) |
| `SidePanelR`, `Body1`…`Body4` | Grey S-shaped side panels and side stripes (`Body1`…`Body4` are the mirrored left side) |
| `PodFace`, `PodFaceTrim`, `EyeL/R` | Rear face panel, green trim, eye lamps |
| `ControlPanel`, `EStopL/R`, `EStopHousing`, `EStopMain` | Control panel on the sloped roof, big emergency stop on top |
| `Mast` | Box posts with inner channels, head, scanner cantilever, middle tie |
| `NavScanner`, `Beacon` | Navigation scanner housing and beacon dome |
| `StackLightBase/Green/Amber/Red/Cap` | Industrial stack light on the right mast post |
| `Lift` | Carriage, brackets, fork shanks, fork blades with side skirts, roller windows, tip taper |
| `GuideRollers`, `GuideRollersL` | Carriage guide rollers running in the mast channels |
| `LiftCylinder`, `CylRod`, `Sprocket`, `ChainFixed`, `ChainCarriage` | Lift cylinder and 2:1 chain drive |
| `DriveWheel`, `CasterL/R`, `LoadRollerL/R` (+ hubs, forks, axles) | Running gear |

## Editing

Open the file in SolidCraft. Change `lift` to see the mechanism move; leave it at 0 before
saving or exporting. SolidCraft exports STEP, STL, OBJ, 3MF and URDF — not GLB, so a
viewer model still needs a conversion step (e.g. STEP → GLB via CONNECT's converter or Blender).
