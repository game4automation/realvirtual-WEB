// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-editor-field.test.tsx — plan-555 9.7: the Monaco path of the
 * `WebOperatorPanel.Config` inspector field, with real Monaco and fake edit
 * targets: fallback, commit / blur / dedupe, unavailable target, drafts,
 * document switch, dirty rule, selection change, StrictMode, expand, load
 * failure, touch + dev flag, rule markers.
 *
 * The field is rendered through the host (`WebOperatorPanelConfigField`); the
 * editor of a field is found through Monaco's public `editor.getEditors()` by
 * the field's model URI. `console.error` must stay empty in every test.
 */

import { StrictMode, createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { WEB_OPERATOR_PANEL_TYPE } from '../src/core/engine/rv-web-operator-panel';
import {
  WebOperatorPanelConfigField, commitOperatorPanelConfig,
} from '../src/core/hmi/operator-devices/WebOperatorPanelHost';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { JSON_EDITOR_LS_KEY } from '../src/core/engine/rv-dev-load-flags';
import { jsonDocumentId, jsonFieldUri, resetJsonFieldRegistryForTest } from '../src/core/hmi/json-editor/rv-json-field-context';
import type { JsonMonaco, JsonMonacoEditor, JsonMonacoModel } from '../src/core/hmi/json-editor/rv-json-monaco-loader';
import { OperatorPanelJsonEditor, type RvJsonEditorHandle } from '../src/core/hmi/operator-devices/operator-panel-json-context';

const device = vi.hoisted(() => ({ touch: false }));
const loader = vi.hoisted(() => ({ fail: false, delayMs: 0, calls: 0 }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
  useTouchDevice: () => device.touch,
}));

vi.mock('../src/core/hmi/json-editor/rv-json-monaco-loader', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/hmi/json-editor/rv-json-monaco-loader')>();
  return {
    ...orig,
    loadJsonMonaco: async () => {
      loader.calls++;
      if (loader.delayMs) await new Promise((r) => setTimeout(r, loader.delayMs));
      if (loader.fail) throw new Error('chunk offline (test)');
      return orig.loadJsonMonaco();
    },
  };
});

const { loadJsonMonaco } = await import('../src/core/hmi/json-editor/rv-json-monaco-loader');

let monaco: JsonMonaco;
beforeAll(async () => {
  monaco = await loadJsonMonaco();
}, 60_000);

// ── Fixtures ─────────────────────────────────────────────────────────────

const CELL = {
  version: 1, id: 'cell-panel', title: 'Cell',
  buttons: [{ label: 'Start', signal: 'S_Start', capColor: 'green', row: 1, col: 1 }],
  selectors: [], estops: [],
  stackLight: [{ name: 'Green', signal: 'L_Run', color: 'green' }],
  status: [{ kind: 'idle', tone: 'neutral', text: 'READY' }],
};
const SIGNALS = ['S_Start', 'L_Run'];
const json = (o: unknown) => JSON.stringify(o, null, 2);
const A = json(CELL);
const B = json({ ...CELL, title: 'Cell B' });
const C = json({ ...CELL, title: 'Cell C' });

interface Write { nodePath: string; value: unknown; prev: unknown }

/** A fake edit target that records its writes; `deferred` makes setFieldAsync wait for `settle`. */
function fakeTarget(opts: { available?: boolean; deferred?: boolean; documentKey?: object } = {}) {
  const writes: Write[] = [];
  let settle: { resolve(): void; reject(e: unknown): void } | null = null;
  const t = {
    available: opts.available ?? true,
    documentKey: opts.documentKey,
    setField: (nodePath: string, _c: string, _f: string, value: unknown, prev: unknown) => { writes.push({ nodePath, value, prev }); },
    setFieldAsync: (nodePath: string, _c: string, _f: string, value: unknown, prev: unknown) => {
      writes.push({ nodePath, value, prev });
      if (!opts.deferred) return Promise.resolve();
      return new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    },
    unsetField: () => {},
    withTransaction: async (_l: string, fn: () => Promise<void>) => fn(),
  };
  return { target: t as unknown as EditTarget & { available: boolean }, writes, settle: () => settle! };
}

