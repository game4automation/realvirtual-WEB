// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-macro-tools — the `web_macro_*` tools of plan-641 (Phases 1 + 2).
 *
 *  - record_start / record_stop — a recording of MCP command calls (see
 *    rv-mcp-macro.ts for the contract: serial steps, controlled interruption);
 *  - list / get / annotate — read and comment the macros of the OPEN document;
 *  - save — `macros/<name>.macro.json` into a writable project folder (the GLB
 *    copy is written by every document save, `extras.realvirtual.Macros`, M5);
 *  - import — the way back (Phase 2b): a macro from the project folder (name or
 *    project-relative path) or inline JSON (no folder needed: the public demo)
 *    into the book of the OPEN document, so it can be replayed on another copy;
 *  - assert — an assertion line (`kind: 'assert'`, check allowlist gap |
 *    contact, plan-641 Phase 4): measured when it is added and on every replay;
 *  - replay / status / cancel — a replay is a JOB (M2): it answers with a
 *    `jobId` at once, because CONNECT gives up on a call after its timeout while
 *    the browser would keep executing. One job per document; bound to the
 *    document it started on (`document-changed` otherwise); foreign edits in
 *    between are reported as `concurrentEdit`, not refused.
 *
 * Replay runs every line through the same `runCommandStep` as `web_execute`,
 * with a fresh context per step and recording off, under the dialog policy.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../../core/hmi/editor-command-descriptors';
import { getActiveAssetContext, subscribeActiveAsset } from '../../core/editor/active-asset-store';
import { reportProblem } from '../../core/hmi/problems-store';
import {
  isReplayableStatus,
  jobSummary,
  macroBookOf,
  macroFilePath,
  macroJobs,
  macroRecorder,
  macroSizeBytes,
  MACRO_SIZE_HINT_BYTES,
  normalizeMacro,
  parseMacroMeta,
  serializeMacro,
  type MacroJob,
  type MacroJobReportLine,
  type RvMacro,
  type RvMacroAssertStep,
  type RvMacroBook,
  noteOf,
  RV_MACRO_SCHEMA,
} from './rv-mcp-macro';
import {
  failedExpectation,
  isGeometryCheck,
  runGeometryCheck,
  type GeometryCheckArgs,
  type GeometryExpect,
} from './rv-mcp-check-tools';
import {
  documentKeyOf,
  gatewayOutdatedRefusal,
  isMacroCommand,
  runCommandStep,
  runWithDialogPolicy,
  shouldStop,
  stepDocumentOf,
  type StepDocument,
  type StopRules,
} from './rv-mcp-command-tools';

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...(extra ?? {}) });
}

/** The problem code a failed replay line reports (F6). */
export const MACRO_STEP_FAILED = 'macro-step-failed';

/** One line of a dry run. */
interface DryRunLine {
  step: number;
  kind: 'command' | 'assert';
  command?: string;
  args: Record<string, unknown>;
  reason?: string;
  source?: string;
  recordedStatus?: string;
  willRun: boolean;
  skipReason?: string;
}

