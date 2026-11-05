// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { bumpModelEditEpoch, modelEditEpoch } from '../engine/rv-model-edit-epoch';
/**
 * rv-command-registry — ONE definition per user action (plan-499).
 *
 * A command is the single source of truth for label, availability, the
 * "why not" reason and the execution of an action. Buttons, context-menu items,
 * keyboard handlers and MCP tool bodies are VIEWS: they all go through
 * {@link CommandRegistry.execute}, so the reason a button shows as tooltip is by
 * construction the reason an agent receives as `{error}`.
 *
 * Descriptor / implementation split: the descriptor (id, label, capability,
 * args shape, MCP mirror, lazy `impl` loader) is eager and lives in the open
 * core; the implementation (`enabled` + `run`) may live in the private asset
 * editor and is loaded on first use. The community build's stub answers
 * `impls = {}`, and the descriptor's eager `available` flag turns that into
 * {@link ERR_EDITOR_UNAVAILABLE} BEFORE any mode guard runs.
 *
 * Dispatch order (plan-499 §2.4): unknown → available → context/guard (with
 * the caller's early identity capture) → lazy impl → identity recheck →
 * visible → enabled → identity recheck → run → onExecuted.
 *
 * The registry is origin-agnostic: it never knows "AI". The MCP bridge listens
 * to {@link CommandRegistry.onExecuted} and turns `origin: 'mcp'` into the
 * afterglow; buttons and keys pass `'ui'` / `'shortcut'`.
 */

import type { RVViewer } from '../rv-viewer';
import type { McpToolClassName } from '../engine/rv-mcp-tools';
import type { AssetDocument } from '../editor/rv-asset-document';
import { getActiveAssetContext } from '../editor/active-asset-store';
import {
  ERR_DOCUMENT_CHANGED,
  ERR_EDITOR_UNAVAILABLE,
  ERR_NO_VIEWER,
  isGuardError,
  requireDocument,
  sameDocument,
  type DocumentHandle,
} from '../editor/rv-editor-guard-core';

/**
 * Synchronous answer while an AVAILABLE command's implementation is still
 * loading. Deliberately NOT the descriptor's `unavailableReason`: in the
 * private build that text ("not available in this edition") would be a lie
 * for the first frames after mount (spike finding 1).
 */
export const COMMAND_LOADING_REASON = 'Loading…';

// ─── Types ──────────────────────────────────────────────────────────────

export type CommandOrigin = 'ui' | 'mcp' | 'shortcut';

/** `true`, or the ONE reason (tooltip AND tool result). `details` only reaches the tool result. */
export type CommandEnabled = true | { readonly reason: string; readonly details?: Readonly<Record<string, unknown>> };

/** Which document gate a command needs before its implementation is consulted. */
export type CommandScope = 'editor' | 'none';

/** Types a command argument may have (parity gate: branch transformations are checked against these). */
export type CommandArgType = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'object[]';

export interface CommandContext {
  /** Cooperative cancellation supplied by the caller. */
  readonly signal?: AbortSignal;
  readonly viewer: RVViewer;
  /** The document open in the editor, null for commands with scope 'none'. */
  readonly doc: AssetDocument | null;
  /** Selection snapshot — captured at the EARLIEST step of the call (bridge: call begin). */
  readonly selection: readonly string[];
  readonly mode: string;
  /** R5 identity handle, captured together with `selection`; null for scope 'none'. */
  readonly handle: DocumentHandle | null;
  /**
   * Who triggered the dispatch — set by {@link CommandRegistry.execute}, absent in
   * the synchronous {@link CommandRegistry.enabled} (a rule never depends on it).
   * Only for ATTRIBUTION inside `run()` (a signal write is booked as 'mcp' or
   * 'hmi'); the registry itself stays origin-agnostic.
   */
  readonly origin?: CommandOrigin;
}

export interface CommandImpl<A = unknown, R = unknown> {
  /** Visibility (VS Code `when`): false → view hidden, execute → 'invisible'. */
  visible?(ctx: CommandContext): boolean;
  /** THE one availability rule — tooltip AND tool result. Formulated on the ARGS. */
  enabled(ctx: CommandContext, args: A): CommandEnabled;
  run(ctx: CommandContext, args: A): R | Promise<R>;
  /**
   * plan-641 M4 — turn the args into EXPLICIT values against a captured context:
   * every "null = take it from the selection", every default, every trim the
   * implementation would apply silently. A replay of the result must do the
   * same thing whatever is selected then. Pure and synchronous, no side effects.
   * MANDATORY for a command whose descriptor says `macro: true`.
   */
  resolveArgs?(ctx: CommandContext, args: A): A;
}

