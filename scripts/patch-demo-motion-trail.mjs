// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Adds two MotionTrails to the standard demo: a speed-coloured TCP gripper band
// and whole-robot ghosts. Both use Robot/MotionTrailRecord, initially false.
// The left-bar "Motion trails" button overrides recording scene-wide.
//
// Usage: node scripts/patch-demo-motion-trail.mjs [--in glb] [--out glb] [--update-project]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';
import { updateDemoProjectMetadata } from './patch-demo-turbine-collider.mjs';

export const TRAIL_NODE_PATH = 'Robot/FanucCRX-10iA_L';
export const TCP_TRAIL_NODE_PATH = `${TRAIL_NODE_PATH}/A1/A2/A3/A4/A5/A6/TCP/SchunkEGH80Gripper`;
export const RECORD_SIGNAL = 'MotionTrailRecord';

const ref = (name) => ({ type: 'ComponentReference', path: `Robot/${name}`,
  componentType: 'realvirtual.PLCOutputBool', componentIndex: 0 });

export const ROBOT_MOTION_TRAIL = {
  _fullTypeName: 'realvirtual.MotionTrail', _version: 1, _enabled: true,
  Mode: 'Ghosts', SignalRecord: ref(RECORD_SIGNAL), SignalClear: null,
  MinDistance: 20, MinAngle: 5, BreakDistance: 500, MaxSegments: 5000,
  Lifetime: 3, FadeFraction: 0.5, Color: '#90CAF9', Opacity: 0.35,
  SpeedColoring: false, SpeedMin: 0, SpeedMax: 2000,
  SpeedColorLow: '#FFEB3B', SpeedColorHigh: '#E91E63',
  GhostInterval: 0.6, GhostCount: 5, GhostOpacity: 0.25,
};
export const MOTION_TRAIL = ROBOT_MOTION_TRAIL;
export const TCP_MOTION_TRAIL = {
  ...ROBOT_MOTION_TRAIL, Mode: 'Band', MinDistance: 5,
  FadeFraction: 0.7, Color: '#FF9800', Opacity: 0.3,
  SpeedColoring: true, SpeedMax: 1500, SpeedColorLow: '#29B6F6', SpeedColorHigh: '#FF5722',
};

function signalNode(name, comment) {
  return { name, extras: { realvirtual: {
    PLCOutputBool: {
      _fullTypeName: 'realvirtual.PLCOutputBool', _version: 2, _enabled: true,
      Status: { Connected: true, ValueOverride: true, Value: false, OldValue: false },
      Comment: comment, OriginDataType: '',
      Settings: { Active: true, DetectBoolFlanks: false, Override: false },
      Metadata: { Metadata: [] }, Name: name, Active: 'Always',
    },
    layer: 0, tag: 'Untagged', activeSelf: true,
  } } };
}

function pathIndex(json) {
  const parent = {};
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parent[c] = i; }));
  const pathOf = (i) => { const p = []; for (let k = i; k !== undefined; k = parent[k]) p.unshift(json.nodes[k].name); return p.join('/'); };
  return json.nodes.map((_, i) => pathOf(i));
}

/** Pure, idempotent patch: all other JSON and the binary remainder stay intact. */
export function patchDemoMotionTrail(glbBuffer) {
  const { json, rest } = readGlb(glbBuffer);
  const paths = pathIndex(json);
  const find = (p) => {
    const hits = paths.flatMap((q, i) => (q === p ? [i] : []));
    if (hits.length > 1) throw new Error(`Ambiguous node ${p}`);
    return hits[0];
  };
  const robot = find('Robot');
  const target = find(TRAIL_NODE_PATH);
  const tcp = find(TCP_TRAIL_NODE_PATH);
  if (robot === undefined || target === undefined || tcp === undefined) throw new Error('Robot, robot root or TCP gripper node missing');
  let changed = false;
  for (const [name, comment] of [
    [RECORD_SIGNAL, 'Demo: records the robot motion trail while true; the left-bar Motion trails button overrides it'],
  ]) {
    if (find(`Robot/${name}`) !== undefined) continue;
    json.nodes.push(signalNode(name, comment));
    (json.nodes[robot].children ??= []).push(json.nodes.length - 1);
    changed = true;
  }
  for (const [index, config] of [[target, ROBOT_MOTION_TRAIL], [tcp, TCP_MOTION_TRAIL]]) {
    const rv = ((json.nodes[index].extras ??= {}).realvirtual ??= {});
    if (!isDeepStrictEqual(rv.MotionTrail, config)) { rv.MotionTrail = config; changed = true; }
  }
  return changed ? { buffer: writeGlb(json, rest), changed } : { buffer: glbBuffer, changed };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: {
    in: { type: 'string' }, out: { type: 'string' }, 'update-project': { type: 'boolean' },
  } });
  const input = resolve(values.in ?? 'public/demo-realvirtual/DemoRealvirtualWeb.glb');
  const output = resolve(values.out ?? input);
  const { buffer, changed } = patchDemoMotionTrail(readFileSync(input));
  if (changed || output !== input) writeFileSync(output, buffer);
  if (values['update-project']) updateDemoProjectMetadata(output, buffer);
  console.log(changed ? `patched ${output}` : `${output} already up to date`);
}
