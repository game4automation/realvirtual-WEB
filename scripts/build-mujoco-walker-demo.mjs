// plan-673 O13/O14/O15 — the MuJoCo walker as a document of the DEMO project.
//
//   node spikes/659/duck/build-collision-primitives.mjs   # the simulated hulls
//   node spikes/659/duck/build-duck.mjs                   # the robot itself
//   node scripts/build-mujoco-walker-demo.mjs             # this file
//   node scripts/build-mujoco-walker-demo.mjs --check     # report, write nothing
//
// ## Why it lives in the delivered demo project and no longer in a spike folder
//
// Thomas decided it on 2026-10-25: *"es soll ins commercial tier aber in der
// public demo sein"*. Until then the walker was served from a project folder of
// its own (`public/spike-659-duck/`, built by `spikes/659/make-demo-project.mjs`)
// whose every artefact was gitignored, because a spike does not belong in a
// DELIVERED artefact. The decision reverses that, so the document joins
// `public/demo-realvirtual/` like the Setzkasten did the day before.
//
// ## The licence position, which is what made this possible at all
//
// `spikes/659/duck/.gitignore` wrote the rule down in advance: *"Wandert das
// Modell später in ein Demo-Projekt, wird das GLB DORT als Projekt-Asset
// versioniert (project.json → documents[]), nicht hier."* That is exactly what
// happens here, and it is allowed because:
//
//  - the GEOMETRY is own work, derived only from the Apache-2.0 text files of
//    the fixture (`mjcf/robot_allcollisions.xml`, `rig/kinematics.json`). The
//    CC BY-NC-SA meshes of the original were never opened.
//  - the COLLISION HULLS are original MuJoCo primitives since plan-659 stage 2
//    (`duck/build-collision-primitives.mjs`), not decimated meshes.
//  - the ONNX POLICIES are Apache-2.0 on their own model card
//    (`pollen-robotics/microduck-policies`), and they are the only third-party
//    payload this document carries.
//
// So the Apache-2.0 attribution travels WITH the document, as
// `MuJoCoWalker.LICENSE.txt` — the same pattern `fmu-demo.LICENSE.txt` already
// uses for the embedded BouncingBall FMU.
//
// NOT copied here, and the `.gitignore` of the fixtures must stay as it is: the
// `.stl` collision meshes and `visual/microduck.glb` of the original are
// CC BY-NC-SA 4.0, NonCommercial AND ShareAlike, and that clause explicitly
// covers "decimated or converted meshes". This repository mirrors to an
// unfiltered public GitHub remote.
//
// ## How it became publishable (plan-673 O16, 2026-10-25)
//
// The document used to be registered `devOnly: true`, which made the deploy
// PRUNE it (`scripts/_bunny-lib.mjs`: a `devOnly` row loses its row and its
// GLB), and that flag was load-bearing, not cosmetic:
//
//   The walker needs two WASM runtimes — `@mujoco/mujoco` (10.1 MB
//   `mujoco.wasm`) and `onnxruntime-web` (13.5 MB
//   `ort-wasm-simd-threaded.wasm`). Both were installed out-of-band by
//   `spikes/659/ensure-deps.mjs` only, so this script wrote their dev-server
//   paths (`/node_modules/...`) into `rv_mujoco.wasm` — paths that exist on the
//   dev server and in no `dist/`. Flipping `devOnly` alone would therefore have
//   shipped a demo that dies in two 404s.
//
//   Thomas chose option (a), bundling over runtime CDN URLs: both packages are
//   exact-version dependencies of the PRIVATE package.json, and the two
//   binaries reach `dist/` through a Vite `?url` seam,
//   `realvirtual-WebViewer-Private~/src/mujoco/rv-mujoco-wasm-url.ts`, on the
//   pattern of `kinematic-solver/rv-kinematic-wasm-url.ts`. Cost: +23.6 MB in
//   the deploy and ~155 MB per developer install. Rejected (b): a publicly
//   hosted demo fetching two libraries from a third party at runtime.
//
// So `rv_mujoco.wasm` is no longer written at all — `RVMuJoCoRobotConfig` has
// no such field any more; the viewer supplies its own binaries. Anyone adding
// a runtime URL to this document should check first whether it is a property of
// the MACHINE (then it belongs here) or of the viewer BUILD (then it does not).

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { stableDocumentId } from './_rv-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');
const SPIKE = resolve(ROOT, 'spikes/659');
const FIXTURES = resolve(SPIKE, 'fixtures/microduck');

