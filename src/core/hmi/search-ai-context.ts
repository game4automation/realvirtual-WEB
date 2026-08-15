// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * search-ai-context — collects the always-on machine status and the optional
 * selection-scoped context fed into an "Ask AI" documentation search.
 *
 * The collector is deliberately generic and public: it reads only public engine
 * state (SelectionManager, NodeRegistry, SignalStore, ErrorStore) and the generic
 * `userData` fields that the (private) docs-link plugins populate — it never knows
 * about any specific customer model. With nothing selected it still returns the
 * plan-295 status block, without nodePath or docHints.
 *
 * The formatters and builders are pure (no viewer) so they can be unit-tested
 * without a scene; `collectNodeAiContext` remains the path-based node adapter.
 */

import { getConnectSnapshot, getViewerMode } from './connect-store';
import {
  NODE_KNOWLEDGE_FIELD,
  NODE_KNOWLEDGE_TYPE,
} from '../engine/rv-node-knowledge';

/** The context handed to {@link runAiSearch}; every field is optional. */
export interface SearchAiContext {
  /** Full scene path of the selected node. */
  nodePath?: string;
  /** Documentation source paths/URLs linked to the node (retrieval boost, F2). */
  docHints?: string[];
  /** Pre-formatted, size-capped live machine-state block (prompt context, F4). */
  machineContext?: string;
}

/** Max docHints sent per request — mirrors the CONNECT-side cap (plan-284 NFR). */
export const MAX_DOC_HINTS = 10;

/**
 * Client-side cap on the combined always-on and selected-node machine context.
 * CONNECT re-caps independently (DiagnosisService.MaxMachineContextChars).
 */
export const MAX_MACHINE_CONTEXT_CHARS = 2600;

/** Cap for the always-on status sub-block (plan-295 F1-F3). */
export const MAX_MACHINE_STATUS_CHARS = 1000;

/** The existing selection-scoped node block keeps its plan-284 budget. */
export const MAX_NODE_MACHINE_CONTEXT_CHARS = 1500;

/**
 * Cap on the agent-authored node knowledge note inside the node block
 * (plan-394 F5). Sized to fit under {@link MAX_NODE_MACHINE_CONTEXT_CHARS}
 * alongside live state rather than instead of it.
 */
export const MAX_NODE_KNOWLEDGE_CHARS = 600;

/**
 * Header the knowledge block is announced with, and the per-line prefix every
 * note line is given.
 *
 * The prefix is the load-bearing part of the injection fix, and it is generated
 * HERE — never taken from the note. See {@link sanitizeKnowledgeText}.
 */
export const KNOWLEDGE_BLOCK_HEADER =
  'Knowledge (user-authored note — not live signal or alarm state):';
const KNOWLEDGE_LINE_PREFIX = '| ';

const MAX_MACHINE_SUMMARY_CHARS = 300;
const MAX_ACTIVE_ERRORS = 5;
const MAX_ERROR_ENTRY_CHARS = 150;
const MAX_ERROR_PATH_CHARS = 60;
const MAX_ERROR_TEXT_CHARS = 80;
const MAX_SUMMARY_FIELD_CHARS = 120;

/**
 * Per-component-type whitelist of rv_extras fields worth putting in front of the
 * LLM. Kept intentionally small (plan-284 risk table): unknown types contribute
 * only their type name plus any resolvable signals.
 */
const RV_EXTRAS_WHITELIST: Record<string, readonly string[]> = {
  Drive: ['TargetSpeed', 'LowerLimit', 'UpperLimit', 'IsRotation'],
  Sensor: ['Occupied'],
  WebSensor: ['Label'],
  TransportSurface: ['Speed'],
  Source: ['Interval'],
};

