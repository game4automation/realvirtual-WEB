// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * build-demo-maintenance-procedure.mjs — plan-522 Phase 5: the guided
 * "Coolant Nozzle Cleaning" procedure of the standard demo (§3.4), written into
 * `DemoRealvirtualWeb.glb` as web-editor components on nodes.
 *
 * Why a script and not a save from the web editor (decision 2026-10-21): the
 * editor's save re-exports the WHOLE document through three's GLTFExporter
 * (uncompressed, re-serialised materials and names). For the demo every
 * installation ships, the procedure is instead added the way every other demo
 * GLB patch is made — nodes through `rv-glb-nodes` (file-wide name rules), the
 * components in exactly the shape the editor writes (`ComponentReference`
 * object form, asset-relative authored paths, `{x,y,z}` vectors in viewer
 * coordinates) — and every existing byte stays as it is. The editor functions of
 * Phase 4 are accepted separately on the resulting GLB (open, inspect, picker,
 * rename/move rewrite).
 *
 * Needs the coolant nozzle node of `extract-demo-coolant-nozzle.mjs` (the real
 * nozzle of the spindle head, cut out of `ZAxis_3`).
 *
 * Camera views stand where a person stands: eye height ~1.6 m, in front of the
 * part the step is about (review Thomas 2026-10-22).
 *
 * Usage: node scripts/build-demo-maintenance-procedure.mjs [--in <glb>] [--out <glb>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { createGroup, findByPath, fileNameCollisions } from './lib/rv-glb-nodes.mjs';
import { NOZZLE_PATH } from './extract-demo-coolant-nozzle.mjs';

export const PROCEDURE_PARENT = 'DemoCell/CNC';
export const PROCEDURE_NAME = 'Maintenance';
export const PROCEDURE_PATH = `${PROCEDURE_PARENT}/${PROCEDURE_NAME}`;

const CNC_DOOR = 'DemoCell/CNC/CNCCase|CNCDoor';
const CNC_CASE = 'DemoCell/CNC/CNCCase';
const CNC_SCREEN = 'DemoCell/CNC/Screen';
const MAIN_SWITCH = 'DemoCell/CabinetStanding/ButtonContainer/HandleSwitchOn';
const MAIN_SWITCH_LEVER = `${MAIN_SWITCH}/HandleOnSwitch/PlaneOnSwitch`;
const FENCE_DOOR = 'DemoCell/Fences/Fence-1m-Door/Door';
const NOZZLE = NOZZLE_PATH;
// The CNC axes go to their maintenance position (0) when the cell stops, so the
// nozzle is always where the camera views expect it.
const CNC_AXES = ['X_Axis', 'X_Axis/YAxis', 'X_Axis/YAxis/ZAxis'].map((p) => `DemoCell/CNC/MovingParts/${p}`);

const ref = (path, componentType = '') => ({ type: 'ComponentReference', path, componentType });
const v3 = (x, y, z) => ({ x, y, z });
const NO_VIEW = { CameraPosition: v3(0, 0, 0), CameraTarget: v3(0, 0, 0) };

// Viewer-world camera views (metres): eye height ~1.6 m, standing in front.
const VIEW_SCREEN = { CameraPosition: v3(1.95, 1.65, -1.1), CameraTarget: v3(1.33, 1.55, -0.55) };
const VIEW_SWITCH = { CameraPosition: v3(4.14, 1.55, 0.62), CameraTarget: v3(3.62, 1.13, 1.12) }; // from the side and lower: no glare on the white panel
const VIEW_DOORS = { CameraPosition: v3(5.0, 1.65, 0.1), CameraTarget: v3(2.9, 1.1, 0.05) };
const VIEW_INSIDE = { CameraPosition: v3(1.75, 1.75, 0.95), CameraTarget: v3(0.55, 1.3, 0.0) }; // beside the robot (base at x 1.57, z 0.11)
const VIEW_NOZZLE = { CameraPosition: v3(0.98, 1.52, 0.22), CameraTarget: v3(0.55, 1.37, 0.05) };

function step(fields) {
  return {
    Title: '', Instruction: '', WarningNote: '', Severity: 'Info', CompletionType: 'Checkbox',
    CheckboxLabel: 'Done', EstimatedMinutes: 1, ...NO_VIEW, CameraDuration: 1.2, HighlightTargets: [],
    ...fields,
  };
}
const driveTo = (destination, drive = CNC_DOOR) => ({ drive: ref(drive, 'Drive'), Destination: destination, Relative: false });
const axesHome = () => Object.fromEntries(CNC_AXES.map((p, k) => [k === 0 ? 'LogicStep_DriveTo' : `LogicStep_DriveTo_${k}`, driveTo(0, p)]));
const spray = (intensity, clogged) => ({
  Type: 'CoolantSpray', Anchors: [ref(NOZZLE)], Intensity: intensity,
  ReducedAnchors: clogged ? [ref(NOZZLE)] : [], ReducedIntensity: 0.15, Length: 0.14, Angle: 10, StartDelay: 0,
});
/**
 * Unscrew (or refit) the tip. It is screwed into the elbow from below, so it comes
 * OUT along its spray direction (`dir` = local -Y in the ZAxis frame), turning
 * the loosening way of a right-hand thread: negative about local +Y.
 */
const nozzleMove = (dir, out, delay = 0) => ({
  Targets: [ref(NOZZLE)],
  PositionOffset: out ? v3(dir[0] * 0.03, dir[1] * 0.03, dir[2] * 0.03) : v3(0, 0, 0),
  RotationAxis: v3(0, 1, 0), RotationAngle: out ? -720 : 0, Duration: 2.0, Easing: 'Linear', ScrewMotion: true, StartDelay: delay,
});
/**
 * The main switch lever turns a quarter turn about its own axis (local Z, the panel
 * normal) to OFF and back. The running cell has it ON = the switch cap's active
 * offset (-90 deg from rest), so OFF is +90 back to the rest pose: counter-clockwise
 * as seen from the front.
 */
const mainSwitch = (off, delay = 0) => ({
  Targets: [ref(MAIN_SWITCH_LEVER)], PositionOffset: v3(0, 0, 0), RotationAxis: v3(0, 0, 1), RotationAngle: off ? 90 : 0,
  Duration: 0.8, Easing: 'EaseInOut', ScrewMotion: false, StartDelay: delay,
});
const fenceDoor = (angle) => ({
  Targets: [ref(FENCE_DOOR)], PositionOffset: v3(0, 0, 0), RotationAxis: v3(0, 1, 0), RotationAngle: angle,
  Duration: 1.5, Easing: 'EaseInOut', ScrewMotion: false, StartDelay: 0,
});
const transparency = (opacity) => ({ Targets: [ref(CNC_CASE)], Opacity: opacity, Duration: 0.8, StartDelay: 0 });

/** The nine steps of §3.4: [node name, components]. */
export function procedureSteps(fenceOpenAngle, sprayDir) {
  return [
    ['01 Cell stopped', {
      LogicStep_MaintenanceStep: step({
        Title: 'Cell stopped',
        Instruction: 'The cell has been frozen for maintenance and the CNC axes are in their maintenance position. Check on the machine screen that the CNC is idle and no part is being machined.',
        ...VIEW_SCREEN, HighlightTargets: [ref(CNC_SCREEN)], CheckboxLabel: 'Machine is idle',
      }),
      ...axesHome(),
    }],
    ['02 Lockout main switch', {
      LogicStep_MaintenanceStep: step({
        Title: 'Lockout / tagout main switch',
        Instruction: 'Turn the main switch on the control panel to OFF, attach your personal padlock and the tag.',
        WarningNote: 'Never work inside the machine without your own lock on the main switch.',
        Severity: 'Warning', CompletionType: 'ConfirmWarning', CheckboxLabel: 'Main switch locked out',
        ...VIEW_SWITCH, HighlightTargets: [ref(MAIN_SWITCH)], EstimatedMinutes: 2,
      }),
      LogicStep_AnimateTransform: mainSwitch(true, 0.6),
    }],
    ['03 Open doors', {
      LogicStep_MaintenanceStep: step({
        Title: 'Open safety fence and machine door',
        Instruction: 'Open the safety fence door, then slide the CNC machine door fully open.',
        ...VIEW_DOORS, HighlightTargets: [ref(FENCE_DOOR), ref(CNC_DOOR)], CheckboxLabel: 'Doors open',
      }),
      LogicStep_DriveTo: driveTo(600),
      LogicStep_AnimateTransform: fenceDoor(fenceOpenAngle),
    }],
    ['04 Look inside', {
      LogicStep_MaintenanceStep: step({
        Title: 'Look inside',
        Instruction: 'The housing is shown transparent so you can see the spindle and its coolant nozzle below the black elbow.',
        CompletionType: 'Observation', ...VIEW_INSIDE,
      }),
      LogicStep_SetTransparency: transparency(0.25),
    }],
    ['05 Check spray pattern', {
      LogicStep_MaintenanceStep: step({
        Title: 'Check spray pattern',
        Instruction: 'Run a coolant test. The nozzle should spray a full jet at the tool, but it only drips: the tip is clogged.',
        Severity: 'Warning', CompletionType: 'Observation', ...VIEW_NOZZLE, HighlightTargets: [ref(NOZZLE)],
      }),
      LogicStep_Effect: spray(1, true),
    }],
    ['06 Unscrew nozzle tip', {
      LogicStep_MaintenanceStep: step({
        Title: 'Unscrew nozzle tip',
        Instruction: 'Stop the coolant. Unscrew the nozzle tip by hand (two turns).',
        ...VIEW_NOZZLE, HighlightTargets: [ref(NOZZLE)], CheckboxLabel: 'Tip removed', EstimatedMinutes: 3,
      }),
      LogicStep_Effect: spray(0, false),
      LogicStep_AnimateTransform: nozzleMove(sprayDir, true, 0.4),
    }],
    ['07 Clean tip', {
      LogicStep_MaintenanceStep: step({
        Title: 'Clean tip with compressed air',
        Instruction: 'Blow through the tip with compressed air from the mouth side until the bore is free. Check against the light.',
        WarningNote: 'Wear eye protection.', Severity: 'Warning', CheckboxLabel: 'Tip clean', EstimatedMinutes: 5,
      }),
    }],
    ['08 Refit tip', {
      LogicStep_MaintenanceStep: step({
        Title: 'Refit tip and test spray',
        Instruction: 'Screw the tip back in hand-tight and run the coolant test again: the jet must now be full and even.',
        CompletionType: 'Observation', ...VIEW_NOZZLE, EstimatedMinutes: 3,
      }),
      LogicStep_AnimateTransform: nozzleMove(sprayDir, false),
      LogicStep_Effect: { ...spray(1, false), StartDelay: 2.4 },
    }],
    ['09 Close doors', {
      LogicStep_MaintenanceStep: step({
        Title: 'Close doors and release lockout',
        Instruction: 'Stop the coolant, close the machine door and the safety fence, remove your lock and tag and switch the main switch back on.',
        Severity: 'Success', ...VIEW_DOORS, HighlightTargets: [ref(FENCE_DOOR), ref(MAIN_SWITCH)],
        CheckboxLabel: 'Cell ready', EstimatedMinutes: 2,
      }),
      LogicStep_Effect: spray(0, false),
      LogicStep_SetTransparency: transparency(1),
      LogicStep_DriveTo: driveTo(0),
      LogicStep_AnimateTransform: fenceDoor(0),
      LogicStep_AnimateTransform_1: mainSwitch(false, 1.6),
    }],
  ];
}

export function addProcedure(buffer, { fenceOpenAngle = -100 } = {}) {
  const { json, rest } = readGlb(buffer);
  if (findByPath(json, PROCEDURE_PATH) !== null) throw new Error(`${PROCEDURE_PATH} already exists`);
  for (const p of [NOZZLE, ...CNC_AXES, CNC_DOOR, CNC_CASE, CNC_SCREEN, MAIN_SWITCH, MAIN_SWITCH_LEVER, FENCE_DOOR]) {
    if (findByPath(json, p) === null) throw new Error(`reference target missing: ${p}`);
  }
  // Spray direction of the nozzle tip = its local -Y in the ZAxis frame.
  const [qx, qy, qz, qw] = json.nodes[findByPath(json, NOZZLE)].rotation ?? [0, 0, 0, 1];
  const sprayDir = [-2 * (qx * qy - qw * qz), -(1 - 2 * (qx * qx + qz * qz)), -2 * (qy * qz + qw * qx)];
  const collisions = fileNameCollisions(json).length;
  const proc = createGroup(json, PROCEDURE_PARENT, PROCEDURE_NAME);
  json.nodes[proc.nodeIndex].extras = {
    realvirtual: { LogicStep_MaintenanceProcedure: { ProcedureName: 'Coolant Nozzle Cleaning', EstimatedMinutes: 0 } },
  };
  const made = [];
  for (const [name, comps] of procedureSteps(fenceOpenAngle, sprayDir)) {
    const r = createGroup(json, PROCEDURE_PATH, name);
    json.nodes[r.nodeIndex].extras = { realvirtual: comps };
    made.push(r.path);
  }
  for (const a of demoArrows()) {
    const r = createGroup(json, `${PROCEDURE_PATH}/${a.step}`, a.name);
    Object.assign(json.nodes[r.nodeIndex], localPose(json, findByPath(json, `${PROCEDURE_PATH}/${a.step}`), a));
    json.nodes[r.nodeIndex].extras = { realvirtual: { LogicStep_Arrow: { Type: a.type, Size: a.size, Animate: true } } };
    made.push(r.path);
  }
  if (fileNameCollisions(json).length !== collisions) throw new Error('new file-wide name collisions');
  return { out: writeGlb(json, rest), steps: made };
}

// ─── Arrows (LogicStep_Arrow) ─────────────────────────────────────────
// World poses in viewer metres, measured in the running viewer with the CNC axes
// in their maintenance position (0): the arrow lies in the plane spanned by its
// direction `x` and normal `z` and is seen from the +z side.

const V = (x, y, z) => new Vector3(x, y, z);
// Main switch lever (PlaneOnSwitch): pivot, panel normal (= its local +Z, facing the operator), panel right.
const LEVER = V(3.6829, 1.1007, 1.2206);
const PANEL_N = V(0.652, 0.708, -0.27).normalize();
const PANEL_X = V(-0.383, 0, -0.924).normalize();
// Coolant nozzle: mouth, body axis (local +Y, up into the elbow), and the step camera.
const MOUTH = V(0.5372, 1.3758, 0.0557);
const BODY_UP = V(0.437, 0.876, 0.204).normalize();
const NOZZLE_EYE = V(VIEW_NOZZLE.CameraPosition.x, VIEW_NOZZLE.CameraPosition.y, VIEW_NOZZLE.CameraPosition.z);

/** The arrows of the demo: switch quarter turn (CCW off, CW on — seen from the front), nozzle unscrew / refit. */
export function demoArrows() {
  const forward = MOUTH.clone().sub(NOZZLE_EYE).normalize();
  const right = new Vector3().crossVectors(forward, V(0, 1, 0)).normalize(); // screen right at the nozzle
  const toEye = forward.clone().negate();
  const facing = (dir) => toEye.clone().addScaledVector(dir, -toEye.dot(dir)).normalize();
  // Turning icon as a ring around the screw axis (BODY_UP) of the tip, tilted towards the eye so it
  // is not seen edge-on. BODY_UP points to the eye's side, so unscrewing (negative about BODY_UP) is
  // clockwise as seen there.
  const turnAt = MOUTH.clone().addScaledVector(BODY_UP, 0.012);
  const turnN = BODY_UP.clone().addScaledVector(facing(BODY_UP), 0.8).normalize();
  const spray = BODY_UP.clone().negate();
  // The out arrow on the screw axis, starting right below the tip.
  const moveAt = MOUTH.clone().addScaledVector(spray, 0.035);
  const leverAt = LEVER.clone().addScaledVector(PANEL_N, 0.025);
  return [
    { step: '02 Lockout main switch', name: 'Arrow switch off', type: 'RotateCCW', size: 0.24, pos: leverAt, x: PANEL_X, z: PANEL_N },
    { step: '06 Unscrew nozzle tip', name: 'Arrow tip turn out', type: 'RotateCW', size: 0.085, pos: turnAt, x: right, z: turnN },
    { step: '06 Unscrew nozzle tip', name: 'Arrow tip out', type: 'Linear', size: 0.05, pos: moveAt, x: spray, z: facing(spray) },
    { step: '08 Refit tip', name: 'Arrow tip turn in', type: 'RotateCCW', size: 0.085, pos: turnAt, x: right, z: turnN },
    { step: '08 Refit tip', name: 'Arrow tip in', type: 'Linear', size: 0.05, pos: moveAt, x: BODY_UP, z: facing(BODY_UP) },
    { step: '09 Close doors', name: 'Arrow switch on', type: 'RotateCW', size: 0.24, pos: leverAt, x: PANEL_X, z: PANEL_N },
  ];
}

/** World matrix of a GLB node (translation/rotation/scale or matrix, up the parent chain). */
function worldMatrix(json, index) {
  const parentOf = new Map();
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const local = (n) => (n.matrix ? new Matrix4().fromArray(n.matrix)
    : new Matrix4().compose(V(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), V(...(n.scale ?? [1, 1, 1]))));
  const m = new Matrix4();
  for (let i = index; i !== undefined; i = parentOf.get(i)) m.premultiply(local(json.nodes[i]));
  return m;
}

/** Node TRS below `parentIndex` that puts the arrow at world `pos` with world direction `x` and normal `z`. */
function localPose(json, parentIndex, { pos, x, z }) {
  const inv = worldMatrix(json, parentIndex).invert();
  const p = pos.clone().applyMatrix4(inv);
  const lx = x.clone().transformDirection(inv);
  const lz = z.clone().transformDirection(inv);
  lz.addScaledVector(lx, -lz.dot(lx)).normalize();
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(lx, new Vector3().crossVectors(lz, lx), lz));
  return { translation: p.toArray(), rotation: q.toArray() };
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const input = resolve(arg('--in') ?? 'public/demo-realvirtual/DemoRealvirtualWeb.glb');
  const output = resolve(arg('--out') ?? input);
  const angle = arg('--fence-angle');
  const { out, steps } = addProcedure(readFileSync(input), angle ? { fenceOpenAngle: Number(angle) } : {});
  writeFileSync(output, out);
  for (const s of steps) console.log(s);
  console.log(`wrote ${output} (${out.length} bytes)`);
}
