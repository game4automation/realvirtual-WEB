// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The library Fanuc CRX WITHOUT its shipped robot definition — the fixture of
 * the rig-derivation suites.
 *
 * Until 2026-10-25 `public/library/Robots/FanucCRX-10iA-L.glb` shipped unrigged
 * (plan-773 E5), and the suites that test rigging a robot at runtime
 * (`web_robot_rig_from_library`, the IK path tools, the program export) used it
 * as their one REAL unrigged robot. Thomas then decided the library robot ships
 * with a `RobotIK` and a demo `IKPath` (`scripts/author-robot-ik.mjs`). The
 * derivation path itself is unchanged and still has to be tested on real
 * geometry, so this helper hands those suites the same file with exactly that
 * definition taken out again — in the JSON chunk only, the geometry bytes stay
 * as they are:
 *
 *   - `RobotIK` removed from the robot root;
 *   - `IKPath` / `IKTarget` removed from the `Robotpath` subtree, which leaves
 *     six component-free nodes that claim nothing and are not built by the bake.
 *
 * Pass the result as `{ data }` to `loadBakedGLB(LIBRARY_CRX_URL, …)`.
 */

export const LIBRARY_CRX_URL = '/library/Robots/FanucCRX-10iA-L.glb';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

type GltfNode = { name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> } };

/** Strip the shipped robot definition out of a GLB's JSON chunk. */
export function stripRobotDefinition(bytes: ArrayBuffer): ArrayBuffer {
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('stripRobotDefinition: not a GLB');
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('stripRobotDefinition: first chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen))) as { nodes: GltfNode[] };
  const rest = new Uint8Array(bytes, 20 + jsonLen);

  let removed = 0;
  for (const n of json.nodes) {
    const rv = n.extras?.realvirtual;
    if (!rv) continue;
    for (const key of ['RobotIK', 'IKPath', 'IKTarget']) {
      if (key in rv) { delete rv[key]; removed++; }
    }
  }
  if (removed === 0) throw new Error('stripRobotDefinition: the file carries no RobotIK / IKPath / IKTarget — stale fixture?');

  let text = JSON.stringify(json);
  const enc = new TextEncoder();
  let body = enc.encode(text);
  while (body.length % 4 !== 0) { text += ' '; body = enc.encode(text); }
  const total = 12 + 8 + body.length + rest.length;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, GLB_MAGIC, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, total, true);
  ov.setUint32(12, body.length, true);
  ov.setUint32(16, CHUNK_JSON, true);
  out.set(body, 20);
  out.set(rest, 20 + body.length);
  return out.buffer;
}

/** Fetch the library CRX and strip its shipped robot definition. */
export async function fetchUnriggedLibraryCrx(): Promise<ArrayBuffer> {
  const res = await fetch(LIBRARY_CRX_URL);
  if (!res.ok) throw new Error(`fetch ${LIBRARY_CRX_URL}: HTTP ${res.status}`);
  return stripRobotDefinition(await res.arrayBuffer());
}
