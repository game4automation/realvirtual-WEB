// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RvJsonEditor — a Monaco JSON editor for an inspector field (plan-555).
 * Field-neutral: what it knows about the field comes from a
 * {@link JsonFieldContext} (schema, signal keys, snippets, rules), keyed by
 * the model URI.
 *
 *  - Inline: compact editor (4–15 lines, auto height). "Expand editor" opens a
 *    large {@link FloatingPanel} with a second editor on the SAME model.
 *  - Apply: on blur of the editor text (focus really left both editors and
 *    their widgets), Ctrl/Cmd+Enter, closing the expand window, or unmount —
 *    through `onCommit` against the edit target captured at mount. Invalid
 *    JSON is never applied. A write that has not come back through `value`
 *    yet is `pending`; a second trigger for the same text writes nothing.
 *  - External changes (undo/redo, MCP writes) update an unchanged model as ONE
 *    Monaco undo step; a dirty model keeps the user's text and shows a
 *    conflict hint (Ctrl+Enter overwrites, Escape reloads).
 *  - Text that was not applied when the editor goes away (invalid, target
 *    gone or switched to another document, write rejected) is kept as a draft
 *    for the URI and restored on the next mount.
 *  - Rule markers (owner `rv-json-rules`) debounced 250 ms; syntax markers come
 *    from the JSON worker (owner `json`).
 *
 * The parent renders it with `key={docId + '|' + nodePath}` — a selection or
 * document switch is always an unmount + mount. Monaco loads lazily through
 * {@link loadJsonMonaco}; until then `fallback` is shown.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { OpenInFull } from '@mui/icons-material';
import { FloatingPanel } from '../FloatingPanel';
import {
  FIELD_BG, FIELD_BORDER, FIELD_BORDER_HOVER, FS, ICON_SIZE, INK_LOW, INK_MID, MONO, WARN,
} from '../shared-sx';
import { getActiveEditTarget, type EditTarget } from '../rv-edit-target';
import {
  JSON_RULES_OWNER, loadJsonMonaco,
  type JsonMonaco, type JsonMonacoEditor, type JsonMonacoEditorOptions, type JsonMonacoMarkerData,
  type JsonMonacoModel,
} from './rv-json-monaco-loader';
import {
  dropJsonFieldState, getJsonFieldState, normalizeEol, registerJsonFieldContext, setJsonDraft,
  takeJsonDraft, type JsonFieldContext, type JsonFieldState,
} from './rv-json-field-context';
import { rangeForPath } from './rv-json-path-ranges';

/** Rule-marker debounce after a keystroke. */
const MARKER_DEBOUNCE_MS = 250;
const MIN_LINES = 4;
const MAX_LINES = 15;

/** What a commit did. */
export interface JsonCommitResult {
  /** True when the text was handed to the edit target. */
  applied: boolean;
  /** Messages to list under the field (errors when not applied, rule warnings when applied). */
  messages: string[];
  /** Settles when the write was applied (resolve) or refused (reject). */
  done?: Promise<void>;
}

/** Test seam (and nothing else): the live editor and its actions. */
export interface RvJsonEditorHandle {
  editor: JsonMonacoEditor;
  model: JsonMonacoModel;
  /** The expand window's editor while it is open. */
  expandEditor: JsonMonacoEditor | null;
  commitNow(): void;
  /** Moves focus out of the editors (as a click elsewhere would). */
  blur(): void;
}

export interface RvJsonEditorProps {
  context: JsonFieldContext;
  /** The stored text (the field value as the store has it). */
  value: string;
  /** Text the model starts with when it is created (e.g. typed into the fallback). */
  initialText: string;
  /** Applies a text through `target` (captured at mount). */
  onCommit(text: string, target: EditTarget): JsonCommitResult;
  /** Every change of the editor text. */
  onTextChange?(text: string): void;
  /** Monaco failed to load — the parent shows its plain field. */
  onLoadError?(error: unknown): void;
  /** Shown until Monaco is ready. */
  fallback?: ReactNode;
  testId: string;
  /** Accessible name of the message list (`role="alert"`). */
  alertLabel: string;
  /** Accessible name of the editor. */
  ariaLabel: string;
  /** Title of the expand window. */
  expandTitle: string;
  handleRef?: Ref<RvJsonEditorHandle | null>;
}

