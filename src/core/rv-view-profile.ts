// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getSessionStorage } from './rv-safe-storage';

/**
 * View profile of the dev server (plan-615 F3): **dev view** versus
 * **delivered view**.
 *
 * The delivered view is not a mechanism of its own. A delivery is defined by
 * the view keys of its app config — `mode.lock`, `lockSettings`, `lockedTabs`
 * and `ui` (`initialContexts`, `visibilityOverrides`) — which `main.ts` applies
 * at boot. This module only decides WHICH config the boot applies:
 *
 * - **delivered** = the boot config when it carries at least one view key (a
 *   customer workspace serves its delivered `settings.json`), otherwise the boot
 *   config plus the appliance profile `{ mode: { lock: 'hmi' }, lockSettings: true }`
 *   — "HMI only", what an appliance delivery generates.
 * - **dev** = the boot config with every view key removed; all other keys stay.
 *
 * **Switching reloads the page** (plan-615 §6.1, variant B). Only the boot
 * path applies a config the way a delivery does — the resume target and the
 * Projects dashboard are decided from the mode lock at boot, and visibility
 * overrides cannot be taken back at runtime. The choice is kept in
 * sessionStorage (per tab); `?view=dev|delivered` in the URL wins over it and is
 * removed from the URL when the user switches.
 *
 * **Without a choice the boot is unchanged**: the config is applied exactly as
 * loaded, and `current()` reports what that config amounts to.
 *
 * Dev server only: `main.ts` calls {@link applyBootViewProfile} behind
 * `RV_SERVE_INFO !== null`, so a build neither reads `?view=` nor carries this
 * module's logic.
 */

import type { RVAppConfig } from './rv-app-config';

/** The two views of the dev server. */
export type ViewProfile = 'dev' | 'delivered';

/** What the dev toolbar reads and drives. */
export interface ViewProfileHost {
  /** The config a delivery applies (see the module doc for the rule). */
  deliveredConfig(): RVAppConfig;
  /** Persists the choice and reloads the page into that view. */
  apply(profile: ViewProfile): Promise<void>;
  /** The view this page was booted into. */
  current(): ViewProfile;
}

/** sessionStorage key of the chosen view (per tab, survives the reload). */
export const VIEW_PROFILE_SESSION_KEY = 'rv-view-profile';

/** URL parameter that selects a view for one boot; wins over sessionStorage. */
export const VIEW_PROFILE_PARAM = 'view';

/** The config keys that decide what a delivery shows. */
export const VIEW_CONFIG_KEYS = ['mode', 'lockSettings', 'lockedTabs', 'ui'] as const;

/** The delivered view of a config without own view keys: HMI only, settings locked. */
export const APPLIANCE_VIEW: Readonly<Pick<RVAppConfig, 'mode' | 'lockSettings'>> = Object.freeze({
  mode: Object.freeze({ lock: 'hmi' }),
  lockSettings: true,
});

function isViewProfile(value: unknown): value is ViewProfile {
  return value === 'dev' || value === 'delivered';
}

/** True when the config sets any key that changes what the delivery shows. */
export function hasDeliveryViewKeys(config: RVAppConfig): boolean {
  if (typeof config.mode?.lock === 'string' && config.mode.lock.trim() !== '') return true;
  if (config.lockSettings === true) return true;
  if (Array.isArray(config.lockedTabs) && config.lockedTabs.length > 0) return true;
  const ui = config.ui;
  if (ui && Array.isArray(ui.initialContexts) && ui.initialContexts.length > 0) return true;
  if (ui && ui.visibilityOverrides && typeof ui.visibilityOverrides === 'object'
    && Object.keys(ui.visibilityOverrides).length > 0) return true;
  return false;
}

/** The dev view: the boot config without its view keys. Never mutates `boot`. */
export function devViewOf(boot: RVAppConfig): RVAppConfig {
  const out: RVAppConfig = { ...boot };
  for (const key of VIEW_CONFIG_KEYS) delete out[key];
  return out;
}

