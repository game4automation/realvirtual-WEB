// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getLocalStorage } from '../../core/rv-safe-storage';

/**
 * rv-mcp-command-tools — the reduced command interface of plan-641 (Phase 0)
 * and the ONE execution wrapper every MCP command call goes through.
 *
 * ## Three generic tools (the SolidCraft way, plan §2.3b)
 *
 *  - `web_commands(query?)`  — what the command registry offers;
 *  - `web_execute(command, args, _reason?, _source?, _confidence?)` — one command;
 *  - `web_batch(steps, stopOnError?, stopOnPartial?, background?)` — several.
 *
 * New modelling capabilities arrive as COMMANDS in the registry, never as new
 * tools. The bound `web_editor_*` tools stay as aliases and dispatch through
 * {@link runCommandStep} as well (via `dispatchBoundCommand`).
 *
 * ## runCommandStep (M1/M3/M4/M9)
 *
 * (a) synchronously, BEFORE any await: capture the context (or take the
 * caller's early capture), the document and the note; (b) while a recording
 * runs on that document and the command is `macro: true`: take the step lock,
 * resolve the args through `commandRegistry.prepare()` on the CAPTURED context
 * and deep-copy them; (c) `commandRegistry.execute(..., { origin: 'mcp', context })`
 * inside the step window, then wait for the document queue (M8: the change
 * must have landed when the step ends); (d) {@link classifyCommandOutcome};
 * (e) the macro line. Without a recording the call runs exactly as before —
 * raw args, no lock — and is only classified.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam, type McpCallContext, type ToolCommandBinding, type ToolSchema } from '../../core/engine/rv-mcp-tools';
import {
  commandRegistry,
  type CapturedContext,
  type CommandDescriptor,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import { getActiveAssetContext } from '../../core/editor/active-asset-store';
import { CLASS_RANK, commandClassOf } from './rv-mcp-tool-class';
import { MOVED_TOOLS, movedToolOf } from './rv-mcp-moved-tools';
import { commandsSkipDialogPolicy } from './rv-mcp-command-dialog-policy';
import {
  classifyCommandOutcome,
  jobSummary,
  macroJobs,
  macroRecorder,
  noteOf,
  parseMacroMeta,
  type MacroJob,
  type MacroJobReportLine,
  type MacroMeta,
  type MacroRecorder,
  type MacroRecordingDoc,
  type RvMacroStepResult,
  type StepExecuteResult,
} from './rv-mcp-macro';

// ─── Types ──────────────────────────────────────────────────────────────

let gatewayState: 'none' | 'connect-with-classes' | 'connect-without-classes' = 'none';

export function setGatewayCommandClassesState(state: typeof gatewayState): void {
  gatewayState = state;
}

/** Only migrated commands acquire a new restriction through an older CONNECT. */
export function gatewayOutdatedRefusal(id: string, registry = commandRegistry, moved = MOVED_TOOLS): Record<string, unknown> | null {
  if (gatewayState !== 'connect-without-classes' || !moved.some((m) => m.movedTo.includes(id))) return null;
  const desc = registry.get(id);
  if (!desc) return null;
  const cls = commandClassOf(desc);
  if (CLASS_RANK.indexOf(cls) <= CLASS_RANK.indexOf('edit')) return null;
  return {
    ok: false, command: id, status: 'failed',
    error: `This realvirtual CONNECT cannot classify command ${id} (class ${cls}) — update CONNECT; read and edit commands still run.`,
    kind: 'gateway-outdated',
  };
}

/** Keep the refusal in the ordinary per-step report, including background jobs. */
async function runGatewayCommandStep(req: CommandStepRequest): Promise<CommandStepOutcome> {
  const refusal = gatewayOutdatedRefusal(req.command, req.registry);
  if (!refusal) return runCommandStep(req);
  const reason = String(refusal['error']);
  return {
    result: { ok: false, kind: 'gateway-outdated', reason },
    outcome: { status: 'failed', kind: 'gateway-outdated', reason },
    args: req.args, recorded: false,
  };
}

/** The document surface the wrapper observes — `RvDocument` satisfies it. */
export interface StepDocument extends MacroRecordingDoc {
  whenIdle(): Promise<void>;
}