function storeWithSignals(): SignalStore {
  const store = new SignalStore();
  for (const name of SIGNALS) store.register(name, `Model/PLC/${name}`, false);
  return store;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  device.touch = false;
  loader.fail = false;
  loader.delayMs = 0;
  loader.calls = 0;
  localStorage.removeItem(JSON_EDITOR_LS_KEY);
  errorSpy = vi.spyOn(console, 'error');
});

afterEach(async () => {
  cleanup();
  await flush();
  setActiveEditTarget(null);
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
  const leaked = monaco.editor.getModels().filter((m) => m.uri.scheme === 'rv-json').map((m) => m.uri.toString());
  resetJsonFieldRegistryForTest();
  expect(leaked).toEqual([]);
});

/** Lets the deferred unmount work (microtasks) and React settle. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until<T>(fn: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - t0 > ms) throw new Error('timeout');
    await flush(20);
  }
}

function uriFor(target: object, nodePath = 'Model/Panel'): string {
  return jsonFieldUri('WebOperatorPanel', 'Config', jsonDocumentId(target), nodePath);
}

function editorFor(uri: string): JsonMonacoEditor | undefined {
  return monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri) as JsonMonacoEditor | undefined;
}

async function waitEditor(uri: string): Promise<{ editor: JsonMonacoEditor; model: JsonMonacoModel }> {
  const editor = await until(() => editorFor(uri));
  return { editor, model: editor.getModel()! };
}

type FieldProps = { value: unknown; nodePath?: string; store?: SignalStore | null };

function ui({ value, nodePath = 'Model/Panel', store = null }: FieldProps) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <WebOperatorPanelConfigField
        value={value}
        fieldName="Config"
        componentType={WEB_OPERATOR_PANEL_TYPE}
        nodePath={nodePath}
        viewer={null}
        signalStore={store}
      />
    </ThemeProvider>
  );
}

function mount(props: FieldProps, strict = false) {
  const r = render(strict ? <StrictMode>{ui(props)}</StrictMode> : ui(props));
  return { ...r, update: (p: FieldProps) => r.rerender(strict ? <StrictMode>{ui(p)}</StrictMode> : ui(p)) };
}

/** Moves real focus out of the field: a button elsewhere on the page. */
function outsideButton(): HTMLButtonElement {
  let b = document.getElementById('rv-test-outside') as HTMLButtonElement | null;
  if (!b) {
    b = document.createElement('button');
    b.id = 'rv-test-outside';
    b.textContent = 'outside';
    b.style.cssText = 'position:fixed;right:0;bottom:0;width:60px;height:30px;';
    document.body.appendChild(b);
  }
  return b;
}

const alertText = () => screen.queryByRole('alert', { name: 'Operator panel configuration' })?.textContent ?? '';

// ── Tests ────────────────────────────────────────────────────────────────

