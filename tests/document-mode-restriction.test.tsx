// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-document mode restriction (`documents[].modes` + `mode` as default).
 *
 * Pins the four places the restriction is decided: the ModeManager (refusal,
 * fallback, `available()`), the switcher (hides what is forbidden), the boot
 * resolver (`?mode=` of a forbidden mode lands in the default) and the pure
 * open-target helpers the dashboard chain uses before the document is loaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { ModeDropdown } from '../src/core/hmi/ModeDropdown';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import { resolveBootMode } from '../src/core/rv-boot-mode';
import {
  allowedModesOf,
  effectiveOpenMode,
  handoffParkMode,
  isModeAllowedForRow,
  restrictedOpenTarget,
} from '../src/core/project/rv-document-mode';
import type { RVViewer } from '../src/core/rv-viewer';

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

/** The modes `main.ts` + the asset editor register, in their order. */
function makeModes(): ModeManager {
  const host: ModeHost = {
    viewer: {} as RVViewer,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
    setContext: () => {}, emit: () => {},
  };
  return new ModeManager(host)
    .register({ id: 'viewer', label: 'Viewer', order: 5 })
    .register({ id: 'hmi', label: 'HMI', order: 10 })
    .register({ id: 'des', label: 'DES', order: 20 })
    .register({ id: 'planner', label: 'Planner', order: 30 })
    .register({ id: 'commissioning', label: 'Commissioning', order: 35 })
    .register({ id: 'editor', label: 'Editor', order: 40, runtime: 'detached' });
}

const WALKER = {
  allowed: ['commissioning', 'viewer'],
  defaultMode: 'commissioning',
  owner: 'doc_mujocowalker_15i4u8p',
};

beforeEach(() => { try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ } });
afterEach(() => cleanup());

describe('ModeManager — document restriction', () => {
  it('allows every mode without a restriction (today\'s behaviour)', () => {
    const m = makeModes();
    expect(m.available().map(d => d.id)).toEqual(['viewer', 'hmi', 'des', 'planner', 'commissioning', 'editor']);
    expect(m.refusalReason('hmi')).toBeNull();
  });

  it('offers only the allowed modes plus the authoring editor', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    expect(m.available().map(d => d.id)).toEqual(['viewer', 'commissioning', 'editor']);
    expect(m.isAllowed('editor')).toBe(true);
    expect(m.isAllowed('des')).toBe(false);
  });

  it('refuses a forbidden switch with a reason instead of switching', () => {
    const m = makeModes();
    m.setMode('commissioning');
    m.setRestriction(WALKER);
    expect(m.switchMode('hmi')).toBe(false);
    expect(m.activeMode).toBe('commissioning');
    expect(m.lastRefusal).toBe('mode-not-allowed:hmi for doc_mujocowalker_15i4u8p');
    expect(m.refusalReason('des')).toBe('mode-not-allowed:des for doc_mujocowalker_15i4u8p');
  });

  it('refuses a forbidden requestMode before any exit guard is asked', async () => {
    const m = makeModes();
    m.setMode('commissioning');
    m.setRestriction(WALKER);
    let asked = 0;
    m.registerExitGuard('commissioning', () => { asked++; return true; });
    expect(await m.requestMode('des')).toBe(false);
    expect(asked).toBe(0);
    expect(await m.requestMode('viewer')).toBe(true);
    expect(m.activeMode).toBe('viewer');
  });

  it('enforceRestriction moves a forbidden active mode to the default', () => {
    const m = makeModes();
    m.setMode('hmi');
    m.setRestriction(WALKER);
    expect(m.enforceRestriction()).toBe(true);
    expect(m.activeMode).toBe('commissioning');
  });

  it('enforceRestriction keeps an allowed active mode', () => {
    const m = makeModes();
    m.setMode('viewer');
    m.setRestriction(WALKER);
    m.enforceRestriction();
    expect(m.activeMode).toBe('viewer');
  });

  it('falls back to the first allowed mode when the default is absent or forbidden', () => {
    const m = makeModes();
    m.setRestriction({ allowed: ['commissioning', 'viewer'], defaultMode: 'hmi', owner: 'd' });
    // available() is sorted by order: viewer (5) before commissioning (35).
    expect(m.restrictedFallback()).toBe('viewer');
    m.setRestriction({ allowed: ['commissioning'], owner: 'd' });
    expect(m.restrictedFallback()).toBe('commissioning');
  });

  it('peekRestoreTarget never answers a forbidden persisted mode', () => {
    const m = makeModes();
    m.setMode('des');                       // persists 'des'
    m.setRestriction(WALKER);
    expect(m.peekRestoreTarget()).toBe('commissioning');
  });

  it('clearing the restriction restores the full set', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    m.setRestriction(null);
    expect(m.available()).toHaveLength(6);
    expect(m.switchMode('des')).toBe(true);
  });

  it('a kiosk lock outranks the restriction', () => {
    const m = makeModes();
    m.lock('hmi');
    m.setRestriction(WALKER);
    expect(m.isAllowed('hmi')).toBe(true);
    expect(m.enforceRestriction()).toBe(true);
    expect(m.activeMode).toBe('hmi');
  });

  it('setRestriction is idempotent — an equal restriction notifies nobody', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    const v = m.getSnapshot();
    m.setRestriction({ ...WALKER, allowed: [...WALKER.allowed] });
    expect(m.getSnapshot()).toBe(v);
  });
});

