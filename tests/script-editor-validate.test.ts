// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-editor-validate.test.ts — plan-210 phase 3 (§4.3): the save pipeline
 * as PURE functions (no React, no Monaco — deliberate factoring so the gate
 * logic is testable headless; the Monaco part stays a thin shell).
 *
 *  - Parse errors / DES lint (with DesSafe escalation) / ApiVersion block the
 *    save: `validateScriptForSave` reports ok:false and the caller never
 *    reaches `applyScriptSave` — the old code keeps running (store and
 *    registry untouched by contract).
 *  - Valid saves emit exactly one `setCode` op (with `prev` for undo) and
 *    invoke the hot-reload sink.
 */

import { describe, expect, it } from 'vitest';
import {
  applyScriptSave, readWebComponentCode, validateScriptForSave, SCRIPT_TEMPLATE,
  type ScriptSceneStoreLike,
} from '../src/core/hmi/script/rv-script-save-pipeline';
import type { PrimitiveEditOp, SetCodeOp } from '../src/core/hmi/scene/rv-scene-edits';

const VALID = `function setup(self) {
  return { continuous: { fixedUpdate(dt) { /* noop */ } } };
}`;

function recordingStore(): { store: ScriptSceneStoreLike; ops: PrimitiveEditOp[] } {
  const ops: PrimitiveEditOp[] = [];
  return {
    ops,
    store: {
      applyOp: (op) => { ops.push(op); return Promise.resolve(); },
    },
  };
}

describe('validateScriptForSave (§4.3 gate)', () => {
  it('accepts a valid setup script', () => {
    const v = validateScriptForSave(VALID);
    expect(v.ok).toBe(true);
    expect(v.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('blocks on a syntax error (parse rule)', () => {
    const v = validateScriptForSave('function setup( { return }');
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'parse' && d.severity === 'error')).toBe(true);
  });

  it('blocks on leftover module syntax (export is not a script statement)', () => {
    // The stored contract is a plain script (global setup, phase 0) — a stray
    // `export` must never reach the QuickJS eval.
    const v = validateScriptForSave('export function setup(self) { return {}; }');
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'parse' || d.rule === 'module-syntax')).toBe(true);
  });

  it('blocks a CommonJS emit (exports.* parses, but must never reach QuickJS)', () => {
    // `new Function` accepts this (exports only explodes at RUNTIME) — the
    // dedicated module-syntax rule catches it.
    const cjs = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nfunction setup(self) { return {}; }\nexports.setup = setup;';
    const v = validateScriptForSave(cjs);
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'module-syntax')).toBe(true);
  });

  it('DES lint: fixedUpdate is a warning without DesSafe, an error with DesSafe', () => {
    const relaxed = validateScriptForSave(VALID, { desSafe: false });
    expect(relaxed.ok).toBe(true);
    expect(relaxed.diagnostics.some((d) => d.rule === 'fixed-update' && d.severity === 'warning')).toBe(true);

    const strict = validateScriptForSave(VALID, { desSafe: true });
    expect(strict.ok).toBe(false);
    expect(strict.diagnostics.some((d) => d.rule === 'fixed-update' && d.severity === 'error')).toBe(true);
  });

  it('DES lint: blocked globals are always errors', () => {
    const v = validateScriptForSave('function setup(self) { const t = Date.now(); return {}; }');
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'blocked-global' && d.severity === 'error')).toBe(true);
  });

  it('blocks when the component declares a newer ApiVersion than the build supports', () => {
    const v = validateScriptForSave(VALID, { apiVersion: 2 });
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'api-version')).toBe(true);
  });

  it('warns (only) when no global setup function exists', () => {
    const v = validateScriptForSave('const x = 1;');
    expect(v.ok).toBe(true);
    expect(v.diagnostics.some((d) => d.rule === 'missing-setup' && d.severity === 'warning')).toBe(true);
  });

  it('never executes the candidate code', () => {
    // A top-level side effect would throw here if validation executed it.
    const v = validateScriptForSave('throw new Error("must not run"); function setup(s){return {};}');
    expect(v.ok).toBe(true);
  });

  it('supports an injected parse check (QuickJS dry-run seam)', () => {
    const v = validateScriptForSave(VALID, {
      parseCheck: () => { throw new SyntaxError('quickjs says no'); },
    });
    expect(v.ok).toBe(false);
    expect(v.diagnostics.some((d) => d.rule === 'parse' && d.message.includes('quickjs says no'))).toBe(true);
  });

  it('the bundled SCRIPT_TEMPLATE passes validation cleanly', () => {
    const v = validateScriptForSave(SCRIPT_TEMPLATE);
    expect(v.ok).toBe(true);
  });
});