describe('plan-555 9.7 — fallback, touch, dev flag, load failure', () => {
  it('the Suspense / loading fallback is the text field; text typed there is in the Monaco model', async () => {
    const { target } = fakeTarget();
    setActiveEditTarget(target);
    loader.delayMs = 300;
    mount({ value: A });
    const input = screen.getByTestId('rv-web-operator-panel-config-input') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    fireEvent.change(input, { target: { value: B } });
    const { model } = await waitEditor(uriFor(target));
    expect(model.getValue()).toBe(B);
  });

  it('touch device → text field, Monaco never loaded', async () => {
    device.touch = true;
    setActiveEditTarget(fakeTarget().target);
    mount({ value: A });
    await flush(100);
    expect(screen.getByTestId('rv-web-operator-panel-config-input').tagName).toBe('TEXTAREA');
    expect(screen.queryByTestId('rv-web-operator-panel-config-editor')).toBeNull();
    expect(loader.calls).toBe(0);
  });

  it('dev flag rv-webviewer-json-editor = 0 → text field, Monaco never loaded', async () => {
    localStorage.setItem(JSON_EDITOR_LS_KEY, '0');
    setActiveEditTarget(fakeTarget().target);
    mount({ value: A });
    await flush(100);
    expect(screen.getByTestId('rv-web-operator-panel-config-input').tagName).toBe('TEXTAREA');
    expect(loader.calls).toBe(0);
  });

  it('Monaco failing to load → the text field keeps the typed text, a console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setActiveEditTarget(fakeTarget().target);
    loader.fail = true;
    loader.delayMs = 100;
    mount({ value: A });
    fireEvent.change(screen.getByTestId('rv-web-operator-panel-config-input'), { target: { value: B } });
    await until(() => warn.mock.calls.some((c) => String(c[0]).includes('Monaco failed to load')));
    await flush(50);
    expect(screen.queryByTestId('rv-web-operator-panel-config-editor')).toBeNull();
    expect((screen.getByTestId('rv-web-operator-panel-config-input') as HTMLTextAreaElement).value).toBe(B);
    warn.mockRestore();
  });
});

