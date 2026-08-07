// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * App-level configuration singleton.
 *
 * Loaded from `public/settings.json` before React mounts.
 * Provides lock-mode helpers consumed by settings stores and UI.
 */

import type { VisualSettings } from './hmi/visual-settings-store';
import type { RenderMode } from './rv-render-modes';
import type { InterfaceSettings } from '../interfaces/interface-settings-store';
import type { SearchSettings } from './hmi/search-settings-store';
import type { UIVisibilityRule } from './hmi/ui-context-store';
import { debug } from './engine/rv-debug';

/** Configuration for context-aware UI visibility (loaded from settings.json `ui` key). */
export interface UIContextConfig {
  /** Contexts to activate on startup (e.g. ["kiosk"]). */
  initialContexts?: string[];
  /** Per-element visibility rule overrides — keys are element IDs like 'kpi-bar'. */
  visibilityOverrides?: Record<string, UIVisibilityRule>;
}

/** Settings tab identifiers used for selective locking. */
export type SettingsTabId = 'model' | 'mouse' | 'visual' | 'simulation' | 'environment' | 'interfaces' | 'devtools' | 'tests' | 'mcp' | 'multiuser' | 'groups';

/** Top-level app configuration loaded from `public/settings.json`. */
export interface RVAppConfig {
  /** Lock all settings — hides the settings gear button entirely. */
  lockSettings?: boolean;
  /** Selectively lock individual tabs (settings gear still visible). */
  lockedTabs?: SettingsTabId[];
  /** Default model URL or filename (priority: URL param > settings.json defaultModel > last opened > first model). */
  defaultModel?: string;
  /** Base path for project-specific assets (docs, AASX, logos). Relative to BASE_URL. Ends with '/'. */
  projectAssetsPath?: string;
  /** Public corresponding-source URL for the exact embedded AGPL WebViewer build. */
  sourceUrl?: string;

  /**
   * Zero-knowledge encryption for password-protected deploys (plan-267). When
   * `enabled`, model GLBs on the CDN are AES-256-GCM RVE1 envelopes (self-
   * describing via magic) under their normal `.glb` names — the runtime shows a
   * password gate and decrypts before parsing. Salt/iterations live in each
   * envelope header, so this flag is just a boolean signal set at publish time.
   */
  encryption?: { enabled?: boolean };

  /** Global plugin IDs — lowest priority, overridden by modelname.json and GLB extras. */
  plugins?: string[];
  /** Global per-plugin config — lowest priority, deep-merged with model-specific config. */
  pluginConfig?: Record<string, Record<string, unknown>>;

  /**
   * Suppress per-model opener/welcome dialogs (OpenerMessagePlugin)
   * deployment-wide — e.g. for kiosk installations or host pages with their
   * own onboarding. Default `false`. Custom loaders can instead toggle at
   * runtime via `setOpenerMessagesEnabled()` from opener-message-plugin.
   */
  disableOpenerMessages?: boolean;

  /**
   * Opt-in: load external plugin bundles at runtime via HEAD-then-import.
   * - `./project-plugin.js` (always checked if enabled)
   * - `./models/{modelName}/model-plugin.js` (per-model)
   * Default `false` — leaving it off keeps the network tab clean and skips two
   * HEAD requests per model load. Enable only when deploying external plugin
   * bundles (not bundled by Vite) alongside the viewer.
   */
  externalPlugins?: boolean;

  /** Partial overrides merged on top of localStorage values.
   *  Accepts the legacy `lightingMode` key (renamed to `renderMode`) for back-compat. */
  visual?: Partial<VisualSettings> & { lightingMode?: RenderMode };
  interface?: Partial<InterfaceSettings>;
  search?: Partial<SearchSettings>;

  /** Groups configuration: overlay exclusions and default-hidden groups. */
  groups?: {
    excludedFromOverlay?: string[];
    defaultHiddenGroups?: string[];
  };

  /** Context-aware UI visibility configuration. */
  ui?: UIContextConfig;

  /** Analytics configuration. GA script is only injected when a measurement ID is provided. */
  analytics?: {
    /** Google Analytics 4 Measurement ID (e.g. "G-XXXXXXXXXX"). Omit to disable tracking. */
    googleAnalyticsId?: string;
    /** Privacy-policy URL linked from the consent gate. Omit to hide the link. */
    privacyPolicyUrl?: string;
  };