describe('applyScriptSave (§4.1 steps 6–7)', () => {
  it('emits one setCode op with prev and invokes the hot-reload sink', async () => {
    const { store, ops } = recordingStore();
    const reloads: Array<[string, string]> = [];
    const result = applyScriptSave({
      nodePath: 'Line1/Gate', code: VALID, prev: '// old',
      store, reload: (p, c) => reloads.push([p, c]),
    });
    await result.done;
    expect(result.persisted).toBe(true);
    expect(result.reloaded).toBe(true);
    expect(ops).toHaveLength(1);
    const op = ops[0] as SetCodeOp;
    expect(op.kind).toBe('setCode');
    expect(op.nodePath).toBe('Line1/Gate');
    expect(op.code).toBe(VALID);
    expect(op.prev).toBe('// old');           // undo restores the pre-save source
    expect(reloads).toEqual([['Line1/Gate', VALID]]);
  });

  it('skips the op when the stored code is unchanged (still reloads)', () => {
    const { store, ops } = recordingStore();
    const reloads: string[] = [];
    const result = applyScriptSave({
      nodePath: 'N', code: VALID, prev: VALID,
      store, reload: (p) => reloads.push(p),
    });
    expect(result.persisted).toBe(true);
    expect(ops).toHaveLength(0);
    expect(reloads).toEqual(['N']);
  });

  it('reports persist-only when the trust gate keeps the reload sink null', () => {
    const { store, ops } = recordingStore();
    const result = applyScriptSave({
      nodePath: 'N', code: VALID, prev: undefined, store, reload: null,
    });
    expect(result.persisted).toBe(true);
    expect(result.reloaded).toBe(false);
    expect(ops).toHaveLength(1);
  });

  it('reports unpersisted without a store (nothing throws)', () => {
    const result = applyScriptSave({
      nodePath: 'N', code: VALID, prev: undefined, store: null, reload: null,
    });
    expect(result.persisted).toBe(false);
    expect(result.reloaded).toBe(false);
  });
});

describe('failed validation leaves store and registry untouched (contract)', () => {
  it('a blocked save never reaches applyScriptSave — no op, no reload', () => {
    // This mirrors the panel flow: validate first, apply only on ok.
    const { store, ops } = recordingStore();
    const reloads: string[] = [];
    const broken = 'function setup( {';
    const v = validateScriptForSave(broken);
    if (v.ok) {
      applyScriptSave({ nodePath: 'N', code: broken, prev: '// running', store, reload: (p) => reloads.push(p) });
    }
    expect(v.ok).toBe(false);
    expect(ops).toEqual([]);         // old stored state stays
    expect(reloads).toEqual([]);     // old VM keeps running
  });
});

describe('readWebComponentCode', () => {
  it('reads Code from materialised userData and tolerates absence', () => {
    const node = { userData: { realvirtual: { WebComponent: { Code: '// c' } } } };
    expect(readWebComponentCode(node)).toBe('// c');
    expect(readWebComponentCode({ userData: {} })).toBeUndefined();
    expect(readWebComponentCode(null)).toBeUndefined();
    expect(readWebComponentCode({ userData: { realvirtual: { WebComponent: { Code: 42 } } } })).toBeUndefined();
  });
});