/** MCP mirror of a 1:1 tool — checked against the decorator by the parity gate. */
export interface CommandMcpMirror {
  readonly tool: string;
  readonly params: readonly { readonly name: string; readonly type: string; readonly required: boolean }[];
}

export interface CommandDescriptor<A = unknown, R = unknown> {
  readonly id: string;
  readonly label: string | ((args: A) => string);
  /** Icon name from a small map (no MUI import in the core). */
  readonly icon?: string;
  /** Full chord for badge and MCP table: 'S>I', 'H', 'Shift+H', 'Ctrl+Z'. */
  readonly shortcut?: string;
  readonly readOnly: boolean;
  /** Above the 120 s web_execute timeout, execution automatically runs as a job. */
  readonly timeoutMs?: number;
  /** The implementation honours ctx.signal for cooperative cancellation. */
  readonly cancellable?: boolean;
  /** CONNECT class override where the derived command class would be wrong. */
  readonly toolClass?: McpToolClassName;
  readonly destructive?: boolean;
  /** Goes 1:1 into `doc.withTransaction(label)` by the implementation. */
  readonly undoLabel?: string | ((args: A) => string);
  readonly scope: CommandScope;
  /** Eager capability (F20): false in a build without the implementation (community stub). */
  readonly available: boolean;
  /** Reason when unavailable / when the loader answers null. */
  readonly unavailableReason: string;
  /** Target button for choreography + afterglow, derived from args. Default: id. */
  readonly buttonKey?: (args: A) => string;
  /** MCP mirror for 1:1-bound tools (parity gate). */
  readonly mcp?: CommandMcpMirror;
  /** Shape of the COMMAND args (name → type); a `null` value means "take it from the context". */
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  /** Lazy implementation. Stub build: resolves null. */
  readonly impl: () => Promise<CommandImpl<A, R> | null>;
  /**
   * An OPEN implementation that is already in memory (planner, sim, runtime
   * commands). Cached at `register()`, so `enabled()` answers without a
   * `preload` and a key/click dispatch runs in the caller's tick — exactly like
   * the direct call it replaces. `impl` must resolve the same object.
   */
  readonly eagerImpl?: CommandImpl<A, R>;
  /**
   * plan-641 — the command changes the DOCUMENT (model), so an MCP call of it is
   * recorded as a macro line. Requires `readOnly: false` and an implementation
   * with `resolveArgs`, and `run()` must resolve only after the change is
   * applied (M8). Runtime / view / selection / history commands never carry it.
   */
  readonly macro?: boolean;
}

/** Result of {@link CommandRegistry.prepare}: the resolved args, or why the command cannot run. */
export type PrepareResult<A = unknown> =
  | { readonly ok: true; readonly args: A; readonly resolved: boolean }
  | { readonly ok: false; readonly reason: string; readonly kind: ExecuteFailureKind };

/** Early capture of the call's context (bridge: at call begin, before any wait). */
export interface CapturedContext {
  readonly handle: DocumentHandle | null;
  readonly selection: readonly string[];
}

export interface ExecuteOptions {
  /** Cooperative cancellation forwarded to the command context. */
  readonly signal?: AbortSignal;
  readonly origin: CommandOrigin;
  readonly buttonKey?: string;
  /** Viewer override; default is the attached viewer, then the active asset context's. */
  readonly viewer?: RVViewer;
  /** Pre-captured handle + selection (bridge path). Absent: captured now (UI click). */
  readonly context?: CapturedContext;
}

export type ExecuteFailureKind = 'disabled' | 'unknown' | 'invisible' | 'unavailable' | 'stale' | 'threw' | 'commercial-feature';

export type ExecuteResult<R = unknown> =
  | { readonly ok: true; readonly value: R }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly kind: ExecuteFailureKind;
    /** Extra fields for the tool result (e.g. the list of available types); never shown in a tooltip. */
    readonly details?: Readonly<Record<string, unknown>>;
  };

export interface ExecutedEvent {
  readonly id: string;
  readonly args: unknown;
  readonly origin: CommandOrigin;
  readonly buttonKey: string;
  readonly result: ExecuteResult;
}