export interface CommandStepRequest {
  readonly signal?: AbortSignal;
  readonly command: string;
  readonly args: unknown;
  /** Meta arguments of the call (`_reason/_source/_confidence`). */
  readonly meta?: MacroMeta | null;
  /** Early capture (bound aliases: the call context). Absent: captured now. */
  readonly captured?: CapturedContext;
  readonly buttonKey?: string;
  readonly viewer?: RVViewer;
  /** false = never record (replay). Default true. */
  readonly record?: boolean;
  readonly registry?: CommandRegistry;
  readonly recorder?: MacroRecorder;
  /** The document to observe; default: the captured / active one. `null` = none. */
  readonly doc?: StepDocument | null;
}

export interface CommandStepOutcome {
  readonly result: StepExecuteResult;
  readonly outcome: RvMacroStepResult;
  /** The args the command actually ran with (resolved when recorded). */
  readonly args: unknown;
  readonly recorded: boolean;
  /** 1-based index of the recorded line. */
  readonly step?: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** True for a command a macro may contain (M1): flagged `macro` and not read-only. */
export function isMacroCommand(desc: CommandDescriptor<never, unknown> | CommandDescriptor | undefined): boolean {
  return !!desc && desc.macro === true && desc.readOnly === false;
}

/** The op-logged document behind a captured context, else the active one. */
export function stepDocumentOf(captured: CapturedContext | undefined): StepDocument | null {
  const fromHandle = (captured?.handle?.doc as { document?: unknown } | undefined)?.document;
  const doc = fromHandle ?? getActiveAssetContext()?.doc?.document ?? null;
  if (!doc || typeof (doc as StepDocument).onHistoryChange !== 'function') return null;
  return doc as StepDocument;
}

function deepCopy<T>(v: T): T {
  if (v === undefined || v === null) return v;
  try { return JSON.parse(JSON.stringify(v)) as T; } catch { return v; }
}

export interface CommandStepHooks {
  before(id: string, args: Record<string, unknown>, captured: CapturedContext | undefined): Promise<unknown>;
  after(token: unknown, id: string, args: Record<string, unknown>, outcome: CommandStepOutcome): Record<string, unknown> | null;
}

let commandStepHooks: CommandStepHooks | null = null;

export function setCommandStepHooks(h: CommandStepHooks | null): void {
  commandStepHooks = h;
}

/** Only attended execution invokes visual hooks. */
async function runAttendedStep(req: CommandStepRequest): Promise<{ outcome: CommandStepOutcome; delta: Record<string, unknown> | null }> {
  const hooks = commandStepHooks;
  const args = asArgsRecord(req.args);
  let token: unknown;
  let prepared = false;
  try {
    if (hooks) { token = await hooks.before(req.command, args, req.captured); prepared = true; }
  } catch { /* visual hooks must never break execution */ }
  const outcome = await runGatewayCommandStep(req);
  let delta: Record<string, unknown> | null = null;
  try {
    if (hooks && prepared) delta = hooks.after(token, req.command, args, outcome);
  } catch { /* visual hooks must never break execution */ }
  return { outcome, delta };
}

function asArgsRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

// ─── The wrapper ────────────────────────────────────────────────────────

/** THE execution of one command step — `web_execute`, `web_batch`, aliases and replay. */
export async function runCommandStep(req: CommandStepRequest): Promise<CommandStepOutcome> {
  const registry = req.registry ?? commandRegistry;
  const recorder = req.recorder ?? macroRecorder;
  // (a) Synchronous snapshot — nothing below may read the live selection again.
  const captured = req.captured ?? registry.captureContext(req.viewer);
  const doc = req.doc !== undefined ? req.doc : stepDocumentOf(captured);
  const desc = registry.get(req.command);
  const macro = isMacroCommand(desc);
  const note = noteOf(req.meta ?? null, 'agent');
  const execOpts = {
    origin: 'mcp' as const,
    ...(req.buttonKey ? { buttonKey: req.buttonKey } : {}),
    ...(req.viewer ? { viewer: req.viewer } : {}),
    context: captured,
    signal: req.signal,
  };

  const plain = async (): Promise<CommandStepOutcome> => {
    const before = macro && doc ? doc.changeSeq : null;
    const result = await registry.execute(req.command, req.args, execOpts);
    if (macro && doc && result.ok) await doc.whenIdle();
    const changed = before !== null && doc ? doc.changeSeq !== before : null;
    return { result, outcome: classifyCommandOutcome(result, changed), args: req.args, recorded: false };
  };

  if (req.record === false || !macro || !doc || !recorder.isRecordingFor(doc)) return plain();

  // (b) Recording: strictly serial (M9).
  return recorder.withStepLock(async () => {
    if (!recorder.isRecordingFor(doc)) return plain();
    const prep = await registry.prepare(req.command, captured, req.args, req.viewer);
    const at = new Date().toISOString();
    if (!prep.ok) {
      const result: StepExecuteResult = { ok: false, kind: prep.kind, reason: prep.reason };
      const outcome = classifyCommandOutcome(result, null);
      const step = recorder.appendStep(doc, {
        kind: 'command', command: req.command, args: deepCopy(asArgsRecord(req.args)), note, result: outcome, at,
      });
      return { result, outcome, args: req.args, recorded: step !== null, ...(step ? { step } : {}) };
    }
    const stored = deepCopy(asArgsRecord(prep.args));
    // (c) The step window: every history change from here on belongs to this step.
    recorder.openWindow(doc);
    let result: StepExecuteResult;
    let changes: number | null = null;
    try {
      result = await registry.execute(req.command, prep.args, execOpts);
      if (result.ok) await doc.whenIdle();
    } finally {
      changes = recorder.closeWindow(doc);
    }
    // (d) M3, (e) the line — only if the recording survived the step (an undo inside it ends it).
    const outcome = classifyCommandOutcome(result, changes === null ? null : changes > 0);
    const step = recorder.appendStep(doc, { kind: 'command', command: req.command, args: stored, note, result: outcome, at });
    return { result, outcome, args: prep.args, recorded: step !== null, ...(step ? { step } : {}) };
  });
}

// ─── Discovery helpers ──────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Up to five registered ids that look like `id` (for an `unknown` answer). */
export function findSimilarCommands(id: string, registry: CommandRegistry = commandRegistry): string[] {
  const q = id.trim().toLowerCase();
  if (!q) return [];
  const tail = q.split('.').pop() ?? q;
  return registry.list()
    .map((d) => {
      const lid = d.id.toLowerCase();
      const ltail = lid.split('.').pop() ?? lid;
      const contains = lid.includes(tail) || tail.includes(ltail) ? 0 : 1;
      return { id: d.id, score: contains * 100 + Math.min(editDistance(q, lid), editDistance(tail, ltail)) };
    })
    .filter((x) => x.score < 100 + Math.max(3, Math.floor(tail.length / 2)))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((x) => x.id);
}

/** The meta properties announced on every macro-capable tool (plan §9.2). */
export const MACRO_META_PROPERTIES: Readonly<Record<string, { type: string; description: string }>> = {
  _reason: { type: 'string', description: 'Why this change (stored with the macro line, never executed). Optional.' },
  _source: { type: 'string', description: 'Where the reason comes from, e.g. "parts:DFM-6-5", "knowledge:<node>", "customer:<who>/<date>". Optional.' },
  _confidence: { type: 'string', description: 'observed | inferred | unverified — how the reason was obtained. Optional.' },
};

function bindingIds(binding: ToolCommandBinding | undefined): string[] {
  if (!binding) return [];
  return typeof binding === 'string' ? [binding] : binding.branches.map((b) => b.id);
}

/**
 * Names of the bound tools whose command(s) are macro-capable — the aliases
 * that accept `_reason/_source/_confidence` (stripped centrally in `_handleCall`).
 */
export function macroCapableToolNames(
  dispatcher: ReadonlyMap<string, { command?: ToolCommandBinding }>,
  registry: CommandRegistry = commandRegistry,
): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of dispatcher) {
    if (bindingIds(entry.command).some((id) => isMacroCommand(registry.get(id)))) out.add(name);
  }
  return out;
}

