// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// QuickJS-WASM script sandbox (built by plan-242 phase 0, moved to the public
// core by plan-210 phase 0 — ADR-023: the sandbox is the carrier of the free
// JS-in-GLB behavior layer and therefore lives in the AGPL core).
//
// Foundation for the virtual PLC (plan-242, private) and the shared script
// runtime of plan-205 / plan-210. Wraps a QuickJS-WASM runtime + context
// behind a small, throw-free evaluation surface:
//
//  - Lazy loading: the QuickJS module (singlefile variant, WASM base64-embedded
//    in the JS chunk) is dynamically imported on the FIRST `create()` call and
//    cached module-wide. QuickJS never lands in the eager bundle.
//  - `setMemoryLimit()` (default 32 MB) + interrupt handler with a wallclock
//    deadline per evaluation (default 5 ms) — infinite-loop / memory-bomb
//    protection for programs from untrusted shared scenes.
//  - `evaluate(code)` is synchronous and NEVER throws — errors come back as a
//    structured `SandboxResult` (`{ ok, value?, error? }`).
//  - Host bridge is a strict whitelist: a bare QuickJS context has NO fetch,
//    NO DOM, NO timers, NO XMLHttpRequest. The ONLY way to grant host
//    capabilities to guest code is `exposeFunction(name, fn)`.
//  - Dispose hygiene: every QuickJS handle is released deterministically
//    (try/finally); `dispose()` tears down context + runtime and is idempotent.
//  - Poisoning: after an interrupt abort or a memory-limit failure the guest
//    heap is treated as corrupt — `isPoisoned` turns true, further evaluations
//    are refused, and the caller must dispose + create a fresh sandbox
//    (COLD restart, plan-242 §2.4 sandbox-recovery contract).
//
// Hot-path note (the PLC scan will call `evaluate()` at 60 Hz): the runtime and
// context are created ONCE per sandbox and reused across evaluations — no
// per-call context/handle setup beyond the eval result itself.
//
// One-runtime-per-sandbox is the right shape for the vPLC (one program).
// For MANY per-node script components use `RVScriptHost`
// (`rv-script-host.ts`), which shares ONE runtime across per-component
// contexts and adds the lifecycle-handle contract (plan-210 §6b).

import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSWASMModule,
} from 'quickjs-emscripten-core';

// ─── Public types ──────────────────────────────────────────────────────────

/** Structured error info of a failed sandbox evaluation. */
export interface SandboxError {
  /** Error class name (e.g. 'SyntaxError', 'InternalError', 'SandboxPoisonedError'). */
  name: string;
  /** Human-readable error message. */
  message: string;
  /** Guest stack trace when available. */
  stack?: string;
}

/** Result of `RVScriptSandbox.evaluate()` — never thrown, always returned. */
export interface SandboxResult {
  /** True when the code evaluated without error. */
  ok: boolean;
  /** Result of the last expression (only when `ok` is true). Dumped to a plain JS value. */
  value?: unknown;
  /** Structured error (only when `ok` is false). */
  error?: SandboxError;
}

/** A host function exposed into the sandbox via the whitelist bridge. */
export type SandboxHostFunction = (...args: unknown[]) => unknown;

/** Creation options for `RVScriptSandbox.create()`. */
export interface RVScriptSandboxOptions {
  /** Guest heap limit in bytes. Default: 32 MB. */
  memoryLimitBytes?: number;
  /** Wallclock deadline per `evaluate()` call in milliseconds. Default: 5 ms. */
  evalDeadlineMs?: number;
}

// ─── Defaults ──────────────────────────────────────────────────────────────

export const DEFAULT_SANDBOX_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_SANDBOX_EVAL_DEADLINE_MS = 5;

/** Max nesting depth when marshalling host return values into the guest. */
const MAX_MARSHAL_DEPTH = 16;

// ─── Lazy QuickJS module loading (module-wide singleton) ───────────────────

let quickJSModulePromise: Promise<QuickJSWASMModule> | null = null;

async function instantiateQuickJSModule(): Promise<QuickJSWASMModule> {
  // Dynamic imports keep QuickJS (and its embedded WASM) out of the eager
  // bundle — Vite emits separate chunks loaded on first sandbox creation.
  const [core, variant] = await Promise.all([
    import('quickjs-emscripten-core'),
    import('@jitl/quickjs-singlefile-browser-release-sync'),
  ]);
  return core.newQuickJSWASMModuleFromVariant(variant.default);
}

/**
 * Loads (and caches module-wide) the QuickJS-WASM module. Shared by
 * `RVScriptSandbox` and `RVScriptHost` so both use the same lazily-loaded
 * WASM instance.
 */
export function loadQuickJSModule(): Promise<QuickJSWASMModule> {
  if (!quickJSModulePromise) {
    quickJSModulePromise = instantiateQuickJSModule().catch((err: unknown) => {
      // Clear the cache so a later create() can retry (e.g. transient network
      // failure while fetching the chunk).
      quickJSModulePromise = null;
      throw err;
    });
  }
  return quickJSModulePromise;
}

