// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-host.test.ts — plan-210 phase 0 (shared runtime + lifecycle handles).
 *
 * Contract of `RVScriptHost` / `RVScriptContext`:
 *  - ONE shared QuickJS runtime, one isolated context per component
 *    (isolated globals; a poisoned context does not affect its siblings)
 *  - lifecycle guest handles: global `setup()` contract, retained handler
 *    handles, repeated host→VM `callHandler()` invocations with closure state
 *  - interrupt deadline per call; poison backoff (disable once, NO re-create
 *    per tick, explicit `enable()` to retry)
 *  - per-call arena: no handle growth across many calls; clean dispose
 *  - runtime-wide memory limit
 */

import { describe, it, expect, afterEach } from 'vitest';
import { RVScriptHost } from '../src/core/engine/rv-script-host';

// ─── Helpers ───────────────────────────────────────────────────────────────

const hosts: RVScriptHost[] = [];

async function makeHost(
  options?: Parameters<typeof RVScriptHost.create>[0],
): Promise<RVScriptHost> {
  const host = await RVScriptHost.create(options);
  hosts.push(host);
  return host;
}

afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts.length = 0;
});

const COUNTER_SCRIPT = `
  function setup(self) {
    let n = 0;
    return {
      continuous: {
        fixedUpdate(dt) { n += dt; return n; },
      },
      onReset() { n = 0; return n; },
    };
  }
`;

// ─── Context isolation on the shared runtime ───────────────────────────────

describe('RVScriptHost — shared runtime, isolated contexts', () => {
  it('contexts have isolated global scopes', async () => {
    const host = await makeHost();
    const a = host.createContext({ callDeadlineMs: 100 });
    const b = host.createContext({ callDeadlineMs: 100 });
    expect(a.evaluate('globalThis.x = 41; x').value).toBe(41);
    expect(b.evaluate('typeof x').value).toBe('undefined');
    expect(host.contextCount).toBe(2);
  });

  it('a poisoned context (endless loop) does not affect a sibling context', async () => {
    const host = await makeHost();
    const a = host.createContext({ callDeadlineMs: 5 });
    const b = host.createContext({ callDeadlineMs: 100 });

    const r = a.evaluate('while (true) {}');
    expect(r.ok).toBe(false);
    expect(a.isPoisoned).toBe(true);
    expect(a.isDisabled).toBe(true);

    // Sibling keeps working on the SAME runtime.
    expect(b.evaluate('6 * 7').value).toBe(42);
    expect(b.isPoisoned).toBe(false);
  });

  it('the memory limit is runtime-wide and rejects huge allocations', async () => {
    const host = await makeHost({ memoryLimitBytes: 8 * 1024 * 1024 });
    const ctx = host.createContext({ callDeadlineMs: 1000 });
    const r = ctx.evaluate('new Uint8Array(64 * 1024 * 1024)');
    expect(r.ok).toBe(false);
    expect(ctx.isPoisoned).toBe(true);
    expect(ctx.isDisabled).toBe(true);
  });
});

// ─── Lifecycle: setup contract + retained handler handles ──────────────────

describe('RVScriptContext — lifecycle guest handles', () => {
  it('loadScript + runSetup + 100× callHandler share closure state', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });

    expect(ctx.loadScript(COUNTER_SCRIPT).ok).toBe(true);
    expect(ctx.runSetup({ name: 'Conveyor1' }).ok).toBe(true);
    expect(ctx.hasHandler('continuous.fixedUpdate')).toBe(true);
    expect(ctx.hasHandler('des.onAccept')).toBe(false);

    let last: unknown;
    for (let i = 0; i < 100; i++) {
      const r = ctx.callHandler('continuous.fixedUpdate', 1);
      expect(r.ok).toBe(true);
      last = r.value;
    }
    expect(last).toBe(100);

    // Top-level handler works too, and resets the SAME closure state.
    expect(ctx.callHandler('onReset').value).toBe(0);
    expect(ctx.callHandler('continuous.fixedUpdate', 2).value).toBe(2);
  });

  it('setup receives marshalled plain-object arguments', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(`
      function setup(self) {
        return { whoami() { return self.name + '@' + self.path; } };
      }
    `);
    expect(ctx.runSetup({ name: 'Turntable', path: 'Line1/Turntable' }).ok).toBe(true);
    expect(ctx.callHandler('whoami').value).toBe('Turntable@Line1/Turntable');
  });

  it('runSetup without a global setup function returns SetupMissingError', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript('const notSetup = 1;');
    const r = ctx.runSetup();
    expect(r.ok).toBe(false);
    expect(r.error!.name).toBe('SetupMissingError');
  });

  it('callHandler on an unknown path returns HandlerNotFoundError', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(COUNTER_SCRIPT);
    ctx.runSetup();
    const r = ctx.callHandler('continuous.nope');
    expect(r.ok).toBe(false);
    expect(r.error!.name).toBe('HandlerNotFoundError');
  });

  it('a guest exception inside a handler is a structured error, not a poison', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(`function setup() { return { boom() { throw new Error('guest kaputt'); } }; }`);
    ctx.runSetup();
    const r = ctx.callHandler('boom');
    expect(r.ok).toBe(false);
    expect(r.error!.message).toContain('guest kaputt');
    expect(ctx.isPoisoned).toBe(false);
    expect(ctx.isDisabled).toBe(false);
    // Context stays usable.
    expect(ctx.evaluate('1 + 1').value).toBe(2);
  });
});

