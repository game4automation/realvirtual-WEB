// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-script-host — shared QuickJS runtime with one guest context per script
 * component (plan-210 phase 0, generalising the plan-242 sandbox).
 *
 * Where `RVScriptSandbox` is "one runtime + one context per program" (right
 * for the single vPLC program), `RVScriptHost` is the shape needed for MANY
 * per-node `WebComponent` scripts:
 *
 *  - ONE shared `QuickJSRuntime` (lazy-loaded WASM module, same loader as the
 *    sandbox). **The memory limit is runtime-wide** — all contexts share the
 *    same guest heap budget (default 32 MB). 32 MB × N per-component sandboxes
 *    would not scale; one shared heap does.
 *  - ONE `QuickJSContext` per component (`createContext()`), each with its own
 *    global scope, its own whitelist bridge (`exposeFunction`) and its own
 *    per-call interrupt deadline.
 *  - **Lifecycle guest handles** (the core new capability): `loadScript()`
 *    evaluates the component source, `runSetup()` calls the script's global
 *    `setup(...)` function and RETAINS the returned handler object as a live
 *    QuickJS handle. `callHandler('continuous.fixedUpdate', dt)` then invokes
 *    handlers host→VM repeatedly — resolved lazily by dotted path and cached.
 *  - **Setup contract (decision, documented):** scripts declare a GLOBAL
 *    `function setup(self) { … return { continuous: { fixedUpdate(dt){…} } } }`.
 *    ES-module syntax (`import`/`export`) stays a SyntaxError by construction
 *    (`type:'global'` evaluation) — real module support via
 *    `evalCode(…, { type:'module' })` returns variant-dependent
 *    namespace/promise handles and is deliberately deferred; because the host
 *    API is code-string based, switching to modules later is non-breaking.
 *  - **Poison backoff:** an interrupt-deadline abort or memory failure marks
 *    the offending context poisoned AND disabled — the `onDisable(reason)`
 *    callback fires ONCE and every further call returns a structured
 *    `ContextDisabledError` without touching the VM. There is NO automatic
 *    re-create per tick (that would be a poison loop for a buggy
 *    `while(true)` in `fixedUpdate`). Re-enabling is EXPLICIT via `enable()`;
 *    for memory poisoning prefer dispose + fresh context with fresh code.
 *    Other contexts on the same runtime are unaffected.
 *  - **Per-call arena:** every `callHandler`/`runSetup` marshals its arguments
 *    into guest handles and disposes them (and the call result) in `finally` —
 *    no handle leaks under high call density. The only retained handles are
 *    the handler root + resolved handler functions, released on `dispose()`.
 *
 * Everything is synchronous and throw-free at the call surface — failures come
 * back as structured `SandboxResult`s, mirroring `RVScriptSandbox`.
 */

import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from 'quickjs-emscripten-core';
import {
  type SandboxError,
  type SandboxResult,
  type SandboxHostFunction,
  DEFAULT_SANDBOX_MEMORY_LIMIT_BYTES,
  DEFAULT_SANDBOX_EVAL_DEADLINE_MS,
  loadQuickJSModule,
  toSandboxError,
  isMemoryError,
  marshalHostValue,
  exposeHostFunction,
} from './rv-script-sandbox';

// ─── Options ───────────────────────────────────────────────────────────────

/** Creation options for `RVScriptHost.create()`. */
export interface RVScriptHostOptions {
  /**
   * Guest heap limit in bytes for the SHARED runtime — this budget covers ALL
   * contexts created from this host. Default: 32 MB.
   */
  memoryLimitBytes?: number;
}

/** Options for `RVScriptHost.createContext()`. */
export interface RVScriptContextOptions {
  /** Wallclock deadline per host→VM call in milliseconds. Default: 5 ms. */
  callDeadlineMs?: number;
  /**
   * Fired ONCE when the context disables itself after an interrupt-deadline
   * abort or a memory failure (poison backoff), or on an explicit `disable()`.
   * The host user (component registry / HMI) surfaces the reason.
   */
  onDisable?: (reason: string) => void;
}

/** Name of the global setup function the script contract requires. */
export const SCRIPT_SETUP_FUNCTION = 'setup';

