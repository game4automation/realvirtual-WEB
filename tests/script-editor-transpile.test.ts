// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-editor-transpile.test.ts — plan-210 phase 3 (§4.2/§4.3): TS→JS
 * erasure through the REAL Monaco TypeScript worker (browser test — Monaco is
 * loaded lazily here exactly as the panel does, which also exercises the
 * loader's worker setup end-to-end).
 *
 * Asserts the emitted JS is QuickJS-conservative: type annotations gone, no
 * import/export emit (module: None — the stored contract is a plain script
 * against the global `setup` convention), and the emit feeds cleanly into
 * `validateScriptForSave`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadScriptEditorMonaco, transpileModel, SCRIPT_LANGUAGE_ID, type Monaco,
} from '../src/core/hmi/script/monaco-loader';
import { validateScriptForSave } from '../src/core/hmi/script/rv-script-save-pipeline';

let monaco: Monaco;

beforeAll(async () => {
  monaco = await loadScriptEditorMonaco();
}, 60_000);

let modelCounter = 0;

async function transpile(code: string) {
  const uri = monaco.Uri.parse(`file:///rv-script-test/${modelCounter++}.ts`);
  const model = monaco.editor.createModel(code, SCRIPT_LANGUAGE_ID, uri);
  try {
    return await transpileModel(monaco, model);
  } finally {
    model.dispose();
  }
}

describe('TS→JS erasure via the Monaco TS worker (§4.3)', () => {
  it('erases type annotations, interfaces and casts', async () => {
    const ts = `interface GateState { open: boolean }
type Speed = number;
function setup(self: Self): Handlers {
  const state: GateState = { open: false };
  const v: Speed = 100 as Speed;
  return {
    continuous: {
      fixedUpdate(dt: number): void {
        if (!state.open && v > 0) self.log('tick', dt);
      },
    },
  };
}`;
    const result = await transpile(ts);
    expect(result.syntaxErrors).toEqual([]);
    expect(result.js.length).toBeGreaterThan(0);
    // Types erased:
    expect(result.js).not.toContain('interface');
    expect(result.js).not.toContain(': Self');
    expect(result.js).not.toContain(': Handlers');
    expect(result.js).not.toContain(': number');
    expect(result.js).not.toContain(' as Speed');
    // Logic kept:
    expect(result.js).toContain('function setup(self)');
    expect(result.js).toContain("self.log('tick', dt)");
  });

  it('produces no import/export emit (plain-script contract, module: None)', async () => {
    const result = await transpile(`function setup(self: Self) { return {}; }`);
    expect(result.js).not.toMatch(/\bexport\b/);
    expect(result.js).not.toMatch(/\bimport\b/);
    expect(result.js).not.toMatch(/\brequire\s*\(/);
    expect(result.js).not.toContain('Object.defineProperty(exports');
  });

  it('emitted JS parses under the save-pipeline validation (QuickJS-conservative)', async () => {
    const result = await transpile(`function setup(self: Self): Handlers {
  let count: number = 0;
  return { continuous: { fixedUpdate(dt: number) { count += 1; } } };
}`);
    expect(result.syntaxErrors).toEqual([]);
    const validation = validateScriptForSave(result.js);
    expect(validation.ok).toBe(true);
  });

  it('a top-level export is rejected before any swap (validation gate)', async () => {
    const result = await transpile(`export function setup(self: Self) { return {}; }`);
    // Either the worker flags it (module: None) or the emitted module syntax
    // fails the plain-script parse — both block the save.
    const blocked = result.syntaxErrors.length > 0
      || result.semanticErrors.length > 0
      || !validateScriptForSave(result.js).ok;
    expect(blocked).toBe(true);
  });

  it('reports syntax errors instead of emitting broken JS silently', async () => {
    const result = await transpile('function setup( {');
    expect(result.syntaxErrors.length).toBeGreaterThan(0);
  });

  it('SDK typings are active: self surface known, DOM absent (§4.2)', async () => {
    // `self.drive` comes from rv-sdk.d.ts; `window`/`fetch` must be unknown
    // identifiers under noLib + minimal ambient lib.
    const good = await transpile(`function setup(self: Self) {
  const d = self.drive('Line1/Drive');
  return {};
}`);
    expect(good.semanticErrors).toEqual([]);

    const domFree = await transpile(`function setup(self: Self) {
  window.alert('x');
  fetch('/nope');
  return {};
}`);
    expect(domFree.semanticErrors.length).toBeGreaterThan(0);
  });
});
