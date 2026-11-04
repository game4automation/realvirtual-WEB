# NOTICE - Microduck fixture (plan-659 Phase 0)

Third-party material, procured 2026-10-22 by pinned revision. Attribution and
licence terms per file group. Nothing here is realvirtual work product.

## What of this the demo still USES (plan-659 stage 2, 2026-10-23)

The demo no longer loads any CC BY-NC-SA 4.0 file, at build time or at run time.

| At run time the demo loads | Licence |
|---|---|
| `policies/BEST_alpha_walking.onnx`, `policies/BEST_alpha_stand.onnx` | Apache-2.0, explicitly |
| `reference/microduck-reference-fixtures.json` | realvirtual measurement output |
| `spikes/659/duck/rv-duck.glb` (visible geometry) | realvirtual original work (stage 1) |
| `spikes/659/duck/rv-duck-collision.xml` (simulated geometry) | realvirtual original work (stage 2) |

The two generated files are derived from the Apache-2.0 **text** in this
directory - the body tree, all 14 joints, every `<inertial>`, the sites, the
sensors, the actuator classes and the STAND keyframe - plus measured dimensions.
Both halves of the geometry are now original realvirtual work:

- **stage 1**, `spikes/659/duck/build-duck.mjs`: the visible geometry, built from
  primitives. It never opened `visual/microduck.glb`.
- **stage 2**, `spikes/659/duck/build-collision-primitives.mjs`: the eleven
  collision hulls, each an original MuJoCo `box` or `ellipsoid`. It reads
  `mjcf/prepared-scene.xml` (Apache-2.0 text) and
  `spikes/659/duck/collision-hulls.measured.json`, and writes a scene that
  references **no mesh file at all**. Guarded by a test, not a comment:
  `spikes/659/collision-primitives.node.test.ts`.

`mjcf/assets/*.stl` is therefore needed by exactly one script,
`spikes/659/duck/measure-collision-hulls.mjs`, which measured the bounding boxes
and the soles' support plane **once** and wrote them into that JSON. Measuring an
object is not copying it: six numbers per part, no vertex, triangle, hull or
normal, nothing simplified, decimated or converted - which is the point, because
`LICENSE-MODELS.md`'s attribution clause explicitly covers "decimated or
converted meshes". The STL files are gitignored, are not redistributed, and
nothing needs them to run the demo.

**What this does and does not settle.** The NonCommercial blocker is gone: no
CC BY-NC-SA material is shipped or loaded. The Apache-2.0 obligations below are
NOT gone - the ONNX weights and every number taken from the MJCF still require
the licence text, the attribution and the change notices carried by this file -
and neither are the trademark constraints in the last section.
`visual/microduck.glb` and `mjcf/assets/*.stl` remain in this directory under
their original terms, unused.

## Attribution

**Microduck** robot, MJCF robot description, 3D model files and the ONNX
locomotion policies: Copyright **Pollen Robotics**.

- Robot / runtime repository: <https://github.com/pollen-robotics/microduck>
- Training repository: <https://github.com/pollen-robotics/microduck_rl>
- Browser reference implementation (HF Space):
  <https://huggingface.co/spaces/pollen-robotics/microduck-simulator>
- Policy weights (HF model repository):
  <https://huggingface.co/pollen-robotics/microduck-policies>

No file in this directory has been modified, with two exceptions that are
realvirtual-generated and marked as such:

- `mjcf/prepared-scene.xml` - a derived scene produced by
  `spikes/659/make-microduck-fixtures.py` from `mjcf/robot_allcollisions.xml`
  (visual geoms stripped, unreferenced mesh assets dropped, `<option timestep>`,
  a floor plane and a STAND keyframe injected). Derivative of an Apache-2.0 file.
- `reference/*.json` - measurement output, not third-party material.

## Licence per file group