/**
 * A failure that happens INSIDE `run()` after `enabled()` said yes (a
 * verification that did not land, a refused op). Thrown by implementations;
 * `execute` turns it into `{ok:false, kind:'threw' (or its kind), reason, details}`.
 */
export class CommandError extends Error {
  constructor(message: string, readonly details?: Readonly<Record<string, unknown>>, readonly kind?: ExecuteFailureKind) {
    super(message);
    this.name = 'CommandError';
  }
}

// ─── Registry ───────────────────────────────────────────────────────────

type AnyDescriptor = CommandDescriptor<unknown, unknown>;
type AnyImpl = CommandImpl<unknown, unknown>;
type ContextOrRefusal = CommandContext | { readonly error: string; readonly kind: ExecuteFailureKind };

const commercialPrefixes = new Map<string, string>();
export function registerCommercialPrefix(prefix: string, reason: string): () => void {
  commercialPrefixes.set(prefix, reason);
  return () => { if (commercialPrefixes.get(prefix) === reason) commercialPrefixes.delete(prefix); };
}
const commercialReason = 'experiment manager is a commercial module (realvirtual Commercial)';
registerCommercialPrefix('experiment.', commercialReason);
// plan-2208b B4: checkpoint autosave of a live run (des.checkpoints.set, des.checkpoint.list/.load)
// belongs to the experiment manager since plan-2211 F1. Only unknown ids reach this table, so the
// core des.* commands are unaffected.
registerCommercialPrefix('des.checkpoint', 'live checkpoints are part of the experiment manager, a commercial module (realvirtual Commercial)');
function unknownFailure(id: string): Extract<ExecuteResult, { ok: false }> {
  for (const [prefix, reason] of commercialPrefixes) {
    if (id.startsWith(prefix)) return { ok: false, kind: 'commercial-feature', reason, details: { module: 'des-experiments' } };
  }
  return { ok: false, kind: 'unknown', reason: `Unknown command: ${id}` };
}

export class CommandRegistry {
  private readonly _descs = new Map<string, { desc: AnyDescriptor; gen: number }>();
  private readonly _impls = new Map<string, AnyImpl | null>();
  private readonly _loading = new Map<string, Promise<AnyImpl | null>>();
  private readonly _executed = new Set<(e: ExecutedEvent) => void>();
  /** plan-2237: called with the id when a dispatch begins (recording seam). */
  dispatchHook?: ((id: string) => void) | null;
  private readonly _listeners = new Set<() => void>();
  private _gen = 0;
  private _version = 0;
  private _viewer: RVViewer | undefined;

  /** Default viewer for context building (the bridge and the editor plugin attach it). */
  attachViewer(viewer: RVViewer | undefined): void {
    this._viewer = viewer;
  }

  register<A, R>(desc: CommandDescriptor<A, R>): () => void {
    const gen = ++this._gen;
    this._descs.set(desc.id, { desc: desc as unknown as AnyDescriptor, gen });
    if (desc.eagerImpl) this._impls.set(desc.id, desc.eagerImpl as unknown as AnyImpl);
    else this._impls.delete(desc.id);
    this._loading.delete(desc.id);
    this._bump();
    return () => {
      const cur = this._descs.get(desc.id);
      if (cur && cur.gen === gen) {
        this._descs.delete(desc.id);
        this._impls.delete(desc.id);
        this._bump();
      }
    };
  }

  get(id: string): AnyDescriptor | undefined {
    return this._descs.get(id)?.desc;
  }

  list(): readonly AnyDescriptor[] {
    return [...this._descs.values()].map((e) => e.desc);
  }

  /** The button key a dispatch of `id` with `args` targets. */
  buttonKeyOf(id: string, args: unknown): string {
    const desc = this.get(id);
    try {
      return desc?.buttonKey?.(args) ?? id;
    } catch {
      return id;
    }
  }

  /** The human label of a dispatch (activity pill, button text). */
  labelOf(id: string, args: unknown): string {
    const desc = this.get(id);
    if (!desc) return id;
    if (typeof desc.label === 'string') return desc.label;
    try { return desc.label(args); } catch { return id; }
  }

