// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * WebOperatorPanelHost — the React side of the `WebOperatorPanel` component
 * (plan-543).
 *
 *  - {@link WebOperatorPanelWindows}: the overlay that renders ONE operator
 *    window ({@link OperatorPanel}) per entry of the viewer's
 *    `webOperatorPanels` host — main model and placements. Re-renders when a
 *    component is added, edited or removed; nothing per frame.
 *  - {@link WEB_OPERATOR_PANEL_UI}: the overlay slot the viewer registers the
 *    first time a model carries a panel (dynamic import — a model without one
 *    never loads this module through the viewer).
 *  - {@link WebOperatorPanelConfigField}: the inspector editor of `Config` — a
 *    Monaco JSON editor on mouse/keyboard devices (plan-555, loaded lazily
 *    through `./operator-panel-json-context`), the multi-line monospace text
 *    field on touch devices / with the dev flag; validated on blur with the
 *    same messages the window and the Problems panel show; invalid JSON is
 *    never applied. Self-registers with the field renderer registry on import
 *    (App.tsx) — so nothing of the editor may be imported here statically.
 */

import {
  Component, Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import { Box, TextField } from '@mui/material';
import type { UISlotEntry, UISlotProps } from '../../rv-ui-plugin';
import { fieldRendererRegistry, type FieldRendererProps } from '../rv-field-renderer-registry';
import { persistFieldOp } from '../scene/scene-field-ops';
import {
  getActiveEditTarget, getEditTargetVersion, subscribeEditTarget, type EditTarget,
} from '../rv-edit-target';
import { useTouchDevice } from '../../../hooks/use-mobile-layout';
import { isJsonEditorEnabled } from '../../engine/rv-dev-load-flags';
import { FS, INK_MID, MONO, WARN, inspectorInputSx } from '../shared-sx';
import {
  WEB_OPERATOR_PANEL_TYPE, type WebOperatorPanelEntry, type WebOperatorPanelHost,
} from '../../engine/rv-web-operator-panel';
import { parseWebOperatorPanelConfig, webOperatorPanelRuleWarnings } from '../../engine/rv-extras-validator';
import { OperatorPanel } from './OperatorPanel';

// ─── Windows ───────────────────────────────────────────────────────────

/** Default window width when the config gives none (as `OperatorPanel`). */
const DEFAULT_WIDTH = 300;
/** Margin of a docked window from the screen edge, px. */
const DOCK_MARGIN_X = 80;
const DOCK_MARGIN_Y = 100;
/** Assumed window height for the bottom docks, px (the operator panel stays ≤ 400). */
const DOCK_HEIGHT = 420;
/** Each further window in the same dock is offset by one title bar. */
const STACK_DX = 24;
const STACK_DY = 48;

/**
 * Where an entry's window first appears: the config's `position` when it has
 * one, else its `Dock` corner, stacked by `dockIndex` so every title bar of a
 * corner stays reachable.
 */
export function dockPosition(
  entry: Pick<WebOperatorPanelEntry, 'dock' | 'dockIndex' | 'controller'>,
  viewport: { w: number; h: number },
): { x: number; y: number } {
  const config = entry.controller.config;
  if (config?.position) return config.position;
  const width = config?.width ?? DEFAULT_WIDTH;
  const i = entry.dockIndex;
  const left = entry.dock.endsWith('left');
  const top = entry.dock.startsWith('top');
  const x = left ? DOCK_MARGIN_X + i * STACK_DX : viewport.w - width - DOCK_MARGIN_X - i * STACK_DX;
  const y = top ? DOCK_MARGIN_Y + i * STACK_DY : viewport.h - DOCK_HEIGHT - i * STACK_DY;
  return { x: Math.max(8, Math.round(x)), y: Math.max(8, Math.round(y)) };
}

const NO_ENTRIES: readonly WebOperatorPanelEntry[] = [];
const NOOP_SUBSCRIBE = () => () => {};

/** One operator window per `WebOperatorPanel` of the loaded model. */
export function WebOperatorPanelWindows({ viewer }: UISlotProps) {
  const host = (viewer as { webOperatorPanels?: WebOperatorPanelHost } | null | undefined)?.webOperatorPanels;
  const entries = useSyncExternalStore(host?.subscribe ?? NOOP_SUBSCRIBE, host?.getEntries ?? (() => NO_ENTRIES));
  if (entries.length === 0) return null;
  const viewport = { w: typeof window === 'undefined' ? 1600 : window.innerWidth, h: typeof window === 'undefined' ? 1000 : window.innerHeight };
  return (
    <>
      {entries.map((e) => (
        <OperatorPanel
          key={e.panelId}
          viewer={viewer}
          panelId={e.panelId}
          source={e.controller}
          title={e.title}
          defaultPosition={dockPosition(e, viewport)}
          defaultCollapsed={e.startCollapsed}
        />
      ))}
    </>
  );
}

/** Overlay slot of the operator windows (registered by the viewer on demand). */
export const WEB_OPERATOR_PANEL_UI: { id: string; slots: UISlotEntry[] } = {
  id: 'web-operator-panels',
  // A visibilityId and deliberately NO rule: the windows are how a station is
  // operated, so they stay in every mode, the plain viewer included (plan-542).
  slots: [{ slot: 'overlay', component: WebOperatorPanelWindows, order: 100, visibilityId: 'web-operator-panels' }],
};

// ─── Inspector field: Config ───────────────────────────────────────────

/** The JSON of a stored `Config` value, pretty-printed when it was stored as an object. */
function configText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return '';
}