// ─── Poison backoff ────────────────────────────────────────────────────────

describe('RVScriptContext — poison backoff', () => {
  it('interrupt in a handler poisons + disables; NO re-run until explicit enable()', async () => {
    const host = await makeHost();
    const disableReasons: string[] = [];
    const ctx = host.createContext({
      callDeadlineMs: 5,
      onDisable: (reason) => disableReasons.push(reason),
    });

    let hostTicks = 0;
    ctx.exposeFunction('tick', () => { hostTicks++; });
    ctx.loadScript(`
      function setup() {
        return { continuous: { fixedUpdate() { tick(); while (true) {} } } };
      }
    `);
    ctx.runSetup();

    // First call: enters the guest (tick fires), then hits the deadline.
    const r1 = ctx.callHandler('continuous.fixedUpdate');
    expect(r1.ok).toBe(false);
    expect(ctx.isPoisoned).toBe(true);
    expect(ctx.isDisabled).toBe(true);
    expect(disableReasons).toHaveLength(1);
    expect(disableReasons[0]).toContain('deadline');
    expect(hostTicks).toBe(1);

    // Backoff: further calls are refused WITHOUT touching the VM — no
    // per-tick re-create/poison loop.
    for (let i = 0; i < 10; i++) {
      const r = ctx.callHandler('continuous.fixedUpdate');
      expect(r.ok).toBe(false);
      expect(r.error!.name).toBe('ContextDisabledError');
    }
    expect(hostTicks).toBe(1);            // the guest never ran again
    expect(disableReasons).toHaveLength(1); // disable fired exactly once

    // Explicit re-enable works (caller's deliberate choice).
    ctx.enable();
    expect(ctx.isDisabled).toBe(false);
    expect(ctx.isPoisoned).toBe(false);
    expect(ctx.evaluate('2 + 2').value).toBe(4);
  });

  it('explicit disable(reason) is reported and reversible', async () => {
    const host = await makeHost();
    const reasons: string[] = [];
    const ctx = host.createContext({ callDeadlineMs: 100, onDisable: (r) => reasons.push(r) });
    ctx.disable('validation failed');
    expect(ctx.isDisabled).toBe(true);
    expect(ctx.disabledReason).toBe('validation failed');
    expect(reasons).toEqual(['validation failed']);
    expect(ctx.evaluate('1').error!.name).toBe('ContextDisabledError');
    ctx.enable();
    expect(ctx.evaluate('1').value).toBe(1);
  });
});

// ─── Handle hygiene / dispose ──────────────────────────────────────────────

describe('RVScriptContext — handle hygiene and dispose', () => {
  it('per-call arena: retained handle count stays flat across 500 calls', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(COUNTER_SCRIPT);
    ctx.runSetup();

    // Warm the handler cache, then measure.
    ctx.callHandler('continuous.fixedUpdate', 1);
    const retained = ctx.retainedHandleCount;   // root + cached fixedUpdate
    expect(retained).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < 500; i++) {
      const r = ctx.callHandler('continuous.fixedUpdate', 1, );
      expect(r.ok).toBe(true);
    }
    // No handle growth from marshalled args / results (arena disposes them).
    expect(ctx.retainedHandleCount).toBe(retained);
  });

  it('loadScript releases previously retained handlers (reload path)', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(COUNTER_SCRIPT);
    ctx.runSetup();
    ctx.callHandler('continuous.fixedUpdate', 1);
    expect(ctx.retainedHandleCount).toBeGreaterThan(0);

    ctx.loadScript(COUNTER_SCRIPT);   // reload drops old handles
    expect(ctx.retainedHandleCount).toBe(0);
    expect(ctx.callHandler('continuous.fixedUpdate').error!.name).toBe('HandlersNotLoadedError');
    ctx.runSetup();
    expect(ctx.callHandler('continuous.fixedUpdate', 3).value).toBe(3);
  });

  it('dispose releases all handles; further calls return ContextDisposedError', async () => {
    const host = await makeHost();
    const ctx = host.createContext({ callDeadlineMs: 100 });
    ctx.loadScript(COUNTER_SCRIPT);
    ctx.runSetup();
    for (let i = 0; i < 100; i++) ctx.callHandler('continuous.fixedUpdate', 1);

    ctx.dispose();
    expect(ctx.isDisposed).toBe(true);
    expect(ctx.retainedHandleCount).toBe(0);
    expect(host.contextCount).toBe(0);
    expect(ctx.callHandler('continuous.fixedUpdate').error!.name).toBe('ContextDisposedError');
    expect(() => ctx.dispose()).not.toThrow();   // idempotent
  });

  it('host.dispose() disposes remaining contexts and the runtime cleanly', async () => {
    const host = await RVScriptHost.create();
    const a = host.createContext({ callDeadlineMs: 100 });
    a.loadScript(COUNTER_SCRIPT);
    a.runSetup();
    a.callHandler('continuous.fixedUpdate', 1);
    host.createContext({ callDeadlineMs: 100 });

    expect(() => host.dispose()).not.toThrow();
    expect(host.isDisposed).toBe(true);
    expect(a.isDisposed).toBe(true);
    expect(() => host.dispose()).not.toThrow();  // idempotent
  });

  it('dumpMemoryUsage returns runtime statistics (diagnostics)', async () => {
    const host = await makeHost();
    host.createContext({ callDeadlineMs: 100 });
    const dump = host.dumpMemoryUsage();
    expect(typeof dump).toBe('string');
    expect(dump.length).toBeGreaterThan(0);
  });
});
