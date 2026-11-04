// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-macro — the macro core of plan-641 (Stufe 1): data model, classifier,
 * the per-document macro book, the recorder and the job registry.
 *
 * ## What a macro is
 *
 * A declarative list of COMMAND calls (`commandRegistry` ids with explicit,
 * resolved args), each with the reason and source the agent gave for it. No
 * code: a step runs only a command the registry would run anyway, which is what
 * makes a foreign macro safe to inspect (`dryRun`) and replay line by line.
 *
 * ## Recording contract (plan §2.5 M1/M3/M4/M8/M9)
 *
 *  - Only MCP-originated calls of `macro: true` commands are recorded, inside
 *    the shared wrapper `runCommandStep` (rv-mcp-command-tools.ts) — never
 *    passively through `onExecuted` (raw args, after the await, no context).
 *  - While a recording runs, macro steps are strictly serial (one step lock).
 *    A change of the document's op stack between start and end of a step
 *    window belongs to that step; no change = `noop`.
 *  - Every change the recorder cannot attribute to its own step — undo, redo,
 *    a history replacement or rollback, an edit outside a window (UI click,
 *    another session) — ENDS the recording in a controlled way
 *    (`recording-interrupted`, reason + last valid step kept). No mirror stack.
 *  - `record_start` sets a coalesce floor on the document, so the first step
 *    cannot be folded into an edit made before the recording; the floor is
 *    released on stop and on every interruption.
 *
 * ## Leaf module
 *
 * No viewer, no registry, no Three.js. The per-document book map itself lives
 * in the core leaf `core/editor/rv-macro-store.ts`, because the two document
 * writers (asset export, scene writer) read it through `macrosForEmbed` — and
 * importing THIS module from the core would put the recorder and the jobs into
 * the entry bundle.
 */

import {
  macrosForEmbed,
  peekMacroBook as peekBook,
  RV_MACROS_KEY,
  setMacroBook,
  type RvMacroBookBase,
} from '../../core/editor/rv-macro-store';

export { macrosForEmbed, RV_MACROS_KEY };

// ─── Data model (plan §2.3) ─────────────────────────────────────────────

/** Schema id written into every macro. A different id is not read (upcaster below). */
export const RV_MACRO_SCHEMA = 'rv-macro/1';
/** The meta arguments every macro-capable call accepts (F2). */
export const MACRO_META_KEYS = ['_reason', '_source', '_confidence'] as const;
/** Upper size the plan aims at per macro (NF "Groesse"); exceeding it is reported, not refused. */
export const MACRO_SIZE_HINT_BYTES = 100 * 1024;

export type RvMacroConfidence = 'observed' | 'inferred' | 'unverified';

export interface RvMacroNote {
  reason?: string;
  source?: string;
  author: 'agent' | 'user';
  confidence?: RvMacroConfidence;
}

export type RvMacroStatus = 'ok' | 'partial' | 'noop' | 'failed' | 'requires-commercial';

export interface RvMacroStepResult {
  status: RvMacroStatus;
  /** `ExecuteResult.kind` of a failure. */
  kind?: string;
  reason?: string;
  /** Names the command created (`value.created`). */
  created?: string[];
}

export interface RvMacroCommandStep {
  kind: 'command';
  command: string;
  args: Record<string, unknown>;
  note: RvMacroNote;
  result: RvMacroStepResult;
  at: string;
}

export interface RvMacroAssertStep {
  kind: 'assert';
  check: 'gap' | 'contact';
  args: Record<string, unknown>;
  expect: { gapMm?: { min?: number; max?: number }; contact?: boolean };
  note: RvMacroNote;
  at: string;
}

export type RvMacroStep = RvMacroCommandStep | RvMacroAssertStep;

/** Why a recording ended without `record_stop` (M8). */
export interface RvMacroInterruption {
  reason: string;
  at: string;
  /** Number of steps the macro held when it was interrupted (the last valid one is `afterStep`). */
  afterStep: number;
}

export interface RvMacro {
  $schema: typeof RV_MACRO_SCHEMA;
  name: string;
  document: { id?: string; name: string; sha256AtStart?: string };
  steps: RvMacroStep[];
  /** Additive: controlled ends of recordings (M8). Older readers ignore it. */
  interruptions?: RvMacroInterruption[];
}