/** The delivered view: the boot config, or boot + appliance profile when it has no view keys. */
export function deliveredViewOf(boot: RVAppConfig): RVAppConfig {
  if (hasDeliveryViewKeys(boot)) return { ...boot };
  return { ...boot, mode: { lock: APPLIANCE_VIEW.mode!.lock }, lockSettings: true };
}

/** The view the boot config amounts to when nobody chose one. */
export function implicitViewOf(boot: RVAppConfig): ViewProfile {
  return hasDeliveryViewKeys(boot) ? 'delivered' : 'dev';
}

/** The explicitly requested view: URL parameter first, then sessionStorage, else null. */
export function readRequestedView(
  search: string,
  storage: Pick<Storage, 'getItem'> | null,
): ViewProfile | null {
  try {
    const fromUrl = new URLSearchParams(search).get(VIEW_PROFILE_PARAM);
    if (isViewProfile(fromUrl)) return fromUrl;
  } catch { /* malformed query — fall through */ }
  try {
    const stored = storage?.getItem(VIEW_PROFILE_SESSION_KEY) ?? null;
    if (isViewProfile(stored)) return stored;
  } catch { /* storage blocked */ }
  return null;
}

/** The config the boot applies for `requested`, and the view that results. */
export function resolveBootView(
  boot: RVAppConfig,
  requested: ViewProfile | null,
): { config: RVAppConfig; profile: ViewProfile } {
  if (requested === 'dev') return { config: devViewOf(boot), profile: 'dev' };
  if (requested === 'delivered') return { config: deliveredViewOf(boot), profile: 'delivered' };
  return { config: boot, profile: implicitViewOf(boot) };
}

/** `href` without the `view` parameter — so the stored choice decides the next boot. */
export function urlWithoutViewParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(VIEW_PROFILE_PARAM);
  return url.toString();
}

/** Everything the host touches outside itself — injected so tests need no reload. */
export interface ViewProfileHostOptions {
  boot: RVAppConfig;
  profile: ViewProfile;
  storage: Pick<Storage, 'setItem'> | null;
  href: () => string;
  navigate: (url: string) => void;
}

/** Builds the host for a booted page. */
export function createViewProfileHost(opts: ViewProfileHostOptions): ViewProfileHost {
  // Frozen copy: the boot config object is the app singleton and gets
  // mutated by URL overrides; the delivered rule must see what was loaded.
  const boot: RVAppConfig = { ...opts.boot };
  return {
    deliveredConfig: () => deliveredViewOf(boot),
    current: () => opts.profile,
    apply: async (profile: ViewProfile) => {
      try { opts.storage?.setItem(VIEW_PROFILE_SESSION_KEY, profile); } catch { /* storage blocked */ }
      opts.navigate(urlWithoutViewParam(opts.href()));
    },
  };
}

// ─── Singleton of the running page ─────────────────────────────────────

let _host: ViewProfileHost | null = null;

/** The host of this page, or null outside the dev server. */
export function getViewProfileHost(): ViewProfileHost | null {
  return _host;
}

/** Test seam / boot: installs the host. */
export function setViewProfileHost(host: ViewProfileHost | null): void {
  _host = host;
}

/**
 * Boot entry (dev server only): resolves the requested view against the loaded
 * config, installs the host and returns the config to apply.
 */
export function applyBootViewProfile(boot: RVAppConfig): RVAppConfig {
  const storage = getSessionStorage();
  const requested = readRequestedView(window.location.search, storage);
  const { config, profile } = resolveBootView(boot, requested);
  setViewProfileHost(createViewProfileHost({
    boot,
    profile,
    storage,
    href: () => window.location.href,
    // An unchanged URL with a #fragment would only scroll on replace(), not reload.
    navigate: (url) => {
      if (url === window.location.href) window.location.reload();
      else window.location.replace(url);
    },
  }));
  return config;
}