// ─── RVScriptHost ──────────────────────────────────────────────────────────

/**
 * Shared QuickJS runtime hosting one isolated context per script component.
 *
 * ```ts
 * const host = await RVScriptHost.create();
 * const ctx = host.createContext({ callDeadlineMs: 5, onDisable: (r) => log(r) });
 * ctx.exposeFunction('log', (...a) => console.log(...a));
 * ctx.loadScript('function setup(self){ let n = 0; return { continuous: { fixedUpdate(dt){ n += dt; } } }; }');
 * ctx.runSetup({ name: 'Conveyor1' });
 * ctx.callHandler('continuous.fixedUpdate', 1 / 60);   // every tick
 * ctx.dispose();
 * host.dispose();
 * ```
 */
export class RVScriptHost {
  private readonly runtime: QuickJSRuntime;
  private readonly contexts = new Set<RVScriptContext>();
  private disposed = false;

  /** Deadline bookkeeping for the SHARED interrupt handler. Guest execution is
   *  single-threaded — at most one context evaluates at any moment, so one
   *  deadline slot on the host suffices. 0 = idle (no deadline). */
  private deadlineAt = 0;
  private interruptFired = false;

  private constructor(runtime: QuickJSRuntime, options: RVScriptHostOptions) {
    this.runtime = runtime;
    this.runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_SANDBOX_MEMORY_LIMIT_BYTES);
    this.runtime.setInterruptHandler(() => {
      if (this.deadlineAt !== 0 && performance.now() >= this.deadlineAt) {
        this.interruptFired = true;
        return true;
      }
      return false;
    });
  }

  /**
   * Creates a host with one shared runtime. The first call lazily loads the
   * QuickJS-WASM module (dynamic import, cached module-wide with the sandbox).
   */
  static async create(options: RVScriptHostOptions = {}): Promise<RVScriptHost> {
    const module = await loadQuickJSModule();
    const runtime = module.newRuntime();
    try {
      return new RVScriptHost(runtime, options);
    } catch (err) {
      runtime.dispose();
      throw err;
    }
  }

  /** True after `dispose()`. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of live (not-yet-disposed) contexts. */
  get contextCount(): number {
    return this.contexts.size;
  }

  /** Sets the runtime-wide guest heap limit in bytes (covers ALL contexts). */
  setMemoryLimit(limitBytes: number): void {
    this.assertUsable('setMemoryLimit');
    this.runtime.setMemoryLimit(limitBytes);
  }

  /** Human-readable QuickJS memory statistics of the shared runtime (diagnostics / leak tests). */
  dumpMemoryUsage(): string {
    this.assertUsable('dumpMemoryUsage');
    return this.runtime.dumpMemoryUsage();
  }

  /** Creates a fresh, isolated guest context for one script component. */
  createContext(options: RVScriptContextOptions = {}): RVScriptContext {
    this.assertUsable('createContext');
    const context = this.runtime.newContext();
    const scriptContext = new RVScriptContext(this, context, options);
    this.contexts.add(scriptContext);
    return scriptContext;
  }

  /** Disposes all remaining contexts and the shared runtime. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ctx of [...this.contexts]) ctx.dispose();
    this.contexts.clear();
    if (this.runtime.alive) this.runtime.dispose();
  }

  // ─── Internal (used by RVScriptContext) ───────────────────────────────────

  /** @internal */
  _beginGuestCall(deadlineMs: number): void {
    this.interruptFired = false;
    this.deadlineAt = performance.now() + deadlineMs;
  }

  /** @internal */
  _endGuestCall(): boolean {
    this.deadlineAt = 0;
    return this.interruptFired;
  }

  /** @internal */
  _releaseContext(ctx: RVScriptContext): void {
    this.contexts.delete(ctx);
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`RVScriptHost.${operation}: host has been disposed`);
    }
  }
}

// ─── RVScriptContext ───────────────────────────────────────────────────────

/**
 * One component's guest context on the shared runtime: own global scope, own
 * whitelist bridge, own call deadline, own poison/disable state, and the
 * retained lifecycle handler handles returned by the script's `setup()`.
 */
export class RVScriptContext {
  private readonly host: RVScriptHost;
  private readonly context: QuickJSContext;
  private readonly onDisableCb?: (reason: string) => void;

