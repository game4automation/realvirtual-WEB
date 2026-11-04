# NOTICE - Unitree G1 fixture (plan-659 Phase 0, best-effort)

Phase 0 was re-prioritised on 2026-10-22 while it ran: Microduck became the
demo target and the G1 dropped to best-effort. This directory therefore holds
what was established cheaply (licence, provenance, tensor contract, matching
MJCF) and no reference fixtures.

## Attribution

**Unitree G1** robot description and the pre-trained locomotion policy:
Copyright (c) 2016-2023 HangZhou YuShu TECHNOLOGY CO.,LTD. ("Unitree Robotics").

- MJCF + policy: <https://github.com/unitreerobotics/unitree_rl_gym>
  @ `276801e46c5d433564f24658bac64f254b7d2d4b`
- Menagerie MJCF: <https://github.com/google-deepmind/mujoco_menagerie>
  @ `cda5236f98383f6fbaa4820c6b18dba892cd087f`, directory `unitree_g1/`

No file here is modified.

## Licence

Everything in this directory is **BSD-3-Clause**:

| Files | Licence text |
|-------|--------------|
| `mjcf/menagerie/*` | `licenses/LICENSE-menagerie-unitree_g1-BSD-3.txt` (Unitree copyright; Menagerie `unitree_g1/README.md` states "This model is released under a BSD-3-Clause License") |
| `mjcf/unitree_rl_gym/*`, `policy/*`, `reference/*` | `licenses/LICENSE-unitree_rl_gym-BSD-3.txt` (repository root), plus `licenses/LICENSE-legged_gym-BSD-3.txt` for the vendored legged_gym part |

BSD-3-Clause covers "source and binary forms", and `policy/motion.pt` is a
binary committed inside that repository, so the repository licence is the only
statement that exists for the weights. There is **no separate weights licence,
model card or NOTICE** anywhere in the repository - see the Phase 0 report for
the list of places searched.

BSD-3-Clause requires on redistribution: the copyright notice, the condition
list and the disclaimer (clause 1/2 - satisfied by the licence texts in
`licenses/` plus this file), and clause 3 forbids using the name of the
copyright holder or its contributors to endorse or promote derived products
without prior written permission. In practice that is the same rule as for
Microduck: factual attribution only, no endorsement or partnership impression
with "Unitree" or "Unitree Robotics".

## Not included on purpose

The mesh sets are **not** checked in (plan-659 N7: this repository's `public`
remote is an unfiltered GitHub mirror):

- `unitree_rl_gym` `g1_description/meshes/` - 27 files needed by
  `g1_12dof.xml`, 25.2 MB (the full directory is 54.3 MB)
- Menagerie `unitree_g1/assets/` - 51 files, 36.0 MB

`g1-asset-manifest.json` carries the pinned revision, the URL template and the
SHA-256 of each of the 27 meshes actually required, so they can be fetched and
verified by script.