export class McpMacroTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  /** The open document and its book, or the reason there is none. */
  private _book(): { doc: StepDocument; book: RvMacroBook; name: string } | string {
    ensureEditorCommandsRegistered();
    const viewer = this.viewer;
    commandRegistry.attachViewer(viewer);
    const doc = stepDocumentOf(commandRegistry.captureContext(viewer));
    if (!doc) return 'No document is open — open one with web_document_open or web_editor_open';
    const book = macroBookOf(doc, () => viewer?.currentModelRoot?.userData?.['realvirtual']);
    const name = getActiveAssetContext()?.doc?.name ?? (doc as { name?: string }).name ?? '';
    return { doc, book, name };
  }

  @McpTool('Start recording a macro of your MCP model changes (resolved args + _reason/_source/_confidence); an existing name continues. Undo, redo or a manual edit ends it. Guide: web_help(macros).', { readOnly: false })
  async webMacroRecordStart(
    @McpParam('name', 'Macro name.') name: string,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return err('name is required');
    const active = getActiveAssetContext()?.doc;
    try {
      const info = macroRecorder.start(ctx.doc, ctx.book, trimmed, {
        ...(active?.id ? { id: active.id } : {}), name: ctx.name,
      }, (interrupt) => subscribeActiveAsset(() => {
        if (getActiveAssetContext()?.doc?.document !== ctx.doc) interrupt('document-changed');
      }));
      return JSON.stringify({
        recording: info.name, steps: info.steps, document: ctx.name,
        note: 'Run model changes via web_execute / web_batch / bound web_editor_* tools; stop with web_macro_record_stop.',
      });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  }

  @McpTool('Stop the recording and return its summary, or why the last one was interrupted. The next document save embeds it in the GLB.', { readOnly: false })
  async webMacroRecordStop(): Promise<string> {
    const r = macroRecorder.stop();
    if (!r) {
      const last = macroRecorder.lastInterruption;
      return last
        ? JSON.stringify({ recording: null, interrupted: { name: last.name, ...last.interruption } })
        : err('No recording is running');
    }
    const size = macroSizeBytes(r.macro);
    return JSON.stringify({
      name: r.macro.name, steps: r.macro.steps.length, newSteps: r.newSteps,
      failedOrNoop: r.macro.steps.filter((s) => s.kind === 'command' && !isReplayableStatus(s.result.status)).length,
      ...(size > MACRO_SIZE_HINT_BYTES ? { warning: `Macro is ${Math.round(size / 1024)} KB (aim < 100 KB)` } : {}),
      saved: 'embedded on the next document save (web_editor_save / web_document_save)',
    });
  }

  @McpTool('List the macros of the open document, the running recording and the jobs; files adds unimported macros/*.macro.json.', { readOnly: true })
  async webMacroList(
    @McpParam('files', 'Default false.', 'boolean', false) files?: boolean,
  ): Promise<string> {
    const ctx = this._book();
    const jobs = macroJobs.list().map((j) => ({ jobId: j.id, kind: j.kind, name: j.name, state: j.state, done: j.done, total: j.total }));
    const fileInfo = files === true
      ? await listMacroFiles(typeof ctx === 'string' ? new Set<string>() : new Set(ctx.book.macros.keys()))
      : null;
    if (typeof ctx === 'string') return JSON.stringify({ macros: [], ...(fileInfo ?? {}), recording: macroRecorder.active, jobs, note: ctx });
    const macros = [...ctx.book.macros.values()].map((m) => ({
      name: m.name,
      steps: m.steps.length,
      replayable: m.steps.filter((s) => s.kind === 'assert' || isReplayableStatus(s.result.status)).length,
      ...(m.interruptions?.length ? { interruptions: m.interruptions.length } : {}),
    }));
    return JSON.stringify({ document: ctx.name, macros, ...(fileInfo ?? {}), recording: macroRecorder.active, jobs });
  }

  @McpTool('Get one macro with every line: command, args, note and recorded result (steps from 1).', { readOnly: true })
  async webMacroGet(
    @McpParam('name', 'Macro name.') name: string,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const m = ctx.book.macros.get(String(name ?? '').trim());
    if (!m) return err(`No macro "${name}" in this document`, { macros: [...ctx.book.macros.keys()] });
    return JSON.stringify({
      ...serializeMacro(m),
      steps: m.steps.map((s, i) => ({ step: i + 1, ...s })),
    });
  }

  @McpTool('Set the reason / source / confidence of one macro line.', { readOnly: false })
  async webMacroAnnotate(
    @McpParam('name', 'Macro name.') name: string,
    @McpParam('step', 'Step (1-based).', 'integer') step: number,
    @McpParam('reason', 'Why.') reason: string,
    @McpParam('source', 'Source of the reason.', 'string', false) source?: string,
    @McpParam('confidence', 'observed | inferred | unverified.', 'string', false) confidence?: string,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const m = ctx.book.macros.get(String(name ?? '').trim());
    if (!m) return err(`No macro "${name}" in this document`);
    const idx = Math.round(Number(step)) - 1;
    const line = m.steps[idx];
    if (!line) return err(`step must be 1..${m.steps.length}`);
    const meta = parseMacroMeta({ _reason: reason, _source: source, _confidence: confidence });
    if (!meta) return err('reason, source or confidence is required');
    line.note = { ...line.note, ...meta };
    ctx.book.touched = true;
    ctx.doc.markMetaDirty?.();
    return JSON.stringify({ name: m.name, step: idx + 1, note: line.note });
  }

  @McpTool('Write a macro to macros/<name>.macro.json in the writable project folder; stripNotes removes reasons and sources.', { readOnly: false })
  async webMacroSave(
    @McpParam('name', 'Macro name.') name: string,
    @McpParam('stripNotes', 'Default false.', 'boolean', false) stripNotes?: boolean,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const m = ctx.book.macros.get(String(name ?? '').trim());
    if (!m) return err(`No macro "${name}" in this document`);
    const payload = serializeMacro(m, { stripNotes: stripNotes === true });
    const relPath = macroFilePath(m.name);
    try {
      const folder = await projectFolder();
      if (!folder || !folder.writable) {
        return JSON.stringify({
          written: null, path: relPath,
          reason: 'No writable project folder is open — the macro stays embedded in the GLB (next document save).',
        });
      }
      const { writeSettingsFile } = await import('../../core/project/rv-project-storage');
      await writeSettingsFile(folder.dir, payload, relPath);
      return JSON.stringify({ written: relPath, steps: payload.steps.length, stripNotes: stripNotes === true });
    } catch (e) {
      return err(`Writing ${relPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  @McpTool('Import a macro into the open document from the project folder (source: name or path) or inline (json).', { readOnly: false })
  async webMacroImport(
    @McpParam('source', 'Name or project path.', 'string', false) source?: string,
    @McpParam('json', 'Macro JSON.', 'string', false) json?: string,
    @McpParam('overwrite', 'Default false.', 'boolean', false) overwrite?: boolean,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const src = typeof source === 'string' ? source.trim() : '';
    const hasJson = json !== undefined && json !== null && !(typeof json === 'string' && json.trim() === '');
    if (!!src === hasJson) return err('Pass exactly one of source (name or path in the project folder) or json (the macro inline)');
    let raw: unknown;
    let from: string;
    if (hasJson) {
      from = 'json';
      if (typeof json === 'string') {
        try { raw = JSON.parse(json); } catch (e) {
          return err(`json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        raw = json;
      }
    } else {
      const relPath = macroSourcePath(src);
      if (!relPath) return err(`source "${src}" is not a project-relative path (no "..", no absolute path)`);
      from = relPath;
      let folder: Awaited<ReturnType<typeof projectFolder>>;
      try { folder = await projectFolder(); } catch { folder = null; }
      if (!folder) {
        return err('No project folder is open — import the macro inline with json instead', { path: relPath });
      }
      const read = await readProjectJson(folder.dir, relPath);
      if (read.state !== 'ok') {
        return err(read.state === 'missing' ? `${relPath} not found in the project folder` : `${relPath} is not valid JSON`, { path: relPath });
      }
      raw = read.value;
    }
    const macro = normalizeMacro(raw);
    if (!macro) {
      return err(`Not a macro (${from}): it needs a name, steps and $schema "${RV_MACRO_SCHEMA}" (or none)`, { from });
    }
    const existing = ctx.book.macros.has(macro.name);
    if (existing && overwrite !== true) {
      return err(`A macro "${macro.name}" already exists in this document — pass overwrite: true to replace it`, { name: macro.name, from });
    }
    if (macroRecorder.isRecordingFor(ctx.doc) && macroRecorder.active?.name === macro.name) {
      return err(`"${macro.name}" is being recorded — stop the recording first`);
    }
    const warnings: string[] = [];
    if (macro.document.name && ctx.name && macro.document.name !== ctx.name) {
      warnings.push(`Recorded on document "${macro.document.name}", imported into "${ctx.name}" — check the node paths with web_macro_replay dryRun.`);
    }
    const rawSteps = raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)
      ? (raw as { steps: unknown[] }).steps.length : 0;
    if (rawSteps > macro.steps.length) {
      warnings.push(`${rawSteps - macro.steps.length} of ${rawSteps} lines are unreadable and were skipped.`);
    }
    ctx.book.macros.set(macro.name, macro);
    ctx.book.touched = true;
    ctx.doc.markMetaDirty?.();
    return JSON.stringify({
      name: macro.name, steps: macro.steps.length, warnings, from,
      ...(existing ? { replaced: true } : {}),
    });
  }

  @McpTool('Add an assertion line (check gap|contact) to a macro; measured now and on every replay.', { readOnly: false, timeoutMs: 60_000 })
  async webMacroAssert(
    @McpParam('name', 'Macro name.') name: string,
    @McpParam('check', 'gap | contact.') check: string,
    @McpParam('args', 'JSON {a,b,pose?,toleranceMm?}.') args: string,
    @McpParam('expect', 'JSON {gapMm:{min,max}} | {contact}.') expect: string,
    @McpParam('_reason', 'Why (macro note).', 'string', false) _reason?: string,
    @McpParam('_source', 'Source of the reason.', 'string', false) _source?: string,
    @McpParam('_confidence', 'observed | inferred | unverified.', 'string', false) _confidence?: string,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return err('name is required');
    if (!isGeometryCheck(check)) return err('check must be gap | contact');
    const parsedArgs = parseAssertArgs(args);
    if (typeof parsedArgs === 'string') return err(parsedArgs);
    const parsedExpect = parseAssertExpect(expect);
    if (typeof parsedExpect === 'string') return err(parsedExpect);
    if (macroRecorder.isReplaying(ctx.doc)) return err('A replay is running on this document — wait for it');
    const measured = await runGeometryCheck(this.viewer, parsedArgs);
    let macro = ctx.book.macros.get(trimmed);
    if (!macro) {
      const active = getActiveAssetContext()?.doc;
      macro = {
        $schema: RV_MACRO_SCHEMA, name: trimmed,
        document: { ...(active?.id ? { id: active.id } : {}), name: ctx.name }, steps: [],
      };
      ctx.book.macros.set(trimmed, macro);
    }
    const step: RvMacroAssertStep = {
      kind: 'assert', check,
      args: { ...parsedArgs } as unknown as Record<string, unknown>,
      expect: parsedExpect,
      note: noteOf(parseMacroMeta({ _reason, _source, _confidence }), 'agent'),
      at: new Date().toISOString(),
    };
    macro.steps.push(step);
    ctx.book.touched = true;
    ctx.doc.markMetaDirty?.();
    const verdict = 'error' in measured ? measured.error : failedExpectation(measured, parsedExpect);
    return JSON.stringify({
      name: macro.name, step: macro.steps.length, check,
      passesNow: verdict === null,
      ...(verdict ? { reason: verdict } : {}),
      measured,
    });
  }

  @McpTool('Replay a macro line by line as a JOB: returns a jobId (poll web_macro_status, stop with web_macro_cancel). dryRun lists what would run. Failed lines go to the Problems panel.', { readOnly: false })
  async webMacroReplay(
    @McpParam('name', 'Macro name.') name: string,
    @McpParam('dryRun', 'Change nothing, list.', 'boolean', false) dryRun?: boolean,
    @McpParam('stopOnError', 'Default true.', 'boolean', false) stopOnError?: boolean,
    @McpParam('stopOnPartial', 'Default false.', 'boolean', false) stopOnPartial?: boolean,
  ): Promise<string> {
    const ctx = this._book();
    if (typeof ctx === 'string') return err(ctx);
    const m = ctx.book.macros.get(String(name ?? '').trim());
    if (!m) return err(`No macro "${name}" in this document`, { macros: [...ctx.book.macros.keys()] });
    for (const step of m.steps) {
      if (step.kind !== 'command') continue;
      const refusal = gatewayOutdatedRefusal(step.command);
      if (refusal) return JSON.stringify(refusal);
    }
    if (dryRun) return JSON.stringify({ name: m.name, dryRun: true, steps: dryRunLines(m) });
    if (macroRecorder.isRecordingFor(ctx.doc)) {
      return err('A recording is running on this document — stop it first (a replay is never recorded)');
    }
    let job: MacroJob;
    try {
      job = macroJobs.create('replay', m.name, documentKeyOf(ctx.doc), m.steps.length);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
    const rules: StopRules = { stopOnError: stopOnError !== false, stopOnPartial: stopOnPartial === true };
    void runReplayJob(job, m, ctx.doc, rules, this.viewer);
    return JSON.stringify({ jobId: job.id, state: job.state, total: job.total, poll: 'web_macro_status' });
  }

  @McpTool('Progress and per-line report of a replay / batch job (state, counts, abortReason, concurrentEdits). Without jobId: the newest.', { readOnly: true })
  async webMacroStatus(
    @McpParam('jobId', 'Job id.', 'string', false) jobId?: string,
  ): Promise<string> {
    const id = String(jobId ?? '').trim();
    const job = id ? macroJobs.get(id) : macroJobs.list().at(-1);
    if (!job) return err(id ? `Unknown job "${id}"` : 'No job has run in this tab');
    return JSON.stringify(jobSummary(job));
  }

  @McpTool('Cancel a running replay / batch job between two lines.', { readOnly: false })
  async webMacroCancel(
    @McpParam('jobId', 'Job id.') jobId: string,
  ): Promise<string> {
    const id = String(jobId ?? '').trim();
    const job = macroJobs.get(id);
    if (job?.kind === 'execute' && job.state === 'running' && !job.abort) {
      return JSON.stringify({ ok: false, jobId: id, kind: 'not-cancellable', error: `${job.name} cannot be cancelled — it runs to the end` });
    }
    if (!macroJobs.cancel(id)) {
      const job = macroJobs.get(id);
      return err(job ? `Job ${id} is already ${job.state}` : `Unknown job "${id}"`);
    }
    job?.abort?.abort();
    return JSON.stringify({ jobId: id, cancelRequested: true });
  }
}

