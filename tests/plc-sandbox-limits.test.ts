// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-sandbox-limits.test.ts — plan-242 Phase 0 (QuickJS script sandbox).
 *
 * Security and robustness contract of `RVScriptSandbox` (the foundation for
 * the virtual PLC and the plan-205/210 script runtime):
 *  - infinite loops are aborted via the interrupt deadline → ok:false + poisoned
 *  - the memory limit rejects huge allocations → ok:false
 *  - the host bridge is a whitelist: no fetch / document / setTimeout / XHR
 *  - `exposeFunction` marshals arguments and return values correctly
 *  - simple evaluation works; syntax errors are structured results, not throws
 *  - dispose hygiene: double dispose is safe, disposed sandboxes refuse work
 *
 * The sandbox moved to the public core in plan-210 phase 0 (ADR-023) — this
 * suite now runs in every build. The private `@rv-private/plc/rv-script-sandbox`
 * path remains a re-export shim for the vPLC.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RVScriptSandbox } from '../src/core/engine/rv-script-sandbox';

// ─── Helpers ───────────────────────────────────────────────────────────────

const sandboxes: RVScriptSandbox[] = [];

async function makeSandbox(
  options?: Parameters<typeof RVScriptSandbox.create>[0],
): Promise<RVScriptSandbox> {
  const sandbox = await RVScriptSandbox.create(options);
  sandboxes.push(sandbox);
  return sandbox;
}

afterEach(() => {
  for (const sandbox of sandboxes) sandbox.dispose();
  sandboxes.length = 0;
});

// ─── Basic evaluation ──────────────────────────────────────────────────────