// ─── Meta arguments (F2) ────────────────────────────────────────────────

export interface MacroMeta {
  reason?: string;
  source?: string;
  confidence?: RvMacroConfidence;
}

const CONFIDENCES: readonly RvMacroConfidence[] = ['observed', 'inferred', 'unverified'];

function cleanText(v: unknown, max = 2000): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Parse the three meta values; unknown confidence values are dropped, not guessed. */
export function parseMacroMeta(raw: { _reason?: unknown; _source?: unknown; _confidence?: unknown }): MacroMeta | null {
  const reason = cleanText(raw._reason);
  const source = cleanText(raw._source, 500);
  const c = typeof raw._confidence === 'string' ? raw._confidence.trim().toLowerCase() : '';
  const confidence = (CONFIDENCES as readonly string[]).includes(c) ? (c as RvMacroConfidence) : undefined;
  if (!reason && !source && !confidence) return null;
  return { ...(reason ? { reason } : {}), ...(source ? { source } : {}), ...(confidence ? { confidence } : {}) };
}

/**
 * Split the meta arguments off a wire object (F2). Returns a COPY without
 * `_reason/_source/_confidence` — what the tool may see — and the parsed meta.
 */
export function splitMacroMeta(wire: Readonly<Record<string, unknown>> | null | undefined): {
  args: Record<string, unknown>;
  meta: MacroMeta | null;
} {
  const args: Record<string, unknown> = {};
  const raw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wire ?? {})) {
    if ((MACRO_META_KEYS as readonly string[]).includes(k)) raw[k] = v;
    else args[k] = v;
  }
  return { args, meta: parseMacroMeta(raw) };
}

/** A note for a recorded step. */
export function noteOf(meta: MacroMeta | null | undefined, author: RvMacroNote['author'] = 'agent'): RvMacroNote {
  return { author, ...(meta ?? {}) };
}

// ─── Classification (M3) ────────────────────────────────────────────────

/** The two result shapes a step can produce: an `ExecuteResult`, or a refusal before dispatch. */
export type StepExecuteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: string; readonly reason: string | null; readonly details?: Readonly<Record<string, unknown>> };

function nonEmpty(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v > 0;
  return false;
}

function createdOf(value: unknown): string[] | undefined {
  const c = (value as { created?: unknown } | null)?.created;
  if (!Array.isArray(c)) return undefined;
  const names = c.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return names.length ? names : undefined;
}

/**
 * THE classification of a command outcome (plan M3) — shared by `web_execute`,
 * `web_batch`, the bound aliases and the replay.
 *
 * `changed` is the M9 change evidence of the step window: `true`/`false` when a
 * document was observed, `null` when there was nothing to observe (a scope
 * `'none'` command, no open document) — then only the value decides.
 */
export function classifyCommandOutcome(result: StepExecuteResult, changed: boolean | null): RvMacroStepResult {
  if (!result.ok) {
    if (result.kind === 'unavailable') {
      return { status: 'requires-commercial', kind: result.kind, ...(result.reason ? { reason: result.reason } : {}) };
    }
    return { status: 'failed', kind: result.kind, ...(result.reason ? { reason: result.reason } : {}) };
  }
  const value = result.value as Record<string, unknown> | null | undefined;
  const created = createdOf(value);
  const withCreated = <T extends RvMacroStepResult>(r: T): T => (created ? { ...r, created } : r);
  if (value && typeof value === 'object') {
    if (typeof value['error'] === 'string' || value['error'] === true) {
      return { status: 'failed', kind: 'value-error', reason: String(value['error']) };
    }
    if (value['ok'] === false) {
      return { status: 'failed', kind: 'value-error', reason: typeof value['reason'] === 'string' ? value['reason'] : 'ok: false' };
    }
    if (nonEmpty(value['skipped'])) return withCreated({ status: 'partial' });
    if (Array.isArray(value['applied']) && value['applied'].length === 0) return { status: 'noop' };
  }
  if (changed === false) return { status: 'noop' };
  return withCreated({ status: 'ok' });
}

/** Statuses a replay runs (M3: `ok` and `partial`); the rest are noted, not replayed. */
export function isReplayableStatus(s: RvMacroStatus): boolean {
  return s === 'ok' || s === 'partial';
}

