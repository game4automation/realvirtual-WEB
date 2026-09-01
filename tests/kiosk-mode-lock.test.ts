// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The generic kiosk lock and, above all, WHEN it is applied (plan-721 F5, §2.2).
 *
 * Two existing callers of `ModeManager.lock()` do the same thing at
 * fundamentally different times:
 *
 *  * `src/plugins/connect-embed/connect-embed-store.ts` locks EARLY, from the
 *    mode-registration block in `main.ts` — before the boot resolves what to
 *    open.
 *  * The project plugins (`projects/mauser3dhmi`, `projects/Toray`) lock LATE,
 *    from the model-plugin hook, i.e. after the model has already loaded.
 *
 * `resolveResumeTarget` reads `modes.lockedMode`. A late lock is therefore
 * invisible to it: the kiosk branch silently does not apply, and the boot falls
 * through to the legacy catalogue resolution — the exact failure plan-721
 * exists to remove. So the early caller is the precedent and the late one is
 * the counter-example, and that ordering is asserted here rather than left to
 * the next person to rediscover.
 */

import { describe, it, expect } from 'vitest';
import { lockedModeOf, type RVAppConfig } from '../src/core/rv-app-config';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import { resolveResumeTarget } from '../src/core/project/rv-project-open';
import mainSource from '../src/main.ts?raw';

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

/** The same inert mock host `rv-mode-manager.test.ts` uses. */
const HOST: ModeHost = {
  viewer: {} as never,
  pluginsForMode: () => EMPTY,
  enablePlugin: () => {},
  disablePlugin: () => {},
  callPlugin: () => {},
  setContext: () => {},
  emit: () => {},
};

/** The two modes the assertions below need; `main.ts` registers more. */
function modes(): ModeManager {
  return new ModeManager(HOST)
    .register({ id: 'hmi', label: 'HMI', order: 10 })
    .register({ id: 'planner', label: 'Planner', order: 30 });
}

describe('reading the flag', () => {
  it('names the mode a delivery locked the box into', () => {
    expect(lockedModeOf({ mode: { lock: 'hmi' } })).toBe('hmi');
    expect(lockedModeOf({ mode: { lock: '  hmi  ' } })).toBe('hmi');
  });

  it('an absent, blank or non-string flag is "no lock"', () => {
    // The generated appliance config is machine-written, so an empty string is
    // a real shape — and it must never lock the box into a mode called ''.
    expect(lockedModeOf({})).toBeNull();
    expect(lockedModeOf({ mode: {} })).toBeNull();
    expect(lockedModeOf({ mode: { lock: '' } })).toBeNull();
    expect(lockedModeOf({ mode: { lock: '   ' } })).toBeNull();
    expect(lockedModeOf({ mode: { lock: 42 } } as unknown as RVAppConfig)).toBeNull();
  });

  it('leaves every existing delivery unlocked — the flag is opt-in', () => {
    // Every settings.json in the wild predates this key.
    expect(lockedModeOf({ defaultModel: 'line.glb', lockSettings: true })).toBeNull();
  });
});

describe('applying the flag', () => {
  it('a config with the flag leaves lockedMode set, in that mode', () => {
    const m = modes();
    expect(m.lockedMode).toBeNull();
    const id = lockedModeOf({ mode: { lock: 'hmi' } });
    if (id) m.lock(id);
    expect(m.lockedMode).toBe('hmi');
    expect(m.activeMode).toBe('hmi');
  });

  it('and the lock then holds against every later switch', () => {
    const m = modes();
    m.lock('hmi');
    m.setMode('planner');
    expect(m.activeMode).toBe('hmi');
    m.restore('planner');
    expect(m.activeMode).toBe('hmi');
  });

  it('a mode this build does not register is ignored, not fatal', () => {
    // A community build has no Editor; a config naming one must not strand the
    // deployment in a mode that cannot render.
    const m = modes();
    m.lock('editor');
    expect(m.lockedMode).toBeNull();
  });

  it('no flag means the deployment behaves exactly as before', () => {
    const m = modes();
    const id = lockedModeOf({});
    if (id) m.lock(id);
    expect(m.lockedMode).toBeNull();
  });
});

describe('the lock is what makes the resume rule take the kiosk branch', () => {
  it('locked ⇒ the URL is discarded and the start document wins', () => {
    const m = modes();
    m.lock('hmi');
    const target = resolveResumeTarget({
      search: '?model=pasted.glb',
      remembered: { asset: 'stale.glb', mode: 'planner' },
      defaultModel: 'Machine.glb',
      modeLocked: m.lockedMode !== null,
    });
    expect(target).toEqual({ asset: 'Machine.glb', mode: null, source: 'defaultModel' });
  });

  it('unlocked ⇒ the very same inputs resolve to the URL', () => {
    const m = modes();
    const target = resolveResumeTarget({
      search: '?model=pasted.glb',
      remembered: { asset: 'stale.glb', mode: 'planner' },
      defaultModel: 'Machine.glb',
      modeLocked: m.lockedMode !== null,
    });
    expect(target).toEqual({ asset: 'pasted.glb', mode: null, source: 'url' });
  });
});

// ─── The ordering contract (§2.2, review finding 2) ──────────────────────

describe('main.ts wires the lock BEFORE it resolves the resume target', () => {
  const lockAt = mainSource.indexOf('lockedModeOf(appConfig)');
  const resumeAt = mainSource.indexOf('resolveResumeTarget({');

  it('both call sites are present in the boot', () => {
    expect(lockAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeGreaterThan(-1);
  });

  it('and the lock comes first', () => {
    // Source order is the honest proxy here: `main.ts` is one long async boot,
    // and what this guards against is somebody moving the lock to a
    // model-plugin hook "for consistency with Mauser" — which is precisely the
    // move that makes the kiosk branch silently stop applying.
    expect(lockAt).toBeLessThan(resumeAt);
  });

  it('and it comes before the project is even resolved', () => {
    // The sharper form of the same contract, and the one that pins the
    // connect-embed placement rather than merely "somewhere above". A lock
    // applied after the project has been resolved and its model loaded — the
    // model-plugin position — would sit BELOW this line.
    expect(lockAt).toBeLessThan(mainSource.indexOf('resolveActiveProject({'));
  });

  it('it sits with the mode registration, not in a plugin hook', () => {
    // `lock()` only works on a REGISTERED mode, so the placement is bounded on
    // both sides: after `modes.register(...)` and immediately after it.
    const registerAt = mainSource.indexOf('.register({ id: \'viewer\'');
    expect(registerAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(registerAt);
    expect(mainSource.slice(registerAt, lockAt).split('\n').length).toBeLessThan(60);
  });
});
