# AGV Stacker — Blender build script

`build_agv_stacker.py` builds the library model
`public/library/MobileRobots/AGVStacker.glb`: a driverless pallet stacker with its
realvirtual components written straight into `extras.realvirtual` (schema
`schema/v1/rv-odt.json`), so a rebuild brings the machine back fully wired.

## Build

Blender **5.2.x** (built and checked with 5.2.2 LTS), headless:

```bash
blender --background --python tools/blender/agv-stacker/build_agv_stacker.py -- <out.glb> [--ref <dir>]
node scripts/build-local-library-catalog.mjs   # re-stamps sha256 / sizeBytes in catalog.json
```

- `<out.glb>` — output file, normally `public/library/MobileRobots/AGVStacker.glb`.
- `--ref <dir>` — the reference folder `.agv-ref` (Unity project root). It holds the two
  ISO 7010 pictograms not shipped elsewhere (`iso7010-W015.png`, `iso7010-W024.png`,
  public domain, Wikimedia Commons); the rest of the ISO 7010 set is read from
  `<dir>/../Packages/io.realvirtual.starter/Assets/3DPrefabs/Decals/Imgs`. Without
  `--ref` the script uses `RV_AGV_REF`, else the first ancestor folder (of the script or
  of the current directory) that contains `.agv-ref`.

The script fails loudly on: overlapping decals, a `ComponentReference` that does not
resolve, fork blades resting in the wheel arms, wheel arms outside the Europallet fork
windows, a fork top that does not fit under the 100 mm deck opening, load rollers not on
`Chassis`, and a non-uniform scale on any empty. The vertex AO is baked with Cycles, so two
builds are equivalent but not byte-identical — always re-run the catalog script.

## Where the dimensions come from

- Vendor dimension drawing and front view (overall 1687 × 855 × 1798 mm, fork
  1150 × 180 mm, 1310 mm turning radius); the derivations are commented in the script
  (load-roller axle solved from the turning radius, 2:1 chain reeving from the lift travel).
- Two deliberate deviations, both for function: the fork centre distance `FORK_CC`
  (centred in the two fork windows of a Europallet entered on its 800 mm face) and the
  **wheel arms**: the load rollers sit in two flat arms on the chassis (|x| = 106…266 mm,
  44 mm high) instead of in the fork blades, so they stay on the floor when the fork lifts.
  The arms fit between the pallet's bottom boards and under the end of a
  `RollConveyor-3m` (end legs at |x| = 430…570 mm, plan-612 spike).

## Model contract (used by plan-612 PalletYard)

| Node | Component / role |
|------|------------------|
| `AGV_Stacker` (root) | middle of the vehicle **including a carried pallet**; travel forward = local +Z (pod first), the fork points to −Z |
| `Lift` | `Drive` LinearY, 0…1200 mm |
| `LiftRam` | `Drive` + `Drive_Gear` (factor 0.5 → `Lift`) |
| `Lift/ForkAnchor` | Empty on the blade top at the pallet centre — the handover attach point |
| `Chassis/Steer`, `Chassis/Steer/Wheel_Drive` | steering and traction `Drive` |
| `Chassis/Wheel_LoadL/R`, `Chassis/Wheel_CasterL/R` | `Drive` + `Drive_Gear` → `Wheel_Drive` |
| `Lamp_*` | `Lamp` (beacon, scanner, safety beams, eyes, status) |
| `Snap-Load` | pallet seat at lift 0 |

All `Drive_Gear.MasterDrive` paths are computed from the live Blender hierarchy
(`path_of`), never typed as literals. A scene that embeds the model under another name
must rewrite them to its instance root (plan-612 generator `tools/pallet-yard.mjs`).

## Reference material

Renders, vendor photos, decal sheets and the earlier build stages stay in the Unity
project's `.agv-ref/` folder (not versioned here): `render-v2-*.png` for the look,
`AGV-Stacker-sheet.png` for the drawing, `build_agv_stacker_v2.py` as the predecessor of
this script. `_patch_components.py` there is obsolete — its component block is already in
this script, with the corrected paths.