// ─── Shared helpers (also used by RVScriptHost) ────────────────────────────

/** Normalise a dumped guest error value into a structured `SandboxError`. */
export function toSandboxError(dumped: unknown): SandboxError {
  if (dumped !== null && typeof dumped === 'object') {
    const obj = dumped as Record<string, unknown>;
    return {
      name: typeof obj.name === 'string' ? obj.name : 'Error',
      message: typeof obj.message === 'string' ? obj.message : String(dumped),
      stack: typeof obj.stack === 'string' ? obj.stack : undefined,
    };
  }
  return { name: 'Error', message: String(dumped) };
}

/** True when a structured guest error looks like a QuickJS out-of-memory abort. */
export function isMemoryError(error: SandboxError): boolean {
  return /out of memory/i.test(error.message) || /out of memory/i.test(error.name);
}

/**
 * Marshals a host value into a guest handle. Supports undefined, null,
 * boolean, number, string, plain arrays and plain objects (recursively,
 * depth-capped). Unsupported types (functions, symbols, bigint, class
 * instances beyond plain data) throw — the caller converts that into a
 * guest exception. The returned handle is OWNED by the caller (dispose it).
 */
export function marshalHostValue(ctx: QuickJSContext, value: unknown, depth = 0): QuickJSHandle {
  if (depth > MAX_MARSHAL_DEPTH) {
    throw new Error(`marshal depth limit (${MAX_MARSHAL_DEPTH}) exceeded`);
  }
  if (value === undefined) return ctx.undefined;
  if (value === null) return ctx.null;
  switch (typeof value) {
    case 'boolean':
      return value ? ctx.true : ctx.false;
    case 'number':
      return ctx.newNumber(value);
    case 'string':
      return ctx.newString(value);
    case 'object':
      break;
    default:
      throw new Error(`unsupported host value type '${typeof value}'`);
  }
  if (Array.isArray(value)) {
    const arr = ctx.newArray();
    try {
      for (let i = 0; i < value.length; i++) {
        const h = marshalHostValue(ctx, value[i], depth + 1);
        try {
          ctx.setProp(arr, i, h);
        } finally {
          h.dispose();
        }
      }
      return arr;
    } catch (err) {
      arr.dispose();
      throw err;
    }
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('unsupported host value (only plain objects and arrays marshal into the sandbox)');
  }
  const obj = ctx.newObject();
  try {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const h = marshalHostValue(ctx, entry, depth + 1);
      try {
        ctx.setProp(obj, key, h);
      } finally {
        h.dispose();
      }
    }
    return obj;
  } catch (err) {
    obj.dispose();
    throw err;
  }
}

/**
 * Installs a host function on the guest global scope (whitelist bridge).
 * Shared implementation for `RVScriptSandbox.exposeFunction` and
 * `RVScriptContext.exposeFunction`.
 */
export function exposeHostFunction(ctx: QuickJSContext, name: string, fn: SandboxHostFunction): void {
  const fnHandle = ctx.newFunction(name, (...argHandles: QuickJSHandle[]) => {
    // Arg handles are borrowed (owned by the caller) — dump, don't dispose.
    const args = argHandles.map((h) => ctx.dump(h));
    let ret: unknown;
    try {
      ret = fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: ctx.newError(`host function '${name}' failed: ${message}`) };
    }
    try {
      return marshalHostValue(ctx, ret, 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: ctx.newError(`host function '${name}' returned an unmarshallable value: ${message}`) };
    }
  });
  try {
    ctx.setProp(ctx.global, name, fnHandle);
  } finally {
    fnHandle.dispose();
  }
}

// ─── RVScriptSandbox ───────────────────────────────────────────────────────

/**
 * Isolated QuickJS-WASM evaluation context with hard resource limits and a
 * whitelist-only host bridge.
 *
 * Usage:
 * ```ts
 * const sandbox = await RVScriptSandbox.create({ evalDeadlineMs: 5 });
 * sandbox.exposeFunction('readSignal', (name) => store.get(String(name)));
 * const r = sandbox.evaluate('readSignal("SensorInFeed") ? 1 : 0');
 * if (!r.ok) console.warn(r.error);
 * if (sandbox.isPoisoned) { sandbox.dispose(); } // then rebuild via create()
 * ```
 */
export class RVScriptSandbox {
  private readonly runtime: QuickJSRuntime;
  private readonly context: QuickJSContext;

  private evalDeadlineMs: number;
  /** Deadline timestamp (performance.now()) of the active evaluation; 0 = idle. */
  private deadlineAt = 0;
  /** Set by the interrupt handler when it aborts the active evaluation. */
  private interruptFired = false;
  private poisoned = false;
  private disposed = false;

  private constructor(
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    options: RVScriptSandboxOptions,
  ) {
    this.runtime = runtime;
    this.context = context;
    this.evalDeadlineMs = options.evalDeadlineMs ?? DEFAULT_SANDBOX_EVAL_DEADLINE_MS;

    this.runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_SANDBOX_MEMORY_LIMIT_BYTES);

