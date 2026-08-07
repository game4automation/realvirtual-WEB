// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ModeManager tests (plan-198 mode system).
 *
 * Pure unit tests against a mock ModeHost — no RVViewer/Three.js needed.
 * Validates switch orchestration, ordering, exclusivity, the re-entrancy
 * guard, persistence, and the backward-compat set math (shared/core never
 * toggle).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModeManager,
  computeModePluginSets,
  pluginParticipatesInMode,
  modeContext,
  type ModeHost,
  type ModePluginSets,
} from '../src/core/rv-mode-manager';
import type { RVViewerPlugin } from '../src/core/rv-plugin';

/** Records every host operation in a flat call-log for ordering assertions. */
function makeHost(
  sets: ModePluginSets,
  log: string[],
  events: Array<{ event: string; data: any }>,
): ModeHost {
  return {
    viewer: {} as any,
    pluginsForMode: () => sets,
    enablePlugin: (id) => log.push(`enable:${id}`),
    disablePlugin: (id) => log.push(`disable:${id}`),
    callPlugin: (p, method) => log.push(`${method}:${p.id}`),
    setContext: (ctx, active) => log.push(`ctx:${ctx}=${active}`),
    emit: (event, data) => { log.push(`emit:${event}`); events.push({ event, data }); },
  };
}

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

beforeEach(() => {
  try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ }
});

describe('ModeManager — registry', () => {
  it('lists descriptors sorted by order', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'planner', label: 'Planner', order: 30 });
    m.register({ id: 'hmi', label: 'HMI', order: 10 });
    m.register({ id: 'des', label: 'DES', order: 20 });
    expect(m.list().map((d) => d.id)).toEqual(['hmi', 'des', 'planner']);
  });

  it('has() reflects registration', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    expect(m.has('hmi')).toBe(false);
    m.register({ id: 'hmi', label: 'HMI' });
    expect(m.has('hmi')).toBe(true);
  });
});