// ─── Parse / serialise (M5) ─────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseNote(raw: unknown): RvMacroNote {
  const r = isRecord(raw) ? raw : {};
  const meta = parseMacroMeta({ _reason: r['reason'], _source: r['source'], _confidence: r['confidence'] });
  return noteOf(meta, r['author'] === 'user' ? 'user' : 'agent');
}

const STATUSES: readonly RvMacroStatus[] = ['ok', 'partial', 'noop', 'failed', 'requires-commercial'];

function parseStep(raw: unknown): RvMacroStep | null {
  if (!isRecord(raw)) return null;
  const at = typeof raw['at'] === 'string' ? raw['at'] : '';
  if (raw['kind'] === 'assert') {
    const check = raw['check'];
    if (check !== 'gap' && check !== 'contact') return null;
    return {
      kind: 'assert', check,
      args: isRecord(raw['args']) ? { ...raw['args'] } : {},
      expect: isRecord(raw['expect']) ? { ...(raw['expect'] as RvMacroAssertStep['expect']) } : {},
      note: parseNote(raw['note']), at,
    };
  }
  // `kind` absent = a command step (tolerant reader).
  if (raw['kind'] !== undefined && raw['kind'] !== 'command') return null;
  const command = typeof raw['command'] === 'string' ? raw['command'].trim() : '';
  if (!command) return null;
  const res = isRecord(raw['result']) ? raw['result'] : {};
  const status = (STATUSES as readonly string[]).includes(String(res['status'])) ? res['status'] as RvMacroStatus : 'ok';
  const created = Array.isArray(res['created']) ? (res['created'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    kind: 'command', command,
    args: isRecord(raw['args']) ? JSON.parse(JSON.stringify(raw['args'])) as Record<string, unknown> : {},
    note: parseNote(raw['note']),
    result: {
      status,
      ...(typeof res['kind'] === 'string' ? { kind: res['kind'] } : {}),
      ...(typeof res['reason'] === 'string' ? { reason: res['reason'] } : {}),
      ...(created.length ? { created } : {}),
    },
    at,
  };
}

/**
 * Read one macro (upcaster). A missing `$schema` is read as `rv-macro/1`; any
 * other schema id is refused (null) — an unknown major version may mean
 * something else entirely. Never throws.
 */
export function normalizeMacro(raw: unknown): RvMacro | null {
  if (!isRecord(raw)) return null;
  if (raw['$schema'] !== undefined && raw['$schema'] !== RV_MACRO_SCHEMA) return null;
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name) return null;
  const docRaw = isRecord(raw['document']) ? raw['document'] : {};
  const steps = Array.isArray(raw['steps']) ? raw['steps'].map(parseStep).filter((s): s is RvMacroStep => s !== null) : [];
  const interruptions = Array.isArray(raw['interruptions'])
    ? raw['interruptions'].filter(isRecord).map((i) => ({
      reason: String(i['reason'] ?? ''), at: String(i['at'] ?? ''), afterStep: Number(i['afterStep'] ?? 0) || 0,
    }))
    : [];
  return {
    $schema: RV_MACRO_SCHEMA,
    name,
    document: {
      ...(typeof docRaw['id'] === 'string' ? { id: docRaw['id'] } : {}),
      name: typeof docRaw['name'] === 'string' ? docRaw['name'] : '',
      ...(typeof docRaw['sha256AtStart'] === 'string' ? { sha256AtStart: docRaw['sha256AtStart'] } : {}),
    },
    steps,
    ...(interruptions.length ? { interruptions } : {}),
  };
}

/** Every macro under `extras.realvirtual.Macros` (an array). Absent / malformed → `[]`. */
export function parseMacros(rvExtras: unknown): RvMacro[] {
  if (!isRecord(rvExtras)) return [];
  const list = rvExtras[RV_MACROS_KEY];
  if (!Array.isArray(list)) return [];
  const out: RvMacro[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const m = normalizeMacro(raw);
    if (m && !seen.has(m.name)) { seen.add(m.name); out.push(m); }
  }
  return out;
}