/** Add the optional meta properties to the schemas of the named tools (never to read-only ones). */
export function withMacroMetaParams(schemas: readonly ToolSchema[], names: ReadonlySet<string>): ToolSchema[] {
  return schemas.map((s) => {
    if (!names.has(s.name) || s.annotations?.readOnlyHint === true) return s;
    const properties = { ...s.inputSchema.properties };
    for (const [k, v] of Object.entries(MACRO_META_PROPERTIES)) if (!properties[k]) properties[k] = { ...v };
    return { ...s, inputSchema: { ...s.inputSchema, properties } };
  });
}

// ── plan-641 Nachtrag 2026-10-21: aliases out of tools/list ──

/** localStorage key of the emergency switch that lists the bound aliases again. */
export const LIST_ALIASES_STORAGE_KEY = 'rv-mcp-list-aliases';

/**
 * Whether the command-bound alias tools are listed in `tools/list`. Default false
 * (hidden, still callable). Emergency switch: URL `?mcpAliases=1` or
 * `localStorage['rv-mcp-list-aliases'] = '1'` (reconnect / reload); on the Node
 * bridge additionally `RV_MCP_LIST_ALIASES=1`.
 */
export function aliasesListed(
  search: string | undefined = typeof location !== 'undefined' ? location.search : undefined,
  storage: Pick<Storage, 'getItem'> | undefined = getLocalStorage() ?? undefined,
): boolean {
  try {
    const q = new URLSearchParams(search ?? '').get('mcpAliases');
    if (q !== null) return q === '1' || q === 'true';
  } catch { /* no URL */ }
  try {
    return storage?.getItem(LIST_ALIASES_STORAGE_KEY) === '1';
  } catch { return false; }
}