/** What committing a `Config` text did (the shape the JSON editor expects). */
export interface OperatorPanelConfigCommit {
  /** True when the text was handed to the edit target. */
  applied: boolean;
  /** Parse errors + "Not applied" when not applied; the validation messages when applied. */
  messages: string[];
  /** Settles when the write was applied (resolve) or refused (reject) — only with an awaitable target. */
  done?: Promise<void>;
}

/**
 * Commits a `Config` text: text that is not JSON is NOT applied (parse error
 * + "Not applied — fix the JSON first."); JSON is written and its validation
 * messages returned. With `target` (the JSON editor's target, captured at
 * mount) the write goes through `setFieldAsync` when it has one, an
 * unavailable target is `applied: false`; without it the write goes through
 * the active edit target via `persistFieldOp`, as the text field always did.
 */
export function commitOperatorPanelConfig(
  text: string,
  prev: unknown,
  nodePath: string,
  signalStore: FieldRendererProps['signalStore'],
  target?: EditTarget,
): OperatorPanelConfigCommit {
  const parsed = parseWebOperatorPanelConfig(text);
  if (text.trim() !== '' && parsed.errors.length > 0) {
    return { applied: false, messages: [...parsed.errors, 'Not applied — fix the JSON first.'] };
  }
  const messages = text.trim() === '' ? [] : webOperatorPanelRuleWarnings(
    text, signalStore ? (name) => signalStore.get(name) !== undefined : undefined,
  );
  if (!target) {
    if (text !== configText(prev)) persistFieldOp(nodePath, WEB_OPERATOR_PANEL_TYPE, 'Config', text, prev);
    return { applied: true, messages };
  }
  if (!target.available) return { applied: false, messages: ['Not applied — no document accepts edits right now.'] };
  if (target.setFieldAsync) {
    return { applied: true, messages, done: target.setFieldAsync(nodePath, WEB_OPERATOR_PANEL_TYPE, 'Config', text, prev) };
  }
  target.setField(nodePath, WEB_OPERATOR_PANEL_TYPE, 'Config', text, prev);
  return { applied: true, messages };
}

interface ConfigTextFieldProps {
  value: unknown;
  nodePath: string;
  signalStore: FieldRendererProps['signalStore'];
  /** The field text, owned by {@link WebOperatorPanelConfigField} (shared with the JSON editor). */
  local: string;
  setLocal(text: string): void;
  /** Re-sync the text when the stored value changes (the plain text-field path only). */
  resync: boolean;
  /** Rendered inside the JSON editor's frame (no own padding). */
  embedded?: boolean;
}

/**
 * The plain text field: a monospace multi-line JSON field, applied on blur or
 * Ctrl/Cmd+Enter. Used on touch devices, with the dev flag
 * `rv-webviewer-json-editor = 0`, while the JSON editor loads and when it
 * cannot load.
 */
