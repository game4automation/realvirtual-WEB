// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-panel-json-context.ts — the Monaco side of the `WebOperatorPanel.Config`
 * inspector field (plan-555), loaded ONLY through `React.lazy` from
 * `WebOperatorPanelHost.tsx` (the host is in the entry chunk; this module and
 * everything it imports — the JSON editor, jsonc-parser, schema, snippets —
 * are not).
 *
 *  - {@link createOperatorPanelJsonContext}: the field context — schema group,
 *    `signal` keys with the SignalStore's signals (read fresh per request),
 *    the six device snippets and the validator's issues as rule markers.
 *  - {@link OperatorPanelJsonEditor}: the {@link RvJsonEditor} for one panel
 *    node in one document (keyed by document id + node path).
 */

import { createElement, useMemo, type ReactNode, type Ref } from 'react';
import type { SignalStore } from '../../engine/rv-signal-store';
import type { EditTarget } from '../rv-edit-target';
import { RvJsonEditor, type JsonCommitResult, type RvJsonEditorHandle } from '../json-editor/RvJsonEditor';
import {
  jsonDocumentId, jsonFieldUri, type JsonFieldContext, type JsonRuleIssue, type JsonSignalInfo,
} from '../json-editor/rv-json-field-context';
import { validateOperatorPanelConfigIssues } from './operator-panel-model';
import { OPERATOR_PANEL_JSON_SCHEMA, OPERATOR_PANEL_SCHEMA_ID } from './operator-panel-json-schema';
import { OPERATOR_PANEL_SNIPPETS } from './operator-panel-snippets';

export { RvJsonEditor, type JsonCommitResult, type RvJsonEditorHandle };

const NOT_FOUND = / not found in model$/;

/** The signals of a store as completion / hover entries. */
export function signalStoreJsonSignals(store: SignalStore): JsonSignalInfo[] {
  const out: JsonSignalInfo[] = [];
  for (const [name, value] of store.getAll()) {
    const meta = store.getSignalMeta(name);
    out.push({ name, value, type: store.getType(name), address: meta?.address, comment: meta?.comment });
  }
  return out;
}

/** The validator's issues of a parsable config text as rule markers; `[]` for text that is not JSON. */
export function operatorPanelRuleIssues(text: string, store: SignalStore | null | undefined): JsonRuleIssue[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const hasSignal = store ? (name: string) => store.get(name) !== undefined : undefined;
  return validateOperatorPanelConfigIssues(raw, hasSignal).issues.map((i) => ({
    path: i.path,
    message: `${i.pathText} ${i.message}`,
    severity: NOT_FOUND.test(i.message) ? 'warning' : 'error',
  }));
}

/** The JSON field context of one `WebOperatorPanel.Config` model. */
export function createOperatorPanelJsonContext(uri: string, store: SignalStore | null | undefined): JsonFieldContext {
  return {
    uri,
    schemaId: OPERATOR_PANEL_SCHEMA_ID,
    schema: OPERATOR_PANEL_JSON_SCHEMA,
    signalKeys: ['signal'],
    signals: store ? () => signalStoreJsonSignals(store) : undefined,
    snippets: OPERATOR_PANEL_SNIPPETS,
    validate: (text) => operatorPanelRuleIssues(text, store),
  };
}

export interface OperatorPanelJsonEditorProps {
  nodePath: string;
  /** The stored `Config` text. */
  value: string;
  /** The text the editor starts with (what was typed in the fallback). */
  initialText: string;
  signalStore: SignalStore | null | undefined;
  /** The active document (`EditTarget.documentKey ?? target`). */
  documentKey: object;
  onCommit(text: string, target: EditTarget): JsonCommitResult;
  onTextChange(text: string): void;
  onLoadError(error: unknown): void;
  fallback: ReactNode;
  handleRef?: Ref<RvJsonEditorHandle | null>;
}

/** The Monaco editor of a `WebOperatorPanel.Config` field. */
export function OperatorPanelJsonEditor(props: OperatorPanelJsonEditorProps) {
  const docId = jsonDocumentId(props.documentKey);
  const uri = jsonFieldUri('WebOperatorPanel', 'Config', docId, props.nodePath);
  const context = useMemo(() => createOperatorPanelJsonContext(uri, props.signalStore), [uri, props.signalStore]);
  return createElement(RvJsonEditor, {
    key: `${docId}|${props.nodePath}`,
    context,
    value: props.value,
    initialText: props.initialText,
    onCommit: props.onCommit,
    onTextChange: props.onTextChange,
    onLoadError: props.onLoadError,
    fallback: props.fallback,
    testId: 'rv-web-operator-panel-config-editor',
    alertLabel: 'Operator panel configuration',
    ariaLabel: 'Operator panel config (JSON)',
    expandTitle: `Operator panel config — ${props.nodePath.split('/').pop() || props.nodePath}`,
    handleRef: props.handleRef,
  });
}