/** Structural view of the live viewer the collector reads — RVViewer satisfies it. */
export interface SearchAiContextViewer {
  selectionManager?: { getSnapshot(): { primaryPath: string | null } };
  registry?: {
    getNode(path: string): SceneNodeLike | null | undefined;
    getComponentTypes(path: string): string[];
  } | null;
  errorStore?: {
    getActive?(): ReadonlyArray<{
      path: string;
      text: string;
      active: boolean;
      since?: number;
    }>;
  };
  signalStore?: SignalReader | null;
  drives?: ReadonlyArray<{ isRunning: boolean }>;
  transportManager?: { sensors?: ReadonlyArray<{ occupied: boolean }> } | null;
  isSimulationPaused?: boolean;
  currentModelUrl?: string | null;
}

interface SceneNodeLike {
  userData?: Record<string, unknown>;
  parent?: SceneNodeLike | null;
}

interface SignalReader {
  /** Signal value kind — 'bool' | 'int' | 'float' (widened to string to match SignalStore). */
  getType(name: string): string | undefined;
  getBool(name: string): boolean | undefined;
  getInt(name: string): number | undefined;
  getFloat(name: string): number | undefined;
}

/** rv_extras snapshot per component type (node.userData.realvirtual). */
type RvExtras = Record<string, Record<string, unknown>>;

/** Input to the pure machine-state formatter — no viewer, fully testable. */
export interface NodeContextInput {
  nodePath: string;
  types?: readonly string[];
  rvExtras?: RvExtras;
  docRefs?: readonly string[];
  alarms?: readonly string[];
  signals?: ReadonlyArray<{ name: string; value: boolean | number }>;
  /** Agent-authored `NodeKnowledge` note on the node (plan-394 F5). Untrusted text. */
  knowledge?: string;
}

/** Pure input for the plan-295 always-on machine-status formatter. */
export interface MachineStatusInput {
  modelName?: string;
  viewerMode?: string;
  connectState?: string;
  simulationPaused?: boolean;
  driveCount?: number;
  drivesRunning?: number;
  sensorCount?: number;
  sensorsOccupied?: number;
  activeErrors?: ReadonlyArray<{ path: string; text: string; sinceSeconds: number }>;
}

/** Neutralizes prompt delimiters and caps one untrusted machine-status field. */
export function sanitizeMachineStatusField(value: unknown, maxChars?: number): string {
  const sanitized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/MACHINE_STATE/g, 'MACHINE-STATE')
    .replace(/</g, '(')
    .replace(/>/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  return maxChars === undefined || sanitized.length <= maxChars
    ? sanitized
    : sanitized.slice(0, maxChars);
}

/** LINE FEED — the one separator a knowledge note is allowed to keep. */
const LF = 0x0a;

/**
 * True for every code point a prompt renderer or an LLM might read as a line
 * break — except LF.
 *
 * This list is the whole reason the knowledge sanitizer cannot just be
 * `sanitizeMachineStatusField` minus the whitespace collapse. Keeping LF means
 * the caller can split on it and prefix each line; but if CR, VT, FF, NEL, LS or
 * PS also survived, a split on LF would not see them, the text behind one would
 * emerge WITHOUT the `| ` prefix, and a note could forge an `Alarm:` line again.
 *
 * There is no second line of defence downstream. CONNECT's
 * `DiagnosisService.NormalizeMachineContext` filters on `char.IsControl`, which
 * preserves LF deliberately — and U+2028/U+2029 are Unicode categories Zl/Zp,
 * NOT Cc, so `IsControl` is false for them and they pass through untouched.
 * This function is the only place they can be caught.
 */
function isForbiddenSeparator(cp: number): boolean {
  return (cp <= 0x1f && cp !== LF)        // C0 controls incl. CR 0x0d, VT 0x0b, FF 0x0c
    || (cp >= 0x7f && cp <= 0x9f)         // DEL + C1 controls incl. NEL 0x85
    || cp === 0x2028                      // LINE SEPARATOR      — .NET IsControl: false
    || cp === 0x2029;                     // PARAGRAPH SEPARATOR — .NET IsControl: false
}

