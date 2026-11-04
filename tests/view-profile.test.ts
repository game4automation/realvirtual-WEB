// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-615 §9.3 — dev view ↔ delivered view (`rv-view-profile.ts`, variant B).
 *
 * `apply('delivered')` locks the mode and the settings, `apply('dev')` lifts
 * both and restores the starting config. Variant B means apply() persists the
 * choice and reloads; the reload's boot then resolves the config — so the
 * cycle is asserted over the real boot resolution with a stored choice, the
 * real `setAppConfig` / `isSettingsLocked` / `isTabLocked` / `lockedModeOf`,
 * and a real ModeManager for the lock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPLIANCE_VIEW, VIEW_PROFILE_SESSION_KEY, createViewProfileHost, deliveredViewOf, devViewOf,
  hasDeliveryViewKeys, readRequestedView, resolveBootView, urlWithoutViewParam,
  type ViewProfile,
} from '../src/core/rv-view-profile';
import {
  getAppConfig, isSettingsLocked, isTabLocked, lockedModeOf, setAppConfig, type RVAppConfig,
} from '../src/core/rv-app-config';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import mainSource from '../src/main.ts?raw';

/** A stand-in Storage. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

/** What main.ts does with the resolved config: set the singleton, apply the lock. */
function boot(config: RVAppConfig, search: string, storage: Storage, modes: ModeManager) {
  const { config: applied, profile } = resolveBootView(config, readRequestedView(search, storage));
  setAppConfig(applied);
  modes.unlock();
  const lock = lockedModeOf(applied);
  if (lock) modes.lock(lock);
  return profile;
}

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

/** The inert mock host of tests/kiosk-mode-lock.test.ts. */
const HOST: ModeHost = {
  viewer: {} as never,
  pluginsForMode: () => EMPTY,
  enablePlugin: () => {},
  disablePlugin: () => {},
  callPlugin: () => {},
  setContext: () => {},
  emit: () => {},
};

function modeManager(): ModeManager {
  return new ModeManager(HOST)
    .register({ id: 'hmi', label: 'HMI', order: 10 })
    .register({ id: 'planner', label: 'Planner', order: 30 });
}

afterEach(() => { setAppConfig({}); });

describe('9.3 apply(delivered) locks, apply(dev) unlocks and restores', () => {
  it('Test_ApplyCycle_ConfigWithoutViewKeys_DeliveredLocksDevRestores', async () => {
    const start: RVAppConfig = { defaultModel: 'demo.glb', analytics: { googleAnalyticsId: '' } };
    const storage = memoryStorage();
    const modes = modeManager();
    const navigate = vi.fn();

    // First boot, no choice: unchanged, reported as dev.
    expect(boot(start, '', storage, modes)).toBe('dev');
    expect(getAppConfig()).toBe(start);
    expect(isSettingsLocked()).toBe(false);
    expect(modes.lockedMode).toBeNull();

    const host = createViewProfileHost({ boot: start, profile: 'dev', storage, href: () => 'http://localhost:5615/?model=demo.glb', navigate });
    await host.apply('delivered');
    expect(storage.getItem(VIEW_PROFILE_SESSION_KEY)).toBe('delivered');
    expect(navigate).toHaveBeenCalledWith('http://localhost:5615/?model=demo.glb');

    // Reload → delivered: mode and settings locked (appliance profile).
    expect(boot(start, '', storage, modes)).toBe('delivered');
    expect(isSettingsLocked()).toBe(true);
    expect(isTabLocked('visual')).toBe(true);
    expect(modes.lockedMode).toBe('hmi');
    expect(modes.activeMode).toBe('hmi');

    await createViewProfileHost({ boot: start, profile: 'delivered', storage, href: () => 'http://x/', navigate }).apply('dev');
    expect(storage.getItem(VIEW_PROFILE_SESSION_KEY)).toBe('dev');

    // Reload → dev: both lifted, starting config restored.
    expect(boot(start, '', storage, modes)).toBe('dev');
    expect(isSettingsLocked()).toBe(false);
    expect(modes.lockedMode).toBeNull();
    expect(getAppConfig()).toEqual(start);
  });

  it('Test_ApplyCycle_DeliveryConfig_DeliveredIsTheConfigItself', () => {
    const delivery: RVAppConfig = {
      defaultModel: 'line.glb',
      mode: { lock: 'planner' },
      lockedTabs: ['mouse'],
      ui: { initialContexts: ['kiosk'], visibilityOverrides: { help: { hiddenIn: ['kiosk'] } } },
    };
    const storage = memoryStorage();
    const modes = modeManager();

    // No choice: the delivery config applies unchanged and reports "delivered".
    expect(boot(delivery, '', storage, modes)).toBe('delivered');
    expect(getAppConfig()).toBe(delivery);
    expect(modes.lockedMode).toBe('planner');

    storage.setItem(VIEW_PROFILE_SESSION_KEY, 'dev');
    expect(boot(delivery, '', storage, modes)).toBe('dev');
    expect(modes.lockedMode).toBeNull();
    expect(isTabLocked('mouse')).toBe(false);
    expect(getAppConfig()).toEqual({ defaultModel: 'line.glb' });

    storage.setItem(VIEW_PROFILE_SESSION_KEY, 'delivered');
    expect(boot(delivery, '', storage, modes)).toBe('delivered');
    expect(getAppConfig()).toEqual(delivery); // no appliance profile layered on top
    expect(isSettingsLocked()).toBe(false);
    expect(isTabLocked('mouse')).toBe(true);
    expect(modes.lockedMode).toBe('planner');
  });
});