  /**
   * Public-hosted news feed opt-in. Omitted in private, customer, and
   * self-hosted settings so those deployments make no external request.
   */
  news?: {
    /** Must be exactly true to enable the public news request. */
    enabled?: boolean;
    /** Absolute HTTP(S) URL of the versioned news endpoint, without a query. */
    apiUrl?: string;
  };

  /**
   * Startup behaviour of the Projects dashboard (plan-372 §2.12).
   *
   * By default it opens only when the session has nothing else to show: no
   * `?project=` / `?scene=` / `?model=`, no `defaultModel`, and not
   * mode-locked. Every delivered customer build either sets `defaultModel` or
   * runs kiosk-locked, so those boot into their model **unchanged**.
   *
   * The two flags exist for the deployments that fall outside that rule:
   * `suppress` for a shell that owns its own entry point, `force` for an
   * authoring install that wants the dashboard even with a default model.
   * `suppress` wins when both are set — refusing to show a window is always
   * the safer half of a contradictory configuration.
   */
  projects?: {
    /** Never auto-open the dashboard, whatever the other conditions say. */
    suppress?: boolean;
    /** Always auto-open it, unless `suppress` is also set or the mode is locked. */
    force?: boolean;
  };

  /** Simulation behavior toggles (deploy-config, never editable via UI). */
  simulation?: {
    /**
     * Global kill-switch for the MU accumulation gap clamp (plan-255 §2.8).
     * Default `true`. Set `false` to disable accumulation deployment-wide
     * WITHOUT re-exporting scenes (rollback path — applied to
     * `RVTransportSurface.accumulateDefault` at boot in main.ts).
     */
    accumulateDefault?: boolean;
    /**
     * Global kill-switch for zone-based physics simulation (plan-276 F10).
     * Default `true` (= ALLOWED). Set `false` to disable physics zones
     * deployment-wide WITHOUT re-exporting scenes (applied to
     * `physicsSettings.enabled` at boot in main.ts, AND-ed with the
     * localStorage `rv.physics` ACTIVATION toggle — Settings → Simulation →
     * "Physics (whole scene)", default OFF/opt-in). Load-time-only — takes
     * effect on the next model load.
     */
    physicsEnabled?: boolean;
    /**
     * Global kill-switch for the TransportSurface physics mode (plan-276
     * Phase 4, F5). Default `true` (= surfaces with `PhysicsMode: true` may be
     * physics-managed). Set `false` to keep ALL surfaces kinematic
     * deployment-wide WITHOUT re-exporting scenes (applied to
     * `RVTransportSurface.physicsDefault` at boot in main.ts —
     * `accumulateDefault` pattern). Narrower than `physicsEnabled`, which
     * turns off the whole physics-zone feature.
     */
    physicsSurfaceDefault?: boolean;
  };

  /**
   * AI error diagnosis + operator comment backend (plan-253). Deploy-config
   * only (like `analytics.googleAnalyticsId`) — never editable via UI.
   * Both URLs absent (the default) keeps the demo/fake path fully offline.
   */
  diagnostics?: {
    /** Base URL of the CONNECT diagnosis backend (`{diagnoseUrl}/diagnose`). Omit to disable. */
    diagnoseUrl?: string;
    /** Base URL of the CONNECT comment store (`{notesUrl}/comments`). Omit for localStorage notes. */
    notesUrl?: string;
  };

  /**
   * Product documentation the context-sensitive help opens (plan-370). Deploy
   * config only — never editable through the UI. A customer who mirrors or
   * replaces the documentation points `baseUrl` at their own site; the topic
   * paths below it stay the same.
   *
   * Whether the help entry is offered at all is a separate, orthogonal switch:
   * `ui.visibilityOverrides['help']`.
   */
  docs?: {
    /**
     * Base URL of the documentation. Default: `https://realvirtual.io/doc/web/`.
     * Ignored (default used) when it is not an absolute `http:`/`https:` URL.
     */
    baseUrl?: string;
  };
}