describe('ModeManager — setMode orchestration', () => {
  it('emits mode-changing before mode-changed with correct from/to', () => {
    const events: Array<{ event: string; data: any }> = [];
    const m = new ModeManager(makeHost(EMPTY, [], events));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.setMode('hmi');
    m.setMode('des');
    const changes = events.filter((e) => e.event.startsWith('mode-'));
    expect(changes.map((e) => e.event)).toEqual([
      'mode-changing', 'mode-changed', // hmi
      'mode-changing', 'mode-changed', // des
    ]);
    expect(changes[2].data).toEqual({ from: 'hmi', to: 'des' });
    expect(changes[3].data).toEqual({ from: 'hmi', to: 'des' });
  });

  it('orders ops: deactivate hooks → disable → ctx swap → enable → activate hooks', () => {
    const log: string[] = [];
    const sets: ModePluginSets = {
      deactivateHooks: [{ id: 'leaveHook' } as RVViewerPlugin],
      disable: [{ id: 'leave' } as RVViewerPlugin],
      enable: [{ id: 'enter' } as RVViewerPlugin],
      activateHooks: [{ id: 'enterHook' } as RVViewerPlugin],
    };
    const m = new ModeManager(makeHost(sets, log, []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.setMode('hmi'); // from null
    log.length = 0;     // focus on the hmi → des switch
    m.setMode('des');
    expect(log).toEqual([
      'emit:mode-changing',
      'onModeDeactivate:leaveHook',
      'disable:leave',
      'ctx:mode:hmi=false',
      'ctx:mode:des=true',
      'enable:enter',
      'onModeActivate:enterHook',
      'emit:mode-changed',
    ]);
  });

  it('is a no-op when the mode is already active', () => {
    const log: string[] = [];
    const m = new ModeManager(makeHost(EMPTY, log, []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.setMode('hmi');
    log.length = 0;
    m.setMode('hmi');
    expect(log).toEqual([]);
    expect(m.activeMode).toBe('hmi');
  });

  it('ignores an unknown mode', () => {
    const log: string[] = [];
    const m = new ModeManager(makeHost(EMPTY, log, []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.setMode('nope');
    expect(log).toEqual([]);
    expect(m.activeMode).toBeNull();
  });

  it('first switch sets only the target context (no stale from context)', () => {
    const log: string[] = [];
    const m = new ModeManager(makeHost(EMPTY, log, []));
    m.register({ id: 'planner', label: 'Planner' });
    m.setMode('planner');
    expect(log.filter((l) => l.startsWith('ctx:'))).toEqual(['ctx:mode:planner=true']);
  });

  it('rejects re-entrant setMode (guard)', () => {
    const log: string[] = [];
    let m!: ModeManager;
    const host = makeHost(EMPTY, log, []);
    // Re-enter setMode from within a host callback.
    host.setContext = () => { m.setMode('des'); log.push('reentrant-attempt'); };
    m = new ModeManager(host);
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.setMode('hmi');
    expect(m.activeMode).toBe('hmi'); // reentrant call was rejected
    expect(log).toContain('reentrant-attempt');
  });
});

describe('ModeManager — persistence', () => {
  it('persists the active mode and restore() reads it', () => {
    const m1 = new ModeManager(makeHost(EMPTY, [], []));
    m1.register({ id: 'hmi', label: 'HMI' });
    m1.register({ id: 'des', label: 'DES' });
    m1.setMode('des');

    const m2 = new ModeManager(makeHost(EMPTY, [], []));
    m2.register({ id: 'hmi', label: 'HMI' });
    m2.register({ id: 'des', label: 'DES' });
    m2.restore('hmi');
    expect(m2.activeMode).toBe('des');
  });

  it('restore() falls back when nothing persisted', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.restore('hmi');
    expect(m.activeMode).toBe('hmi');
  });

  it('restore() ignores a persisted but unregistered mode', () => {
    try { localStorage.setItem('rv-active-mode', 'ghost'); } catch { /* ignore */ }
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.restore('hmi');
    expect(m.activeMode).toBe('hmi');
  });

  it('notifies subscribers and bumps the snapshot on change', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    let notified = 0;
    m.subscribe(() => notified++);
    const v0 = m.getSnapshot();
    m.setMode('hmi');
    expect(notified).toBeGreaterThan(0);
    expect(m.getSnapshot()).toBeGreaterThan(v0);
  });
});

describe('ModeManager — lock', () => {
  it('lock() activates the target and reports lockedMode', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    expect(m.lockedMode).toBeNull();
    m.lock('hmi');
    expect(m.lockedMode).toBe('hmi');
    expect(m.activeMode).toBe('hmi');
  });

  it('rejects setMode to any other mode while locked', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.lock('hmi');
    m.setMode('des');
    expect(m.activeMode).toBe('hmi');
  });

  it('restore() honours the lock over a persisted mode', () => {
    try { localStorage.setItem('rv-active-mode', 'des'); } catch { /* ignore */ }
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.lock('hmi');
    m.restore('hmi');
    expect(m.activeMode).toBe('hmi');
  });

  it('unlock() re-enables free switching', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.register({ id: 'des', label: 'DES' });
    m.lock('hmi');
    m.unlock();
    expect(m.lockedMode).toBeNull();
    m.setMode('des');
    expect(m.activeMode).toBe('des');
  });

  it('lock() ignores an unknown mode (stays unlocked)', () => {
    const m = new ModeManager(makeHost(EMPTY, [], []));
    m.register({ id: 'hmi', label: 'HMI' });
    m.lock('ghost');
    expect(m.lockedMode).toBeNull();
  });
});

describe('computeModePluginSets — participation math', () => {
  const shared = { id: 'shared' } as RVViewerPlugin;                       // modes undefined
  const core = { id: 'core', core: true } as RVViewerPlugin;
  const hmiOnly = { id: 'hmi1', modes: ['hmi'] } as RVViewerPlugin;
  const plannerOnly = { id: 'plan1', modes: ['planner'] } as RVViewerPlugin;
  const all = [shared, core, hmiOnly, plannerOnly];
  const none = () => false;

  it('participation: shared/core in every mode incl. null; specific never in null', () => {
    expect(pluginParticipatesInMode(shared, null)).toBe(true);
    expect(pluginParticipatesInMode(core, null)).toBe(true);
    expect(pluginParticipatesInMode(hmiOnly, null)).toBe(false);
    expect(pluginParticipatesInMode(hmiOnly, 'hmi')).toBe(true);
    expect(pluginParticipatesInMode(plannerOnly, 'hmi')).toBe(false);
  });

  it('shared and core never appear in any set', () => {
    const s = computeModePluginSets(all, none, 'hmi', 'planner');
    const ids = (arr: RVViewerPlugin[]) => arr.map((p) => p.id);
    for (const list of [s.enable, s.disable, s.activateHooks, s.deactivateHooks]) {
      expect(ids(list)).not.toContain('shared');
      expect(ids(list)).not.toContain('core');
    }
  });

  it('boot (from null) disables non-target plugins, no enables', () => {
    // Nothing disabled yet; entering hmi from null.
    const s = computeModePluginSets(all, none, null, 'hmi');
    expect(s.disable.map((p) => p.id)).toEqual(['plan1']); // planner-only off
    expect(s.enable).toEqual([]);
    expect(s.activateHooks.map((p) => p.id)).toEqual(['hmi1']); // hmi enters
    expect(s.deactivateHooks).toEqual([]);
  });

  it('switch hmi→planner: enable planner (was disabled), disable hmi-only', () => {
    const disabled = new Set(['plan1']); // planner was disabled while in hmi
    const isDisabled = (id: string) => disabled.has(id);
    const s = computeModePluginSets(all, isDisabled, 'hmi', 'planner');
    expect(s.enable.map((p) => p.id)).toEqual(['plan1']);
    expect(s.disable.map((p) => p.id)).toEqual(['hmi1']);
    expect(s.activateHooks.map((p) => p.id)).toEqual(['plan1']);
    expect(s.deactivateHooks.map((p) => p.id)).toEqual(['hmi1']);
  });

  it('keeps the default predicate byte-equivalent to an explicit no-op', () => {
    const disabled = new Set(['plan1']);
    const isDisabled = (id: string) => disabled.has(id);
    expect(computeModePluginSets(all, isDisabled, 'hmi', 'planner')).toEqual(
      computeModePluginSets(all, isDisabled, 'hmi', 'planner', () => false),
    );
  });

  it('keeps user-disabled plugins out of enable and both mode hook sets', () => {
    const disabled = new Set(['plan1']);
    const userDisabled = new Set(['hmi1', 'plan1']);
    const s = computeModePluginSets(
      all,
      (id) => disabled.has(id),
      'hmi',
      'planner',
      (id) => userDisabled.has(id),
    );
    expect(s.enable).toEqual([]);
    expect(s.activateHooks).toEqual([]);
    expect(s.deactivateHooks).toEqual([]);
  });

  it('modeContext formats the context name', () => {
    expect(modeContext('planner')).toBe('mode:planner');
  });
});
