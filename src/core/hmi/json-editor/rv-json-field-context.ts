// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-json-field-context.ts — what the JSON field editor knows per field
 * (plan-555), keyed by the Monaco model URI. No Monaco import.
 *
 * Monaco's completion / hover providers are global per LANGUAGE, so the JSON
 * loader registers exactly one of each for 'json' and looks the field up here
 * by `model.uri`:
 *
 *  - {@link JsonFieldContext}: schema group, signal keys + a signal getter
 *    (read fresh on every completion request), snippets and the field's own
 *    validation. Registered by the editor while it is mounted (refcounted —
 *    an inline editor and its expand window share one URI).
 *  - {@link JsonFieldState}: ONE per URI, shared by every editor of that
 *    model — the last confirmed store value, the conflict flag, the pending
 *    write (dedupe) and the editor refcount (model dispose).
 *  - Drafts: text that was not applied when the editor went away (invalid
 *    JSON, target gone, document switched, write rejected) — restored on the
 *    next mount of the same URI, for the rest of the session.
 *
 * URIs: `rv-json://<componenttype>.<fieldname>/<docId>/<encoded nodePath>.json`
 * (see {@link jsonFieldUri}). The document id keeps two documents with the
 * same node path apart; the schema of a group matches every URI of its
 * authority with ONE `fileMatch` entry.
 */

/** A signal as offered by completion / hover. */
export interface JsonSignalInfo {
  name: string;
  /** PLC type when the store knows it — never guessed. */
  type?: string;
  value?: unknown;
  address?: string;
  comment?: string;
}

/** An insertable snippet for an array element (e.g. a button in `buttons`). */
export interface JsonSnippet {
  /** The array property whose elements it creates, e.g. `buttons`. */
  arrayKey: string;
  label: string;
  detail: string;
  /** Monaco snippet syntax (`${1:Start}`), a JSON object literal. */
  body: string;
}

/** A field-specific problem at a JSON path. */
export interface JsonRuleIssue {
  path: (string | number)[];
  message: string;
  severity: 'error' | 'warning';
}

/** Everything the JSON language features need to know about one field. */
export interface JsonFieldContext {
  /** The Monaco model URI (from {@link jsonFieldUri}). */
  uri: string;
  /** Schema group; ONE schema per group, matched by the URI authority. */
  schemaId?: string;
  schema?: object;
  /** Property names whose string VALUE is a signal name, e.g. `['signal']`. */
  signalKeys?: readonly string[];
  /** The signals, read fresh on every completion / hover request. */
  signals?: () => readonly JsonSignalInfo[];
  snippets?: readonly JsonSnippet[];
  /** The field's rules (markers, owner `rv-json-rules`); only called for parsable JSON. */
  validate?: (text: string) => JsonRuleIssue[];
}

/** One per URI, shared by the inline editor and its expand window. */
export interface JsonFieldState {
  /** Last CONFIRMED store value (from the prop) — never set optimistically. */
  lastApplied: string;
  /** The store changed while the text was dirty. */
  conflict: boolean;
  /** Last commit error for the current text. */
  lastError?: string;
  /** Text of a write that has not come back through the prop yet (dedupe). */
  pending?: string;
  /** Mounted editors on this model (dispose at 0). */
  editors: number;
}

// ─── URIs ──────────────────────────────────────────────────────────────

const DOC_IDS = new WeakMap<object, number>();
let nextDocId = 1;

/** A stable, session-local id for a document instance (an edit target's `documentKey`). */
export function jsonDocumentId(documentKey: object): number {
  let id = DOC_IDS.get(documentKey);
  if (id === undefined) {
    id = nextDocId++;
    DOC_IDS.set(documentKey, id);
  }
  return id;
}

/** The scheme of every JSON field model. */
export const JSON_FIELD_SCHEME = 'rv-json';