  private callDeadlineMs: number;
  private poisoned = false;
  private disabled = false;
  private disabledReasonValue: string | null = null;
  private disposed = false;

  /** Retained root handle of the object returned by `setup()`. */
  private handlersRoot: QuickJSHandle | null = null;
  /** Lazily resolved + retained handler function handles, keyed by dotted path. */
  private readonly handlerCache = new Map<string, QuickJSHandle>();

  /** @internal — created via `RVScriptHost.createContext()`. */
  constructor(host: RVScriptHost, context: QuickJSContext, options: RVScriptContextOptions) {
    this.host = host;
    this.context = context;
    this.callDeadlineMs = options.callDeadlineMs ?? DEFAULT_SANDBOX_EVAL_DEADLINE_MS;
    this.onDisableCb = options.onDisable;

    // Warm-up without a deadline (see RVScriptSandbox constructor).
    const warmup = this.context.evalCode('0', 'script-host://warmup', { type: 'global' });
    if (warmup.error) warmup.error.dispose();
    else warmup.value.dispose();
  }

  /** True after an interrupt abort or memory failure in this context. */
  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /** True while the context refuses guest calls (poison backoff or explicit `disable()`). */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Reason of the last `disable()`; null when enabled. */
  get disabledReason(): string | null {
    return this.disabledReasonValue;
  }

  /** True after `dispose()`. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of retained lifecycle handles (root + cached handlers). Leak tests. */
  get retainedHandleCount(): number {
    return (this.handlersRoot ? 1 : 0) + this.handlerCache.size;
  }

  /** Sets the wallclock deadline per host→VM call in milliseconds. */
  setCallDeadlineMs(ms: number): void {
    this.assertUsable('setCallDeadlineMs');
    this.callDeadlineMs = ms;
  }

  /** Exposes a host function into THIS context's global scope (whitelist bridge). */
  exposeFunction(name: string, fn: SandboxHostFunction): void {
    this.assertUsable('exposeFunction');
    exposeHostFunction(this.context, name, fn);
  }

  /**
   * Evaluates the component source (setup contract: the script defines a
   * global `setup` function). Drops any previously retained handlers first —
   * a reload evaluates fresh code and must re-run `runSetup()`.
   */
  loadScript(code: string): SandboxResult {
    const result = this.guarded(() => {
      this.releaseHandlers();
      return this.evaluateInternal(code, 'script-host://component');
    });
    return result;
  }

  /**
   * Synchronously evaluates `code` in this context. NEVER throws — mirrors
   * `RVScriptSandbox.evaluate()`.
   */
  evaluate(code: string): SandboxResult {
    return this.guarded(() => this.evaluateInternal(code, 'script-host://eval'));
  }

  /**
   * Calls the script's global `setup(...args)` and retains the returned
   * handler object as a live guest handle. Args are marshalled host→VM
   * (plain values only). On success, `callHandler()` becomes available.
   */
  runSetup(...args: unknown[]): SandboxResult {
    return this.guarded(() => {
      this.releaseHandlers();
      const ctx = this.context;
      const setupFn = ctx.getProp(ctx.global, SCRIPT_SETUP_FUNCTION);
      try {
        if (ctx.typeof(setupFn) !== 'function') {
          return {
            ok: false,
            error: {
              name: 'SetupMissingError',
              message: `script does not define a global '${SCRIPT_SETUP_FUNCTION}' function`,
            },
          };
        }
        const call = this.callGuestFunction(setupFn, args);
        if (!call.ok) return call.result;
        const root = call.handle;
        if (ctx.typeof(root) !== 'object') {
          // Primitive / undefined return — nothing to retain; still a success
          // (a script may legitimately return nothing and only use exposed
          // host functions / onSignal-style bridges added later).
          const dumped = ctx.dump(root);
          root.dispose();
          return { ok: true, value: dumped };
        }
        this.handlersRoot = root;   // RETAINED until dispose/reload
        return { ok: true };
      } finally {
        setupFn.dispose();
      }
    });
  }

