// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.5 / F4 — "is this file a plugin?", answered without running it.
 *
 * The gesture the plan adds makes it easy to bind the wrong file: with the glob
 * opened, every `.ts` under `plugins/` is draggable, and most of them are helper
 * modules that export no plugin pair at all. Binding one used to produce a chip
 * saying "bound" and a viewer doing nothing.
 *
 * The one thing the answer may NOT do is import the file. Importing it is
 * exactly what a user who bound the wrong file does not want to happen — and on
 * a helper with side effects it is worse than the missing plugin. So the answer
 * comes from the source TEXT, read through the `?raw` glob the migration
 * already uses.
 *
 * The rule is tested through `scanPluginExportsIn`, which takes the text
 * directly. `scanPluginExports` (the glob-backed wrapper) resolves to whatever
 * files happen to be on the machine, and a test that depended on that would be
 * a test of the checkout rather than of the rule.
 */

import { describe, it, expect } from 'vitest';
import {
  scanPluginExports,
  scanPluginExportsIn,
} from '../src/core/rv-model-plugin-manager';

const REGISTER = 'export function registerModelPlugins(viewer) {}';
const UNREGISTER = 'export function unregisterModelPlugins(viewer) {}';

describe('plan-479 F4 — the pair is recognised in every spelling in the tree', () => {
  it('accepts plain function declarations', () => {
    const scan = scanPluginExportsIn(`${REGISTER}\n${UNREGISTER}\n`);
    expect(scan).toEqual({
      isPluginModule: true, hasRegister: true, hasUnregister: true, unreadable: false,
    });
  });

  it('accepts async functions and arrow consts', () => {
    expect(scanPluginExportsIn(
      'export async function registerModelPlugins(v: RVViewer) { await x(); }\n'
      + 'export const unregisterModelPlugins = (v: RVViewer) => { y(); };\n',
    ).isPluginModule).toBe(true);
  });

  it('accepts the pair anywhere in a long file, imports and all', () => {
    const source = [
      "import { Vector3 } from 'three';",
      "import { RibbonPanel } from './ribbon-panel';",
      'const state = { tension: 0 };',
      REGISTER,
      'function helper() { return state; }',
      UNREGISTER,
    ].join('\n');
    expect(scanPluginExportsIn(source).isPluginModule).toBe(true);
  });
});

describe('plan-479 F4 — a helper file is reported as one', () => {
  it('rejects a file with neither half', () => {
    const scan = scanPluginExportsIn(
      "import { Vector3 } from 'three';\nexport function tensionOf(x: number) { return x; }\n",
    );
    expect(scan.isPluginModule).toBe(false);
    expect(scan.hasRegister).toBe(false);
    expect(scan.hasUnregister).toBe(false);
    // Readable, and the answer is a real "no" — not the "no answer" of a file
    // the scan could not reach.
    expect(scan.unreadable).toBe(false);
  });

  it('rejects HALF a pair, and says which half is there', () => {
    // The most misleading shape of all: it looks like a plugin and the manager
    // would refuse it at load time with a console line nobody reads.
    const scan = scanPluginExportsIn(`${REGISTER}\n`);
    expect(scan.isPluginModule).toBe(false);
    expect(scan.hasRegister).toBe(true);
    expect(scan.hasUnregister).toBe(false);
  });

  it('is not fooled by a mention that is not an export', () => {
    const source = [
      '// registerModelPlugins is called by the manager',
      "import { registerModelPlugins } from './real-plugin';",
      'const unregisterModelPlugins = () => {};',   // declared, never exported
      'viewer.registerModelPlugins?.();',
    ].join('\n');
    expect(scanPluginExportsIn(source).isPluginModule).toBe(false);
  });

  it('does not accept a name that merely starts the same', () => {
    expect(scanPluginExportsIn(
      'export function registerModelPluginsLater() {}\n'
      + 'export function unregisterModelPluginsLater() {}\n',
    ).isPluginModule).toBe(false);
  });

  it('reads an empty or absent source as "no", not as a crash', () => {
    expect(scanPluginExportsIn('').isPluginModule).toBe(false);
    expect(scanPluginExportsIn(undefined as unknown as string).isPluginModule).toBe(false);
  });
});

describe('plan-479 F4 — the glob-backed wrapper', () => {
  it('says "no answer" for a reference nothing in the build matches', async () => {
    const scan = await scanPluginExports('plugins/nothing-of-the-sort.ts', 'NoSuchProject');
    // `unreadable`, NOT `isPluginModule: false` with a verdict: a project whose
    // code is not in this build resolves at RUNTIME, and painting that as
    // "exports nothing" would warn about a plugin that is about to work.
    expect(scan.unreadable).toBe(true);
    expect(scan.isPluginModule).toBe(false);
  });

  it('says "no answer" for an empty reference rather than scanning everything', async () => {
    expect((await scanPluginExports('')).unreadable).toBe(true);
    expect((await scanPluginExports('   ')).unreadable).toBe(true);
  });
});