const SRC_GLB = resolve(SPIKE, 'duck/rv-duck.glb');
const PROJECT_DIR = resolve(ROOT, 'public/demo-realvirtual');
const ASSET_DIR = resolve(PROJECT_DIR, 'mujoco-walker');
const GLB_NAME = 'MuJoCoWalker.glb';
const OUT_GLB = resolve(PROJECT_DIR, GLB_NAME);
const LICENSE_NAME = 'MuJoCoWalker.LICENSE.txt';
const PROJECT_JSON = resolve(PROJECT_DIR, 'project.json');

// DERIVED, never hand-written: `tests/demo-manifest-invariants` requires every
// document id of the manifest to be `stableDocumentId(path)`.
const DOC_ID = stableDocumentId(GLB_NAME);
const DOC_NAME = 'Walking Robot (MuJoCo detail physics)';

/** The operator panel of this robot — the SSOT, in the private tree. */
const PANEL_JSON = resolve(PRIVATE, 'src/mujoco/robot-panel.json');

// ── the runtime assets, as PROJECT assets ───────────────────────────────────
//
// Everything the model names has to resolve from the project folder, not from
// the dev server's view of the repository: a delivered project carries its own
// assets. Served paths are relative to the project root, which is what the
// loader resolves a non-absolute `rv_mujoco` URL against.
//
// `policy-*.onnx` are the only third-party bytes; `MuJoCoWalker.LICENSE.txt`
// carries their Apache-2.0 attribution.
const ASSETS = [
  { from: resolve(SPIKE, 'duck/rv-duck-collision.xml'), to: 'robot.xml',
    what: 'the simulated scene: Apache-2.0 body tree, ORIGINAL MuJoCo primitives for every collision hull' },
  { from: resolve(FIXTURES, 'reference/microduck-reference-fixtures.json'), to: 'contract.json',
    what: 'the contract: dt, decimation, joint order, default pose, observation layout' },
  { from: resolve(FIXTURES, 'policies/BEST_alpha_walking.onnx'), to: 'policy-walking.onnx',
    what: 'the walking policy (Apache-2.0)' },
  { from: resolve(FIXTURES, 'policies/BEST_alpha_stand.onnx'), to: 'policy-stand.onnx',
    what: 'the stand / fall-recovery policy (Apache-2.0)' },
];