describe('plan-555 9.7 — commit', () => {
  it('valid text: commitNow writes once with the string; invalid: nothing written, "Not applied"', async () => {
    const { target, writes } = fakeTarget();
    setActiveEditTarget(target);
    const handle = createRef<RvJsonEditorHandle>();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <OperatorPanelJsonEditor
          nodePath="Model/Panel" value={A} initialText={A} signalStore={null} documentKey={target}
          onCommit={(t, tg) => commitOperatorPanelConfig(t, A, 'Model/Panel', null, tg)}
          onTextChange={() => {}} onLoadError={() => {}} fallback={null} handleRef={handle}
        />
      </ThemeProvider>,
    );
    await until(() => handle.current);
    const h = handle.current!;
    act(() => { h.model.setValue(B); });
    act(() => { h.commitNow(); h.commitNow(); });
    expect(writes).toEqual([{ nodePath: 'Model/Panel', value: B, prev: A }]);

    act(() => { h.model.setValue('{ "version": 1, '); });
    act(() => { h.commitNow(); });
    expect(writes).toHaveLength(1);
    expect(alertText()).toMatch(/Config is not valid JSON/);
    expect(alertText()).toMatch(/Not applied/);

    // A second attempt without a text change does not set the message again.
    const list = screen.getByRole('alert', { name: 'Operator panel configuration' });
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((m) => mutations.push(...m));
    mo.observe(list, { childList: true, subtree: true, characterData: true });
    act(() => { h.blur(); h.commitNow(); });
    await flush(20);
    mo.disconnect();
    expect(mutations).toEqual([]);
  });

  it('an unavailable edit target: applied:false message, nothing written, a later commit writes', async () => {
    const ft = fakeTarget({ available: false });
    setActiveEditTarget(ft.target);
    mount({ value: A });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(B); });
    act(() => { editor.trigger('test', 'editor.action.selectAll', null); });
    // Ctrl+Enter through the real keybinding.
    editor.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await flush(20);
    expect(ft.writes).toEqual([]);
    expect(alertText()).toMatch(/no document accepts edits/);
    ft.target.available = true;
    editor.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await flush(20);
    expect(ft.writes.map((w) => w.value)).toEqual([B]);
  });

  it('a real focus change out of the editor commits', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    mount({ value: A });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    editor.focus();
    act(() => { model.setValue(B); });
    await userEvent.click(outsideButton());
    await until(() => ft.writes.length > 0);
    expect(ft.writes.map((w) => w.value)).toEqual([B]);
  });

  it('suggest widget: focusing its details or picking a suggestion does not commit; clicking outside while it shows does', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const store = storeWithSignals();
    const text = A.replace('"S_Start"', '""');
    mount({ value: A, store });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(text); });
    editor.focus();
    editor.setPosition(model.getPositionAt(text.indexOf('""') + 1));
    editor.trigger('test', 'editor.action.triggerSuggest', {});
    const row = await until(() => document.querySelector<HTMLElement>('.suggest-widget.visible .monaco-list-row'));

    // Focus the details pane.
    editor.trigger('test', 'toggleSuggestionDetails', {});
    const details = await until(() => document.querySelector<HTMLElement>('.suggest-details-container .suggest-details, .suggest-details'));
    details.setAttribute('tabindex', '0');
    details.focus();
    await flush(60);
    expect(ft.writes).toEqual([]);

    // Pick a suggestion with the mouse.
    editor.focus();
    await userEvent.click(row);
    await flush(60);
    expect(ft.writes).toEqual([]);
    expect(model.getValue()).not.toBe(text);

    // Open it again (on an empty value, so the list is not filtered away) and
    // click outside: commits.
    act(() => { model.setValue(text); });
    editor.focus();
    editor.setPosition(model.getPositionAt(text.indexOf('""') + 1));
    editor.trigger('test', 'editor.action.triggerSuggest', {});
    await until(() => document.querySelector('.suggest-widget.visible .monaco-list-row'), 20_000);
    await userEvent.click(outsideButton());
    await until(() => ft.writes.length > 0);
    expect(ft.writes).toHaveLength(1);
  });

  it('node switch while the suggest list and a hover are open → no unhandled rejection, console.error empty', async () => {
    // Records (never suppresses) rejections that reach the window during this test.
    const rejections: unknown[] = [];
    const onRejection = (e: PromiseRejectionEvent) => { rejections.push(e.reason); };
    window.addEventListener('unhandledrejection', onRejection);
    try {
      const ft = fakeTarget({ available: false });
      setActiveEditTarget(ft.target);
      const store = storeWithSignals();
      const text = A.replace('"S_Start"', '""');
      const r = mount({ value: A, nodePath: 'Model/Panel', store });
      const { model, editor } = await waitEditor(uriFor(ft.target, 'Model/Panel'));
      act(() => { model.setValue(text); });
      editor.focus();
      editor.setPosition(model.getPositionAt(text.indexOf('""') + 1));
      editor.trigger('test', 'editor.action.triggerSuggest', {});
      await until(() => document.querySelector('.suggest-widget.visible .monaco-list-row'), 20_000);
      editor.trigger('test', 'editor.action.showHover', {});
      // Cursor move + focus right before the switch: every delayed editor
      // contribution is still pending when the editor is disposed.
      editor.setPosition(model.getPositionAt(text.indexOf('"title"') + 1));
      editor.focus();
      r.update({ value: C, nodePath: 'Model/Other', store });
      await waitEditor(uriFor(ft.target, 'Model/Other'));
      await flush(200);
      expect(rejections).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });

  it('dedupe: blur and unmount before the write comes back → ONE setFieldAsync; a rejection lets the next commit write again', async () => {
    const ft = fakeTarget({ deferred: true });
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    editor.focus();
    act(() => { model.setValue(B); });
    await userEvent.click(outsideButton());
    await until(() => ft.writes.length > 0);
    // Reject → the next commit of the same text writes again.
    await act(async () => { ft.settle().reject(new Error('refused')); await Promise.resolve(); });
    await flush(10);
    expect(alertText()).toMatch(/Not applied — refused/);
    editor.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await flush(10);
    expect(ft.writes).toHaveLength(2);
    // Pending again: an unmount before the prop returns writes nothing more.
    r.unmount();
    await flush(10);
    expect(ft.writes).toHaveLength(2);
  });
});