    // Installed ONCE; QuickJS polls it periodically while guest code runs.
    // Returning true aborts the current evaluation.
    this.runtime.setInterruptHandler(() => {
      if (this.deadlineAt !== 0 && performance.now() >= this.deadlineAt) {
        this.interruptFired = true;
        return true;
      }
      return false;
    });

    // Warm-up: the FIRST call into the WASM eval path is slow (browser tiers
    // up the WASM functions lazily) and would eat the whole per-eval deadline.
    // Run one throwaway evaluation without a deadline (deadlineAt === 0) so
    // user evaluations get their full configured budget.
    const warmup = this.context.evalCode('0', 'sandbox://warmup', { type: 'global' });
    if (warmup.error) {
      warmup.error.dispose();
    } else {
      warmup.value.dispose();
    }
  }

  /**
   * Creates a new sandbox. The first call lazily loads the QuickJS-WASM module
   * (dynamic import, cached module-wide); later calls reuse the loaded module.
   */
  static async create(options: RVScriptSandboxOptions = {}): Promise<RVScriptSandbox> {
    const module = await loadQuickJSModule();
    const runtime = module.newRuntime();
    try {
      const context = runtime.newContext();
      return new RVScriptSandbox(runtime, context, options);
    } catch (err) {
      runtime.dispose();
      throw err;
    }
  }

  /** True after an interrupt abort or memory failure — the guest heap is corrupt; dispose and rebuild. */
  get isPoisoned(): boolean {
    return this.poisoned;
  }

  /** True after `dispose()` — the sandbox refuses all further work. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Sets the guest heap limit in bytes. */
  setMemoryLimit(limitBytes: number): void {
    this.assertUsable('setMemoryLimit');
    this.runtime.setMemoryLimit(limitBytes);
  }

  /** Sets the wallclock deadline per `evaluate()` call in milliseconds. */
  setEvalDeadlineMs(ms: number): void {
    this.assertUsable('setEvalDeadlineMs');
    this.evalDeadlineMs = ms;
  }

  /**
   * Exposes a host function into the sandbox's global scope (whitelist bridge).
   * Guest arguments arrive dumped to plain JS values; the return value is
   * marshalled back (undefined/null/boolean/number/string, plain arrays and
   * objects). A throwing host function surfaces as a guest exception — it never
   * crashes the host.
   */
  exposeFunction(name: string, fn: SandboxHostFunction): void {
    this.assertUsable('exposeFunction');
    exposeHostFunction(this.context, name, fn);
  }

  /**
   * Synchronously evaluates `code` in the sandbox. NEVER throws — all failures
   * (syntax errors, guest exceptions, interrupt aborts, memory-limit hits,
   * poisoned/disposed state) come back as `{ ok: false, error }`.
   */
  evaluate(code: string): SandboxResult {
    if (this.disposed) {
      return {
        ok: false,
        error: { name: 'SandboxDisposedError', message: 'sandbox has been disposed' },
      };
    }
    if (this.poisoned) {
      return {
        ok: false,
        error: {
          name: 'SandboxPoisonedError',
          message:
            'sandbox context is poisoned by a previous interrupt or memory failure — dispose and create a new sandbox',
        },
      };
    }

    this.interruptFired = false;
    this.deadlineAt = performance.now() + this.evalDeadlineMs;

    let result: ReturnType<QuickJSContext['evalCode']>;
    try {
      // type: 'global' — module syntax (import/export) is a SyntaxError, which
      // keeps dynamic module loading out of the sandbox by construction.
      result = this.context.evalCode(code, 'sandbox://eval', { type: 'global' });
    } catch (err) {
      // A throw from the WASM binding itself (not a guest exception) means the
      // engine state is unreliable — poison the sandbox.
      this.poisoned = true;
      return {
        ok: false,
        error: {
          name: 'SandboxInternalError',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    } finally {
      this.deadlineAt = 0;
    }

    if (result.error) {
      let dumped: unknown;
      try {
        dumped = this.context.dump(result.error);
      } catch {
        dumped = 'failed to read guest error';
      } finally {
        result.error.dispose();
      }
      const error = toSandboxError(dumped);
      if (this.interruptFired || isMemoryError(error)) {
        this.poisoned = true;
      }
      return { ok: false, error };
    }

    let value: unknown;
    try {
      value = this.context.dump(result.value);
    } catch (err) {
      result.value.dispose();
      return {
        ok: false,
        error: {
          name: 'SandboxDumpError',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    result.value.dispose();
    return { ok: true, value };
  }

  /** Tears down context and runtime. Idempotent — double dispose is safe. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (this.context.alive) this.context.dispose();
    } finally {
      if (this.runtime.alive) this.runtime.dispose();
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`RVScriptSandbox.${operation}: sandbox has been disposed`);
    }
  }
}
