// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ScriptEditorPanel — Monaco-based editor for `WebComponent` scripts in
 * `rv_extras` (plan-210 phase 3, §4.1–§4.3, §4.6).
 *
 * Rendered in the 'overlay' slot (registered by web-component-plugin.ts);
 * visible whenever script-editor-store says `open`. Monaco (editor core +
 * TS worker) loads lazily on the FIRST open — never in the eager bundle.
 *
 *  - Node picker: every node carrying a `WebComponent` entry, plus
 *    "Add script to selected node" for the current 3D selection. This is the
 *    v1 entry (plus the 'Edit Script' inspector action) — the inline
 *    inspector button follows once the inspector files are unlocked
 *    (parallel workstream).
 *  - Language mode: TypeScript against the generated SDK typings
 *    (rv-sdk.d.ts extraLib, noLib — §4.2); TS inline diagnostics come from
 *    Monaco, DES-lint markers are applied debounced (owner 'rv-des-lint').
 *  - Save (Ctrl-S / button, §4.3): TS→JS erasure via the Monaco TS worker →
 *    `validateScriptForSave` (parse + DES lint + apiVersion) → on success one
 *    `setCode` op (undoable, coalesced) + hot-reload
 *    (`WebComponentPlugin.reloadOrCreate`). On failure NOTHING swaps — the
 *    old code keeps running, markers/toast show, the editor stays dirty.
 *  - Trust gate (§4.6): while scripting is disabled for the model the editor
 *    is read-only under a banner with an explicit enable button
 *    (`setAllowScripts(true)` re-wires the loaded model).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box, Button, Chip, IconButton, MenuItem, Select, Snackbar, Tooltip, Typography,
} from '@mui/material';
import { Add, Save } from '@mui/icons-material';
import type { Object3D } from 'three';
import { FloatingPanel } from '../FloatingPanel';
import type { UISlotProps } from '../../rv-ui-plugin';
import type { RVViewer } from '../../rv-viewer';
import { getSceneStore } from '../scene/scene-store-singleton';
import { lintDesSafety, type DesLintDiagnostic } from '../../sdk/rv-des-lint';
import { computeWebComponentNodePath } from '../../engine/rv-web-component-registry';
import {
  loadScriptEditorMonaco, transpileModel, SCRIPT_LANGUAGE_ID, type Monaco,
} from './monaco-loader';
import {
  applyScriptSave, readWebComponentCode, readWebComponentRaw, validateScriptForSave,
  SCRIPT_TEMPLATE, type ScriptSaveDiagnostic,
} from './rv-script-save-pipeline';
import {
  closeScriptEditor, getScriptEditorState, setScriptEditorNode, subscribeScriptEditor,
} from './script-editor-store';

type MonacoEditor = ReturnType<Monaco['editor']['create']>;

/** DES-lint marker debounce after a keystroke. */
const LINT_DEBOUNCE_MS = 300;

/** Minimal structural surface of WebComponentPlugin (avoids an hmi → plugins import). */
interface ScriptPluginLike {
  readonly scriptsAllowed: boolean;
  setAllowScripts(allow: boolean): void;
  reloadOrCreate(nodePath: string, jsCode: string): Promise<boolean>;
}

function getScriptPlugin(viewer: RVViewer): ScriptPluginLike | null {
  const p = viewer.getPlugin('web-component') as unknown as ScriptPluginLike | undefined;
  return p && typeof p.reloadOrCreate === 'function' ? p : null;
}

// ─── Scene helpers ──────────────────────────────────────────────────────────

interface ScriptNodeEntry {
  path: string;
  label: string;
}

