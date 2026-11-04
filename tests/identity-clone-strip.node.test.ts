// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 1b — identity of clones and reference nodes (Inventory C, F10, F12).
 *
 *  - `Object3D.clone()` JSON-copies `userData`: a runtime clone (ghost, MU spawn,
 *    chain element, multiuser / DES MU) arrives with its source's seed AND authored
 *    `NodeId`. `stripIdentity` takes both off the whole clone, the source keeps them.
 *  - `ensureRuntimeIdentity` gives a reference node no file produced (a live drop)
 *    a runtime id — once; an existing identity (authored or seeded) wins.
 *  - The runtime clone sites call it (source text check — the clones are built deep
 *    inside running components).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Object3D } from 'three';
import { ensureRuntimeIdentity, identityIdOf, stripIdentity } from '../src/core/engine/rv-decode-identity';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { getNodeId, setNodeId } from '../src/core/engine/rv-node-id';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tree(): { a: Object3D; b: Object3D } {
  const a = new Object3D();
  a.name = 'A';
  a.userData[RV_SEEDED_NODE_ID_KEY] = 'seed-a';
  const b = new Object3D();
  b.name = 'B';
  setNodeId(b, 'authored-b');
  b.userData.realvirtual.Drive = { TargetSpeed: 1 };
  a.add(b);
  return { a, b };
}

describe('plan-769 Phase 1b — clone identity (Inventory C)', () => {
  it('a JSON clone copies the identity; stripIdentity removes seed and NodeId from the clone only', () => {
    const { a } = tree();
    const clone = a.clone();
    expect(identityIdOf(clone)).toBe('seed-a');
    expect(identityIdOf(clone.children[0]!)).toBe('authored-b');
    expect(stripIdentity(clone)).toBe(2);
    expect(identityIdOf(clone)).toBeNull();
    expect(identityIdOf(clone.children[0]!)).toBeNull();
    // Other extras survive; the source is untouched.
    expect((clone.children[0]!.userData.realvirtual as { Drive?: unknown }).Drive).toEqual({ TargetSpeed: 1 });
    expect(identityIdOf(a)).toBe('seed-a');
    expect(getNodeId(a.children[0]!)).toBe('authored-b');
  });

  it('ensureRuntimeIdentity mints once, never over an existing identity, never as an authored NodeId', () => {
    const { a, b } = tree();
    expect(ensureRuntimeIdentity(a)).toBe('seed-a');
    expect(ensureRuntimeIdentity(b)).toBe('authored-b');
    const live = new Object3D();
    const id = ensureRuntimeIdentity(live);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ensureRuntimeIdentity(live)).toBe(id);
    expect(getNodeId(live)).toBeNull(); // runtime only: never written by a save (F17)
    expect(live.userData[RV_SEEDED_NODE_ID_KEY]).toBe(id);
  });

  it('the runtime clone sites strip the identity', () => {
    const sites: Array<[string, RegExp]> = [
      ['src/core/engine/rv-source.ts', /function stripComponentMetadata[\s\S]{0,400}stripIdentity\(obj\)/],
      ['src/core/engine/rv-chain.ts', /template\.clone\(\);[\s\S]{0,600}stripIdentity\(clone\)/],
      ['src/plugins/multiuser-plugin.ts', /template\.clone\(\);\s*\r?\n\s*\/\/[^\n]*\r?\n\s*stripIdentity\(clone\)/],
    ];
    for (const [file, re] of sites) expect(readFileSync(join(root, file), 'utf8'), file).toMatch(re);
  });
});