// ─── Project folder ─────────────────────────────────────────────────────

/** The open project FOLDER (File System Access), or null — the public demo and delivered builds have none. */
async function projectFolder(): Promise<{ dir: FileSystemDirectoryHandle; writable: boolean } | null> {
  const { getProjectStore } = await import('../../core/project/project-store');
  const backend = getProjectStore().getBackend() as { writable?: boolean; directory?: FileSystemDirectoryHandle } | null;
  return backend?.directory ? { dir: backend.directory, writable: backend.writable === true } : null;
}

/**
 * The project-relative path of an import `source`: a bare name is a macro name
 * (`macroFilePath`), anything with a slash or a `.json` ending is a path. Null
 * for an absolute path or a `..` segment.
 */
export function macroSourcePath(source: string): string | null {
  const s = source.trim().replace(/\\/g, '/');
  if (!s) return null;
  if (!s.includes('/') && !s.toLowerCase().endsWith('.json')) return macroFilePath(s);
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** Read a JSON file below `dir` (any depth) through `readSettingsFile`. */
async function readProjectJson(
  dir: FileSystemDirectoryHandle, relPath: string,
): Promise<{ state: 'ok'; value: unknown } | { state: 'missing' | 'invalid' }> {
  const { tryGetSubfolder } = await import('../../core/engine/rv-local-filesystem');
  const { readSettingsFile } = await import('../../core/project/rv-project-storage');
  const parts = relPath.split('/');
  const file = parts.pop() as string;
  let cur: FileSystemDirectoryHandle = dir;
  for (const p of parts) {
    const next = await tryGetSubfolder(cur, p);
    if (!next) return { state: 'missing' };
    cur = next;
  }
  try { await cur.getFileHandle(file); } catch { return { state: 'missing' }; }
  const value = await readSettingsFile(cur, file);
  return value === null ? { state: 'invalid' } : { state: 'ok', value };
}

/** At most this many folder files are listed (a macros folder is small; the cap keeps a stray folder cheap). */
const MACRO_FILE_LIST_CAP = 200;

/** `macros/*.macro.json` of the project folder whose macro is not in `inBook` (web_macro_list files). */
async function listMacroFiles(inBook: ReadonlySet<string>): Promise<{ files: Array<Record<string, unknown>>; filesNote?: string }> {
  let folder: Awaited<ReturnType<typeof projectFolder>>;
  try { folder = await projectFolder(); } catch { folder = null; }
  if (!folder) return { files: [], filesNote: 'No project folder is open — import a macro inline with web_macro_import json.' };
  const { tryGetSubfolder } = await import('../../core/engine/rv-local-filesystem');
  const sub = await tryGetSubfolder(folder.dir, 'macros');
  if (!sub) return { files: [], filesNote: 'The project folder has no macros/ folder.' };
  const names: string[] = [];
  for await (const [entry, handle] of (sub as unknown as { entries(): AsyncIterable<[string, { kind: string }]> }).entries()) {
    if (handle.kind === 'file' && entry.toLowerCase().endsWith('.macro.json')) names.push(entry);
  }
  names.sort();
  const files: Array<Record<string, unknown>> = [];
  for (const entry of names.slice(0, MACRO_FILE_LIST_CAP)) {
    const path = `macros/${entry}`;
    const read = await readProjectJson(folder.dir, path);
    const macro = read.state === 'ok' ? normalizeMacro(read.value) : null;
    if (!macro) { files.push({ path, error: 'not a valid macro' }); continue; }
    if (!inBook.has(macro.name)) files.push({ name: macro.name, path, steps: macro.steps.length });
  }
  return names.length > MACRO_FILE_LIST_CAP
    ? { files, filesNote: `Only the first ${MACRO_FILE_LIST_CAP} of ${names.length} files are listed.` }
    : { files };
}

// ─── Replay ─────────────────────────────────────────────────────────────

/** Why a line is not run, or null when it is (M1/M3). */
function skipReasonOf(step: RvMacro['steps'][number]): string | null {
  if (step.kind === 'assert') return isGeometryCheck(step.check) ? null : `unknown check "${String(step.check)}"`;
  if (!isReplayableStatus(step.result.status)) return `recorded as ${step.result.status}`;
  const desc = commandRegistry.get(step.command);
  if (desc && !isMacroCommand(desc)) return 'not a macro command';
  return null;
}

/** The dry-run listing (`dryRun` changes nothing). */
export function dryRunLines(m: RvMacro): DryRunLine[] {
  return m.steps.map((s, i) => {
    const skip = skipReasonOf(s);
    return {
      step: i + 1, kind: s.kind,
      ...(s.kind === 'command' ? { command: s.command, recordedStatus: s.result.status } : {}),
      args: s.args,
      ...(s.note.reason ? { reason: s.note.reason } : {}),
      ...(s.note.source ? { source: s.note.source } : {}),
      willRun: skip === null,
      ...(skip ? { skipReason: skip } : {}),
    };
  });
}

/** The job body: one line after the other, bound to the document it started on. */
export async function runReplayJob(
  job: MacroJob, macro: RvMacro, doc: StepDocument, rules: StopRules, viewer: RVViewer | undefined,
): Promise<void> {
  macroRecorder.beginReplay(doc);
  let lastSeq = doc.changeSeq;
  try {
    for (let i = 0; i < macro.steps.length; i++) {
      if (job.cancelRequested) { macroJobs.finish(job, 'cancelled'); return; }
      // M2: bound to document identity — a switch aborts.
      const current = stepDocumentOf(commandRegistry.captureContext(viewer));
      if (current !== doc) { macroJobs.finish(job, 'aborted', 'document-changed'); return; }
      const concurrentEdit = doc.changeSeq !== lastSeq;
      if (concurrentEdit) job.concurrentEdits++;
      const step = macro.steps[i];
      const skip = skipReasonOf(step);
      let line: MacroJobReportLine;
      if (skip) {
        line = { step: i + 1, kind: step.kind, ...(step.kind === 'command' ? { command: step.command } : {}), status: 'skipped', reason: skip };
      } else if (step.kind === 'assert') {
        line = await runAssertLine(step, i, viewer);
        if (line.status === 'failed') reportStepFailure(job, macro, i, line);
      } else {
        const outcome = await runWithDialogPolicy(() => runCommandStep({
          command: step.command, args: step.args, viewer, record: false,
        }), [step.command]);
        line = {
          step: i + 1, kind: 'command', command: step.command, status: outcome.outcome.status,
          ...(outcome.outcome.reason ? { reason: outcome.outcome.reason } : {}),
          ...(outcome.outcome.kind ? { errorKind: outcome.outcome.kind } : {}),
          ...(outcome.outcome.created ? { created: outcome.outcome.created } : {}),
        };
        if (outcome.outcome.status === 'failed') reportStepFailure(job, macro, i, line);
      }
      if (concurrentEdit) line.concurrentEdit = true;
      job.report.push(line);
      job.done = i + 1;
      lastSeq = doc.changeSeq;
      if (line.status !== 'skipped' && shouldStop(line.status, rules)) break;
      // Let the bridge answer status / cancel calls between two lines.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    macroJobs.finish(job, 'done');
  } catch (e) {
    macroJobs.finish(job, 'aborted', e instanceof Error ? e.message : String(e));
  } finally {
    macroRecorder.endReplay(doc);
  }
}

/** Parse the `args` of an assertion: `{a, b, pose?, toleranceMm?}`, or the reason why not. */
export function parseAssertArgs(raw: unknown): GeometryCheckArgs | string {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return 'args must be a JSON object {a, b, pose?, toleranceMm?}'; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'args must be a JSON object {a, b, pose?, toleranceMm?}';
  const o = obj as Record<string, unknown>;
  const a = typeof o['a'] === 'string' ? o['a'].trim() : '';
  const b = typeof o['b'] === 'string' ? o['b'].trim() : '';
  if (!a || !b) return 'args needs the node paths a and b';
  const out: GeometryCheckArgs = { a, b };
  if (o['pose'] !== undefined && o['pose'] !== null) {
    const pose = o['pose'];
    if (typeof pose !== 'object' || Array.isArray(pose)) return 'args.pose must be an object {drive: position}';
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(pose as Record<string, unknown>)) {
      const n = Number(v);
      if (!Number.isFinite(n)) return `args.pose value for "${k}" is not a number`;
      p[k] = n;
    }
    if (Object.keys(p).length) out.pose = p;
  }
  if (o['toleranceMm'] !== undefined && o['toleranceMm'] !== null) {
    const t = Number(o['toleranceMm']);
    if (!Number.isFinite(t) || t < 0) return 'args.toleranceMm must be a number >= 0';
    out.toleranceMm = t;
  }
  return out;
}

/** Parse the `expect` of an assertion: `{gapMm?: {min?, max?}, contact?}` with at least one rule. */
export function parseAssertExpect(raw: unknown): GeometryExpect | string {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return 'expect must be a JSON object {gapMm?:{min?,max?}, contact?}'; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'expect must be a JSON object {gapMm?:{min?,max?}, contact?}';
  const o = obj as Record<string, unknown>;
  const out: GeometryExpect = {};
  if (o['contact'] !== undefined) {
    if (typeof o['contact'] !== 'boolean') return 'expect.contact must be true or false';
    out.contact = o['contact'];
  }
  if (o['gapMm'] !== undefined) {
    const g = o['gapMm'];
    if (!g || typeof g !== 'object' || Array.isArray(g)) return 'expect.gapMm must be {min?, max?}';
    const gm: { min?: number; max?: number } = {};
    for (const k of ['min', 'max'] as const) {
      const v = (g as Record<string, unknown>)[k];
      if (v === undefined || v === null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) return `expect.gapMm.${k} must be a number`;
      gm[k] = n;
    }
    if (gm.min === undefined && gm.max === undefined) return 'expect.gapMm needs min and/or max';
    out.gapMm = gm;
  }
  if (out.contact === undefined && out.gapMm === undefined) return 'expect needs gapMm and/or contact';
  return out;
}

/** Measure one assertion line against `expect` (Phase 4: no longer skipped). */
async function runAssertLine(step: RvMacroAssertStep, index: number, viewer: RVViewer | undefined): Promise<MacroJobReportLine> {
  const base = { step: index + 1, kind: 'assert' as const, check: step.check };
  const args = parseAssertArgs(step.args);
  if (typeof args === 'string') return { ...base, status: 'failed', reason: args, errorKind: 'invalid-args' };
  const expect = parseAssertExpect(step.expect);
  if (typeof expect === 'string') return { ...base, status: 'failed', reason: expect, errorKind: 'invalid-args' };
  const r = await runGeometryCheck(viewer, args);
  if ('error' in r) return { ...base, status: 'failed', reason: r.error, errorKind: r.code };
  const verdict = failedExpectation(r, expect);
  const measured = { gapMm: r.gapMm, contact: r.contact, overlap: r.overlap, contained: r.contained };
  return verdict
    ? { ...base, status: 'failed', reason: verdict, errorKind: 'assertion-failed', measured }
    : { ...base, status: 'ok', measured };
}

function reportStepFailure(job: MacroJob, macro: RvMacro, index: number, line: MacroJobReportLine): void {
  const step = macro.steps[index];
  const path = step && typeof step.args['path'] === 'string'
    ? step.args['path'] as string
    : step && typeof step.args['a'] === 'string' ? step.args['a'] as string : undefined;
  try {
    reportProblem({
      id: `${MACRO_STEP_FAILED}:${job.id}:${index + 1}`,
      severity: 'error',
      code: MACRO_STEP_FAILED,
      title: `Macro "${macro.name}" step ${index + 1} failed: ${line.command ?? (line.check ? `assert ${line.check}` : '')}`,
      detail: `${line.reason ?? 'failed'} — args ${JSON.stringify(step?.args ?? {}).slice(0, 300)}`,
      ...(path ? { nodePath: path } : {}),
    });
  } catch { /* the report never breaks the job */ }
}
