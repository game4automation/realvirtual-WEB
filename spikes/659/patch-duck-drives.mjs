// plan-659 Phase 3 (bridge) — write a copy of `rv-duck.glb` whose 14 joint
// nodes additionally carry `extras.realvirtual = { Drive: … }`, so the real
// viewer can be asked whether a Drive-carrying node survives the destructive
// bake.
//
// Only the JSON chunk is rewritten; the BIN chunk is copied byte for byte. The
// source file is READ ONLY (a parallel agent owns `duck/`).
//
//   node spikes/659/patch-duck-drives.mjs [out.glb]
//
// Default output: public/models/rv-duck-drives.glb (served by the dev server).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, 'duck/rv-duck.glb');
const OUT = resolve(process.argv[2] ?? resolve(here, '../../public/models/rv-duck-drives.glb'));

const RAD2DEG = 180 / Math.PI;
const align4 = (n) => (n + 3) & ~3;

const buf = readFileSync(SRC);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen;
const binLen = buf.readUInt32LE(binStart);
const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);

let patched = 0;
for (const node of json.nodes) {
  const j = node.extras?.rv_joint;
  if (!j) continue;
  const axis = j.axis ?? [0, 0, 1];
  // `directionToGltfAxis`: RotationZ -> (0,0,-1), reversed -> (0,0,+1);
  // RotationY -> (0,-1,0), reversed -> (0,1,0); RotationX -> (1,0,0).
  const dir = ['RotationX', 'RotationY', 'RotationZ'];
  const i = axis.findIndex((v) => Math.abs(v) > 0.999);
  if (i < 0) throw new Error(`joint ${j.name}: non-cardinal axis [${axis}]`);
  const positive = axis[i] > 0;
  // RotationX's glTF axis is +X, RotationY/-Z are NEGATIVE — so "reversed" is
  // inverted for X.
  const reverse = i === 0 ? !positive : positive;
  const standDeg = (j.stand_angle ?? 0) * RAD2DEG;
  node.extras.realvirtual = {
    Drive: {
      Direction: dir[i],
      ReverseDirection: reverse,
      // The authored pose IS the stand pose, so the drive's base quaternion is
      // `rest ⊗ R(axis, stand)`. Carrying `-stand` as the Offset makes
      // `currentPosition` the raw joint angle in degrees.
      Offset: -standDeg,
      UseLimits: false,
      TargetSpeed: 0,
    },
  };
  patched++;
}

const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPadded = align4(jsonBytes.length);
const total = 12 + 8 + jsonPadded + 8 + align4(bin.length);
const out = Buffer.alloc(total, 0);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonPadded, 12);
out.writeUInt32LE(0x4e4f534a, 16);
out.fill(0x20, 20, 20 + jsonPadded);
jsonBytes.copy(out, 20);
const p = 20 + jsonPadded;
out.writeUInt32LE(align4(bin.length), p);
out.writeUInt32LE(0x004e4942, p + 4);
bin.copy(out, p + 8);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`patched ${patched} joint nodes -> ${OUT} (${out.length} bytes)`);