  /** Load implementations up front so {@link enabled} answers synchronously. */
  async preload(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => this._loadImpl(id)));
  }

  /**
   * Synchronous availability for views and the bridge preflight. Same order as
   * {@link execute} up to `enabled()`; an implementation that is not loaded yet
   * reports {@link COMMAND_LOADING_REASON} (callers `preload` on mount/activation).
   */
  enabled(id: string, args: unknown, viewer?: RVViewer, context?: CapturedContext): CommandEnabled {
    const desc = this.get(id);
    if (!desc) return { reason: `Unknown command: ${id}` };
    if (!desc.available) return { reason: ERR_EDITOR_UNAVAILABLE };
    const ctx = this._buildContext(desc, viewer, context);
    if ('error' in ctx) return { reason: ctx.error };
    if (!this._impls.has(id)) return { reason: COMMAND_LOADING_REASON };
    const impl = this._impls.get(id);
    if (!impl) return { reason: desc.unavailableReason };
    if (impl.visible && !impl.visible(ctx)) return { reason: desc.unavailableReason };
    try {
      return impl.enabled(ctx, args);
    } catch (e) {
      return { reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async execute<R = unknown>(id: string, args: unknown, opts: ExecuteOptions): Promise<ExecuteResult<R>> {
    try { this.dispatchHook?.(id); } catch { /**/ }
    const desc = this.get(id);
    const buttonKey = opts.buttonKey ?? this.buttonKeyOf(id, args);
    const done = (result: ExecuteResult): ExecuteResult<R> => {
      const e: ExecutedEvent = { id, args, origin: opts.origin, buttonKey, result };
      for (const l of this._executed) {
        try { l(e); } catch { /* a listener never breaks the dispatch */ }
      }
      return result as ExecuteResult<R>;
    };

    // 1. unknown
    if (!desc) return done(unknownFailure(id));
    // 2. eager capability — BEFORE the mode guard (F20)
    if (!desc.available) return done({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
    // 3. context + guard (reuses the guard-core texts, never copies them)
    const built = this._buildContext(desc, opts.viewer, opts.context);
    if ('error' in built) return done({ ok: false, kind: built.kind, reason: built.error });
    const ctx: CommandContext = { ...built, origin: opts.origin, signal: opts.signal };
    // 4. lazy impl, then identity recheck (the loader may have taken a while).
    //    A cached impl is taken WITHOUT an await, so an already loaded command
    //    runs synchronously up to its own first await — a key press or a click
    //    has its effect in the same tick, as the direct call it replaced did.
    const impl = this._impls.has(id) ? (this._impls.get(id) ?? null) : await this._loadImpl(id);
    if (!impl) return done({ ok: false, kind: 'unavailable', reason: desc.unavailableReason });
    if (!this._stillSame(ctx)) return done({ ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED });
    // 5. visible
    if (impl.visible && !impl.visible(ctx)) {
      return done({ ok: false, kind: 'invisible', reason: desc.unavailableReason });
    }
    // 6. enabled — THE reason
    let en: CommandEnabled;
    try {
      en = impl.enabled(ctx, args);
    } catch (e) {
      return done({ ok: false, kind: 'threw', reason: e instanceof Error ? e.message : String(e) });
    }
    if (en !== true) {
      return done({
        ok: false, kind: 'disabled', reason: en.reason, ...(en.details ? { details: en.details } : {}),
      });
    }
    // 7. second identity recheck right before run
    if (!this._stillSame(ctx)) return done({ ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED });
    try {
      const epochBefore = modelEditEpoch();
      const value = await impl.run(ctx, args);
      if (desc.undoLabel && modelEditEpoch() === epochBefore) bumpModelEditEpoch('model-command');
      return done({ ok: true, value });
    } catch (e) {
      const details = e instanceof CommandError ? e.details : undefined;
      return done({
        ok: false, kind: (e instanceof CommandError && e.kind) || 'threw', reason: e instanceof Error ? e.message : String(e),
        ...(details ? { details } : {}),
      });
    }
  }

  /**
   * plan-641 M4 — resolve a command's args against an EARLY captured context,
   * without running it. Loads the implementation lazily (the result does not
   * depend on how long that takes: the context is the captured one), rechecks
   * the document identity and calls the implementation's `resolveArgs`. An
   * implementation without `resolveArgs` hands the args back unchanged
   * (`resolved: false`). Never throws.
   */
  async prepare<A = unknown>(
    id: string, captured: CapturedContext, args: A, viewer?: RVViewer,
  ): Promise<PrepareResult<A>> {
    const desc = this.get(id);
    if (!desc) return unknownFailure(id);
    if (!desc.available) return { ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE };
    const built = this._buildContext(desc, viewer, captured);
    if ('error' in built) return { ok: false, kind: built.kind, reason: built.error };
    const impl = this._impls.has(id) ? (this._impls.get(id) ?? null) : await this._loadImpl(id);
    if (!impl) return { ok: false, kind: 'unavailable', reason: desc.unavailableReason };
    if (!this._stillSame(built)) return { ok: false, kind: 'stale', reason: ERR_DOCUMENT_CHANGED };
    if (!impl.resolveArgs) return { ok: true, args, resolved: false };
    try {
      return { ok: true, args: impl.resolveArgs(built, args as never) as A, resolved: true };
    } catch (e) {
      return { ok: false, kind: 'threw', reason: e instanceof Error ? e.message : String(e) };
    }
  }

  onExecuted(listener: (e: ExecutedEvent) => void): () => void {
    this._executed.add(listener);
    return () => { this._executed.delete(listener); };
  }

  /** Capture handle + selection NOW — what the bridge does at call begin. */
  captureContext(viewer?: RVViewer): CapturedContext {
    const v = this._resolveViewer(viewer);
    const h = requireDocument(v, 'editor');
    return {
      handle: isGuardError(h) ? null : h,
      selection: [...(v?.selectionManager?.getSnapshot?.().selectedPaths ?? [])],
    };
  }

  // useSyncExternalStore surface (registration / load version)
  readonly subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  readonly getSnapshot = (): number => this._version;

  /** Test hook: drop the loaded-impl cache and the attached viewer (descriptors stay; eager impls re-seed). */
  _resetForTest(): void {
    this._impls.clear();
    this._loading.clear();
    for (const { desc } of this._descs.values()) if (desc.eagerImpl) this._impls.set(desc.id, desc.eagerImpl);
    this._viewer = undefined;
    this._bump();
  }

  // ─── internals ────────────────────────────────────────────────────────

  private _bump(): void {
    this._version++;
    for (const l of this._listeners) l();
  }

  private _loadImpl(id: string): Promise<AnyImpl | null> {
    if (this._impls.has(id)) return Promise.resolve(this._impls.get(id) ?? null);
    const pending = this._loading.get(id);
    if (pending) return pending;
    const desc = this.get(id);
    if (!desc) return Promise.resolve(null);
    const p = desc.impl()
      .then((impl) => impl ?? null, () => null)
      .then((impl) => {
        // A re-register while loading owns the slot now.
        if (this.get(id) === desc) {
          this._impls.set(id, impl);
          this._loading.delete(id);
          this._bump();
        }
        return impl;
      });
    this._loading.set(id, p);
    return p;
  }

  private _resolveViewer(override?: RVViewer): RVViewer | undefined {
    return override ?? this._viewer ?? getActiveAssetContext()?.viewer;
  }

  private _buildContext(desc: AnyDescriptor, viewerOverride?: RVViewer, pre?: CapturedContext): ContextOrRefusal {
    const viewer = this._resolveViewer(viewerOverride);
    const liveSelection = (): string[] => [...(viewer?.selectionManager?.getSnapshot?.().selectedPaths ?? [])];
    if (desc.scope === 'editor') {
      const h = requireDocument(viewer, 'editor');
      if (isGuardError(h)) return { error: h.error, kind: 'invisible' };
      // An early capture pins the call to the document it STARTED against: a
      // swap between capture and now (same path, other document) is stale.
      if (pre?.handle && pre.handle.documentKey !== h.documentKey) {
        return { error: ERR_DOCUMENT_CHANGED, kind: 'stale' };
      }
      return {
        viewer: viewer as RVViewer,
        doc: h.doc as AssetDocument,
        selection: pre ? pre.selection : liveSelection(),
        mode: viewer?.modes?.activeMode ?? '',
        handle: pre?.handle ?? h,
      };
    }
    if (!viewer) return { error: ERR_NO_VIEWER, kind: 'invisible' };
    return {
      viewer,
      doc: null,
      selection: pre ? pre.selection : liveSelection(),
      mode: viewer.modes?.activeMode ?? '',
      handle: null,
    };
  }

  private _stillSame(ctx: CommandContext): boolean {
    if (!ctx.handle) return true;
    if ((ctx.viewer.modes?.activeMode ?? '') !== ctx.mode) return false;
    return sameDocument(ctx.handle);
  }
}

/** The app-wide instance. Tests instantiate their own. */
export const commandRegistry = new CommandRegistry();
