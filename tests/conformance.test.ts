// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * conformance.test.ts — rv-ODT conformance suite runner (plan-187, Phase 4).
 *
 * Loads every GLB in schema/v1/conformance/ with a plain three.js GLTFLoader,
 * applies the rv-ODT component schemas (loadSchemaFromSpec + applySchema — the
 * reference reader's parsing pipeline, without scene wiring) and compares the
 * resulting component state against the *.expected.json fixtures: defaults
 * applied, aliases migrated, enum wire values mapped, unityCoords X negated.
 *
 * Regenerate the GLBs with: node scripts/generate-conformance-glbs.mjs
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applySchema, loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import rvOdt from '../schema/v1/rv-odt.json';

import glb01 from '../schema/v1/conformance/01-empty-scene.glb?url';
import glb02 from '../schema/v1/conformance/02-single-drive.glb?url';
import glb03 from '../schema/v1/conformance/03-drive-with-signal.glb?url';
import glb04 from '../schema/v1/conformance/04-transport-with-unitycoords.glb?url';
import glb05 from '../schema/v1/conformance/05-grip-with-enum.glb?url';
import glb06 from '../schema/v1/conformance/06-source-with-aliases.glb?url';

import exp01 from '../schema/v1/conformance/01-empty-scene.expected.json';
import exp02 from '../schema/v1/conformance/02-single-drive.expected.json';
import exp03 from '../schema/v1/conformance/03-drive-with-signal.expected.json';
import exp04 from '../schema/v1/conformance/04-transport-with-unitycoords.expected.json';
import exp05 from '../schema/v1/conformance/05-grip-with-enum.expected.json';
import exp06 from '../schema/v1/conformance/06-source-with-aliases.expected.json';

interface ExpectedFile {
  description: string;
  /** Why this file is hand-written and how to extend it (plan-2047). Optional. */
  maintenance?: string;
  nodes: Record<string, Record<string, Record<string, unknown>>>;
}

const CASES: Array<[string, string, ExpectedFile]> = [
  ['01-empty-scene', glb01, exp01 as ExpectedFile],
  ['02-single-drive', glb02, exp02 as ExpectedFile],
  ['03-drive-with-signal', glb03, exp03 as ExpectedFile],
  ['04-transport-with-unitycoords', glb04, exp04 as ExpectedFile],
  ['05-grip-with-enum', glb05, exp05 as ExpectedFile],
  ['06-source-with-aliases', glb06, exp06 as ExpectedFile],
];

const COMPONENT_KEYS = new Set(Object.keys((rvOdt as unknown as { components: Record<string, unknown> }).components));

/** Normalize applySchema output for JSON comparison (Vector3 → {x,y,z}). */
function normalize(value: unknown): unknown {
  if (value instanceof Vector3) return { x: value.x, y: value.y, z: value.z };
  return value;
}

describe('rv-ODT conformance suite', () => {
  it.each(CASES)('%s parses to the expected component state', async (_name, url, expected) => {
    const gltf = await new GLTFLoader().loadAsync(url);

    const actualNodes: Record<string, Record<string, Record<string, unknown>>> = {};
    gltf.scene.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      for (const [key, extras] of Object.entries(rv)) {
        if (!COMPONENT_KEYS.has(key)) continue; // _formatVersion etc.
        const instance: Record<string, unknown> = {};
        applySchema(instance, loadSchemaFromSpec(key), extras as Record<string, unknown>);
        for (const f of Object.keys(instance)) instance[f] = normalize(instance[f]);
        (actualNodes[node.name] ??= {})[key] = instance;
      }
    });

    expect(actualNodes).toEqual(expected.nodes);
  });

  /**
   * plan-2047 Fall 6 — the recurring cause, not the symptom.
   *
   * The `*.expected.json` fixtures are maintained BY HAND on purpose: an
   * expectation generated from the parser or the schema this suite checks would
   * be a mirror and would turn a real parser defect green. The price is that a
   * new rv-odt property with a default silently breaks the comparison above,
   * which is exactly how `7a7b64b7` (three new Grip defaults) left
   * 05-grip-with-enum red for three days with a diff nobody could place.
   *
   * This test makes that moment legible instead of generating the answer: it
   * only asserts that each default-carrying property is PRESENT in the fixture
   * of a type the fixture covers, and names the ones that are not. The expected
   * VALUE stays hand-written — the assertion says "decide about this field",
   * never "the parser's output is correct".
   */
  it('a new schema property with a default is named, not silently dropped', () => {
    const defs = (rvOdt as unknown as {
      $defs: Record<string, { properties?: Record<string, { default?: unknown }> }>;
    }).$defs;
    const missing: string[] = [];
    for (const [name, , expected] of CASES) {
      for (const [node, components] of Object.entries(expected.nodes)) {
        for (const [type, state] of Object.entries(components)) {
          for (const [field, prop] of Object.entries(defs[type]?.properties ?? {})) {
            if (prop.default === undefined) continue;
            if (field in state) continue;
            missing.push(`${name} ${node}.${type}.${field} (schema default ${JSON.stringify(prop.default)})`);
          }
        }
      }
    }
    expect(
      missing,
      'these schema properties carry a default but no conformance fixture states it — ' +
      'add each to its *.expected.json by hand, with the commit that introduced it',
    ).toEqual([]);
  });

  it('every conformance GLB carries _formatVersion 1.0 (except the empty scene)', async () => {
    for (const [name, url] of CASES.slice(1)) {
      const gltf = await new GLTFLoader().loadAsync(url);
      let found = false;
      gltf.scene.traverse((node) => {
        const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
        if (rv?._formatVersion === '1.0') found = true;
      });
      expect(found, `${name} should stamp _formatVersion`).toBe(true);
    }
  });
});