describe('ModeDropdown — hides forbidden modes', () => {
  function renderWith(viewer: RVViewer) {
    const Wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RVViewerProvider, { value: viewer }, children);
    return render(createElement(ModeDropdown), { wrapper: Wrapper });
  }

  it('lists only the document\'s modes (and the editor) while it is open', () => {
    const modes = makeModes();
    modes.setMode('commissioning');
    modes.setRestriction(WALKER);
    renderWith({ modes } as unknown as RVViewer);
    fireEvent.click(screen.getByLabelText('Switch workspace mode'));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map(i => i.textContent);
    expect(items).toEqual(['Viewer', 'Commissioning', 'Editor']);
  });
});

describe('resolveBootMode — ?mode= under a restriction', () => {
  const candidates = { locked: null, url: 'hmi', hostedStart: null, published: null, resume: null };

  it('?mode=hmi on a restricted document lands in its default', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    expect(resolveBootMode(candidates, m)).toEqual({ mode: 'commissioning', source: 'restore' });
  });

  it('?mode= naming an allowed mode wins', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    expect(resolveBootMode({ ...candidates, url: 'viewer' }, m)).toEqual({ mode: 'viewer', source: 'url' });
  });

  it('a forbidden resume mode falls through as well', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    expect(resolveBootMode({ ...candidates, url: null, resume: 'des' }, m).mode).toBe('commissioning');
  });

  it('without a restriction ?mode=hmi is taken as before', () => {
    expect(resolveBootMode(candidates, makeModes())).toEqual({ mode: 'hmi', source: 'url' });
  });
});

describe('open-target helpers (decided before the document loads)', () => {
  const has = () => true;
  const runtimeOf = (m: string) => (m === 'editor' ? 'detached' : undefined);

  it('allowedModesOf normalises the row field', () => {
    expect(allowedModesOf({ modes: [' commissioning ', 'viewer', '', 3] })).toEqual(['commissioning', 'viewer']);
    expect(allowedModesOf({ modes: [] })).toBeNull();
    expect(allowedModesOf({})).toBeNull();
    expect(allowedModesOf(null)).toBeNull();
  });

  it('isModeAllowedForRow exempts authoring modes', () => {
    const allowed = ['commissioning'];
    expect(isModeAllowedForRow(allowed, 'commissioning', runtimeOf)).toBe(true);
    expect(isModeAllowedForRow(allowed, 'editor', runtimeOf)).toBe(true);
    expect(isModeAllowedForRow(allowed, 'hmi', runtimeOf)).toBe(false);
    expect(isModeAllowedForRow(null, 'hmi', runtimeOf)).toBe(true);
  });

  it('a stored last mode the document forbids is no target', () => {
    const isAllowed = (m: string) => isModeAllowedForRow(['commissioning', 'viewer'], m, runtimeOf);
    expect(effectiveOpenMode({ lastMode: 'hmi', declaredMode: 'commissioning', isDemo: false, has, isAllowed }))
      .toBe('commissioning');
    expect(effectiveOpenMode({ lastMode: 'viewer', declaredMode: 'commissioning', isDemo: false, has, isAllowed }))
      .toBe('viewer');
  });

  it('restrictedOpenTarget keeps an allowed active mode, else the default', () => {
    const allowed = ['commissioning', 'viewer'];
    const isAllowed = (m: string) => isModeAllowedForRow(allowed, m, runtimeOf);
    expect(restrictedOpenTarget({ active: 'viewer', declaredMode: 'commissioning', allowed, has, isAllowed })).toBe('viewer');
    expect(restrictedOpenTarget({ active: 'hmi', declaredMode: 'commissioning', allowed, has, isAllowed })).toBe('commissioning');
    expect(restrictedOpenTarget({ active: 'hmi', declaredMode: null, allowed, has, isAllowed })).toBe('commissioning');
    expect(restrictedOpenTarget({ active: 'hmi', declaredMode: null, allowed: null, has, isAllowed: () => true })).toBe('hmi');
  });

  it('handoffParkMode parks in a mode the open document allows', () => {
    const m = makeModes();
    m.setRestriction(WALKER);
    expect(handoffParkMode(m)).toBe('viewer');
  });
});
