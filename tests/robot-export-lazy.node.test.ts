// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-export-lazy.node.test.ts — plan-773 §8 T6: the robot program export
 * does not grow the default load.
 *
 * ## Why this is a SOURCE test and not a network one
 *
 * The house rule (2026-10-23) is that the FEATURE CODE is lazy, not merely a
 * binary blob, and that the proof is the BUILD IMPORT GRAPH rather than a
 * network protocol: a request that never fires proves nothing about what is
 * already sitting in the entry chunk. So this walks the static graph from
 * `src/main.ts` with the same walker `tests/bundle-eager-imports.node.test.ts`
 * uses (`tests/helpers/static-import-graph.ts`) and asserts three things:
 *
 * 1. No module of `src/core/robot-program/` is statically reachable from the
 *    entry — not the model, not the converter, not the vendor catalogue.
 * 2. Not from the MCP bridge chunk either. That is stricter than T6 asks for
 *    and is plan-773 §2.5 taken literally (*"`src/core/robot-program/**` is
 *    never statically imported"*): the bridge is loaded in every session that
 *    talks to an agent, so letting the export core ride along with it would
 *    make "lazy" mean "one chunk later" rather than "on use".
 * 3. Each vendor is reached by its OWN literal `import()`. A computed
 *    specifier (`./vendors/${id}`) makes Rollup emit a glob of every match into
 *    ONE chunk, which looks dynamic and is not per-vendor — the single thing
 *    plan-773 §2.3 bought by choosing a TypeScript port over a WASM core.
 *
 * The runtime half (the chunks really do load, and only the asked-for vendor
 * does) is covered where it can be observed: `robot-program-vendors.node.test.ts`
 * loads each vendor through `loadRobotPostProcessor` and asserts the class that
 * comes back.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dynamicSpecifiers, eagerGraphPaths, resolveSpec, REPO_ROOT as ROOT, norm,
} from './helpers/static-import-graph';
import { ROBOT_VENDOR_IDS } from '../src/core/robot-program/rv-robot-vendors';

const EXPORT_CORE = 'src/core/robot-program/';
const VENDORS_MODULE = resolve(ROOT, 'src/core/robot-program/rv-robot-vendors.ts');

/** Files of the export core inside one static graph. */
function exportCoreIn(entry: string): string[] {
  return eagerGraphPaths(resolve(ROOT, entry)).filter((f) => f.includes(EXPORT_CORE));
}

describe('plan-773 T6 — the export core stays out of the default load', () => {
  it('walks a real graph (so an empty result means absence, not a broken walker)', () => {
    expect(eagerGraphPaths(resolve(ROOT, 'src/main.ts')).length).toBeGreaterThan(100);
  });

  it('no module of src/core/robot-program/ is reachable from src/main.ts', () => {
    expect(exportCoreIn('src/main.ts')).toEqual([]);
  });

  it('nor from the MCP bridge chunk (plan-773 §2.5, taken literally)', () => {
    expect(exportCoreIn('src/plugins/mcp-bridge-plugin.ts')).toEqual([]);
  });

  it('nor from the embed entry', () => {
    expect(exportCoreIn('src/embed/rv-embed-viewer.ts')).toEqual([]);
  });

  it('the two callers reach it by import() — so the absence above is laziness, not omission', () => {
    const bridge = readFileSync(resolve(ROOT, 'src/plugins/mcp-bridge/rv-mcp-robot-tools.ts'), 'utf8');
    const ui = readFileSync(resolve(ROOT, 'src/core/hmi/rv-ik-path-field-renderer.tsx'), 'utf8');
    expect(dynamicSpecifiers(bridge).filter((s) => s.includes('robot-program/')).length).toBeGreaterThan(0);
    expect(dynamicSpecifiers(ui).filter((s) => s.includes('robot-program/')).length).toBeGreaterThan(0);
  });
});

describe('plan-773 T6 — every vendor is its own chunk', () => {
  const src = readFileSync(VENDORS_MODULE, 'utf8');
  const dyn = dynamicSpecifiers(src);

  it('the catalogue holds one literal import() per vendor', () => {
    expect(dyn.filter((s) => s.startsWith('./vendors/'))).toHaveLength(ROBOT_VENDOR_IDS.length);
    for (const spec of dyn.filter((s) => s.startsWith('./vendors/'))) {
      expect(resolveSpec(VENDORS_MODULE, spec), spec).not.toBeNull();
    }
  });

  it('no COMPUTED specifier — a template literal would collapse the vendors into one chunk', () => {
    expect(/import\s*\(\s*[`'"][^`'"]*\$\{/.test(src), 'rv-robot-vendors.ts').toBe(false);
  });

  it('the catalogue itself does not statically import a single vendor', () => {
    const reachable = eagerGraphPaths(VENDORS_MODULE).map(norm);
    expect(reachable.filter((f) => f.includes('/robot-program/vendors/'))).toEqual([]);
  });

  it('a vendor does not pull a sibling vendor in with it', () => {
    for (const id of ROBOT_VENDOR_IDS) {
      const file = resolve(ROOT, `src/core/robot-program/vendors/rv-${id === 'abb-rapid' ? 'abb-rapid' : 'sew-srlprg'}.ts`);
      const others = eagerGraphPaths(file).filter((f) => f.includes('/robot-program/vendors/') && !norm(f).endsWith(norm(file).split('/').pop()!));
      expect(others, id).toEqual([]);
    }
  });
});
