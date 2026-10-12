// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-editor.test.ts — plan-555 9.6: the JSON field language features
 * with REAL Monaco (JSON worker included), no React.
 *
 * Suggestions are read from the live suggest widget (DOM), so the merge of our
 * completion provider with the built-in JSON service is measured, not assumed
 * (the "Provider-Messung" of Phase 3).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  JSON_RULES_OWNER, jsonFieldCompletions, jsonFieldHover, loadJsonMonaco,
  type JsonMonaco, type JsonMonacoEditor, type JsonMonacoModel,
} from '../src/core/hmi/json-editor/rv-json-monaco-loader';
import {
  allJsonSchemas, decodeJsonUriSegment, jsonFieldUri, registerJsonFieldContext, resetJsonFieldRegistryForTest,
  type JsonFieldContext, type JsonSignalInfo,
} from '../src/core/hmi/json-editor/rv-json-field-context';
import { createOperatorPanelJsonContext } from '../src/core/hmi/operator-devices/operator-panel-json-context';
import { loadScriptEditorMonaco } from '../src/core/hmi/script/monaco-loader';
import { SignalStore } from '../src/core/engine/rv-signal-store';

let monaco: JsonMonaco;

beforeAll(async () => {
  monaco = await loadJsonMonaco();
}, 60_000);

let counter = 0;
const disposers: (() => void)[] = [];

afterEach(async () => {
  while (disposers.length) disposers.pop()!();
  resetJsonFieldRegistryForTest();
  document.querySelectorAll('[data-rv-test-editor]').forEach((n) => n.remove());
  await Promise.resolve();
  const leaked = monaco.editor.getModels().filter((m) => m.uri.scheme === 'rv-json').map((m) => m.uri.toString());
  expect(leaked).toEqual([]);
});

const MINI_SCHEMA = {
  type: 'object',
  properties: {
    capColor: { description: 'Cap colour of the button.', enum: ['red', 'green', 'blue'] },
    signal: { type: 'string', description: 'The signal it writes.' },
    buttons: { type: 'array', items: { type: 'object' } },
  },
};

function fieldUri(nodePath = `Model/Panel${counter++}`, docId = 1): string {
  return jsonFieldUri('TestField', 'Config', docId, nodePath);
}

function withContext(text: string, ctx: Partial<JsonFieldContext> = {}, uri = fieldUri()) {
  const release = registerJsonFieldContext({ uri, schemaId: 'test-mini', schema: MINI_SCHEMA, signalKeys: ['signal'], ...ctx });
  const model = monaco.editor.createModel(text, 'json', monaco.Uri.parse(uri));
  disposers.push(() => { model.dispose(); release(); });
  return model;
}

function mountEditor(model: JsonMonacoModel): JsonMonacoEditor {
  const host = document.createElement('div');
  host.setAttribute('data-rv-test-editor', '');
  host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px;';
  document.body.appendChild(host);
  const editor = monaco.editor.create(host, { model, theme: 'vs-dark', fixedOverflowWidgets: true, automaticLayout: false });
  editor.layout({ width: 600, height: 300 });
  disposers.push(() => editor.dispose());
  return editor;
}