// ─── Build-time feature flags ──────────────────────────────────
//
// NOTE: the `VITE_UNIFIED_SIM` opt-out (legacy fixedUpdate path) was removed
// in the runtime unification (Phase B) after its soak period — the
// SimulationKernel / executor path is now the only fixed-update orchestration.

// ─── Singleton State ───────────────────────────────────────────

let _config: RVAppConfig = {};

/** Replace the current app config (call once in main.ts before React mount). */
export function setAppConfig(config: RVAppConfig): void {
  _config = config;
}

/** Read the current app config. */
export function getAppConfig(): RVAppConfig {
  return _config;
}

/** True when the entire settings dialog should be hidden. */
export function isSettingsLocked(): boolean {
  return _config.lockSettings === true;
}

/** True when a specific settings tab should be hidden/disabled. */
export function isTabLocked(tab: SettingsTabId): boolean {
  if (_config.lockSettings) return true;
  return _config.lockedTabs?.includes(tab) ?? false;
}

// ─── Fetch ─────────────────────────────────────────────────────

/**
 * Fetch `public/settings.json`. Returns `{}` silently on 404, network error,
 * or invalid JSON so the app always boots with defaults.
 */
export async function fetchAppConfig(): Promise<RVAppConfig> {
  try {
    // Use BASE_URL (not a bare relative path) so it resolves correctly under
    // sub-folder deploys (e.g. Bunny CDN /demo/) regardless of a trailing slash.
    const resp = await fetch(`${import.meta.env.BASE_URL}settings.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) {
      debug('config', 'No settings.json found, using defaults');
      return {};
    }
    const json: unknown = await resp.json();
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      console.warn('[config] settings.json is not a JSON object, ignoring');
      return {};
    }
    const keys = Object.keys(json);
    debug('config', `Loaded settings.json (${keys.length} key${keys.length !== 1 ? 's' : ''})`);
    return json as RVAppConfig;
  } catch {
    debug('config', 'No settings.json found, using defaults');
    return {};
  }
}

// ─── Analytics ────────────────────────────────────────────────

let _analyticsInjected = false;

/**
 * Inject Google Analytics 4 if configured in settings.json.
 * No-op when `analytics.googleAnalyticsId` is absent — AGPL source ships clean.
 *
 * Idempotent: only injects once. GA is a non-essential tracker, so callers
 * MUST gate this behind consent (see consent-gate / consent-store) — main.ts
 * only calls it after the consent gate resolves.
 */
export function initAnalytics(): void {
  if (_analyticsInjected) return;
  const gaId = _config.analytics?.googleAnalyticsId;
  if (!gaId) return;
  _analyticsInjected = true;

  // Inject gtag.js script
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gaId)}`;
  document.head.appendChild(script);

  // Initialize dataLayer and config
  const w = window as unknown as Record<string, unknown>;
  w.dataLayer = w.dataLayer || [];
  // gtag.js ONLY consumes dataLayer entries that are the raw `arguments` object,
  // exactly like Google's canonical snippet. Pushing a plain array (`[...args]`)
  // makes gtag silently ignore every command — neither `config` nor events ever
  // transmit, so no `/g/collect` hit is sent and GA receives nothing. Keep the
  // `arguments` push verbatim.
  // eslint-disable-next-line prefer-rest-params
  const gtag = function () { (w.dataLayer as unknown[]).push(arguments); } as (...args: unknown[]) => void;
  // Expose gtag globally so trackAnalyticsEvent() can fire GA4 custom events.
  w.gtag = gtag;
  gtag('js', new Date());
  gtag('config', gaId);

  debug('config', `Google Analytics initialized: ${gaId}`);
}

/**
 * Fire a GA4 custom event. No-op when analytics was never injected (no id
 * configured, or consent not granted) — gtag is only present after initAnalytics.
 * Used to distinguish what the visitor is looking at (e.g. standard demo model
 * vs. planner workspace) without any extra tracking infrastructure.
 */
export function trackAnalyticsEvent(name: string, params?: Record<string, unknown>): void {
  const gtag = (window as unknown as { gtag?: (...args: unknown[]) => void }).gtag;
  if (!gtag) return;
  gtag('event', name, params ?? {});
}