const LICENSE_TEXT = `${GLB_NAME} and the files in mujoco-walker/ — licence and provenance
================================================================================

THE ROBOT GEOMETRY IS REALVIRTUAL'S OWN WORK.

It was generated by spikes/659/duck/build-duck.mjs from the Apache-2.0 TEXT
files of the Microduck fixture only — the MJCF body tree, joints, sites,
sensors, actuators and inertials of

  huggingface.co/spaces/pollen-robotics/microduck-simulator @ ad9d41a7
    app/public/robot/mjlab/robot_allcollisions.xml   (Apache-2.0)

and the kinematics derived from it. No mesh of the original model was opened,
converted or traced. The collision hulls in mujoco-walker/robot.xml are
original MuJoCo primitives (spikes/659/duck/build-collision-primitives.mjs),
not simplified meshes.

The .stl meshes and visual/microduck.glb of the original model are
CC BY-NC-SA 4.0 (NonCommercial AND ShareAlike, a clause that covers "decimated
or converted meshes") and are NOT part of this document or this repository.


THIRD-PARTY CONTENT IN THIS DOCUMENT
--------------------------------------------------------------------------------

mujoco-walker/policy-walking.onnx
mujoco-walker/policy-stand.onnx

  The two trained locomotion policies, unmodified. Apache-2.0.

  Authoritative licence statement: huggingface.co/pollen-robotics/microduck-policies
  (model card front matter, license: apache-2.0), revision
  665ae4eb20bfe13bca1ef4ea6d4bb6b4a096e448, where they are alpha_walking.onnx
  and alpha_stand.onnx. The copies here are byte-identical to the ones the
  simulator Space ships:

    policy-walking.onnx  sha256 e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c
    policy-stand.onnx    sha256 1569268713e40deea795dd2922dba50d3621e15a872855408b6b1b125b1c094b

mujoco-walker/robot.xml
mujoco-walker/contract.json

  Derived from the Apache-2.0 MJCF named above and from
  pollen-robotics/microduck_rl @ b02fdea4 (Apache-2.0, scripts/infer_policy.py).

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

  Licensed under the Apache License, Version 2.0 (the "License"); you may not
  use these files except in compliance with the License. You may obtain a copy
  of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
  WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
  License for the specific language governing permissions and limitations
  under the License.

  The full attribution record, with the revision and SHA-256 of every file
  taken from the sources, is spikes/659/fixtures/microduck/NOTICE.md and
  asset-manifest.json.


TRADEMARKS

  "Microduck" and "Pollen Robotics" are the marks of their owner. This document
  neither uses them nor presents itself as that product: it is a small
  two-legged service robot of realvirtual's own design that happens to be
  driven by the same openly licensed policies.
`;

// The summary says WHO DRIVES, because since plan-673 O19 that is the visitor:
// the autopilot is off by default (see the `mujoco.autopilot` block below), so a
// summary promising a robot that sets off by itself would be a promise the
// document no longer keeps.
const DOC_SUMMARY = 'Steer a two-legged robot on a trained neural policy through a field of '
  + 'obstacles it can push, trip over and fall against — MuJoCo detail physics in the browser.';

// WHY THE TEXT IS THINNER THAN THE COMPONENT LIST (2026-10-25).
//
// The obstacle nodes carry `Movable`, and the description used to invite the
// visitor to "drag a ball into its path". Dragging does not exist: `RVMovable`
// defines `allowedAxes`, `snap()` and `resetToHome()`
// (`src/core/engine/rv-free-body.ts`) and no production code calls them — only
// tests do. The document went public on /demo with that sentence in it, so the
// INVITATION was removed while the COMPONENT stays on the nodes and keeps its
// properties: Thomas is working on the drag. Put the sentence back as soon as a
// pointer gesture reaches `xfrc_applied` or a mocap body, and mention the keys
// in the same breath.
//
// The keys below are read off `rv-mujoco-keyboard.ts`, not remembered:
// `MOVE_KEYS = ['w','a','s','d','q','e']`, and `intent()` maps them
// `forward = w - s`, `right = d - a` (steering), `strafe = e - q` (sideways, NOT
// yaw), while `r` pulses reset and Space pulses push. Arrow keys are not part of
// the walker's keyboard, and the description named them anyway.
const DOC_DESCRIPTION = `# Walking Robot — MuJoCo detail physics

A small two-legged service robot walks across a field of obstacles. Nothing in this scene is
animated: the robot is a **MuJoCo** model stepped at 5 ms, driven by a **trained neural policy**
that runs in the browser through ONNX Runtime, and every obstacle is a rigid body in the same
solver.

## What it demonstrates

- **A controller that is not a script.** The policy is blind — 61 observation values, no
  distance sensor and no image — so it absorbs a collision by yawing away from it. Walk it into
  the same cube twice and it leaves differently. You steer it by setting a walk and a turn
  command — nothing more — and the gait that carries it there is the network's, not a path
  someone drew.
- **Obstacles that are objects, not settings.** Each one carries its own components:
  \`CollisionShapeSet\` for its collision geometry, \`FreeBody\` for mass, contact dimensionality
  and friction, \`Movable\` to mark it as a body that may be repositioned, and a \`ContactProfile\` on the
  balls, which need rolling friction. Click one and the Property Inspector shows the physics it
  is actually running on.
- **Numbers you can feel.** The robot weighs 0.737 kg and the whole model declares no friction
  coefficient, so it runs on MuJoCo's default mu = 1.0 and can push with its own ground grip:
  7.2 N. That one number sorts the field — a 50 g ball is played away, a 100 g cube is shoved,
  a 200 g cube trips it, and a 2 kg block at chest height puts it on its back.
- **A recovery policy.** It gets up again, which is the second network in the document.

## Try this

- **Press Play, then steer with W/A/S/D, Q/E sidestep, Space to shove.** **W**/**S** is forward
  and back, **A**/**D** steers, **Q**/**E** steps sideways without turning, **R** puts the scene
  back. The dial on the plate sets how fast; the keys only say which way.
- **Or let it walk the course by itself:** turn **Autopilot** on, on the plate. It then walks at
  the nearest obstacle it has not shifted yet, hands the robot straight back the moment you
  touch anything, and takes over again about five seconds after your last input.
- **Press Space to shove the robot** and watch the gait absorb it — or not, and then get up again.
- **Click an obstacle** and change \`MassKg\` in the inspector. Above roughly 0.7 kg it stops
  being something the robot can move at all — that is the 7.2 N above, not a threshold someone
  typed in.
- **Watch the ring at 2 m.** The field is deliberately wide rather than deep: a blind policy
  drifts about 0.5 m per 5 m after a collision, so a single obstacle per station gets missed.

## Why the obstacles look the way they do

Colour reads weight — sand is played away, steel trips, graphite is a wall. The cube spacing is
measured and deliberate: three 90 mm cubes 0.20 m apart box the robot in and it never gets up,
while the same cube alone produces trip, fall, stand up, walk on. A blind policy can only stand
up where there is room to.
`;