  /** True when `runSetup()` retained a handler at the dotted `path` (e.g. `'continuous.fixedUpdate'`). */
  hasHandler(path: string): boolean {
    if (this.disposed || this.disabled || !this.handlersRoot) return false;
    return this.resolveHandler(path) !== null;
  }

  /**
   * Invokes a retained lifecycle handler host→VM (e.g.
   * `callHandler('continuous.fixedUpdate', dt)`). Arguments are marshalled per
   * call inside an arena (all argument + result handles disposed in `finally`).
   * Interrupt/memory aborts poison + disable the context (poison backoff).
   */
  callHandler(path: string, ...args: unknown[]): SandboxResult {
    return this.guarded(() => {
      if (!this.handlersRoot) {
        return {
          ok: false,
          error: { name: 'HandlersNotLoadedError', message: 'runSetup() has not retained a handler object' },
        };
      }
      const fn = this.resolveHandler(path);
      if (!fn) {
        return {
          ok: false,
          error: { name: 'HandlerNotFoundError', message: `no handler at path '${path}'` },
        };
      }
      const call = this.callGuestFunction(fn, args);
      if (!call.ok) return call.result;
      const ctx = this.context;
      let value: unknown;
      try {
        value = ctx.dump(call.handle);
      } catch (err) {
        return {
          ok: false,
          error: { name: 'SandboxDumpError', message: err instanceof Error ? err.message : String(err) },
        };
      } finally {
        call.handle.dispose();
      }
      return { ok: true, value };
    });
  }

  /**
   * Explicitly disables the context (e.g. by the component registry after a
   * validation failure). Fires `onDisable(reason)` once per disable cycle.
   */
  disable(reason: string): void {
    if (this.disposed || this.disabled) return;
    this.disabled = true;
    this.disabledReasonValue = reason;
    try {
      this.onDisableCb?.(reason);
    } catch (err) {
      console.warn('[rv-script-host] onDisable callback failed:', err);
    }
  }

  /**
   * EXPLICIT re-enable after poison backoff — there is deliberately no
   * automatic recovery. Clears the disabled + poisoned flags; the caller is
   * expected to have changed something (typically: load fixed code via
   * `loadScript()` + `runSetup()`). After a MEMORY poison prefer disposing
   * and creating a fresh context — the shared heap may hold garbage from the
   * aborted allocation.
   */
  enable(): void {
    this.assertUsable('enable');
    this.disabled = false;
    this.poisoned = false;
    this.disabledReasonValue = null;
  }

  /** Releases all retained handles and the guest context. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseHandlers();
    if (this.context.alive) this.context.dispose();
    this.host._releaseContext(this);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Common refusal guard: disposed / disabled contexts never touch the VM. */
  private guarded(work: () => SandboxResult): SandboxResult {
    if (this.disposed) {
      return {
        ok: false,
        error: { name: 'ContextDisposedError', message: 'script context has been disposed' },
      };
    }
    if (this.disabled) {
      return {
        ok: false,
        error: {
          name: 'ContextDisabledError',
          message: `script context is disabled (${this.disabledReasonValue ?? 'no reason'}) — call enable() explicitly to retry`,
        },
      };
    }
    return work();
  }

  private evaluateInternal(code: string, filename: string): SandboxResult {
    const ctx = this.context;
    this.host._beginGuestCall(this.callDeadlineMs);
    let result: ReturnType<QuickJSContext['evalCode']>;
    let interrupted: boolean;
    try {
      // type:'global' — see setup-contract note in the module header.
      result = ctx.evalCode(code, filename, { type: 'global' });
    } catch (err) {
      this.host._endGuestCall();
      this.poisonAndDisable('sandbox internal error');
      return {
        ok: false,
        error: { name: 'SandboxInternalError', message: err instanceof Error ? err.message : String(err) },
      };
    } finally {
      interrupted = this.host._endGuestCall();
    }

    if (result.error) {
      let dumped: unknown;
      try {
        dumped = ctx.dump(result.error);
      } catch {
        dumped = 'failed to read guest error';
      } finally {
        result.error.dispose();
      }
      const error = toSandboxError(dumped);
      if (interrupted || isMemoryError(error)) {
        this.poisonAndDisable(interrupted
          ? `interrupt deadline (${this.callDeadlineMs} ms) exceeded`
          : 'guest memory limit exceeded');
      }
      return { ok: false, error };
    }

    let value: unknown;
    try {
      value = ctx.dump(result.value);
    } catch (err) {
      result.value.dispose();
      return {
        ok: false,
        error: { name: 'SandboxDumpError', message: err instanceof Error ? err.message : String(err) },
      };
    }
    result.value.dispose();
    return { ok: true, value };
  }

