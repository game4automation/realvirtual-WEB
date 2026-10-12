// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * monaco-load-order.ts — plan-555 9.2 helper: loads the public Monaco loaders
 * in a given order and asserts that BOTH real language workers answer — the
 * TypeScript worker transpiles, the JSON worker reports a syntax error on an
 * `rv-json:` model (owner `json`).
 */

import { expect } from 'vitest';
import { loadScriptEditorMonaco, transpileModel, SCRIPT_LANGUAGE_ID } from '../../src/core/hmi/script/monaco-loader';
import { loadJsonMonaco } from '../../src/core/hmi/json-editor/rv-json-monaco-loader';
import { hasMonacoWorker } from '../../src/core/hmi/monaco/rv-monaco-workers';

export async function assertWorkersCoexist(order: ('ts' | 'json')[]): Promise<void> {
  for (const which of order) {
    if (which === 'ts') await loadScriptEditorMonaco();
    else await loadJsonMonaco();
  }
  const ts = await loadScriptEditorMonaco();
  const json = await loadJsonMonaco();
  expect(hasMonacoWorker('typescript')).toBe(true);
  expect(hasMonacoWorker('json')).toBe(true);
  expect(hasMonacoWorker('*')).toBe(true);

  const tsModel = ts.editor.createModel('const speed: number = 100;', SCRIPT_LANGUAGE_ID,
    ts.Uri.parse(`file:///rv-load-order-${order.join('-')}.ts`));
  const jsonModel = json.editor.createModel('{ "a": }', 'json', json.Uri.parse(`rv-json://load.order/1/${order.join('-')}.json`));
  try {
    const out = await transpileModel(ts, tsModel);
    expect(out.syntaxErrors).toEqual([]);
    expect(out.js).toContain('const speed = 100');

    const t0 = performance.now();
    let markers = json.editor.getModelMarkers({ resource: jsonModel.uri, owner: 'json' });
    while (markers.length === 0 && performance.now() - t0 < 60_000) {
      await new Promise((r) => setTimeout(r, 100));
      markers = json.editor.getModelMarkers({ resource: jsonModel.uri, owner: 'json' });
    }
    expect(markers.length).toBeGreaterThan(0);
  } finally {
    tsModel.dispose();
    jsonModel.dispose();
  }
}
