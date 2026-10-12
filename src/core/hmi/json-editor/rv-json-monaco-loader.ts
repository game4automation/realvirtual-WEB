// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-monaco-loader.ts — lazy Monaco loader for JSON inspector fields
 * (plan-555), the public sibling of the script editor loader
 * (`../script/monaco-loader.ts`).
 *
 * Monaco is imported EXCLUSIVELY via dynamic import (guarded by
 * tests/plc-import-boundary.node.test.ts MONACO_ALLOWED + lazy assertion); a
 * touch device or the dev flag `rv-webviewer-json-editor = 0` never calls it.
 *
 * What it sets up, once per page:
 *  1. Monaco (package root — it carries `monaco.json`), the generic editor
 *     worker and the JSON language worker.
 *  2. Workers in the shared registry (`../monaco/rv-monaco-workers`): `json`
 *     plus the `'*'` fallback — first wins, so the script and ST editors keep
 *     theirs whatever loads first.
 *  3. JSON diagnostics: syntax only from the worker (owner `json`); schemas are
 *     used for completion / hover ONLY (`schemaValidation: 'ignore'`) — the
 *     field's rules are the single source of rule errors (owner
 *     `rv-json-rules`, set by the editor). The schema list is always the
 *     COMPLETE list of {@link allJsonSchemas}, one entry per schema group.
 *  4. ONE completion and ONE hover provider for 'json', empty for every model
 *     that is not an `rv-json:` field with a registered context: signal names
 *     inside `"signal": "…"` (read fresh per request, JSON-escaped, no doubled
 *     quotes) and snippets at array-element positions. Schema suggestions come
 *     from the built-in JSON service.
 *  5. No theme: Monaco themes are global — the editors use `vs-dark` like the
 *     script editor, the inspector look comes from the surrounding container.
 *
 * A failed load clears the cache so the next mount can retry.
 */

import type * as MonacoApi from 'monaco-editor';
import { MONACO_FALLBACK_WORKER_LABEL, registerMonacoWorker } from '../monaco/rv-monaco-workers';
import {
  JSON_FIELD_SCHEME, allJsonSchemas, getJsonFieldContext, subscribeJsonSchemas,
  type JsonFieldContext, type JsonSignalInfo,
} from './rv-json-field-context';
import { locationAt, stringTokenAt } from './rv-json-path-ranges';

export type JsonMonaco = typeof MonacoApi;
export type JsonMonacoEditor = MonacoApi.editor.IStandaloneCodeEditor;
export type JsonMonacoModel = MonacoApi.editor.ITextModel;
export type JsonMonacoPosition = MonacoApi.Position;
export type JsonMonacoDisposable = MonacoApi.IDisposable;
export type JsonMonacoEditorOptions = MonacoApi.editor.IStandaloneEditorConstructionOptions;
export type JsonMonacoMarkerData = MonacoApi.editor.IMarkerData;
export type JsonMonacoViewState = MonacoApi.editor.ICodeEditorViewState;

/** Marker owner of the field rules (never `json` — that is the syntax owner). */
export const JSON_RULES_OWNER = 'rv-json-rules';

let monacoPromise: Promise<JsonMonaco> | null = null;

/** Loads Monaco with the JSON language set up for inspector fields (promise-cached, retried after a failure). */
export function loadJsonMonaco(): Promise<JsonMonaco> {
  if (!monacoPromise) {
    const p = doLoad();
    monacoPromise = p;
    p.catch(() => { if (monacoPromise === p) monacoPromise = null; });
  }
  return monacoPromise;
}

async function doLoad(): Promise<JsonMonaco> {
  const [monaco, { default: EditorWorker }, { default: JsonWorker }] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('monaco-editor/esm/vs/language/json/json.worker?worker'),
  ]);

  registerMonacoWorker(['json'], () => new JsonWorker());
  registerMonacoWorker([MONACO_FALLBACK_WORKER_LABEL], () => new EditorWorker());

  applyDiagnosticsOptions(monaco);
  subscribeJsonSchemas(() => applyDiagnosticsOptions(monaco));
  registerProviders(monaco);
  return monaco;
}

function applyDiagnosticsOptions(monaco: JsonMonaco): void {
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: 'error',
    enableSchemaRequest: false,
    schemaValidation: 'ignore',
    schemas: allJsonSchemas(),
  });
}

// ─── Providers ─────────────────────────────────────────────────────────