/** A JSON-safe copy; `stripNotes` removes reason / source (customer quotes, risk table). */
export function serializeMacro(macro: RvMacro, opts?: { stripNotes?: boolean }): RvMacro {
  const copy = JSON.parse(JSON.stringify(macro)) as RvMacro;
  if (opts?.stripNotes) {
    for (const s of copy.steps) s.note = { author: s.note.author, ...(s.note.confidence ? { confidence: s.note.confidence } : {}) };
  }
  return copy;
}

/** `macros/<name>.macro.json` — the name made filename-safe. */
export function macroFilePath(name: string): string {
  const safe = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'macro';
  return `macros/${safe}.macro.json`;
}

/** Approximate serialised size in bytes (UTF-16 length is close enough for the hint). */
export function macroSizeBytes(macro: RvMacro): number {
  return JSON.stringify(macro).length;
}

// ─── Macro book (per document) ──────────────────────────────────────────

/** The macros of ONE document (stored in the core leaf, keyed by the document object). */
export type RvMacroBook = RvMacroBookBase<RvMacro>;

/**
 * The book of `doc`, created on first use and seeded from the document's root
 * extras (`seed()` returns the `extras.realvirtual` object of the loaded model).
 */
export function macroBookOf(doc: object, seed?: () => unknown): RvMacroBook {
  let book = peekBook(doc) as RvMacroBook | undefined;
  if (!book) {
    book = { macros: new Map(), touched: false };
    try {
      for (const m of parseMacros(seed?.())) book.macros.set(m.name, m);
    } catch { /* a malformed block is no macro, never an error */ }
    setMacroBook(doc, book);
  }
  return book;
}

/** The book if one exists — never creates. */
export function peekMacroBook(doc: object | null | undefined): RvMacroBook | undefined {
  return peekBook(doc) as RvMacroBook | undefined;
}

// ─── Recorder ───────────────────────────────────────────────────────────

/** The document surface the recorder needs — `RvDocument` satisfies it. */
export interface MacroRecordingDoc {
  readonly changeSeq: number;
  onHistoryChange(cb: (change: { kind: string }) => void): () => void;
  markCoalesceFloor(): () => void;
  markMetaDirty?(): void;
}

export interface MacroRecordingInfo {
  readonly name: string;
  readonly steps: number;
  readonly newSteps: number;
  readonly startedAt: string;
}

export interface MacroStopResult {
  readonly macro: RvMacro;
  readonly newSteps: number;
  readonly interruption: RvMacroInterruption | null;
}

interface Session {
  readonly doc: MacroRecordingDoc;
  readonly book: RvMacroBook;
  readonly macro: RvMacro;
  readonly startedAt: string;
  readonly stepsAtStart: number;
  readonly cleanups: Array<() => void>;
  windowOpen: boolean;
  windowChanges: number;
}

const HISTORY_BREAKS = new Set(['undo', 'redo', 'replace', 'rollback']);

/**
 * The one recorder of this tab. ONE recording at a time (a second start is
 * refused, naming the running one) — macro lines are attributed by strict
 * serialisation, and two concurrent recordings would have to share it anyway.
 */
export class MacroRecorder {
  private _session: Session | null = null;
  private _lock: Promise<void> = Promise.resolve();
  private _lastInterruption: { name: string; interruption: RvMacroInterruption } | null = null;
  /** Documents a replay job is running on — no recording may start there (9.7b M1). */
  private readonly _replaying = new Set<object>();

  get active(): MacroRecordingInfo | null {
    const s = this._session;
    if (!s) return null;
    return {
      name: s.macro.name,
      steps: s.macro.steps.length,
      newSteps: s.macro.steps.length - s.stepsAtStart,
      startedAt: s.startedAt,
    };
  }

  /** The last controlled end of a recording (cleared by the next start). */
  get lastInterruption(): { name: string; interruption: RvMacroInterruption } | null {
    return this._lastInterruption;
  }

  isRecordingFor(doc: object | null | undefined): boolean {
    return !!doc && this._session?.doc === doc;
  }

  isReplaying(doc: object | null | undefined): boolean {
    return !!doc && this._replaying.has(doc);
  }

  beginReplay(doc: object): void { this._replaying.add(doc); }
  endReplay(doc: object): void { this._replaying.delete(doc); }