  /**
   * Calls a guest function with per-call arena semantics: marshals args,
   * disposes every arg handle in `finally`, applies the deadline, and maps
   * interrupt/memory aborts to poison backoff. On success the RESULT handle
   * is returned OWNED by the caller.
   */
  private callGuestFunction(
    fn: QuickJSHandle,
    args: unknown[],
  ): { ok: true; handle: QuickJSHandle } | { ok: false; result: SandboxResult } {
    const ctx = this.context;

    // Arena: marshal all args; dispose them no matter what.
    const argHandles: QuickJSHandle[] = [];
    try {
      for (const arg of args) argHandles.push(marshalHostValue(ctx, arg));
    } catch (err) {
      for (const h of argHandles) h.dispose();
      return {
        ok: false,
        result: {
          ok: false,
          error: { name: 'MarshalError', message: err instanceof Error ? err.message : String(err) },
        },
      };
    }

    this.host._beginGuestCall(this.callDeadlineMs);
    let result: ReturnType<QuickJSContext['callFunction']>;
    let interrupted: boolean;
    try {
      result = ctx.callFunction(fn, ctx.undefined, ...argHandles);
    } catch (err) {
      this.host._endGuestCall();
      this.poisonAndDisable('sandbox internal error');
      return {
        ok: false,
        result: {
          ok: false,
          error: { name: 'SandboxInternalError', message: err instanceof Error ? err.message : String(err) },
        },
      };
    } finally {
      interrupted = this.host._endGuestCall();
      for (const h of argHandles) h.dispose();
    }

    if (result.error) {
      let dumped: unknown;
      try {
        dumped = ctx.dump(result.error);
      } catch {
        dumped = 'failed to read guest error';
      } finally {
        result.error.dispose();
      }
      const error: SandboxError = toSandboxError(dumped);
      if (interrupted || isMemoryError(error)) {
        this.poisonAndDisable(interrupted
          ? `interrupt deadline (${this.callDeadlineMs} ms) exceeded`
          : 'guest memory limit exceeded');
      }
      return { ok: false, result: { ok: false, error } };
    }

    return { ok: true, handle: result.value };
  }

  /**
   * Resolves a dotted handler path (e.g. `'continuous.fixedUpdate'`) on the
   * retained handlers root. The resolved function handle is RETAINED in the
   * cache for repeated host→VM calls; intermediate object handles are
   * disposed immediately.
   */
  private resolveHandler(path: string): QuickJSHandle | null {
    const cached = this.handlerCache.get(path);
    if (cached) return cached;
    if (!this.handlersRoot) return null;

    const ctx = this.context;
    let current: QuickJSHandle = this.handlersRoot;
    let currentOwned = false;   // handlersRoot is retained — never dispose it here
    try {
      for (const segment of path.split('.')) {
        if (ctx.typeof(current) !== 'object') return null;
        const next = ctx.getProp(current, segment);
        if (currentOwned) current.dispose();
        current = next;
        currentOwned = true;
      }
      if (ctx.typeof(current) !== 'function') return null;
      this.handlerCache.set(path, current);   // RETAINED until dispose/reload
      currentOwned = false;                   // ownership moved into the cache
      return current;
    } finally {
      if (currentOwned) current.dispose();
    }
  }

  private poisonAndDisable(reason: string): void {
    this.poisoned = true;
    this.disable(reason);
  }

  private releaseHandlers(): void {
    for (const handle of this.handlerCache.values()) {
      if (handle.alive) handle.dispose();
    }
    this.handlerCache.clear();
    if (this.handlersRoot) {
      if (this.handlersRoot.alive) this.handlersRoot.dispose();
      this.handlersRoot = null;
    }
  }

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`RVScriptContext.${operation}: context has been disposed`);
    }
  }
}