describe('plan-555 9.7 — drafts and documents', () => {
  it('valid dirty text with an unavailable target survives unmount as a draft', async () => {
    const ft = fakeTarget({ available: false });
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(B); });
    r.unmount();
    await flush(10);
    expect(ft.writes).toEqual([]);
    mount({ value: A });
    const again = await waitEditor(uriFor(ft.target));
    expect(again.model.getValue()).toBe(B);
    await until(() => screen.queryByText('Unapplied draft restored'));
  });

  it('document switch: no write into either document, the draft only comes back in the first', async () => {
    const docA = fakeTarget();
    const docB = fakeTarget();
    setActiveEditTarget(docA.target);
    const r = mount({ value: A });
    const first = await waitEditor(uriFor(docA.target));
    act(() => { first.model.setValue(B); });
    act(() => { setActiveEditTarget(docB.target); });
    r.update({ value: A });
    const second = await waitEditor(uriFor(docB.target));
    expect(second.model.getValue()).toBe(A);
    await flush(20);
    expect(docA.writes).toEqual([]);
    expect(docB.writes).toEqual([]);
    expect(screen.queryByText('Unapplied draft restored')).toBeNull();
    act(() => { setActiveEditTarget(docA.target); });
    r.update({ value: A });
    const back = await waitEditor(uriFor(docA.target));
    expect(back.model.getValue()).toBe(B);
    await until(() => screen.queryByText('Unapplied draft restored'));
    expect(docA.writes).toEqual([]);
  });

  it('selection change while dirty + valid → written with the OLD node path and OLD undo base', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A, nodePath: 'Model/Panel' });
    const { model } = await waitEditor(uriFor(ft.target, 'Model/Panel'));
    act(() => { model.setValue(B); });
    r.update({ value: C, nodePath: 'Model/Other' });
    const other = await waitEditor(uriFor(ft.target, 'Model/Other'));
    await flush(10);
    expect(ft.writes).toEqual([{ nodePath: 'Model/Panel', value: B, prev: A }]);
    // The new node's editor shows the new node's value (draftText was reset).
    expect(other.model.getValue()).toBe(C);
  });

  it('selection change while dirty + invalid → nothing written; coming back restores the draft', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A, nodePath: 'Model/Panel' });
    const { model } = await waitEditor(uriFor(ft.target, 'Model/Panel'));
    act(() => { model.setValue('{ "broken": '); });
    r.update({ value: C, nodePath: 'Model/Other' });
    await waitEditor(uriFor(ft.target, 'Model/Other'));
    await flush(10);
    expect(ft.writes).toEqual([]);
    r.update({ value: A, nodePath: 'Model/Panel' });
    const back = await waitEditor(uriFor(ft.target, 'Model/Panel'));
    expect(back.model.getValue()).toBe('{ "broken": ');
    await until(() => screen.queryByText('Unapplied draft restored'));
  });
});

describe('plan-555 9.7 — external changes (dirty rule)', () => {
  it('clean model: an external value replaces the text as ONE undo step', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model } = await waitEditor(uriFor(ft.target));
    r.update({ value: B });
    await until(() => model.getValue() === B);
    act(() => { model.undo(); });
    expect(model.getValue()).toBe(A);
    expect(ft.writes).toEqual([]);
  });

  it('dirty model: text kept, conflict hint; Escape reloads; the hint goes after a commit', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(B); });
    r.update({ value: C });
    await until(() => screen.queryByTestId('rv-web-operator-panel-config-editor-conflict'));
    expect(model.getValue()).toBe(B);
    editor.focus();
    await userEvent.keyboard('{Escape}');
    await until(() => model.getValue() === C);
    await until(() => !screen.queryByTestId('rv-web-operator-panel-config-editor-conflict'));

    // Conflict again, then Ctrl+Enter overwrites and the hint goes.
    act(() => { model.setValue(B); });
    r.update({ value: A });
    await until(() => screen.queryByTestId('rv-web-operator-panel-config-editor-conflict'));
    editor.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await flush(10);
    expect(ft.writes.map((w) => w.value)).toEqual([B]);
    expect(ft.writes[0].prev).toBe(A);
    r.update({ value: B });
    await until(() => !screen.queryByTestId('rv-web-operator-panel-config-editor-conflict'));
  });

  it('the own commit coming back changes neither text nor cursor', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model, editor } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(B); });
    editor.setPosition({ lineNumber: 3, column: 5 });
    editor.focus();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await flush(10);
    const versionBefore = model.getVersionId();
    r.update({ value: B });
    await flush(20);
    expect(model.getVersionId()).toBe(versionBefore);
    expect(editor.getPosition()).toMatchObject({ lineNumber: 3, column: 5 });
  });

  it('an external value in the Monaco path does not reset the shared text', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const { model } = await waitEditor(uriFor(ft.target));
    act(() => { model.setValue(B); });
    r.update({ value: C });
    await flush(20);
    // Switch the same field to the text field (touch): it shows the shared text.
    device.touch = true;
    r.update({ value: C });
    await flush(20);
    expect((screen.getByTestId('rv-web-operator-panel-config-input') as HTMLTextAreaElement).value).toBe(B);
  });
});