| Group | Files | Licence | Source of the statement |
|-------|-------|---------|-------------------------|
| MJCF robot description | `mjcf/robot_allcollisions.xml`, `mjcf/prepared-scene.xml` (derived) | Apache-2.0 | `microduck_rl/LICENSE-MODELS.md`: "Everything else in this repository, including the MJCF robot descriptions (`.xml`) ... is licensed under the Apache License 2.0" |
| ONNX policy weights | `policies/BEST_alpha_walking.onnx`, `policies/BEST_alpha_stand.onnx`, `policies/vendor-manifest.json` | **Apache-2.0, explicitly** | Model card front matter `license: apache-2.0` of `pollen-robotics/microduck-policies` @ `665ae4eb`, a repository that contains only the weights plus their manifest. Both files are byte-identical (SHA-256) to the copies served by the Space. |
| 3D model files - collision meshes | `mjcf/assets/*.stl` (9 files) | **CC BY-NC-SA 4.0 (NonCommercial, ShareAlike)** | `microduck_rl/LICENSE-MODELS.md` covers `src/mjlab_microduck/robot/microduck/assets/*.stl` and, by its own attribution clause, adaptations such as "decimated or converted meshes". The Space's meshes are decimated versions of exactly those files. **Since stage 2 these are UNUSED by the demo** - only `measure-collision-hulls.mjs` reads them, to re-derive dimensions. |
| 3D model file - visual asset | `visual/microduck.glb` | **Unclear; conservatively CC BY-NC-SA 4.0** | Only present in the Space, whose sole licence file is Apache-2.0 and whose README scopes that to "the app code". It is a 3D model file of the same robot from the same CAD source, so `LICENSE-MODELS.md` plausibly governs it, but it is not literally inside the two directories that document names. **Unresolved - see the Phase 0 report.** |
| Render rig | `rig/kinematics.json` | Apache-2.0 (generated metadata, not a 3D model file) | Space repository licence |
| Licence texts / cards | `licenses/*` | as stated inside each file | - |

## What Apache-2.0 requires of us on redistribution

Section 4 of Apache-2.0 asks, for any redistribution:

1. a copy of the licence - `licenses/LICENSE-space-apache-2.0.txt` and
   `licenses/LICENSE-microduck_rl-apache-2.0.txt`;
2. retention of copyright, patent, trademark and attribution notices from the
   source - carried by this file;
3. prominent notices stating that files were changed, for every changed file -
   `mjcf/prepared-scene.xml` is marked above;
4. a NOTICE file **only if the original carries one**. Checked: neither
   `pollen-robotics/microduck` @ `942e58e3`, nor `microduck_rl` @ `b02fdea4`,
   nor the Space @ `ad9d41a7` contains a NOTICE file, so nothing has to be
   propagated. This file is ours, voluntarily.

This directory satisfies 1-3 for the Apache-2.0 material.

CC BY-NC-SA 4.0 is a different and stricter matter and is NOT satisfied by this
directory for any commercial use: it forbids commercial use and requires any
adaptation to be licensed under the same terms. That is why the demo was taken
off those files entirely (see the first section) rather than shipped with them.

## Trademarks

Apache-2.0 grants **no trademark rights** (section 6), and CC BY-NC-SA 4.0
likewise grants none. "Pollen Robotics" and "Microduck" are the marks of their
owner. Therefore, in any realvirtual UI, demo scene, screenshot, video or
caption:

- do NOT imply endorsement, partnership, certification, sponsorship or any
  commercial relationship with Pollen Robotics;
- do NOT use the marks or logo as a feature name, product name, menu entry,
  button label or in a page title;
- DO keep attribution factual and attributive only, for example: "Robot model
  and locomotion policies: Microduck by Pollen Robotics, Apache-2.0 / CC
  BY-NC-SA 4.0 - see NOTICE", with a link to the source repositories.

Whether the demo may be shipped or shown publicly at all is Thomas's decision,
not this file's.