/** Build the GLB of the document from the generated walker. */
export function buildMuJoCoWalkerDemo() {
  if (!existsSync(SRC_GLB)) {
    throw new Error(`${SRC_GLB} is missing — run: node spikes/659/duck/build-duck.mjs`);
  }
  if (!existsSync(PANEL_JSON)) {
    throw new Error(`operator panel config missing: ${PANEL_JSON} (private tree not checked out?)`);
  }
  for (const a of ASSETS) {
    if (!existsSync(a.from)) {
      throw new Error(`${a.from} is missing (${a.what}).\n`
        + 'The Apache-2.0 payloads are procured, not versioned: '
        + 'python spikes/659/make-microduck-fixtures.py');
    }
  }
  return { panelConfig: JSON.parse(readFileSync(PANEL_JSON, 'utf8')) };
}

/**
 * The walker, as the document: the operator panel added and every runtime URL
 * rewritten to a project asset.
 */
export async function composeDocument(panelConfig) {
  const io = new NodeIO();
  const doc = await io.read(SRC_GLB);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const assetRoot = scene.listChildren()[0];
  if (!assetRoot) throw new Error('rv-duck.glb has no root node');

  // The panel goes on a node of its own rather than on the asset root: a
  // component CLAIMS its node, so the empty node survives the destructive bake
  // and the panel is a selectable thing in the hierarchy. Same as the Laser
  // Welding station does it — the viewer's own host builds the controller, so no
  // plugin has to know this particular robot.
  assetRoot.addChild(doc.createNode('OperatorPanel').setExtras({
    realvirtual: {
      WebOperatorPanel: {
        Title: 'Robot',
        // A JSON STRING: the authored form of the field. The reader tolerates an
        // object, but the inspector and MCP both write a string.
        Config: JSON.stringify(panelConfig),
        Dock: 'top-left',
        StartCollapsed: false,
      },
    },
  }));

  // Project asset references, through the house sentinel `rvproject:<relPath>`.
  // The spike pointed these at the repository as the dev server sees it
  // (`/spikes/659/...`), which is not a path any delivered project has. A plain
  // RELATIVE path is not the answer either: the runtime fetches these with a bare
  // `fetch`, so it would resolve against the PAGE — measured, the dev server
  // answered `mujoco-walker/contract.json` with index.html and the plugin died on
  // JSON.parse. And an absolute `/demo-realvirtual/...` would work here and 404 in
  // the demo deploy, which is published under a base path. The plugin resolves the
  // sentinel through the project backend (RVMuJoCoPlugin.resolveProjectAssets).
  const extras = { ...assetRoot.getExtras() };
  const mujoco = { ...extras.rv_mujoco };
  if (mujoco.obstacles !== undefined) {
    throw new Error('the walker GLB still carries rv_mujoco.obstacles — rebuild it (plan-673 O14)');
  }
  mujoco.mjcf = 'rvproject:mujoco-walker/robot.xml';
  mujoco.contract = 'rvproject:mujoco-walker/contract.json';
  mujoco.policies = {
    walking: 'rvproject:mujoco-walker/policy-walking.onnx',
    stand: 'rvproject:mujoco-walker/policy-stand.onnx',
  };
  // `wasm` is DELETED, not rewritten (plan-673 O16). The source GLB still
  // carries the spike's dev-server paths (`spikes/659/duck/build-duck.mjs`,
  // which also feeds the spike demo page), and leaving them in a published
  // document is exactly the 404 this whole step removes. The two binaries now
  // come from the viewer build itself — `rv-mujoco-wasm-url.ts` — so the
  // document has nothing to say about them.
  delete mujoco.wasm;

  // THE AUTOPILOT — PRESENT, CONFIGURED, AND OFF (plan-673 O18 + O19).
  //
  // Written HERE and not only into project.json, for the reason `devOnly` and
  // the description text taught twice: project.json is regenerated by this
  // script, so a value that lives only there survives exactly one build.
  //
  // ## The measurement that built it (O18, and it still holds)
  //
  // Thomas: *"Startet auf Hindernisse zu."* It closed a measured defect rather
  // than adding a trick. With the plain `command.vx` below, the walker leaves
  // on a curve and misses the whole course: two production-build runs, 60 s and
  // 37 s of walking, produced NOT ONE robot/obstacle contact. A blind policy
  // drifts ~0.5 m per 5 m and each station is one obstacle deep, so a visitor
  // who only presses Play never saw the thing this document is about. That is
  // still true of this document with `enabled: false`.
  //
  // ## Why it is nevertheless off (O19, Thomas on 2026-10-25)
  //
  // *"Aus + Schalter im Panel"*, after watching it run: the autopilot fights
  // the operator — *"die Geschwindigkeit wird immer wieder geändert"*. The
  // hand-over is immediate on any foreign write, but five seconds of idle later
  // the dial is the autopilot's again, and on a demo page somebody is always
  // about to touch it. Two true statements, one decision: being driven against
  // is worse than missing the obstacles, and the keyboard gets you to them.
  //
  // So nothing was removed and nothing was weakened. This block stays complete
  // and its three measured numbers stay authoritative; `enabled` is the RESTING
  // STATE of a switch now. The plugin registers it as `RobotAutopilot` and
  // reads the SIGNAL from then on, the plate carries the knob (row 2 of
  // `robot-panel.json`), and a PLC over CONNECT or an MCP write reaches it the
  // same way. The measured behaviour above is one click away — and `Try this`
  // in the description names the keys, which is how the obstacles get met in
  // the meantime.
  //
  // DO NOT flip this back to `true` on the strength of the O18 paragraph alone:
  // that measurement was never in dispute, the interference was the reason.
  //
  // The three numbers are demo decisions and belong to the document:
  //   idleSeconds 5  — how long an operator keeps the robot after their last
  //                    input. Shorter overrides someone who is just thinking or
  //                    has taken a hand off the keyboard; longer and the page
  //                    looks stalled, which for a demo meant to show itself off
  //                    is the worse failure. A judgement, not a measurement.
  //   doneMm 50      — how far the robot must have shifted an obstacle before
  //                    it looks for the next one. Without it the autopilot locks
  //                    onto the 50 g ball it has just kicked (which rolls
  //                    several decimetres and stays the nearest target for the
  //                    rest of the run) instead of walking the course. 50 mm is
  //                    above the solver's resting micro-motion and below what
  //                    even the 2 kg block gives way by.
  //   reachMm 300    — inside this range, with the target roughly ahead, it
  //                    stops steering and walks through. Measured: without it
  //                    the robot shoves the first ball 93 mm and then pirouettes
  //                    beside the second for 35 s of simulation, yaw saturated
  //                    and forward speed down to 0.02 m/s, orbiting a target
  //                    0.16 m away. 0.3 m is a 1.2 s run-in at 0.25 m/s.
  mujoco.autopilot = { enabled: false, idleSeconds: 5, doneMm: 50, reachMm: 300 };
  extras.rv_mujoco = mujoco;
  assetRoot.setExtras(extras);

  return Buffer.from(await io.writeBinary(doc));
}