/** The URI authority of a field (lower case — URIs normalise it). */
export function jsonFieldAuthority(componentType: string, fieldName: string): string {
  return `${componentType}.${fieldName}`.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

/**
 * A node path as ONE URI path segment of unreserved characters only: every
 * byte outside `[A-Za-z0-9_.-]` becomes `~<hex>`. Injective, and Monaco's URI
 * printing leaves it untouched — so the URI string built here IS
 * `monaco.Uri.parse(uri).toString()`, before Monaco is even loaded.
 */
export function encodeJsonUriSegment(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.-]/.test(c) && byte < 0x80 ? c : `~${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Inverse of {@link encodeJsonUriSegment}. */
export function decodeJsonUriSegment(segment: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === '~') {
      bytes.push(parseInt(segment.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(segment.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The model URI of a field in a document:
 * `rv-json://<componenttype>.<fieldname>/<docId>/<encoded nodePath>.json`.
 */
export function jsonFieldUri(componentType: string, fieldName: string, docId: number, nodePath: string): string {
  return `${JSON_FIELD_SCHEME}://${jsonFieldAuthority(componentType, fieldName)}/${docId}/${encodeJsonUriSegment(nodePath)}.json`;
}

// ─── Contexts ──────────────────────────────────────────────────────────

const contexts = new Map<string, { context: JsonFieldContext; refs: number }>();
const schemaListeners = new Set<() => void>();
let schemaSignature = '';

/** Registers (or refreshes) a field context; the returned function releases it. */
export function registerJsonFieldContext(context: JsonFieldContext): () => void {
  const entry = contexts.get(context.uri);
  if (entry) {
    entry.refs++;
    entry.context = context;
  } else {
    contexts.set(context.uri, { context, refs: 1 });
  }
  notifySchemasIfChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const e = contexts.get(context.uri);
    if (!e) return;
    e.refs--;
    if (e.refs <= 0) contexts.delete(context.uri);
    notifySchemasIfChanged();
  };
}

/** The context of a model URI, if a field editor registered one. */
export function getJsonFieldContext(uri: string): JsonFieldContext | undefined {
  return contexts.get(uri)?.context;
}

/** A schema association for `monaco.json.jsonDefaults` (one per schema group). */
export interface JsonSchemaAssociation {
  uri: string;
  fileMatch: string[];
  schema: object;
}

function authorityOf(uri: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)/i.exec(uri);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Every schema of the registered contexts, ONE per `schemaId` with a wildcard
 * `fileMatch` over the URIs of its authority — set as the complete list on
 * every change (Monaco replaces the whole list).
 */
export function allJsonSchemas(): JsonSchemaAssociation[] {
  const byId = new Map<string, { schema: object; authorities: Set<string> }>();
  for (const { context } of contexts.values()) {
    if (!context.schemaId || !context.schema) continue;
    let e = byId.get(context.schemaId);
    if (!e) {
      e = { schema: context.schema, authorities: new Set() };
      byId.set(context.schemaId, e);
    }
    e.authorities.add(authorityOf(context.uri));
  }
  return [...byId.entries()].map(([id, e]) => ({
    uri: `${JSON_FIELD_SCHEME}-schema://${encodeURIComponent(id)}/schema.json`,
    fileMatch: [...e.authorities].map((a) => `${JSON_FIELD_SCHEME}://${a}/**`),
    schema: e.schema,
  }));
}

function notifySchemasIfChanged(): void {
  const sig = allJsonSchemas().map((s) => `${s.uri}|${s.fileMatch.join(',')}`).join(';');
  if (sig === schemaSignature) return;
  schemaSignature = sig;
  for (const fn of schemaListeners) fn();
}

/** Subscribe to schema-list changes (the loader re-sets the diagnostics options). */
export function subscribeJsonSchemas(fn: () => void): () => void {
  schemaListeners.add(fn);
  return () => { schemaListeners.delete(fn); };
}

// ─── Field state + drafts ──────────────────────────────────────────────

const states = new Map<string, JsonFieldState>();
const drafts = new Map<string, string>();

/** The shared state of a URI, created with `lastApplied` on first use. */
export function getJsonFieldState(uri: string, lastApplied: string): JsonFieldState {
  let s = states.get(uri);
  if (!s) {
    s = { lastApplied, conflict: false, editors: 0 };
    states.set(uri, s);
  }
  return s;
}

/** Forgets the state of a URI (its model was disposed). */
export function dropJsonFieldState(uri: string): void {
  states.delete(uri);
}

/** Keeps a text that was not applied, for the next mount of `uri`. */
export function setJsonDraft(uri: string, text: string): void {
  drafts.set(uri, text);
}

/** Takes (and removes) the draft of `uri`. */
export function takeJsonDraft(uri: string): string | undefined {
  const d = drafts.get(uri);
  drafts.delete(uri);
  return d;
}

/** True when a draft is waiting for `uri`. */
export function hasJsonDraft(uri: string): boolean {
  return drafts.has(uri);
}

/** Monaco normalises line ends when it creates a model; compare texts after this. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Test seam: forgets every context, state and draft. */
export function resetJsonFieldRegistryForTest(): void {
  contexts.clear();
  states.clear();
  drafts.clear();
  schemaSignature = '';
  for (const fn of schemaListeners) fn();
}