/** Names of all tools bound to one or more registry commands (the aliases). */
export function boundAliasToolNames(
  dispatcher: ReadonlyMap<string, { command?: ToolCommandBinding }>,
): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of dispatcher) if (bindingIds(entry.command).length > 0) out.add(name);
  return out;
}

/** Mark the named aliases `listed: false` unless `listAll` (the emergency switch). */
export function withAliasListing(schemas: readonly ToolSchema[], aliases: ReadonlySet<string>, listAll: boolean): ToolSchema[] {
  return schemas.map((s) => (s.tombstone === true || (!listAll && aliases.has(s.name)) ? { ...s, listed: false } : s));
}

/** command id -> description of its alias tool, so `web_commands` explains commands without the aliases. */
const aliasDescriptions = new Map<string, { tool: string; description: string }>();

/** Rebuilt on every discover from the dispatcher bindings and the tool schemas. */
export function setAliasDescriptions(
  dispatcher: ReadonlyMap<string, { command?: ToolCommandBinding }>,
  schemas: readonly ToolSchema[],
): void {
  aliasDescriptions.clear();
  const byName = new Map(schemas.map((s) => [s.name, s.description]));
  for (const [name, entry] of dispatcher) {
    const d = byName.get(name);
    if (!d) continue;
    for (const id of bindingIds(entry.command)) if (!aliasDescriptions.has(id)) aliasDescriptions.set(id, { tool: name, description: d });
  }
}

/** The alias description of a command, if a bound tool exists. */
export function aliasDescriptionOf(id: string): { tool: string; description: string } | undefined {
  return aliasDescriptions.get(id);
}

/**
 * Unbound tools that still take the bridge's early call context as their
 * trailing parameter (plan-641 M4): `web_execute` resolves its command's
 * selection fallback against the selection at CALL BEGIN, exactly like a bound
 * alias. (`web_batch` captures fresh per step, M1.)
 */
export const CALL_CONTEXT_TOOLS: ReadonlySet<string> = new Set(['web_execute', 'web_query']);

// ─── Batch (shared with the macro tools) ────────────────────────────────

/** One parsed batch step. */
export interface BatchStep {
  readonly command: string;
  readonly args: Record<string, unknown>;
  readonly meta: MacroMeta | null;
}

/** Parse `steps` (JSON array string or array) into batch steps, or say why not. */
export function parseBatchSteps(raw: unknown): BatchStep[] | { error: string } {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return { error: 'steps must be a JSON array of {command, args?, _reason?, _source?, _confidence?}' }; }
  }
  if (!Array.isArray(list) || list.length === 0) return { error: 'steps must be a non-empty JSON array' };
  const out: BatchStep[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: `step ${i + 1}: must be an object` };
    const command = typeof s?.['command'] === 'string' ? s['command'].trim() : '';
    if (!command) return { error: `step ${i + 1}: "command" is required` };
    let args: unknown = s?.['args'] ?? {};
    if (typeof args === 'string') {
      try { args = args.trim() ? JSON.parse(args) : {}; } catch { return { error: `step ${i + 1}: args is not valid JSON` }; }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: `step ${i + 1}: args must be an object` };
    out.push({ command, args: args as Record<string, unknown>, meta: parseMacroMeta(s ?? {}) });
  }
  return out;
}

export interface StopRules { readonly stopOnError: boolean; readonly stopOnPartial: boolean }