describe('rules', () => {
  it('Test_DevView_StripsOnlyViewKeys_NeverMutates', () => {
    const boot: RVAppConfig = { defaultModel: 'a', lockSettings: true, mode: { lock: 'hmi' }, ui: { initialContexts: ['kiosk'] }, plugins: ['x'] };
    const copy = JSON.parse(JSON.stringify(boot));
    expect(devViewOf(boot)).toEqual({ defaultModel: 'a', plugins: ['x'] });
    expect(boot).toEqual(copy);
  });

  it('Test_DeliveredView_NoViewKeys_AddsApplianceProfile', () => {
    expect(deliveredViewOf({ defaultModel: 'a' })).toEqual({ defaultModel: 'a', ...APPLIANCE_VIEW });
  });

  it.each<[RVAppConfig, boolean]>([
    [{}, false],
    [{ mode: { lock: '  ' } }, false],
    [{ lockSettings: false }, false],
    [{ lockedTabs: [] }, false],
    [{ ui: { initialContexts: [], visibilityOverrides: {} } }, false],
    [{ mode: { lock: 'hmi' } }, true],
    [{ lockSettings: true }, true],
    [{ lockedTabs: ['mouse'] }, true],
    [{ ui: { initialContexts: ['kiosk'] } }, true],
    [{ ui: { visibilityOverrides: { help: {} } } }, true],
  ])('Test_HasDeliveryViewKeys_%j_%s', (config, expected) => {
    expect(hasDeliveryViewKeys(config)).toBe(expected);
  });

  it('Test_RequestedView_UrlWinsOverStorage_InvalidIgnored', () => {
    const storage = memoryStorage();
    storage.setItem(VIEW_PROFILE_SESSION_KEY, 'dev');
    expect(readRequestedView('?view=delivered', storage)).toBe('delivered');
    expect(readRequestedView('?view=nonsense', storage)).toBe('dev');
    expect(readRequestedView('', storage)).toBe('dev');
    storage.setItem(VIEW_PROFILE_SESSION_KEY, 'garbage');
    expect(readRequestedView('', storage)).toBeNull();
    expect(readRequestedView('', null)).toBeNull();
  });

  it('Test_Apply_RemovesViewParamSoTheStoredChoiceDecides', async () => {
    const navigate = vi.fn();
    const storage = memoryStorage();
    const host = createViewProfileHost({
      boot: {}, profile: 'delivered' as ViewProfile, storage,
      href: () => 'http://localhost:5615/?view=delivered&model=a.glb#frag', navigate,
    });
    await host.apply('dev');
    expect(navigate).toHaveBeenCalledWith('http://localhost:5615/?model=a.glb#frag');
    expect(urlWithoutViewParam('http://h/?a=1')).toBe('http://h/?a=1');
  });

  it('Test_Host_DeliveredConfig_IgnoresLaterMutationOfBootObject', () => {
    const bootConfig: RVAppConfig = { defaultModel: 'a' };
    const host = createViewProfileHost({ boot: bootConfig, profile: 'dev', storage: null, href: () => 'http://h/', navigate: () => undefined });
    bootConfig.lockSettings = true; // what main.ts' ?lockSettings override does to the singleton
    expect(host.deliveredConfig()).toEqual({ defaultModel: 'a', ...APPLIANCE_VIEW });
  });
});

describe('main.ts wiring', () => {
  it('Test_Main_AppliesViewProfileDevOnly_BeforeSingletonAndLock', () => {
    const at = mainSource.indexOf('RV_SERVE_INFO !== null ? applyBootViewProfile(loadedConfig) : loadedConfig');
    expect(at).toBeGreaterThan(-1);
    expect(mainSource.indexOf('setAppConfig(appConfig)')).toBeGreaterThan(at);
    expect(mainSource.indexOf('lockedModeOf(appConfig)')).toBeGreaterThan(at);
  });
});