/** All nodes carrying a `WebComponent` entry (editor node picker). */
function listScriptNodes(viewer: RVViewer): ScriptNodeEntry[] {
  const out: ScriptNodeEntry[] = [];
  viewer.scene?.traverse((n) => {
    const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && rv.WebComponent !== undefined) {
      const path = computeWebComponentNodePath(n);
      out.push({ path, label: n.name || path });
    }
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Resolves a node by the wiring path convention (root→leaf name walk). */
function findNodeByPath(viewer: RVViewer, path: string): Object3D | null {
  let hit: Object3D | null = null;
  viewer.scene?.traverse((n) => {
    if (!hit && computeWebComponentNodePath(n) === path) hit = n;
  });
  return hit;
}

// ─── Monaco host ────────────────────────────────────────────────────────────

interface MonacoHostProps {
  initialCode: string;
  readOnly: boolean;
  /** The component's DesSafe claim — escalates live lint warnings to errors. */
  desSafe: boolean;
  onEditor(editor: MonacoEditor, monaco: Monaco): void;
  onDirty(): void;
  onSaveShortcut(): void;
}

/** Applies DES-lint diagnostics as Monaco markers (owner 'rv-des-lint'). */
function applyLintMarkers(
  monaco: Monaco,
  editor: MonacoEditor,
  diagnostics: readonly (DesLintDiagnostic | ScriptSaveDiagnostic)[],
  owner: string,
): void {
  const model = editor.getModel();
  if (!model) return;
  const maxLine = model.getLineCount();
  monaco.editor.setModelMarkers(model, owner, diagnostics.map((d) => {
    const line = Math.min(Math.max(d.line, 1), maxLine);
    const col = Math.max(d.col, 1);
    return {
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: d.message,
      startLineNumber: line,
      startColumn: col,
      endLineNumber: line,
      endColumn: col + 1,
    };
  }));
}

function MonacoHost({ initialCode, readOnly, desSafe, onEditor, onDirty, onSaveShortcut }: MonacoHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSaveShortcut);
  onSaveRef.current = onSaveShortcut;

  useEffect(() => {
    let disposed = false;
    let editor: MonacoEditor | null = null;
    let lintTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeObserver: ResizeObserver | null = null;

    loadScriptEditorMonaco()
      .then((monaco) => {
        if (disposed || !containerRef.current) return;
        setLoading(false);
        editor = monaco.editor.create(containerRef.current, {
          value: initialCode,
          language: SCRIPT_LANGUAGE_ID,
          theme: 'vs-dark',
          readOnly,
          automaticLayout: false, // ResizeObserver below (panel resize / expand)
          minimap: { enabled: false },
          fontSize: 12,
          lineNumbersMinChars: 3,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
        });
        onEditor(editor, monaco);

        const applyLint = () => {
          if (!editor) return;
          const diagnostics = lintDesSafety(editor.getValue(), { desSafe });
          applyLintMarkers(monaco, editor, diagnostics, 'rv-des-lint');
        };

        editor.onDidChangeModelContent(() => {
          onDirtyRef.current();
          if (lintTimer) clearTimeout(lintTimer);
          lintTimer = setTimeout(applyLint, LINT_DEBOUNCE_MS);
        });
        applyLint(); // initial diagnostics on open

        // Ctrl-S / Cmd-S → save pipeline (§4.3).
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());

        resizeObserver = new ResizeObserver(() => editor?.layout());
        resizeObserver.observe(containerRef.current);
      })
      .catch((err) => {
        if (disposed) return;
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
      if (lintTimer) clearTimeout(lintTimer);
      resizeObserver?.disconnect();
      editor?.getModel()?.dispose();
      editor?.dispose();
    };
    // Recreated per node / trust-gate change via the `key` prop on the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <Box ref={containerRef} sx={{ position: 'absolute', inset: 0 }} />
      {loading && (
        <Typography sx={{ p: 2, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
          Loading editor…
        </Typography>
      )}
      {loadError && (
        <Typography sx={{ p: 2, fontSize: 12, color: '#ef5350' }}>
          Editor failed to load: {loadError}
        </Typography>
      )}
    </Box>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/**
 * WebComponent script editor panel — rendered in the 'overlay' slot; visible
 * whenever the script-editor-store says `open`.
 */
export function ScriptEditorPanel({ viewer }: UISlotProps) {
  const state = useSyncExternalStore(subscribeScriptEditor, getScriptEditorState);
  const plugin = getScriptPlugin(viewer);
  const [allowed, setAllowed] = useState(plugin?.scriptsAllowed ?? false);
  const [snack, setSnack] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [nodesVersion, setNodesVersion] = useState(0);

  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const handleEditor = useCallback((editor: MonacoEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  }, []);

  // Selection (for "Add script to selected node" + first-open prefill).
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  useEffect(() => viewer.on('selection-changed', (snap) => setSelectedPath(snap.primaryPath)), [viewer]);

  // Refresh the trust-gate view whenever the panel (re)opens.
  useEffect(() => {
    if (state.open) setAllowed(getScriptPlugin(viewer)?.scriptsAllowed ?? false);
  }, [state.open, viewer]);

  const nodes = useMemo(
    () => (state.open ? listScriptNodes(viewer) : []),
    // nodesVersion bumps after "add script" writes a new WebComponent entry.
    [state.open, viewer, nodesVersion],
  );

  // First open without a picked node: prefer the current selection when it
  // carries a script, else the first scripted node.
  useEffect(() => {
    if (!state.open || state.nodePath !== null) return;
    const preferred = selectedPath !== null && nodes.some((n) => n.path === selectedPath)
      ? selectedPath
      : nodes[0]?.path ?? null;
    if (preferred !== null) setScriptEditorNode(preferred);
  }, [state.open, state.nodePath, nodes, selectedPath]);

  const node = state.nodePath !== null ? findNodeByPath(viewer, state.nodePath) : null;
  const raw = readWebComponentRaw(node);
  const desSafe = raw?.DesSafe === true;
  const apiVersion = typeof raw?.ApiVersion === 'number' ? (raw.ApiVersion as number) : 1;
  const initialCode = readWebComponentCode(node) ?? '';

  // ── Add script to the selected 3D node (v1 entry, §4.6 note) ──
  const canAddToSelection = selectedPath !== null && !nodes.some((n) => n.path === selectedPath);
  const handleAddScript = useCallback(() => {
    if (selectedPath === null) return;
    const store = getSceneStore();
    const applied = applyScriptSave({
      nodePath: selectedPath,
      code: SCRIPT_TEMPLATE,
      prev: undefined,
      store,
      reload: null,     // template only becomes live on the first real save
    });
    if (!store) {
      setSnack('No scene store available — the script will not persist.');
    }
    // Re-list AFTER the async op materialised WebComponent.Code in userData.
    void applied.done.then(() => {
      setNodesVersion((v) => v + 1);
      setScriptEditorNode(selectedPath);
    });
  }, [selectedPath]);

  // ── Save pipeline (§4.3): transpile → validate → setCode op + hot-reload ──
  const handleSave = useCallback(async () => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    const nodePath = getScriptEditorState().nodePath;
    if (!editor || !monaco || !model || nodePath === null) return;
    const currentPlugin = getScriptPlugin(viewer);
    if (!currentPlugin || !currentPlugin.scriptsAllowed) return;   // read-only under the trust gate

    setSaveState('saving');
    try {
      // [4] TS→JS erasure via the Monaco TS worker.
      const transpiled = await transpileModel(monaco, model);
      if (transpiled.syntaxErrors.length > 0) {
        setSaveState('error');
        setSnack(`Not saved — ${transpiled.syntaxErrors.length} syntax error${transpiled.syntaxErrors.length === 1 ? '' : 's'}.`);
        return;
      }

      // [5] Validate BEFORE the swap (parse + DES lint + apiVersion).
      const target = findNodeByPath(viewer, nodePath);
      const targetRaw = readWebComponentRaw(target);
      const validation = validateScriptForSave(transpiled.js, {
        desSafe: targetRaw?.DesSafe === true,
        apiVersion: typeof targetRaw?.ApiVersion === 'number' ? (targetRaw.ApiVersion as number) : 1,
      });
      applyLintMarkers(monaco, editor, validation.diagnostics, 'rv-script-save');
      if (!validation.ok) {
        // Old running code stays, no hot-reload, editor stays dirty (§4.3).
        setSaveState('error');
        const errors = validation.diagnostics.filter((d) => d.severity === 'error');
        setSnack(`Not saved — ${errors.length} validation error${errors.length === 1 ? '' : 's'} (${errors[0]?.message ?? ''}).`);
        return;
      }

      // [6]+[7] setCode op (undoable, coalesced) + COLD hot-reload.
      const result = applyScriptSave({
        nodePath,
        code: transpiled.js,
        prev: readWebComponentCode(target),
        store: getSceneStore(),
        reload: (p, c) => { void currentPlugin.reloadOrCreate(p, c); },
      });
      setDirty(false);
      setSaveState('idle');
      const warnings = validation.diagnostics.filter((d) => d.severity === 'warning').length;
      setSnack(
        result.persisted
          ? warnings > 0
            ? `Saved & reloaded with ${warnings} warning${warnings === 1 ? '' : 's'}.`
            : 'Saved & reloaded.'
          : 'Reloaded (no scene store — the change will not persist).',
      );
    } catch (err) {
      setSaveState('error');
      setSnack(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [viewer]);

  const handleEnableScripts = useCallback(() => {
    getScriptPlugin(viewer)?.setAllowScripts(true);
    setAllowed(true);
  }, [viewer]);

  if (!state.open) return null;

  const headerToolbar = (
    <Box onMouseDown={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 1, minWidth: 0 }}>
      <Select
        size="small"
        value={state.nodePath ?? ''}
        onChange={(e) => { setScriptEditorNode(e.target.value || null); setDirty(false); }}
        displayEmpty
        data-testid="script-node-select"
        sx={{ fontSize: 12, height: 24, minWidth: 160, maxWidth: 260 }}
        MenuProps={{ PaperProps: { sx: { fontFamily: 'inherit' } } }}
      >
        {nodes.length === 0 && (
          <MenuItem value="" disabled sx={{ fontSize: 12 }}>
            No scripted nodes
          </MenuItem>
        )}
        {nodes.map((n) => (
          <MenuItem key={n.path} value={n.path} sx={{ fontSize: 12 }}>
            {n.label}
          </MenuItem>
        ))}
      </Select>
      <Tooltip title={canAddToSelection
        ? `Add a script to the selected node (${selectedPath})`
        : 'Select a node in the 3D view to add a script to it'}
      >
        <span>
          <IconButton
            size="small"
            onClick={handleAddScript}
            disabled={!canAddToSelection}
            sx={{ p: 0.3 }}
            data-testid="script-add"
          >
            <Add sx={{ fontSize: 16 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Save — transpile, validate, hot-reload (Ctrl-S)">
        <span>
          <IconButton
            size="small"
            onClick={() => void handleSave()}
            disabled={!allowed || state.nodePath === null || saveState === 'saving'}
            sx={{ p: 0.3 }}
            data-testid="script-save"
          >
            <Save sx={{ fontSize: 16 }} />
          </IconButton>
        </span>
      </Tooltip>
      <Chip
        size="small"
        label={desSafe ? 'DES-safe' : 'continuous'}
        color={desSafe ? 'success' : 'default'}
        variant="outlined"
        sx={{ height: 18, fontSize: 10, mx: 0.5 }}
        data-testid="script-des-badge"
      />
      {dirty && (
        <Typography sx={{ fontSize: 10, color: '#ffb74d' }} data-testid="script-dirty">
          modified
        </Typography>
      )}
      {saveState === 'error' && (
        <Typography sx={{ fontSize: 10, color: '#ef5350' }}>not saved</Typography>
      )}
    </Box>
  );

  return (
    <>
      <FloatingPanel
        open
        onClose={closeScriptEditor}
        title="Script Editor"
        subtitle={state.nodePath ?? 'no node selected'}
        panelId="script-editor"
        defaultWidth={720}
        defaultHeight={520}
        toolbar={headerToolbar}
      >
        {!allowed && (
          <Box
            sx={{
              flexShrink: 0, display: 'flex', alignItems: 'center', gap: 1,
              px: 1.5, py: 0.75, background: 'rgba(255,167,38,0.12)',
              borderBottom: '1px solid rgba(255,167,38,0.4)',
            }}
            data-testid="script-trust-banner"
          >
            <Typography sx={{ fontSize: 12, color: '#ffb74d', flex: 1 }}>
              Scripting is disabled for this model — the editor is read-only and no component script runs.
            </Typography>
            <Button size="small" variant="outlined" color="warning" onClick={handleEnableScripts} data-testid="script-enable">
              Enable scripting
            </Button>
          </Box>
        )}
        {state.nodePath !== null ? (
          <MonacoHost
            key={`${state.nodePath}::${allowed ? 'rw' : 'ro'}`}
            initialCode={initialCode || SCRIPT_TEMPLATE}
            readOnly={!allowed}
            desSafe={desSafe}
            onEditor={handleEditor}
            onDirty={() => setDirty(true)}
            onSaveShortcut={() => void handleSave()}
          />
        ) : (
          <Typography sx={{ p: 2, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            No node with a WebComponent script in this model. Select a node in the 3D view and use
            the + button to add one.
          </Typography>
        )}
      </FloatingPanel>
      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack ?? ''}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  );
}