  /**
   * Start (or continue) the macro `name` of `book` on `doc`. Appends to an
   * existing macro of that name. `watch` registers extra end conditions (e.g. a
   * document switch) and returns their cleanup.
   */
  start(
    doc: MacroRecordingDoc,
    book: RvMacroBook,
    name: string,
    document: RvMacro['document'],
    watch?: (interrupt: (reason: string) => void) => (() => void) | void,
  ): MacroRecordingInfo {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A macro needs a name');
    if (this._session) throw new Error(`A recording is already running ("${this._session.macro.name}") — stop it first`);
    if (this._replaying.has(doc)) throw new Error('A macro replay is running on this document — wait for it or cancel it');
    let macro = book.macros.get(trimmed);
    if (!macro) {
      macro = { $schema: RV_MACRO_SCHEMA, name: trimmed, document: { ...document }, steps: [] };
      book.macros.set(trimmed, macro);
      book.touched = true;
    }
    const session: Session = {
      doc, book, macro,
      startedAt: new Date().toISOString(),
      stepsAtStart: macro.steps.length,
      cleanups: [],
      windowOpen: false,
      windowChanges: 0,
    };
    this._session = session;
    this._lastInterruption = null;
    // M8: nothing recorded before the start may be amended by the first step.
    session.cleanups.push(doc.markCoalesceFloor());
    session.cleanups.push(doc.onHistoryChange((change) => this._onHistory(session, change.kind)));
    const extra = watch?.((reason) => { if (this._session === session) this.interrupt(reason); });
    if (typeof extra === 'function') session.cleanups.push(extra);
    return this.active!;
  }

  /** End the recording normally. Null when none runs. */
  stop(): MacroStopResult | null {
    const s = this._session;
    if (!s) return null;
    this._end(s);
    return { macro: s.macro, newSteps: s.macro.steps.length - s.stepsAtStart, interruption: null };
  }

  /** End the recording in a controlled way (M8) — the buffer stays, the reason is kept on the macro. */
  interrupt(reason: string): void {
    const s = this._session;
    if (!s) return;
    const interruption: RvMacroInterruption = { reason, at: new Date().toISOString(), afterStep: s.macro.steps.length };
    (s.macro.interruptions ??= []).push(interruption);
    s.book.touched = true;
    this._lastInterruption = { name: s.macro.name, interruption };
    this._end(s);
    s.doc.markMetaDirty?.();
  }

  /**
   * Run `fn` under the step lock (M9: macro steps are strictly serial while a
   * recording runs). A caller started while another step runs waits for it.
   */
  async withStepLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._lock;
    let release!: () => void;
    this._lock = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  /** Open the step window — history changes from now on belong to the step. */
  openWindow(doc: object): void {
    const s = this._session;
    if (!s || s.doc !== doc) return;
    s.windowOpen = true;
    s.windowChanges = 0;
  }

  /** Close the step window and return how many changes fell into it (null without a session). */
  closeWindow(doc: object): number | null {
    const s = this._session;
    if (!s || s.doc !== doc) return null;
    s.windowOpen = false;
    return s.windowChanges;
  }

  /** Append a recorded step to the running macro (no-op when the recording ended meanwhile). */
  appendStep(doc: object, step: RvMacroStep): number | null {
    const s = this._session;
    if (!s || s.doc !== doc) return null;
    s.macro.steps.push(step);
    s.book.touched = true;
    s.doc.markMetaDirty?.();
    return s.macro.steps.length;
  }

  /** Test hook. */
  _resetForTest(): void {
    if (this._session) this._end(this._session);
    this._lock = Promise.resolve();
    this._lastInterruption = null;
    this._replaying.clear();
  }

  private _onHistory(s: Session, kind: string): void {
    if (this._session !== s) return;
    if (HISTORY_BREAKS.has(kind)) { this.interrupt(`history-${kind}`); return; }
    if (s.windowOpen) { s.windowChanges++; return; }
    this.interrupt('change-outside-step');
  }

  private _end(s: Session): void {
    if (this._session === s) this._session = null;
    s.windowOpen = false;
    for (const c of s.cleanups.splice(0)) {
      try { c(); } catch { /* a cleanup never blocks the end */ }
    }
  }
}