describe('RVScriptSandbox — evaluation', () => {
  it('evaluates a simple expression (1 + 2 * 3 → 7)', async () => {
    const sandbox = await makeSandbox();
    const r = sandbox.evaluate('1 + 2 * 3');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(7);
    expect(r.error).toBeUndefined();
  });

  it('keeps global state across evaluations (persistent context)', async () => {
    const sandbox = await makeSandbox();
    expect(sandbox.evaluate('globalThis.counter = 40;').ok).toBe(true);
    const r = sandbox.evaluate('counter + 2');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it('returns structured diagnostics for a syntax error instead of throwing', async () => {
    const sandbox = await makeSandbox();
    let r: ReturnType<RVScriptSandbox['evaluate']> | undefined;
    expect(() => {
      r = sandbox.evaluate('x := ;');
    }).not.toThrow();
    expect(r!.ok).toBe(false);
    expect(r!.error).toBeDefined();
    expect(r!.error!.name).toBe('SyntaxError');
    expect(r!.error!.message.length).toBeGreaterThan(0);
    // A syntax error does NOT poison the sandbox — it stays usable.
    expect(sandbox.isPoisoned).toBe(false);
    expect(sandbox.evaluate('2 + 2').value).toBe(4);
  });

  it('returns a structured error for a guest runtime exception (no throw)', async () => {
    const sandbox = await makeSandbox();
    const r = sandbox.evaluate('undefinedFunction()');
    expect(r.ok).toBe(false);
    expect(r.error!.name).toBe('ReferenceError');
    expect(sandbox.isPoisoned).toBe(false);
  });
});

// ─── Interrupt handler (infinite-loop protection) ──────────────────────────

describe('RVScriptSandbox — interrupt deadline', () => {
  it('aborts while(true){} via the interrupt handler and poisons the sandbox', async () => {
    const sandbox = await makeSandbox({ evalDeadlineMs: 5 });
    const start = performance.now();
    const r = sandbox.evaluate('while (true) {}');
    const elapsed = performance.now() - start;

    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(sandbox.isPoisoned).toBe(true);
    // Deadline is 5 ms — generous upper bound to keep the test robust in CI.
    expect(elapsed).toBeLessThan(2000);
  });

  it('refuses further evaluations once poisoned (rebuild required)', async () => {
    const sandbox = await makeSandbox({ evalDeadlineMs: 5 });
    expect(sandbox.evaluate('while (true) {}').ok).toBe(false);
    expect(sandbox.isPoisoned).toBe(true);

    const r = sandbox.evaluate('1 + 1');
    expect(r.ok).toBe(false);
    expect(r.error!.name).toBe('SandboxPoisonedError');
  });

  it('does not interrupt fast code within the deadline', async () => {
    const sandbox = await makeSandbox({ evalDeadlineMs: 100 });
    const r = sandbox.evaluate('let s = 0; for (let i = 0; i < 1000; i++) s += i; s');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(499500);
    expect(sandbox.isPoisoned).toBe(false);
  });
});

// ─── Memory limit ──────────────────────────────────────────────────────────

describe('RVScriptSandbox — memory limit', () => {
  it('rejects a huge typed-array allocation beyond the memory limit', async () => {
    // 8 MB heap limit, allocation attempts 64 MB — fails fast, no deadline race.
    const sandbox = await makeSandbox({
      memoryLimitBytes: 8 * 1024 * 1024,
      evalDeadlineMs: 1000,
    });
    const r = sandbox.evaluate('new Uint8Array(64 * 1024 * 1024)');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(sandbox.isPoisoned).toBe(true);
  });

  it('rejects unbounded string growth', async () => {
    const sandbox = await makeSandbox({
      memoryLimitBytes: 8 * 1024 * 1024,
      evalDeadlineMs: 2000,
    });
    const r = sandbox.evaluate("let s = 'x'; while (true) { s += s; }");
    expect(r.ok).toBe(false);
  });

  it('allows allocations within the limit', async () => {
    const sandbox = await makeSandbox({
      memoryLimitBytes: 32 * 1024 * 1024,
      evalDeadlineMs: 1000,
    });
    const r = sandbox.evaluate('new Uint8Array(1024 * 1024).length');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(1024 * 1024);
  });
});

// ─── Host-bridge whitelist ─────────────────────────────────────────────────

describe('RVScriptSandbox — whitelist (no ambient host APIs)', () => {
  it('has no fetch, document, setTimeout or XMLHttpRequest', async () => {
    const sandbox = await makeSandbox();
    const r = sandbox.evaluate(
      "[typeof fetch, typeof document, typeof setTimeout, typeof XMLHttpRequest].join(',')",
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe('undefined,undefined,undefined,undefined');
  });

  it('has no window, no eval-adjacent host escape surfaces', async () => {
    const sandbox = await makeSandbox();
    const r = sandbox.evaluate(
      "[typeof window, typeof setInterval, typeof importScripts, typeof WebSocket].join(',')",
    );
    expect(r.ok).toBe(true);
    expect(r.value).toBe('undefined,undefined,undefined,undefined');
  });
});

// ─── exposeFunction (whitelist bridge) ─────────────────────────────────────

describe('RVScriptSandbox — exposeFunction', () => {
  it('exposes a host function that is callable with correct args and return value', async () => {
    const sandbox = await makeSandbox();
    const received: unknown[][] = [];
    sandbox.exposeFunction('hostAdd', (a, b) => {
      received.push([a, b]);
      return (a as number) + (b as number);
    });

    const r = sandbox.evaluate('hostAdd(2, 40)');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
    expect(received).toEqual([[2, 40]]);
  });

  it('marshals strings, booleans, arrays and plain objects both ways', async () => {
    const sandbox = await makeSandbox();
    sandbox.exposeFunction('roundtrip', (v) => v);
    sandbox.exposeFunction('makeState', () => ({
      running: true,
      scanTimeMs: 0.25,
      tags: ['TON', 'CTU'],
    }));

    const echo = sandbox.evaluate("roundtrip({ name: 'Main', ids: [1, 2, 3] }).ids[2]");
    expect(echo.ok).toBe(true);
    expect(echo.value).toBe(3);

    const state = sandbox.evaluate('const s = makeState(); [s.running, s.scanTimeMs, s.tags[1]].join("|")');
    expect(state.ok).toBe(true);
    expect(state.value).toBe('true|0.25|CTU');
  });

  it('converts a throwing host function into a guest error (host never crashes)', async () => {
    const sandbox = await makeSandbox();
    sandbox.exposeFunction('boom', () => {
      throw new Error('host failure');
    });

    const r = sandbox.evaluate('boom()');
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('host failure');
    // Host errors do not poison the sandbox.
    expect(sandbox.isPoisoned).toBe(false);
    expect(sandbox.evaluate('1 + 1').value).toBe(2);
  });

  it('guest can catch host-function errors', async () => {
    const sandbox = await makeSandbox();
    sandbox.exposeFunction('boom', () => {
      throw new Error('nope');
    });
    const r = sandbox.evaluate("try { boom(); 'unreachable' } catch (e) { 'caught' }");
    expect(r.ok).toBe(true);
    expect(r.value).toBe('caught');
  });
});

// ─── Dispose hygiene ───────────────────────────────────────────────────────

describe('RVScriptSandbox — dispose', () => {
  it('double dispose is safe', async () => {
    const sandbox = await RVScriptSandbox.create();
    sandbox.dispose();
    expect(() => sandbox.dispose()).not.toThrow();
    expect(sandbox.isDisposed).toBe(true);
  });

  it('evaluate on a disposed sandbox returns a structured error (no throw)', async () => {
    const sandbox = await RVScriptSandbox.create();
    sandbox.dispose();
    const r = sandbox.evaluate('1 + 1');
    expect(r.ok).toBe(false);
    expect(r.error!.name).toBe('SandboxDisposedError');
  });

  it('exposeFunction on a disposed sandbox throws a clear host-side error', async () => {
    const sandbox = await RVScriptSandbox.create();
    sandbox.dispose();
    expect(() => sandbox.exposeFunction('f', () => 0)).toThrow(/disposed/);
  });

  it('a poisoned sandbox can be disposed and replaced by a fresh one', async () => {
    const poisonedSandbox = await makeSandbox({ evalDeadlineMs: 5 });
    expect(poisonedSandbox.evaluate('while (true) {}').ok).toBe(false);
    expect(poisonedSandbox.isPoisoned).toBe(true);
    poisonedSandbox.dispose();

    const fresh = await makeSandbox();
    expect(fresh.isPoisoned).toBe(false);
    expect(fresh.evaluate('6 * 7').value).toBe(42);
  });
});