async function until<T>(fn: () => T | null | undefined | false, ms = 8000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Opens the suggest widget at `offset` and returns the visible labels. */
async function suggestLabels(editor: JsonMonacoEditor, offset: number, minCount = 1): Promise<string[]> {
  const model = editor.getModel()!;
  editor.focus();
  editor.setPosition(model.getPositionAt(offset));
  editor.trigger('test', 'editor.action.triggerSuggest', {});
  const rows = await until(() => {
    const r = [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')];
    return r.length >= minCount ? r : null;
  });
  // Let a second provider's results land, then read the final list.
  await new Promise((r) => setTimeout(r, 300));
  const final = [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')];
  return (final.length ? final : rows).map((r) => (r.querySelector('.label-name')?.textContent ?? '').trim());
}

async function hoverText(editor: JsonMonacoEditor, offset: number): Promise<string> {
  const model = editor.getModel()!;
  editor.focus();
  editor.setPosition(model.getPositionAt(offset));
  editor.trigger('test', 'editor.action.showHover', {});
  const el = await until(() => {
    const h = document.querySelector('.monaco-hover:not(.hidden) .monaco-hover-content');
    return h && (h.textContent ?? '').trim().length > 0 ? h : null;
  });
  await new Promise((r) => setTimeout(r, 300));
  return el.textContent ?? '';
}

const SIGNALS: JsonSignalInfo[] = [
  { name: 'S_Run', type: 'Bool', value: true, address: 'DB1.DBX0.0', comment: 'Run command' },
  { name: 'S_Stop', value: false },
];

describe('plan-555 Phase 3 — provider measurement (real Monaco, suggest widget)', () => {
  it('schema enum suggestions for capColor appear through the built-in JSON service (fileMatch by authority)', async () => {
    const text = '{ "capColor": "" }';
    const model = withContext(text, { signals: () => SIGNALS });
    const editor = mountEditor(model);
    const labels = await suggestLabels(editor, text.indexOf('""') + 1);
    expect(labels).toEqual(expect.arrayContaining(['"red"', '"green"', '"blue"']));
    // No signal items at a non-signal key.
    expect(labels).not.toContain('S_Run');
  });

  it('at a signal value our items and the JSON service merge without duplicates', async () => {
    const text = '{ "signal": "S" }';
    const model = withContext(text, { signals: () => SIGNALS });
    const editor = mountEditor(model);
    const labels = await suggestLabels(editor, text.indexOf('"S"') + 2, 2);
    expect(labels.filter((l) => l === 'S_Run')).toHaveLength(1);
    expect(labels.filter((l) => l === 'S_Stop')).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('property-name suggestions from the schema still appear in an empty object', async () => {
    const text = '{  }';
    const model = withContext(text, { signals: () => SIGNALS });
    const editor = mountEditor(model);
    const labels = await suggestLabels(editor, 2);
    expect(labels.some((l) => l.includes('capColor'))).toBe(true);
    expect(labels.some((l) => l.includes('signal'))).toBe(true);
  });

  it('schema hover still works with schemaValidation "ignore"; signal hover adds the signal info', async () => {
    const text = '{ "capColor": "red", "signal": "S_Run" }';
    const model = withContext(text, { signals: () => SIGNALS });
    const editor = mountEditor(model);
    expect(await hoverText(editor, text.indexOf('capColor') + 2)).toContain('Cap colour of the button.');
    editor.trigger('test', 'editor.action.hideHover', {});
    const h = await hoverText(editor, text.indexOf('S_Run') + 2);
    expect(h).toContain('S_Run');
    expect(h).toContain('DB1.DBX0.0');
  });
});

describe('plan-555 9.6 — language features of an rv-json field', () => {
  it('schema validation is off: a wrong enum value gets no json-owner marker, a syntax error does', async () => {
    const model = withContext('{ "capColor": "pink" }');
    await new Promise((r) => setTimeout(r, 800));
    expect(monaco.editor.getModelMarkers({ resource: model.uri, owner: 'json' })).toEqual([]);
    model.setValue('{ "a": }');
    const markers = await until(() => {
      const m = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'json' });
      return m.length > 0 ? m : null;
    });
    expect(markers.length).toBeGreaterThan(0);
    expect(monaco.editor.getModelMarkers({ resource: model.uri, owner: JSON_RULES_OWNER })).toEqual([]);
  });

  it('completion inside "signal": "S|" replaces the string content — no doubled quotes', () => {
    const text = '{ "signal": "S" }';
    const model = withContext(text, { signals: () => SIGNALS });
    const pos = model.getPositionAt(text.indexOf('"S"') + 2);
    const items = jsonFieldCompletions(monaco, model, pos);
    const run = items.find((i) => i.label === 'S_Run')!;
    expect(run.sortText).toBe('0_S_Run');
    model.applyEdits([{ range: run.range as never, text: run.insertText }]);
    expect(model.getValue()).toBe('{ "signal": "S_Run" }');
  });

  it('cursor in the middle of a value and an unterminated string', () => {
    const mid = '{ "signal": "S_XYZ" }';
    const m1 = withContext(mid, { signals: () => SIGNALS });
    const i1 = jsonFieldCompletions(monaco, m1, m1.getPositionAt(mid.indexOf('XYZ') + 1)).find((i) => i.label === 'S_Stop')!;
    m1.applyEdits([{ range: i1.range as never, text: i1.insertText }]);
    expect(m1.getValue()).toBe('{ "signal": "S_Stop" }');

    const open = '{ "signal": "S_R\n}';
    const m2 = withContext(open, { signals: () => SIGNALS });
    const i2 = jsonFieldCompletions(monaco, m2, m2.getPositionAt(open.indexOf('S_R') + 3)).find((i) => i.label === 'S_Run')!;
    m2.applyEdits([{ range: i2.range as never, text: i2.insertText }]);
    expect(m2.getValue()).toBe('{ "signal": "S_Run"\n}');
    expect(JSON.parse(m2.getValue())).toEqual({ signal: 'S_Run' });
  });

  it('signal names are JSON-escaped: quote, backslash, tab', () => {
    const names = ['a"b', 'c\\d', 'e\tf'];
    for (const name of names) {
      const text = '{ "signal": "" }';
      const model = withContext(text, { signals: () => [{ name }] });
      const item = jsonFieldCompletions(monaco, model, model.getPositionAt(text.indexOf('""') + 1)).find((i) => i.label === name)!;
      model.applyEdits([{ range: item.range as never, text: item.insertText }]);
      expect((JSON.parse(model.getValue()) as { signal: string }).signal).toBe(name);
    }
  });

  it('names are read fresh per request (same count, different names; another store)', () => {
    let list: JsonSignalInfo[] = [{ name: 'A1' }, { name: 'A2' }];
    const text = '{ "signal": "" }';
    const model = withContext(text, { signals: () => list });
    const at = model.getPositionAt(text.indexOf('""') + 1);
    expect(jsonFieldCompletions(monaco, model, at).map((i) => i.label)).toEqual(['A1', 'A2']);
    list = [{ name: 'B1' }, { name: 'B2' }];
    expect(jsonFieldCompletions(monaco, model, at).map((i) => i.label)).toEqual(['B1', 'B2']);
  });

  it('signal keys anywhere: flashWhen.all[i].signal, when.not.signal', () => {
    const text = '{ "lamp": { "flashWhen": { "all": [ { "signal": "", "is": true } ] } }, "when": { "not": { "signal": "" } } }';
    const model = withContext(text, { signals: () => SIGNALS });
    const first = text.indexOf('""') + 1;
    const second = text.lastIndexOf('""') + 1;
    expect(jsonFieldCompletions(monaco, model, model.getPositionAt(first)).map((i) => i.label)).toContain('S_Run');
    expect(jsonFieldCompletions(monaco, model, model.getPositionAt(second)).map((i) => i.label)).toContain('S_Run');
  });

  it('a model outside rv-json gets neither signals nor hover (URI filter)', () => {
    const text = '{ "signal": "S_Run" }';
    const model = monaco.editor.createModel(text, 'json', monaco.Uri.parse(`file:///other-${counter++}.json`));
    disposers.push(() => model.dispose());
    const pos = model.getPositionAt(text.indexOf('S_Run') + 1);
    expect(jsonFieldCompletions(monaco, model, pos)).toEqual([]);
    expect(jsonFieldHover(monaco, model, pos)).toBeNull();
  });

  it('hover on a signal value: name and value; Type only when the store knows it', () => {
    const text = '{ "a": { "signal": "S_Run" }, "b": { "signal": "S_Stop" } }';
    const model = withContext(text, { signals: () => SIGNALS });
    const h1 = jsonFieldHover(monaco, model, model.getPositionAt(text.indexOf('S_Run') + 1))!;
    const md1 = (h1.contents[0] as { value: string }).value;
    expect(md1).toContain('S\\_Run');
    expect(md1).toContain('Type: `Bool`');
    expect(md1).toContain('Value: `true`');
    const md2 = (jsonFieldHover(monaco, model, model.getPositionAt(text.indexOf('S_Stop') + 1))!.contents[0] as { value: string }).value;
    expect(md2).not.toContain('Type:');
    expect(md2).toContain('Value: `false`');
  });

  it('array-element position in buttons → the button snippet', () => {
    const text = '{ "buttons": [  ] }';
    const model = withContext(text, {
      snippets: [
        { arrayKey: 'buttons', label: 'Button', detail: 'A push button', body: '{ "label": "${1:Start}" }' },
        { arrayKey: 'estops', label: 'E-stop', detail: 'x', body: '{}' },
      ],
    });
    const items = jsonFieldCompletions(monaco, model, model.getPositionAt(text.indexOf('[') + 2));
    expect(items.map((i) => i.label)).toEqual(['Button']);
    expect(items[0].sortText).toBe('1_Button');
    expect(items[0].insertTextRules).toBe(monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
  });

  it('schema registry: two groups → two schemas, release removes only its own, same group → one', () => {
    const r1 = registerJsonFieldContext({ uri: fieldUri('A'), schemaId: 'g1', schema: { type: 'object' } });
    const r2 = registerJsonFieldContext({ uri: fieldUri('B'), schemaId: 'g1', schema: { type: 'object' } });
    const uriOther = jsonFieldUri('Other', 'Field', 1, 'X');
    const r3 = registerJsonFieldContext({ uri: uriOther, schemaId: 'g2', schema: { type: 'array' } });
    expect(allJsonSchemas().map((s) => s.uri).sort()).toHaveLength(2);
    r3();
    expect(allJsonSchemas()).toHaveLength(1);
    r1();
    expect(allJsonSchemas()).toHaveLength(1);
    r2();
    expect(allJsonSchemas()).toHaveLength(0);
  });

  it('node paths with *, #, space and umlaut round-trip and stay inside their authority', () => {
    const nodePath = 'Model/Pa*nel #1/Stäbe x~%';
    const uri = jsonFieldUri('WebOperatorPanel', 'Config', 7, nodePath);
    const parsed = monaco.Uri.parse(uri);
    // Monaco prints it unchanged — the registry key IS model.uri.toString().
    expect(parsed.toString()).toBe(uri);
    expect(parsed.authority).toBe('weboperatorpanel.config');
    expect(decodeJsonUriSegment(parsed.path.split('/')[2].replace(/\.json$/, ''))).toBe(nodePath);
    // Two documents with the same node path → two URIs.
    expect(jsonFieldUri('WebOperatorPanel', 'Config', 8, nodePath)).not.toBe(uri);
  });

  it('a node path with glob characters gets its group schema and no other (no foreign match)', async () => {
    const text = '{ "capColor": "" }';
    const model = withContext(text, { signals: () => SIGNALS }, fieldUri('Model/*/Pa nel#ü'));
    const editor = mountEditor(model);
    const labels = await suggestLabels(editor, text.indexOf('""') + 1);
    expect(labels).toEqual(expect.arrayContaining(['"red"']));
    // A different authority with the same node path sees nothing of the group schema.
    const foreign = jsonFieldUri('Other', 'Thing', 1, 'Model/*/Pa nel#ü');
    const m2 = monaco.editor.createModel(text, 'json', monaco.Uri.parse(foreign));
    disposers.push(() => m2.dispose());
    const e2 = mountEditor(m2);
    editor.trigger('test', 'hideSuggestWidget', {});
    e2.focus();
    e2.setPosition(m2.getPositionAt(text.indexOf('""') + 1));
    e2.trigger('test', 'editor.action.triggerSuggest', {});
    await new Promise((r) => setTimeout(r, 800));
    const rows = [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
      .map((r) => (r.querySelector('.label-name')?.textContent ?? '').trim());
    expect(rows).not.toContain('"red"');
  });

  it('the real operator panel schema: capColor enum and store signals at the same call site (measurement fixed)', async () => {
    const store = new SignalStore();
    store.register('S_Start', 'Model/PLC/S_Start', false, 'PLCInputBool');
    store.register('L_Run', 'Model/PLC/L_Run', true);
    const text = '{ "version": 1, "buttons": [ { "label": "Start", "signal": "", "capColor": "" } ] }';
    const uri = fieldUri();
    const release = registerJsonFieldContext(createOperatorPanelJsonContext(uri, store));
    const model = monaco.editor.createModel(text, 'json', monaco.Uri.parse(uri));
    disposers.push(() => { model.dispose(); release(); });
    const editor = mountEditor(model);
    const caps = await suggestLabels(editor, text.lastIndexOf('""') + 1, 6);
    expect(caps).toEqual(expect.arrayContaining(['"red"', '"yellow"', '"green"', '"blue"', '"white"', '"black"']));
    expect(caps).not.toContain('S_Start');
    editor.trigger('test', 'hideSuggestWidget', {});
    const sigs = await suggestLabels(editor, text.indexOf('""') + 1, 2);
    expect(sigs.filter((l) => l === 'S_Start')).toHaveLength(1);
    expect(sigs).toContain('L_Run');
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it('theme: script editor and JSON editor open together stay vs-dark in both opening orders', async () => {
    const ts = await loadScriptEditorMonaco();
    for (const order of [['json', 'ts'], ['ts', 'json']] as const) {
      const editors: JsonMonacoEditor[] = [];
      for (const which of order) {
        if (which === 'json') {
          editors.push(mountEditor(withContext('{}')));
        } else {
          const host = document.createElement('div');
          host.setAttribute('data-rv-test-editor', '');
          host.style.cssText = 'position:fixed;left:0;top:320px;width:400px;height:200px;';
          document.body.appendChild(host);
          const tsModel = ts.editor.createModel('const a = 1;', 'typescript', ts.Uri.parse(`file:///theme-${counter++}.ts`));
          const tsEditor = ts.editor.create(host, { model: tsModel, theme: 'vs-dark' });
          disposers.push(() => { tsEditor.dispose(); tsModel.dispose(); });
          editors.push(tsEditor as unknown as JsonMonacoEditor);
        }
      }
      for (const e of editors) expect(e.getDomNode()!.classList.contains('vs-dark')).toBe(true);
      while (disposers.length) disposers.pop()!();
    }
  }, 90_000);
});