function ConfigTextField({ value, nodePath, signalStore, local, setLocal, resync, embedded = false }: ConfigTextFieldProps) {
  const text = configText(value);
  const [messages, setMessages] = useState<string[]>([]);

  // Re-sync on selection change, undo/redo and MCP writes — on a CHANGE of the
  // stored text only, so a text typed before this field mounted survives.
  const lastText = useRef(text);
  useEffect(() => {
    if (lastText.current === text) return;
    lastText.current = text;
    if (resync) setLocal(text);
  }, [text, resync, setLocal]);

  const commit = (): void => {
    setMessages(commitOperatorPanelConfig(local, value, nodePath, signalStore).messages);
  };

  return (
    <Box data-testid="rv-web-operator-panel-config" sx={{ px: embedded ? 0 : 1, py: embedded ? 0 : 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <TextField
        multiline
        minRows={4}
        maxRows={16}
        size="small"
        value={local}
        placeholder='{ "version": 1, "id": "my-panel", "title": "Operator panel", … }'
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit();
        }}
        slotProps={{
          htmlInput: { 'data-testid': 'rv-web-operator-panel-config-input', spellCheck: false },
          input: { sx: { fontSize: FS.label, fontFamily: MONO } },
        }}
        sx={{ width: '100%', '& .MuiOutlinedInput-root': { ...inspectorInputSx, height: 'auto' } }}
      />
      {messages.length > 0 && (
        <Box
          role="alert"
          aria-label="Operator panel configuration"
          component="ul"
          sx={{ m: 0, pl: 2, fontSize: FS.label, color: INK_MID, '& li::marker': { color: WARN } }}
        >
          {messages.slice(0, 8).map((m) => <li key={m}>{m}</li>)}
          {messages.length > 8 && <li>… and {messages.length - 8} more</li>}
        </Box>
      )}
    </Box>
  );
}

/** The Monaco JSON editor — its own chunk; the host never imports it statically (plan-555). */
const LazyOperatorPanelJsonEditor = lazy(() => import('./operator-panel-json-context')
  .then((m) => ({ default: m.OperatorPanelJsonEditor })));

/** A chunk that cannot load degrades to the plain text field, never to a broken inspector. */
class JsonEditorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    console.warn('[WebOperatorPanel] JSON editor failed — using the plain text field.', error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Edits `WebOperatorPanel.Config`. With mouse and keyboard: a Monaco JSON
 * editor (plan-555) — schema completion, signal names from the model, device
 * snippets, problems at their place in the text, an expand window — applied
 * on blur or Ctrl/Cmd+Enter. On touch devices, with the dev flag
 * `rv-webviewer-json-editor = 0` or when Monaco cannot load: the plain text
 * field. Either way text that is not JSON is never written, and the
 * validation messages (structure, unknown signals with their path) are listed
 * under the field.
 */
export function WebOperatorPanelConfigField({ value, nodePath, signalStore }: FieldRendererProps) {
  const text = configText(value);
  const touch = useTouchDevice();
  const [jsonEditorEnabled] = useState(isJsonEditorEnabled);
  const [monacoFailed, setMonacoFailed] = useState(false);

  useSyncExternalStore(subscribeEditTarget, getEditTargetVersion);
  const target = getActiveEditTarget();
  const documentKey: object = target.documentKey ?? target;

  // The text shared by the text field and the editor; reset only when the
  // node or the document changes — stored-value changes reach the editor
  // through its dirty rule, never by overwriting this.
  const [draftText, setDraftText] = useState(text);
  const [owner, setOwner] = useState({ nodePath, documentKey });
  if (owner.nodePath !== nodePath || owner.documentKey !== documentKey) {
    setOwner({ nodePath, documentKey });
    setDraftText(text);
  }

  const fieldProps = { value, nodePath, signalStore, local: draftText, setLocal: setDraftText };
  if (touch || !jsonEditorEnabled || monacoFailed) return <ConfigTextField {...fieldProps} resync />;

  const fallback = <ConfigTextField {...fieldProps} resync={false} embedded />;
  return (
    <Box sx={{ px: 1, py: 0.5 }}>
      <JsonEditorBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <LazyOperatorPanelJsonEditor
            nodePath={nodePath}
            value={text}
            initialText={draftText}
            signalStore={signalStore}
            documentKey={documentKey}
            onCommit={(t, editTarget) => commitOperatorPanelConfig(t, value, nodePath, signalStore, editTarget)}
            onTextChange={setDraftText}
            onLoadError={() => setMonacoFailed(true)}
            fallback={fallback}
          />
        </Suspense>
      </JsonEditorBoundary>
    </Box>
  );
}

fieldRendererRegistry.register({
  componentType: WEB_OPERATOR_PANEL_TYPE,
  fieldName: 'Config',
  component: WebOperatorPanelConfigField,
});