/** The field context of a model, or undefined for every non-field model. */
function contextOf(model: JsonMonacoModel): JsonFieldContext | undefined {
  if (model.uri.scheme !== JSON_FIELD_SCHEME) return undefined;
  return getJsonFieldContext(model.uri.toString());
}

/** A signal value under the cursor: the string token and its key. */
function signalValueAt(context: JsonFieldContext, text: string, offset: number) {
  if (!context.signalKeys || context.signalKeys.length === 0) return null;
  const loc = locationAt(text, offset);
  if (loc.isAtPropertyKey) return null;
  const last = loc.path[loc.path.length - 1];
  if (typeof last !== 'string' || !context.signalKeys.includes(last)) return null;
  const token = stringTokenAt(text, offset);
  if (!token) return null;
  return token;
}

/** Escapes a name for the inside of a JSON string (quotes, backslashes, control characters). */
export function jsonStringContent(name: string): string {
  return JSON.stringify(name).slice(1, -1);
}

/**
 * Completion items of a field model at a position — exported for tests; the
 * registered provider calls exactly this.
 */
export function jsonFieldCompletions(
  monaco: JsonMonaco,
  model: JsonMonacoModel,
  position: JsonMonacoPosition,
): MonacoApi.languages.CompletionItem[] {
  const context = contextOf(model);
  if (!context) return [];
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const items: MonacoApi.languages.CompletionItem[] = [];

  const token = signalValueAt(context, text, offset);
  if (token && context.signals) {
    // Replace the string CONTENT (between the quotes); an unterminated string
    // runs to its line end and gets its closing quote from the insert.
    const startPos = model.getPositionAt(token.start + 1);
    const endPos = model.getPositionAt(token.terminated ? token.end - 1 : token.end);
    const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
    const close = token.terminated ? '' : '"';
    for (const s of context.signals()) {
      items.push({
        label: s.name,
        kind: monaco.languages.CompletionItemKind.Variable,
        detail: s.type ? `Signal · ${s.type}` : 'Signal',
        documentation: signalMarkdown(s),
        insertText: jsonStringContent(s.name) + close,
        filterText: s.name,
        sortText: `0_${s.name}`,
        range,
      });
    }
    return items;
  }

  if (context.snippets && context.snippets.length > 0) {
    const loc = locationAt(text, offset);
    const n = loc.path.length;
    if (n >= 2 && typeof loc.path[n - 1] === 'number' && typeof loc.path[n - 2] === 'string' && !stringTokenAt(text, offset)) {
      const arrayKey = loc.path[n - 2] as string;
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      for (const sn of context.snippets) {
        if (sn.arrayKey !== arrayKey) continue;
        items.push({
          label: sn.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: sn.detail,
          insertText: sn.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: `1_${sn.label}`,
          range,
        });
      }
    }
  }
  return items;
}

function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

function signalMarkdown(s: JsonSignalInfo): MonacoApi.IMarkdownString {
  const lines = [`**${s.name.replace(/[\\`*_[\]]/g, '\\$&')}**`];
  if (s.type) lines.push(`Type: \`${s.type}\``);
  lines.push(`Value: \`${formatValue(s.value)}\``);
  if (s.address) lines.push(`Address: \`${s.address}\``);
  if (s.comment) lines.push(`Comment: ${s.comment}`);
  return { value: lines.join('  \n') };
}

/** Hover of a field model at a position — exported for tests; the registered provider calls exactly this. */
export function jsonFieldHover(
  monaco: JsonMonaco,
  model: JsonMonacoModel,
  position: JsonMonacoPosition,
): MonacoApi.languages.Hover | null {
  const context = contextOf(model);
  if (!context?.signals) return null;
  const text = model.getValue();
  const token = signalValueAt(context, text, model.getOffsetAt(position));
  if (!token || !token.terminated) return null;
  let name: unknown;
  try {
    name = JSON.parse(text.slice(token.start, token.end));
  } catch {
    return null;
  }
  const info = context.signals().find((s) => s.name === name);
  if (!info) return null;
  const a = model.getPositionAt(token.start);
  const b = model.getPositionAt(token.end);
  return {
    range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column),
    contents: [signalMarkdown(info)],
  };
}

function registerProviders(monaco: JsonMonaco): void {
  monaco.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"'],
    provideCompletionItems: (model, position) => ({ suggestions: jsonFieldCompletions(monaco, model, position) }),
  });
  monaco.languages.registerHoverProvider('json', {
    provideHover: (model, position) => jsonFieldHover(monaco, model, position),
  });
}