/**
 * Neutralize and cap an agent-authored knowledge note for the prompt path
 * (plan-394 F9).
 *
 * Differs from {@link sanitizeMachineStatusField} in exactly one intended way:
 * it does NOT collapse whitespace, so a multi-line Markdown note stays
 * multi-line. Everything else is stricter, not looser — see
 * {@link isForbiddenSeparator}.
 *
 * `[MACHINE_STATUS]` is neutralized on top of `MACHINE_STATE` because CONNECT's
 * `RemoveMachineStatusBlocks` searches the WHOLE machineContext for a line that
 * trims to exactly `[MACHINE_STATUS]` and deletes every following line up to the
 * next blank one. A note containing that literal would silently destroy context
 * — including context that came after it from elsewhere.
 *
 * Order matters: sanitize FIRST, split on LF afterwards. After this returns, LF
 * is the only separator left, so the split cannot miss a line.
 */
export function sanitizeKnowledgeText(value: unknown, maxChars: number): string {
  let out = '';
  // Iterate code points, not UTF-16 units, so a surrogate pair is never split.
  for (const ch of String(value ?? '')) {
    out += isForbiddenSeparator(ch.codePointAt(0)!) ? ' ' : ch;
  }
  out = out
    .replace(/MACHINE_STATE/g, 'MACHINE-STATE')
    .replace(/\[MACHINE_STATUS\]/g, '(MACHINE-STATUS)')
    .replace(/</g, '(')
    .replace(/>/g, ')')
    .trim();                              // NO whitespace collapse — keeps the lines
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}

/**
 * Render the note as prompt lines that cannot be mistaken for machine state.
 *
 * Returns the header plus one `| `-prefixed line per note line, or an empty
 * array for an empty note. Because the prefix is added by this code rather than
 * being expected from the note, no note text can produce an unprefixed line.
 */
