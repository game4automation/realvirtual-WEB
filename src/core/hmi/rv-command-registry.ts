// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

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
export type CommandArgType = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';

export interface CommandContext {
  readonly viewer: RVViewer;
  /** Active asset document, null for commands with scope 'none'. */
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
}

/** Early capture of the call's context (bridge: at call begin, before any wait). */
export interface CapturedContext {
  readonly handle: DocumentHandle | null;
  readonly selection: readonly string[];
}

export interface ExecuteOptions {
  readonly origin: CommandOrigin;
  readonly buttonKey?: string;
  /** Viewer override; default is the attached viewer, then the active asset context's. */
  readonly viewer?: RVViewer;
  /** Pre-captured handle + selection (bridge path). Absent: captured now (UI click). */
  readonly context?: CapturedContext;
}

export type ExecuteFailureKind = 'disabled' | 'unknown' | 'invisible' | 'unavailable' | 'stale' | 'threw';

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
 * `execute` turns it into `{ok:false, kind:'threw', reason, details}`.
 */
export class CommandError extends Error {
  constructor(message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CommandError';
  }
}

// ─── Registry ───────────────────────────────────────────────────────────

type AnyDescriptor = CommandDescriptor<unknown, unknown>;
type AnyImpl = CommandImpl<unknown, unknown>;
type ContextOrRefusal = CommandContext | { readonly error: string; readonly kind: ExecuteFailureKind };

export class CommandRegistry {
  private readonly _descs = new Map<string, { desc: AnyDescriptor; gen: number }>();
  private readonly _impls = new Map<string, AnyImpl | null>();
  private readonly _loading = new Map<string, Promise<AnyImpl | null>>();
  private readonly _executed = new Set<(e: ExecutedEvent) => void>();
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
    if (!desc) return done({ ok: false, kind: 'unknown', reason: `Unknown command: ${id}` });
    // 2. eager capability — BEFORE the mode guard (F20)
    if (!desc.available) return done({ ok: false, kind: 'unavailable', reason: ERR_EDITOR_UNAVAILABLE });
    // 3. context + guard (reuses the guard-core texts, never copies them)
    const built = this._buildContext(desc, opts.viewer, opts.context);
    if ('error' in built) return done({ ok: false, kind: built.kind, reason: built.error });
    const ctx: CommandContext = { ...built, origin: opts.origin };
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
      const value = await impl.run(ctx, args);
      return done({ ok: true, value });
    } catch (e) {
      const details = e instanceof CommandError ? e.details : undefined;
      return done({
        ok: false, kind: 'threw', reason: e instanceof Error ? e.message : String(e),
        ...(details ? { details } : {}),
      });
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