/** M3: `failed` stops with stopOnError, `partial` additionally with stopOnPartial; `requires-commercial` never stops. */
export function shouldStop(status: RvMacroStepResult['status'], rules: StopRules): boolean {
  if (status === 'failed') return rules.stopOnError;
  if (status === 'partial') return rules.stopOnPartial;
  return false;
}

function reportLine(index: number, command: string, o: CommandStepOutcome): MacroJobReportLine {
  return {
    step: index + 1, kind: 'command', command, status: o.outcome.status,
    ...(o.outcome.reason ? { reason: o.outcome.reason } : {}),
    ...(o.outcome.kind ? { errorKind: o.outcome.kind } : {}),
    ...(o.outcome.created ? { created: o.outcome.created } : {}),
  };
}

// ─── Tools ──────────────────────────────────────────────────────────────

function parseArgsParam(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, args: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, args: raw as Record<string, unknown> };
  if (typeof raw !== 'string') return { ok: false, error: 'args must be a JSON object string' };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? { ok: true, args: v as Record<string, unknown> }
      : { ok: false, error: 'args must be a JSON object' };
  } catch {
    return { ok: false, error: 'args is not valid JSON' };
  }
}

/** Serialise a step outcome the way every command tool answers. */
export function stepOutcomeJson(command: string, o: CommandStepOutcome, registry: CommandRegistry = commandRegistry): Record<string, unknown> {
  const r = o.result;
  const base: Record<string, unknown> = {
    ok: r.ok && o.outcome.status !== 'failed',
    command,
    status: o.outcome.status,
    recorded: o.recorded,
    ...(o.step ? { macroStep: o.step } : {}),
    ...(o.outcome.created ? { created: o.outcome.created } : {}),
  };
  if (r.ok) return { ...base, value: r.value };
  return {
    ...base,
    error: r.reason ?? 'Nothing to do',
    kind: r.kind,
    ...(r.details ? { details: r.details } : {}),
    ...(r.kind === 'unknown' ? { similar: findSimilarCommands(command, registry) } : {}),
  };
}