export function registerInProject(glb) {
  const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'));
  const sha256 = createHash('sha256').update(glb).digest('hex');
  const entry = {
    id: DOC_ID,
    name: DOC_NAME,
    path: GLB_NAME,
    mode: 'commissioning',
    // Only the workspaces this demo makes sense in (Thomas, 2026-10-25): the
    // switcher offers just these while it is open, a switch to HMI / DES /
    // Planner is refused, and `mode` above is the default it opens in. The
    // asset editor stays reachable (authoring modes are never restricted).
    modes: ['commissioning', 'viewer'],
    // NO `devOnly` (plan-673 O16, 2026-10-25): the document goes into the
    // public demo. The two WASM runtimes are bundled dependencies of the
    // private package now, so the deploy carries everything it needs — see the
    // header. Re-adding the flag here is the only way to pull it back out of
    // the deploy; editing project.json alone does not survive the next run.
    sizeBytes: glb.length,
    mtimeMs: Date.now(),
    sha256,
    documentInfo: {
      v: 1,
      summary: DOC_SUMMARY,
      description: DOC_DESCRIPTION,
      updatedAt: '2026-10-25T00:00:00.000Z',
      updatedBy: 'realvirtual',
    },
    extrasScan: 2,
  };
  // Keyed on the PATH, not the id: a document is identified by its file, and an
  // id that is DERIVED from that path can change when the rule does.
  const i = project.documents.findIndex((d) => d.path === GLB_NAME);
  if (i >= 0) project.documents[i] = entry;
  else {
    const mdAt = project.documents.findIndex((d) => String(d.path).endsWith('.md'));
    if (mdAt >= 0) project.documents.splice(mdAt, 0, entry);
    else project.documents.push(entry);
  }
  project.modifiedAt = new Date().toISOString();
  return { project, sha256 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { panelConfig } = buildMuJoCoWalkerDemo();
  const glb = await composeDocument(panelConfig);
  const { project, sha256 } = registerInProject(glb);
  console.log(`document id      ${DOC_ID}`);
  console.log(`glb              ${glb.length} bytes, sha256 ${sha256.slice(0, 16)}...`);
  for (const a of ASSETS) {
    console.log(`asset            mujoco-walker/${a.to.padEnd(20)} ${statSync(a.from).size} bytes`);
  }
  if (process.argv.includes('--check')) {
    console.log('\n--check: nothing written');
  } else {
    mkdirSync(ASSET_DIR, { recursive: true });
    writeFileSync(OUT_GLB, glb);
    writeFileSync(resolve(PROJECT_DIR, LICENSE_NAME), LICENSE_TEXT);
    for (const a of ASSETS) copyFileSync(a.from, resolve(ASSET_DIR, a.to));
    writeFileSync(PROJECT_JSON, `${JSON.stringify(project, null, 2)}\n`);
    console.log(`\nwritten: ${OUT_GLB}`);
    console.log(`written: ${resolve(PROJECT_DIR, LICENSE_NAME)}`);
    console.log(`written: ${ASSET_DIR}/ (${ASSETS.length} files)`);
    console.log(`updated: ${PROJECT_JSON}`);
    console.log(`\nopens at: http://localhost:5100/?doc=${DOC_ID}`);
  }
}