/** The tab-wide recorder. Tests instantiate their own. */
export const macroRecorder = new MacroRecorder();

// ─── Jobs (M2) ──────────────────────────────────────────────────────────

export type MacroJobState = 'running' | 'done' | 'cancelled' | 'aborted';

/** One line of a replay / batch report. `step` is 1-based. */
export interface MacroJobReportLine {
  delta?: unknown;
  /** Full result of a single-command execute job. */
  value?: unknown;
  error?: string;
  step: number;
  kind: 'command' | 'assert';
  command?: string;
  /** Assertion lines: the check that ran (plan-641 Phase 4). */
  check?: string;
  status: RvMacroStatus | 'skipped';
  reason?: string;
  errorKind?: string;
  created?: string[];
  /** Another edit reached the document between the previous step and this one (M2/M9). */
  concurrentEdit?: boolean;
  /** Assertion lines: what was measured (mm). */
  measured?: { gapMm: number; contact: boolean; overlap: boolean; contained: boolean };
}

export interface MacroJob {
  readonly id: string;
  readonly kind: 'replay' | 'batch' | 'execute';
  readonly name: string;
  readonly documentKey: string;
  readonly total: number;
  state: MacroJobState;
  done: number;
  readonly report: MacroJobReportLine[];
  readonly startedAt: string;
  endedAt?: string;
  abortReason?: string;
  concurrentEdits: number;
  cancelRequested: boolean;
  /** Present only for execute jobs whose implementation supports cancellation. */
  abort?: AbortController;
}

let jobSeq = 0;

/** Jobs of this tab; at most ONE running job per document (M2). */
export class MacroJobRegistry {
  private readonly _jobs = new Map<string, MacroJob>();
  private readonly _max = 20;

  /** Create a job, or throw when one already runs on the document. */
  create(kind: MacroJob['kind'], name: string, documentKey: string, total: number): MacroJob {
    const running = this.runningFor(documentKey);
    if (running) throw new Error(`A ${running.kind} job (${running.id}) is already running on this document — wait for it or cancel it`);
    const job: MacroJob = {
      id: `job-${++jobSeq}-${Date.now().toString(36)}`,
      kind, name, documentKey, total,
      state: 'running', done: 0, report: [],
      startedAt: new Date().toISOString(),
      concurrentEdits: 0, cancelRequested: false,
    };
    this._jobs.set(job.id, job);
    this._prune();
    return job;
  }

  get(id: string): MacroJob | undefined { return this._jobs.get(id); }

  list(): MacroJob[] { return [...this._jobs.values()]; }

  runningFor(documentKey: string): MacroJob | undefined {
    for (const j of this._jobs.values()) if (j.state === 'running' && j.documentKey === documentKey) return j;
    return undefined;
  }

  /** Ask a job to stop BETWEEN two steps. False when unknown or already finished. */
  cancel(id: string): boolean {
    const j = this._jobs.get(id);
    if (!j || j.state !== 'running') return false;
    j.cancelRequested = true;
    return true;
  }

  finish(job: MacroJob, state: Exclude<MacroJobState, 'running'>, abortReason?: string): void {
    job.state = state;
    job.endedAt = new Date().toISOString();
    if (abortReason) job.abortReason = abortReason;
  }

  _resetForTest(): void { this._jobs.clear(); }

  private _prune(): void {
    if (this._jobs.size <= this._max) return;
    for (const [id, j] of this._jobs) {
      if (this._jobs.size <= this._max) break;
      if (j.state !== 'running') this._jobs.delete(id);
    }
  }
}

/** The tab-wide job registry. */
export const macroJobs = new MacroJobRegistry();

/** A JSON view of a job for the status tool. */
export function jobSummary(job: MacroJob): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const l of job.report) counts[l.status] = (counts[l.status] ?? 0) + 1;
  return {
    jobId: job.id, kind: job.kind, name: job.name, state: job.state,
    progress: { done: job.done, total: job.total },
    counts,
    ...(job.abortReason ? { abortReason: job.abortReason } : {}),
    ...(job.concurrentEdits ? { concurrentEdits: job.concurrentEdits } : {}),
    startedAt: job.startedAt,
    ...(job.endedAt ? { endedAt: job.endedAt } : {}),
    report: job.report,
  };
}