describe('plan-555 9.7 — StrictMode, expand, markers', () => {
  it('StrictMode double mount keeps the text and writes nothing', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    loader.delayMs = 200;
    mount({ value: A }, true);
    fireEvent.change(screen.getByTestId('rv-web-operator-panel-config-input'), { target: { value: B } });
    const { model } = await waitEditor(uriFor(ft.target));
    await flush(30);
    expect(model.getValue()).toBe(B);
    expect(ft.writes).toEqual([]);
  });

  it('expand: one model for both editors; focus inline ↔ expand writes once at most; closing commits and keeps the model', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const r = mount({ value: A });
    const uri = uriFor(ft.target);
    const { model, editor } = await waitEditor(uri);
    act(() => { model.setValue(B); });
    await userEvent.click(screen.getByRole('button', { name: 'Expand editor' }));
    const expandEditor = await until(() => monaco.editor.getEditors().find((e) => e !== editor && e.getModel() === model));
    expandEditor.focus();
    await flush(30);
    editor.focus();
    await flush(30);
    expandEditor.focus();
    await flush(30);
    expect(ft.writes.length).toBeLessThanOrEqual(1);
    // The 720 px window is wider than the 414 px test viewport — its close
    // button is off-screen for a real pointer, so the click is dispatched.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Close window' })); });
    await flush(30);
    expect(screen.queryByTestId('rv-web-operator-panel-config-editor-expand')).toBeNull();
    expect(ft.writes.map((w) => w.value)).toEqual([B]);
    expect(model.isDisposed()).toBe(false);
    expect(monaco.editor.getEditors().filter((e) => e.getModel() === model)).toHaveLength(1);
    r.unmount();
    await flush(10);
    expect(model.isDisposed()).toBe(true);
  });

  it('rule markers: rv-json-rules at buttons[0].signal for an unknown signal, cleared when valid; owner json untouched', async () => {
    const ft = fakeTarget();
    setActiveEditTarget(ft.target);
    const store = storeWithSignals();
    const bad = A.replace('"S_Start"', '"BT9"');
    mount({ value: bad, store });
    const { model } = await waitEditor(uriFor(ft.target));
    const markers = await until(() => {
      const m = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'rv-json-rules' });
      return m.length > 0 ? m : null;
    });
    expect(markers).toHaveLength(1);
    expect(markers[0].message).toBe("buttons[0].signal 'BT9' not found in model");
    const start = bad.indexOf('"BT9"');
    const a = model.getPositionAt(start);
    const b = model.getPositionAt(start + '"BT9"'.length);
    expect(markers[0]).toMatchObject({ startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column });
    act(() => { model.setValue(A); });
    await until(() => monaco.editor.getModelMarkers({ resource: model.uri, owner: 'rv-json-rules' }).length === 0);
    expect(monaco.editor.getModelMarkers({ resource: model.uri, owner: 'json' })).toEqual([]);
  });
});