export class McpCommandTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  @McpTool('List the command registry — the vocabulary of model changes: id, label, argsSchema, readOnly, macro (recorded via MCP), available, alias tool. Run one with web_execute, several with web_batch. Guide: web_help(commands).', { readOnly: true })
  async webCommands(
    @McpParam('query', 'Substring of id, label or tool.', 'string', false) query?: string,
  ): Promise<string> {
    const q = (query ?? '').trim().toLowerCase();
    const rows = commandRegistry.list()
      .map((d) => {
        const label = commandRegistry.labelOf(d.id, {});
        return {
          id: d.id, label, argsSchema: d.argsSchema, readOnly: d.readOnly,
          door: d.readOnly ? 'web_query' : 'web_execute',
          ...(d.destructive ? { destructive: true } : {}),
          macro: isMacroCommand(d),
          available: d.available,
          ...(d.available ? {} : { unavailableReason: d.unavailableReason }),
          scope: d.scope,
          ...(d.shortcut ? { shortcut: d.shortcut } : {}),
          ...(d.mcp && !movedToolOf(d.mcp.tool) ? { tool: d.mcp.tool } : aliasDescriptionOf(d.id) ? { tool: aliasDescriptionOf(d.id)!.tool } : {}),
          ...(aliasDescriptionOf(d.id) ? { description: aliasDescriptionOf(d.id)!.description } : {}),
        };
      })
      .filter((r) => !q || r.id.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)
        || (r.tool ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({ count: rows.length, commands: rows });
  }

  @McpTool('Run ONE registry command by id — same rule, refusal and undo step as its button. Returns status (ok | partial | noop | failed | requires-commercial) with value or error + kind; an unknown id lists similar ids.', { readOnly: false, timeoutMs: 120_000 })
  async webExecute(
    @McpParam('command', 'Command id, e.g. "editor.setField".') command: string,
    @McpParam('args', 'Args as JSON object.', 'string', false) args?: string,
    @McpParam('_reason', 'Why (macro note).', 'string', false) _reason?: string,
    @McpParam('_source', 'Source, e.g. parts:DFM-6-5.', 'string', false) _source?: string,
    @McpParam('_confidence', 'observed | inferred | unverified.', 'string', false) _confidence?: string,
    @McpParam('background', 'Return a jobId at once (poll web_macro_status).', 'boolean', false) background?: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this.executeOne(command, args, background, ctx, parseMacroMeta({ _reason, _source, _confidence }));
  }

  @McpTool('Run ONE read-only registry command by id (domain queries: inspect, list, status). Same answer shape as web_execute; a writing command is refused with kind not-read-only — use web_execute for it. Guide: web_help(commands).', { readOnly: true, timeoutMs: 120_000 })
  async webQuery(
    @McpParam('command', 'Command id.') command: string,
    @McpParam('args', 'Args as JSON object.', 'string', false) args?: string,
    @McpParam('background', 'Return a jobId at once (poll web_macro_status).', 'boolean', false) background?: boolean,
    ctx?: McpCallContext,
  ): Promise<string> {
    return this.executeOne(command, args, background, ctx, null, true);
  }

  private async executeOne(command: string, args: unknown, background: boolean | undefined, ctx: McpCallContext | undefined, meta: MacroMeta | null, readOnly = false): Promise<string> {
    const id = String(command ?? '').trim();
    if (!id) return JSON.stringify({ error: 'command is required' });
    const desc = commandRegistry.get(id);
    if (!readOnly) {
      const refusal = gatewayOutdatedRefusal(id);
      if (refusal) return JSON.stringify(refusal);
    }
    if (readOnly && desc && desc.readOnly !== true) {
      return JSON.stringify({ ok: false, command: id, status: 'failed', error: `${id} is not read-only — use web_execute`, kind: 'not-read-only', use: 'web_execute' });
    }
    const parsed = parseArgsParam(args);
    if (!parsed.ok) return JSON.stringify({ error: parsed.error });
    const viewer = this.viewer;
    commandRegistry.attachViewer(viewer);
    const req: CommandStepRequest = {
      command: id, args: parsed.args, viewer,
      meta,
      // The bridge's capture at call begin (M4); a direct call captures now.
      captured: ctx ? { handle: ctx.handle, selection: ctx.selection } : commandRegistry.captureContext(viewer),
    };
    const auto = (desc?.timeoutMs ?? 0) > 120_000;
    if (desc && (background === true || auto)) {
      const doc = stepDocumentOf(req.captured);
      let job: MacroJob;
      try {
        job = macroJobs.create('execute', id, documentKeyOf(doc), 1);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      if (desc.cancellable === true) job.abort = new AbortController();
      void runExecuteJob(job, { ...req, doc, signal: job.abort?.signal }, doc, !readOnly);
      return JSON.stringify({ jobId: job.id, state: job.state, total: 1, poll: 'web_macro_status', ...(auto ? { reason: 'long-running command' } : {}) });
    }
    const { outcome, delta } = readOnly
      ? { outcome: await runCommandStep(req), delta: null }
      : await runAttendedStep(req);
    return JSON.stringify({ ...stepOutcomeJson(id, outcome), ...(delta !== null ? { delta } : {}) });
  }

  @McpTool('Run several registry commands in order like web_execute. Stops at a failed step (stopOnError, default true) or a partial one (stopOnPartial); background=true returns a jobId for web_macro_status.', { readOnly: false, timeoutMs: 120_000 })
  async webBatch(
    @McpParam('steps', 'JSON array of {command, args?, _reason?, _source?, _confidence?}.') steps: string,
    @McpParam('stopOnError', 'Default true.', 'boolean', false) stopOnError?: boolean,
    @McpParam('stopOnPartial', 'Default false.', 'boolean', false) stopOnPartial?: boolean,
    @McpParam('background', 'Return a jobId at once.', 'boolean', false) background?: boolean,
  ): Promise<string> {
    const parsed = parseBatchSteps(steps);
    if ('error' in parsed) return JSON.stringify({ error: parsed.error });
    const rules: StopRules = { stopOnError: stopOnError !== false, stopOnPartial: stopOnPartial === true };
    const viewer = this.viewer;
    commandRegistry.attachViewer(viewer);
    if (background) {
      const doc = stepDocumentOf(commandRegistry.captureContext(viewer));
      const key = documentKeyOf(doc);
      let job: MacroJob;
      try {
        job = macroJobs.create('batch', `batch(${parsed.length})`, key, parsed.length);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      void runBatchJob(job, parsed, rules, viewer, doc);
      return JSON.stringify({ jobId: job.id, state: job.state, total: job.total, poll: 'web_macro_status' });
    }
    const report: MacroJobReportLine[] = [];
    let stopped: { step: number; status: string } | null = null;
    for (let i = 0; i < parsed.length; i++) {
      const s = parsed[i];
      const captured = commandRegistry.captureContext(viewer);
      const { outcome: o, delta } = await runAttendedStep({ command: s.command, args: s.args, meta: s.meta, viewer, captured });
      report.push({ ...reportLine(i, s.command, o), ...(delta !== null ? { delta } : {}) });
      if (shouldStop(o.outcome.status, rules)) { stopped = { step: i + 1, status: o.outcome.status }; break; }
    }
    const ok = report.every((l) => l.status !== 'failed');
    return JSON.stringify({
      ok, total: parsed.length, ran: report.length,
      ...(stopped ? { stopped } : {}),
      steps: report,
    });
  }
}

/** A stable key for "the same document" across job steps. */
export function documentKeyOf(doc: object | null | undefined): string {
  if (!doc) return '';
  const id = (doc as { id?: unknown }).id;
  return typeof id === 'string' ? id : 'doc';
}

/**
 * The editor's modal dialogs settle on a click. A JOB line runs outside any
 * `_handleCall` (the call that started the job has long answered), so it
 * installs the same dialog policy an MCP call gets, per line (M1).
 */
export async function runWithDialogPolicy<T>(fn: () => Promise<T>, commandIds?: readonly string[]): Promise<T> {
  if (commandIds && commandsSkipDialogPolicy(commandIds)) return fn();
  let release: (() => unknown) | null = null;
  try {
    const { installMcpDialogPolicy } = await import('./rv-mcp-dialog-policy');
    release = await installMcpDialogPolicy();
  } catch { release = null; }
  try {
    return await fn();
  } finally {
    try { release?.(); } catch { /* never breaks the line */ }
  }
}

/** Single-command job retains its full result and supports cooperative cancellation. */
async function runExecuteJob(job: MacroJob, req: CommandStepRequest, doc: StepDocument | null, gate: boolean): Promise<void> {
  try {
    const o = await runWithDialogPolicy(() => gate ? runGatewayCommandStep(req) : runCommandStep(req), [req.command]);
    job.report.push({
      ...reportLine(0, req.command, o),
      ...(o.result.ok ? { value: o.result.value } : {}),
      ...(!o.result.ok || o.outcome.status === 'failed' ? { error: o.outcome.reason ?? 'Command failed' } : {}),
    });
    job.done = 1;
    if (stepDocumentOf(commandRegistry.captureContext(req.viewer)) !== doc) {
      macroJobs.finish(job, 'aborted', 'document-changed');
    } else {
      macroJobs.finish(job, job.abort?.signal.aborted ? 'cancelled' : 'done');
    }
  } catch (e) {
    if (stepDocumentOf(commandRegistry.captureContext(req.viewer)) !== doc) {
      macroJobs.finish(job, 'aborted', 'document-changed');
      return;
    }
    const error = e instanceof Error ? e.message : String(e);
    job.report.push({ step: 1, kind: 'command', command: req.command, status: 'failed', error, reason: error });
    job.done = 1;
    macroJobs.finish(job, job.abort?.signal.aborted ? 'cancelled' : 'done');
  }
}

/** Background batch: the same steps as the synchronous path, as a job (M2). */
async function runBatchJob(
  job: MacroJob, steps: readonly BatchStep[], rules: StopRules, viewer: RVViewer | undefined, doc: StepDocument | null,
): Promise<void> {
  try {
    for (let i = 0; i < steps.length; i++) {
      if (job.cancelRequested) { macroJobs.finish(job, 'cancelled'); return; }
      // M2: a job is bound to the document it started on.
      if (stepDocumentOf(commandRegistry.captureContext(viewer)) !== doc) {
        macroJobs.finish(job, 'aborted', 'document-changed');
        return;
      }
      const s = steps[i];
      const o = await runWithDialogPolicy(() => runGatewayCommandStep({ command: s.command, args: s.args, meta: s.meta, viewer }), [s.command]);
      job.report.push(reportLine(i, s.command, o));
      job.done = i + 1;
      if (shouldStop(o.outcome.status, rules)) break;
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    macroJobs.finish(job, 'done');
  } catch (e) {
    macroJobs.finish(job, 'aborted', e instanceof Error ? e.message : String(e));
  }
}

/** Re-exported for the status tool. */
export { jobSummary };
