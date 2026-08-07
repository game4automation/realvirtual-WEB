// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ModeManager exit-guard tests (asset-editor refactor): requestMode runs the
 * leaving mode's guards, vetoes cancel, setMode/lock bypass by design.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

function makeManager(): ModeManager {
  const host: ModeHost = {
    viewer: {} as never,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: () => {},
    setContext: () => {},
    emit: () => {},
  };
  const m = new ModeManager(host);
  m.register({ id: 'hmi', label: 'HMI' });
  m.register({ id: 'editor', label: 'Editor', runtime: 'detached' });
  return m;
}

beforeEach(() => {
  try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ }
});

describe('ModeManager — exit guards', () => {
  it('requestMode runs the leaving mode guard; veto cancels the switch', async () => {
    const m = makeManager();
    m.setMode('editor');
    let allow = false;
    m.registerExitGuard('editor', () => allow);

    expect(await m.requestMode('hmi')).toBe(false);
    expect(m.activeMode).toBe('editor');

    allow = true;
    expect(await m.requestMode('hmi')).toBe(true);
    expect(m.activeMode).toBe('hmi');
  });

  it('async guards are awaited', async () => {
    const m = makeManager();
    m.setMode('editor');
    m.registerExitGuard('editor', () => Promise.resolve(false));
    expect(await m.requestMode('hmi')).toBe(false);
    expect(m.activeMode).toBe('editor');
  });

  it('a throwing guard counts as a veto', async () => {
    const m = makeManager();
    m.setMode('editor');
    m.registerExitGuard('editor', () => { throw new Error('boom'); });
    expect(await m.requestMode('hmi')).toBe(false);
    expect(m.activeMode).toBe('editor');
  });

  it('guards only run when LEAVING their mode', async () => {
    const m = makeManager();
    let calls = 0;
    m.registerExitGuard('editor', () => { calls++; return false; });
    m.setMode('hmi');
    expect(await m.requestMode('editor')).toBe(true);  // entering editor: no guard
    expect(calls).toBe(0);
    expect(await m.requestMode('editor')).toBe(true);  // already active: no-op
    expect(calls).toBe(0);
  });

  it('setMode and lock() bypass guards (force semantics)', () => {
    const m = makeManager();
    m.setMode('editor');
    m.registerExitGuard('editor', () => false);
    m.setMode('hmi');                 // direct setMode ignores guards
    expect(m.activeMode).toBe('hmi');
    m.setMode('editor');
    m.lock('hmi');                    // kiosk lock ignores guards too
    expect(m.activeMode).toBe('hmi');
  });

  it('unregistering a guard removes it', async () => {
    const m = makeManager();
    m.setMode('editor');
    const off = m.registerExitGuard('editor', () => false);
    expect(await m.requestMode('hmi')).toBe(false);
    off();
    expect(await m.requestMode('hmi')).toBe(true);
  });
});