const NOT_APPLIED_TARGET = 'Not applied — no document accepts edits right now.';

function setHandle(ref: Ref<RvJsonEditorHandle | null> | undefined, value: RvJsonEditorHandle | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: RvJsonEditorHandle | null }).current = value;
}

const docKeyOf = (t: EditTarget): object => t.documentKey ?? t;

export function RvJsonEditor(props: RvJsonEditorProps) {
  const { context, value, testId, alertLabel, ariaLabel, expandTitle, fallback } = props;

  const [monaco, setMonaco] = useState<JsonMonaco | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Latest props, written after commit (never during render) — every Monaco
  // handler and the unmount path read these, never a stale closure.
  const valueRef = useRef(value);
  const onCommitRef = useRef(props.onCommit);
  const onTextChangeRef = useRef(props.onTextChange);
  const onLoadErrorRef = useRef(props.onLoadError);
  const contextRef = useRef(context);
  const initialTextRef = useRef(props.initialText);
  const handleRefRef = useRef(props.handleRef);
  useLayoutEffect(() => {
    valueRef.current = value;
    onCommitRef.current = props.onCommit;
    onTextChangeRef.current = props.onTextChange;
    onLoadErrorRef.current = props.onLoadError;
    contextRef.current = context;
    initialTextRef.current = props.initialText;
    handleRefRef.current = props.handleRef;
  });

  const mountedRef = useRef(false);
  const capturedTargetRef = useRef<EditTarget | null>(null);
  const modelRef = useRef<JsonMonacoModel | null>(null);
  const stateRef = useRef<JsonFieldState | null>(null);
  const editorRef = useRef<JsonMonacoEditor | null>(null);
  const expandEditorRef = useRef<JsonMonacoEditor | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inlineHostRef = useRef<HTMLDivElement | null>(null);
  const expandHostRef = useRef<HTMLDivElement | null>(null);
  const lastFailedTextRef = useRef<string | null>(null);
  const conflictKeysRef = useRef<{ set(v: boolean): void }[]>([]);

  const show = useCallback((next: string[]) => {
    if (mountedRef.current) setMessages(next);
  }, []);

  const setConflictFlag = useCallback((on: boolean) => {
    const st = stateRef.current;
    if (st) st.conflict = on;
    for (const k of conflictKeysRef.current) k.set(on);
    if (mountedRef.current) setConflict(on);
  }, []);

  // ── Load Monaco ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    loadJsonMonaco().then(
      (m) => { if (!cancelled) setMonaco(() => m); },
      (err: unknown) => {
        if (cancelled) return;
        console.warn('[RvJsonEditor] Monaco failed to load — using the plain text field.', err);
        onLoadErrorRef.current?.(err);
      },
    );
    return () => { cancelled = true; };
  }, []);

  // ── Context registration (schema, signals, snippets) ────────────────
  useEffect(() => registerJsonFieldContext(context), [context]);

  /**
   * Applies the model text: nothing when it equals the confirmed or the
   * pending text; otherwise through the captured target.
   */
  const commitNow = useCallback((): JsonCommitResult | null => {
    const model = modelRef.current;
    const st = stateRef.current;
    const target = capturedTargetRef.current;
    if (!model || model.isDisposed() || !st || !target) return null;
    const text = model.getValue();
    if (text === st.lastApplied || text === st.pending) return null;
    if (!target.available) {
      const res = { applied: false, messages: [NOT_APPLIED_TARGET] };
      if (lastFailedTextRef.current !== text) show(res.messages);
      lastFailedTextRef.current = text;
      st.lastError = NOT_APPLIED_TARGET;
      return res;
    }
    const res = onCommitRef.current(text, target);
    if (!res.applied) {
      if (lastFailedTextRef.current !== text) show(res.messages);
      lastFailedTextRef.current = text;
      st.lastError = res.messages[0];
      return res;
    }
    lastFailedTextRef.current = null;
    st.lastError = undefined;
    st.pending = text;
    show(res.messages);
    res.done?.catch((err: unknown) => {
      if (st.pending === text) st.pending = undefined;
      const msg = `Not applied — ${err instanceof Error ? err.message : String(err)}`;
      st.lastError = msg;
      show([msg]);
    });
    return res;
  }, [show]);

  const reloadFromStore = useCallback(() => {
    const model = modelRef.current;
    const st = stateRef.current;
    if (!model || model.isDisposed() || !st) return;
    const next = normalizeEol(valueRef.current);
    replaceModelText(model, next);
    st.lastApplied = next;
    setConflictFlag(false);
  }, [setConflictFlag]);

  // ── Model + inline editor ────────────────────────────────────────────
  useEffect(() => {
    if (!monaco || !inlineHostRef.current) return;
    mountedRef.current = true;
    const target = getActiveEditTarget();
    capturedTargetRef.current = target;
    const capturedDocKey = docKeyOf(target);

    const uriText = contextRef.current.uri;
    const uri = monaco.Uri.parse(uriText);
    const draft = takeJsonDraft(uriText);
    let model = monaco.editor.getModel(uri);
    let st: JsonFieldState;
    if (!model) {
      dropJsonFieldState(uriText);
      model = monaco.editor.createModel(draft ?? initialTextRef.current, 'json', uri);
      st = getJsonFieldState(uriText, normalizeEol(valueRef.current));
    } else {
      st = getJsonFieldState(uriText, normalizeEol(valueRef.current));
      if (draft !== undefined && draft !== model.getValue()) replaceModelText(model, draft);
    }
    st.editors++;
    modelRef.current = model;
    stateRef.current = st;
    if (draft !== undefined) setDraftRestored(true);
    setConflict(st.conflict);
    const ownModel = model;

    const editor = monaco.editor.create(inlineHostRef.current, editorOptions(ownModel, ariaLabel, false));
    editorRef.current = editor;
    const disposables = wireEditor(monaco, editor);

    // Auto height: 4–15 lines of content.
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const fit = () => {
      const host = inlineHostRef.current;
      if (!host) return;
      const h = Math.min(MAX_LINES * lineHeight, Math.max(MIN_LINES * lineHeight, editor.getContentHeight()));
      host.style.height = `${h}px`;
      editor.layout({ width: host.clientWidth, height: h });
    };
    disposables.push(editor.onDidContentSizeChange(fit));
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(inlineHostRef.current);

    // Rule markers, debounced; text echo to the parent; conflict hint reset.
    let markerTimer: ReturnType<typeof setTimeout> | null = null;
    const applyMarkers = () => {
      markerTimer = null;
      if (ownModel.isDisposed()) return;
      setRuleMarkers(monaco, ownModel, contextRef.current);
    };
    disposables.push(ownModel.onDidChangeContent(() => {
      const text = ownModel.getValue();
      onTextChangeRef.current?.(text);
      if (st.conflict && text === st.lastApplied) setConflictFlag(false);
      if (markerTimer) clearTimeout(markerTimer);
      markerTimer = setTimeout(applyMarkers, MARKER_DEBOUNCE_MS);
    }));
    applyMarkers();

    setHandle(handleRefRef.current, {
      editor,
      model: ownModel,
      get expandEditor() { return expandEditorRef.current; },
      commitNow: () => { commitNow(); },
      blur: () => {
        const active = document.activeElement as HTMLElement | null;
        active?.blur?.();
        document.body.focus();
      },
    } as RvJsonEditorHandle);

    return () => {
      mountedRef.current = false;
      if (markerTimer) clearTimeout(markerTimer);
      ro.disconnect();
      for (const d of disposables) d.dispose();
      const text = ownModel.isDisposed() ? null : ownModel.getValue();
      editor.dispose();
      editorRef.current = null;
      setHandle(handleRefRef.current, null);
      st.editors--;

      // Deferred one microtask: a StrictMode re-mount runs in between and
      // takes the model (and the text) over — then nothing is committed and
      // nothing disposed. A real unmount commits or keeps a draft.
      queueMicrotask(() => {
        if (mountedRef.current && modelRef.current === ownModel) return; // re-mounted
        if (text !== null && text !== st.lastApplied && text !== st.pending) {
          const sameDocument = docKeyOf(getActiveEditTarget()) === capturedDocKey;
          const res = sameDocument ? commitNow() : null;
          if (!res || !res.applied) setJsonDraft(uriText, text);
          else res.done?.catch(() => setJsonDraft(uriText, text));
        }
        if (st.editors <= 0 && !ownModel.isDisposed()) {
          monaco.editor.setModelMarkers(ownModel, JSON_RULES_OWNER, []);
          ownModel.dispose();
          dropJsonFieldState(uriText);
        }
      });
    };
    // Recreated per document / node through the parent's `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  /** Commands and the blur rule shared by the inline and the expand editor. */
  function wireEditor(m: JsonMonaco, editor: JsonMonacoEditor) {
    const conflictKey = editor.createContextKey<boolean>('rvJsonConflict', stateRef.current?.conflict ?? false);
    conflictKeysRef.current.push(conflictKey);
    editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.Enter, () => { commitNow(); });
    editor.addCommand(m.KeyCode.Escape, () => reloadFromStore(), 'rvJsonConflict && !suggestWidgetVisible');
    const blur = editor.onDidBlurEditorText(() => {
      setTimeout(() => {
        if (!modelRef.current || modelRef.current.isDisposed()) return;
        if (focusIsInside()) return;
        commitNow();
      }, 0);
    });
    return [
      blur,
      { dispose: () => { conflictKeysRef.current = conflictKeysRef.current.filter((k) => k !== conflictKey); } },
    ];
  }

  /** True while focus is in one of our editors, its widgets or the expand window. */
  function focusIsInside(): boolean {
    if (editorRef.current?.hasWidgetFocus()) return true;
    if (expandEditorRef.current?.hasWidgetFocus()) return true;
    const active = document.activeElement;
    if (!active || active === document.body) return false;
    // The whole field counts (the Expand button included): only leaving it commits.
    const hosts = [rootRef.current, inlineHostRef.current, expandHostRef.current, editorRef.current?.getDomNode(), expandEditorRef.current?.getDomNode()];
    return hosts.some((h) => h?.contains(active));
  }

  // ── External value changes: the dirty rule ──────────────────────────
  useEffect(() => {
    const model = modelRef.current;
    const st = stateRef.current;
    if (!monaco || !model || model.isDisposed() || !st) return;
    const next = normalizeEol(value);
    st.pending = undefined;
    const current = model.getValue();
    if (next === current) {
      st.lastApplied = next;
      setConflictFlag(false);
      lastFailedTextRef.current = null;
    } else if (current === st.lastApplied) {
      replaceModelText(model, next);
      st.lastApplied = next;
      setConflictFlag(false);
    } else if (next !== st.lastApplied) {
      st.lastApplied = next;
      setConflictFlag(true);
    }
  }, [value, monaco, setConflictFlag]);

  // ── Expand window: a second editor on the same model ────────────────
  useEffect(() => {
    if (!expanded || !monaco || !modelRef.current) return;
    let editor: JsonMonacoEditor | null = null;
    let disposables: { dispose(): void }[] = [];
    let ro: ResizeObserver | null = null;
    // The panel content mounts in the same commit; create on the next frame.
    const raf = requestAnimationFrame(() => {
      const host = expandHostRef.current;
      const model = modelRef.current;
      if (!host || !model || model.isDisposed()) return;
      editor = monaco.editor.create(host, editorOptions(model, ariaLabel, true));
      const inlineState = editorRef.current?.saveViewState();
      if (inlineState) editor.restoreViewState(inlineState);
      expandEditorRef.current = editor;
      disposables = wireEditor(monaco, editor);
      ro = new ResizeObserver(() => editor?.layout());
      ro.observe(host);
      editor.layout();
      editor.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      for (const d of disposables) d.dispose();
      if (editor) {
        const view = editor.saveViewState();
        editor.dispose();
        if (view) editorRef.current?.restoreViewState(view);
      }
      expandEditorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, monaco]);

  const closeExpand = useCallback(() => {
    commitNow();
    setExpanded(false);
  }, [commitNow]);

  const ready = monaco !== null;

  return (
    <Box ref={rootRef} data-testid={testId} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {!ready && fallback}
      <Box sx={{ display: ready ? 'flex' : 'none', alignItems: 'flex-start', gap: 0.5 }}>
        <Box
          sx={{
            flex: 1, minWidth: 0, bgcolor: FIELD_BG, border: 1, borderColor: FIELD_BORDER, borderRadius: 1,
            overflow: 'hidden', '&:hover': { borderColor: FIELD_BORDER_HOVER }, '&:focus-within': { borderColor: 'primary.main' },
          }}
        >
          <Box ref={inlineHostRef} data-testid={`${testId}-monaco`} sx={{ width: '100%', height: MIN_LINES * 18 }} />
        </Box>
        <Tooltip title="Expand editor">
          <IconButton size="small" aria-label="Expand editor" onClick={() => setExpanded(true)} sx={{ color: INK_LOW }}>
            <OpenInFull sx={{ fontSize: ICON_SIZE.sm }} />
          </IconButton>
        </Tooltip>
      </Box>
      {ready && conflict && (
        <Box data-testid={`${testId}-conflict`} sx={{ fontSize: FS.label, color: WARN }}>
          The stored config changed while you were editing — Ctrl+Enter overwrites it, Escape reloads it.
        </Box>
      )}
      {ready && draftRestored && (
        <Box data-testid={`${testId}-draft`} sx={{ fontSize: FS.label, color: WARN }}>
          Unapplied draft restored
        </Box>
      )}
      {messages.length > 0 && (
        <Box
          role="alert"
          aria-label={alertLabel}
          component="ul"
          sx={{ m: 0, pl: 2, fontSize: FS.label, color: INK_MID, '& li::marker': { color: WARN } }}
        >
          {messages.slice(0, 8).map((m) => <li key={m}>{m}</li>)}
          {messages.length > 8 && <li>… and {messages.length - 8} more</li>}
        </Box>
      )}
      {ready && <Box sx={{ fontSize: FS.label, color: INK_LOW }}>Ctrl+Enter to apply</Box>}
      {expanded && (
        <FloatingPanel open onClose={closeExpand} title={expandTitle} panelId="json-editor" defaultWidth={720} defaultHeight={520}>
          <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <Box ref={expandHostRef} data-testid={`${testId}-expand`} sx={{ position: 'absolute', inset: 0 }} />
          </Box>
        </FloatingPanel>
      )}
    </Box>
  );
}

function editorOptions(model: JsonMonacoModel, ariaLabel: string, large: boolean): JsonMonacoEditorOptions {
  return {
    model,
    theme: 'vs-dark',
    ariaLabel,
    automaticLayout: false,
    fixedOverflowWidgets: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    fontFamily: MONO,
    fontSize: FS.label,
    lineNumbers: large ? 'on' : 'off',
    lineNumbersMinChars: 3,
    folding: large,
    glyphMargin: false,
    overviewRulerLanes: large ? 2 : 0,
    renderLineHighlight: large ? 'line' : 'none',
    scrollbar: { alwaysConsumeMouseWheel: false },
    tabSize: 2,
    quickSuggestions: { strings: true, other: true, comments: false },
    accessibilitySupport: 'auto',
    // Off on purpose: Monaco's WordHighlighter (0.55) schedules every cursor
    // move / focus through a 50 ms `Delayer` whose promise it never catches.
    // Disposing the editor inside that window — a node or document switch right
    // after typing — rejects it with an unhandled `Canceled`. Occurrence
    // highlighting adds nothing to a JSON config field; with it off the
    // highlighter never triggers.
    occurrencesHighlight: 'off',
  };
}

/** Replaces the whole text as ONE undo step (own stack element before and after). */
function replaceModelText(model: JsonMonacoModel, text: string): void {
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
}

/** The field rules as markers (owner `rv-json-rules`); none for unparsable text. */
function setRuleMarkers(monaco: JsonMonaco, model: JsonMonacoModel, context: JsonFieldContext): void {
  const text = model.getValue();
  let parsable = true;
  try {
    if (text.trim() !== '') JSON.parse(text);
    else parsable = false;
  } catch {
    parsable = false;
  }
  if (!parsable || !context.validate) {
    monaco.editor.setModelMarkers(model, JSON_RULES_OWNER, []);
    return;
  }
  const markers: JsonMonacoMarkerData[] = context.validate(text).map((issue) => {
    const range = rangeForPath(text, issue.path);
    const severity = issue.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning;
    if (!range) {
      return { severity, message: issue.message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: model.getLineMaxColumn(1) };
    }
    const a = model.getPositionAt(range.start);
    const b = model.getPositionAt(range.end);
    return { severity, message: issue.message, startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
  });
  monaco.editor.setModelMarkers(model, JSON_RULES_OWNER, markers);
}