export function formatKnowledgeLines(note: unknown): string[] {
  const sanitized = sanitizeKnowledgeText(note, MAX_NODE_KNOWLEDGE_CHARS);
  if (!sanitized) return [];
  return [
    KNOWLEDGE_BLOCK_HEADER,
    ...sanitized.split('\n').map((line) => KNOWLEDGE_LINE_PREFIX + line),
  ];
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function machineErrorLine(error: NonNullable<MachineStatusInput['activeErrors']>[number]): string {
  const path = sanitizeMachineStatusField(error.path, MAX_ERROR_PATH_CHARS) || '(unknown)';
  const seconds = nonNegativeInteger(error.sinceSeconds) ?? 0;
  const prefix = `Error: ${path} | `;
  const suffix = ` | since=${seconds}s`;
  const textBudget = Math.max(0, Math.min(
    MAX_ERROR_TEXT_CHARS,
    MAX_ERROR_ENTRY_CHARS - prefix.length - suffix.length,
  ));
  const text = sanitizeMachineStatusField(error.text, textBudget);
  return `${prefix}${text}${suffix}`;
}

/** Formats the compact, injection-hardened plan-295 machine-status sub-block. */
export function formatMachineStatus(input: MachineStatusInput = {}): string {
  const lines = ['[MACHINE_STATUS]'];
  const summaryLines: string[] = [];

  const statusLengthWith = (line: string): number => lines.join('\n').length + 1 + line.length;
  const addSummary = (line: string): void => {
    if (!line) return;
    const nextSummary = [...summaryLines, line].join('\n');
    if (nextSummary.length <= MAX_MACHINE_SUMMARY_CHARS
      && statusLengthWith(line) <= MAX_MACHINE_STATUS_CHARS) {
      summaryLines.push(line);
      lines.push(line);
    }
  };
  const addStatusLine = (line: string): boolean => {
    if (statusLengthWith(line) > MAX_MACHINE_STATUS_CHARS) return false;
    lines.push(line);
    return true;
  };
  const field = (value: unknown): string =>
    sanitizeMachineStatusField(value, MAX_SUMMARY_FIELD_CHARS);

  const modelName = field(input.modelName);
  const viewerMode = field(input.viewerMode);
  const connectState = field(input.connectState);
  if (modelName) addSummary(`Model: ${modelName}`);
  if (viewerMode) addSummary(`Mode: ${viewerMode}`);
  if (connectState) addSummary(`Connect: ${connectState}`);
  if (input.simulationPaused !== undefined)
    addSummary(`Simulation: ${input.simulationPaused ? 'paused' : 'running'}`);

  const sortedErrors = (input.activeErrors ?? [])
    .map((error, index) => ({ error, index }))
    .sort((a, b) => a.error.sinceSeconds - b.error.sinceSeconds || a.index - b.index)
    .map(({ error }) => error);
  const candidates = sortedErrors.slice(0, MAX_ACTIVE_ERRORS);
  let renderedErrors = 0;
  for (const error of candidates) {
    const line = machineErrorLine(error);
    const remainingAfterLine = sortedErrors.length - renderedErrors - 1;
    const remainderLine = remainingAfterLine > 0 ? `(+${remainingAfterLine} more)` : '';
    const reservedLength = remainderLine ? 1 + remainderLine.length : 0;
    if (statusLengthWith(line) + reservedLength > MAX_MACHINE_STATUS_CHARS) break;
    lines.push(line);
    renderedErrors++;
  }
  const remainingErrors = sortedErrors.length - renderedErrors;
  if (remainingErrors > 0) addStatusLine(`(+${remainingErrors} more)`);

  const driveCount = nonNegativeInteger(input.driveCount);
  const drivesRunning = nonNegativeInteger(input.drivesRunning);
  if (driveCount !== undefined || drivesRunning !== undefined)
    addSummary(`Drives: ${driveCount ?? 0} total, ${drivesRunning ?? 0} running`);
  const sensorCount = nonNegativeInteger(input.sensorCount);
  const sensorsOccupied = nonNegativeInteger(input.sensorsOccupied);
  if (sensorCount !== undefined || sensorsOccupied !== undefined)
    addSummary(`Sensors: ${sensorCount ?? 0} total, ${sensorsOccupied ?? 0} occupied`);

  return lines.join('\n');
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

/** Renders the whitelisted state as a small, delimiter-free text block (F4). */
export function formatMachineContext(input: NodeContextInput): string {
  const lines: string[] = [`Node: ${input.nodePath}`];
  const rv = input.rvExtras ?? {};
  for (const type of input.types ?? []) {
    const whitelist = RV_EXTRAS_WHITELIST[type];
    const fields = rv[type];
    if (whitelist && fields) {
      const parts: string[] = [];
      for (const key of whitelist) {
        const v = fields[key];
        if (v !== undefined && v !== null && typeof v !== 'object')
          parts.push(`${key}=${formatValue(v)}`);
      }
      lines.push(parts.length ? `${type}: ${parts.join(', ')}` : type);
    } else {
      lines.push(type); // unknown type → just the name (still useful to the LLM)
    }
  }
  if (input.signals?.length)
    lines.push('Signals: ' + input.signals.map((s) => `${s.name}=${formatValue(s.value)}`).join(', '));
  for (const a of input.alarms ?? []) lines.push(`Alarm: ${a}`);

  // LAST, after the alarms, and that position is deliberate (plan-394 §2.7): the
  // whole block is cut to MAX_NODE_MACHINE_CONTEXT_CHARS below, so whatever sits
  // at the end is what gets lost first. A stale note losing its tail is a far
  // better outcome than live signals or an active alarm being pushed out of the
  // prompt by one.
  lines.push(...formatKnowledgeLines(input.knowledge));

  const text = lines.join('\n');
  return text.length > MAX_NODE_MACHINE_CONTEXT_CHARS
    ? text.slice(0, MAX_NODE_MACHINE_CONTEXT_CHARS)
    : text;
}

/** Reduces a doc reference (PdfLink url or path) to a stable relative path CONNECT can match. */
export function normalizeDocRef(ref: string): string {
  const s = (ref ?? '').trim();
  if (!s) return '';
  try {
    // Handles absolute (http[s]://…) and relative refs uniformly; drops query/hash.
    return new URL(s, 'http://_local_/').pathname.replace(/^\/+/, '');
  } catch {
    return s.replace(/[?#].*$/, '');
  }
}

/** Pure assembly of the wire context from already-extracted node data (testable without a viewer). */
export function buildSearchAiContext(input: NodeContextInput | null): SearchAiContext | null {
  if (!input || !input.nodePath) return null;
  const ctx: SearchAiContext = { nodePath: input.nodePath };

  const docHints = Array.from(
    new Set((input.docRefs ?? []).map(normalizeDocRef).filter((s) => s.length > 0)),
  ).slice(0, MAX_DOC_HINTS);
  if (docHints.length) ctx.docHints = docHints;

  ctx.machineContext = formatMachineContext(input);
  return ctx;
}

// ─── Viewer extraction ───

function readRvExtras(node: SceneNodeLike | null | undefined): RvExtras | undefined {
  const rv = node?.userData?.realvirtual;
  return rv && typeof rv === 'object' ? (rv as RvExtras) : undefined;
}

/**
 * Read the agent-authored knowledge note off a node (plan-394 F5).
 *
 * NO ancestor walk, unlike {@link extractDocRefs}: a note on the model root
 * would otherwise be reported as knowledge about every node in the scene, and
 * the LLM could not tell inherited from specific. Inheritance is a possible
 * opt-in parameter later, never a default.
 */
function extractNodeKnowledge(node: SceneNodeLike | null | undefined): string | undefined {
  const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
  const entry = rv?.[NODE_KNOWLEDGE_TYPE];
  if (!entry || typeof entry !== 'object') return undefined;
  const note = (entry as Record<string, unknown>)[NODE_KNOWLEDGE_FIELD];
  return typeof note === 'string' && note.trim().length > 0 ? note : undefined;
}

/** Collects `_rvPdfLinks` source urls from the node and up its parent chain (F1: node + parents). */
function extractDocRefs(node: SceneNodeLike | null | undefined): string[] {
  const refs: string[] = [];
  let n: SceneNodeLike | null | undefined = node;
  let depth = 0;
  while (n && depth < 8) {
    const links = n.userData?._rvPdfLinks as Array<{ source?: { url?: string } }> | undefined;
    if (Array.isArray(links))
      for (const l of links) if (l?.source?.url) refs.push(l.source.url);
    n = n.parent;
    depth++;
  }
  return refs;
}

/** True when an error entry belongs to the node (exact or ancestor/descendant path). */
function nodeMatches(errorPath: string, nodePath: string): boolean {
  return errorPath === nodePath
    || errorPath.startsWith(nodePath + '/')
    || nodePath.startsWith(errorPath + '/');
}

/**
 * Reads current values of signals referenced by the node's rv_extras. Generic
 * heuristic: any string field whose value resolves to a known signal in the
 * SignalStore is treated as a bound signal — no per-type signal wiring needed.
 */
function extractSignals(
  store: SignalReader | null,
  rvExtras: RvExtras | undefined,
  types: readonly string[],
): Array<{ name: string; value: boolean | number }> {
  if (!store || !rvExtras) return [];
  const out: Array<{ name: string; value: boolean | number }> = [];
  const seen = new Set<string>();
  for (const type of types) {
    const fields = rvExtras[type];
    if (!fields) continue;
    for (const v of Object.values(fields)) {
      if (typeof v !== 'string' || v.length === 0 || seen.has(v)) continue;
      const t = store.getType(v);
      if (!t) continue;
      seen.add(v);
      const value = t === 'bool' ? store.getBool(v) : t === 'int' ? store.getInt(v) : store.getFloat(v);
      if (value !== undefined) out.push({ name: v, value });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/**
 * plan-284 F10: extra docHints from the query's top node search hits — gives the
 * answer a part-specific doc boost even when nothing is selected. Reads each hit
 * node's linked docs (`_rvPdfLinks`) and normalizes/dedupes/caps them.
 */
export function docHintsForNodes(viewer: SearchAiContextViewer, nodePaths: readonly string[]): string[] {
  const registry = viewer.registry;
  if (!registry || nodePaths.length === 0) return [];
  const refs: string[] = [];
  for (const path of nodePaths)
    for (const r of extractDocRefs(registry.getNode(path))) refs.push(r);
  return Array.from(new Set(refs.map(normalizeDocRef).filter((s) => s.length > 0))).slice(0, MAX_DOC_HINTS);
}

/**
 * Merges extra docHints (e.g. from F10 query hits) into a context, creating a
 * hints-only context when there was no selection. Returns the input unchanged when
 * there are no extra hints.
 */
export function withExtraDocHints(
  context: SearchAiContext | null,
  extra: readonly string[],
): SearchAiContext | null {
  if (extra.length === 0) return context;
  const docHints = Array.from(new Set([...(context?.docHints ?? []), ...extra])).slice(0, MAX_DOC_HINTS);
  if (docHints.length === 0) return context;
  return { ...(context ?? {}), docHints };
}

/**
 * Collects the live context for the currently selected node, or `null` when
 * nothing is selected (search then behaves as before plan-284).
 */
export function collectNodeAiContext(
  viewer: SearchAiContextViewer,
  path: string,
): SearchAiContext | null {
  if (!path) return null;
  const registry = viewer.registry;
  const node = registry?.getNode(path);
  const rvExtras = readRvExtras(node);
  const types = registry?.getComponentTypes(path) ?? (rvExtras ? Object.keys(rvExtras) : []);
  const docRefs = extractDocRefs(node);
  const alarms = (viewer.errorStore?.getActive?.() ?? [])
    .filter((e) => e.active && nodeMatches(e.path, path))
    .map((e) => e.text);
  const signals = extractSignals(viewer.signalStore ?? null, rvExtras, types);
  const knowledge = extractNodeKnowledge(node);

  return buildSearchAiContext({
    nodePath: path, types, rvExtras, docRefs, alarms, signals, knowledge,
  });
}

/** Reduces the current model URL to the basename shown in machine status. */
function modelNameFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const clean = url.replace(/\\/g, '/').replace(/[?#].*$/, '');
  const basename = clean.slice(clean.lastIndexOf('/') + 1);
  if (!basename) return undefined;
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

/** Always returns machine status and appends selected-node context when available. */
export function collectSearchAiContext(viewer: SearchAiContextViewer): SearchAiContext {
  const errors = viewer.errorStore?.getActive?.() ?? [];
  const now = typeof performance === 'undefined' ? 0 : performance.now();
  const drives = viewer.drives;
  const sensors = viewer.transportManager?.sensors;
  const statusBlock = formatMachineStatus({
    modelName: modelNameFromUrl(viewer.currentModelUrl),
    viewerMode: getViewerMode(),
    connectState: getConnectSnapshot().state,
    simulationPaused: viewer.isSimulationPaused,
    driveCount: drives?.length,
    drivesRunning: drives?.filter((drive) => drive.isRunning).length,
    sensorCount: sensors?.length,
    sensorsOccupied: sensors?.filter((sensor) => sensor.occupied).length,
    activeErrors: errors
      .filter((error) => error.active !== false)
      .map((error) => ({
        path: error.path,
        text: error.text,
        sinceSeconds: typeof error.since === 'number'
          ? Math.max(0, (now - error.since) / 1000)
          : 0,
      })),
  });

  const path = viewer.selectionManager?.getSnapshot().primaryPath ?? null;
  const nodeContext = path ? collectNodeAiContext(viewer, path) : null;
  if (!nodeContext) return { machineContext: statusBlock };
  return {
    ...nodeContext,
    machineContext: `${statusBlock}\n\n${nodeContext.machineContext ?? ''}`,
  };
}
