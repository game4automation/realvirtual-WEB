// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Central list of all localStorage keys used by the WebViewer. */

/** The CONNECT standalone signal-link hint has already been shown on this device. */
export const CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY = 'rv-connect-embed-signal-hint-seen';

/**
 * Versioned acknowledgement of what the AI Bridge may reach (plan-366 Phase 6).
 * Stores the ACCEPTED version string, not a boolean: raising
 * `AI_BRIDGE_CONSENT_VERSION` (ai-consent-store.ts) must ask again, the same way
 * `LICENSE_TERMS_VERSION` re-asks when the terms change. Never written implicitly.
 */
export const AI_BRIDGE_CONSENT_KEY = 'rv-ai-bridge-consent';

/**
 * Which Assets-tab library sections are COLLAPSED (plan-702 F2).
 *
 * Stores the exception, not the norm: an unknown `groupKey` reads as expanded,
 * so a library the user just attached is visible instead of hidden behind a
 * closed header — the one moment they most want to see it.
 */
export const ASSETS_SECTIONS_COLLAPSED_KEY = 'rv-assets-sections-collapsed';

/**
 * Card edge length in the project dashboard's content grid, in pixels.
 *
 * A view preference, not project data: it follows the person, not the project
 * they happen to have open, which is why it lives here and not in the manifest.
 */
export const PROJECTS_CARD_SIZE_KEY = 'rv-projects-card-size';

/**
 * The asset the Editor mode opened last (plan-410 F2).
 *
 * Holds a versioned `{ v, base, savedAt }` record whose `base` is an
 * `AssetBase` identity — never a URL, never `kind: 'empty'`. Read by
 * `last-edited-asset-store.ts` as the last fallback of the editor's open chain
 * (pending > draft > shelf hint > THIS > empty).
 */
export const EDITOR_LAST_ASSET_KEY = 'rv-editor-last-asset';

export const ALL_RV_STORAGE_KEYS = [
  'rv-visual-settings',
  'rv-visual-presets',
  'rv-search-settings',
  'rv-interface-settings',
  'historian',
  'rv-webviewer-last-model',
  'rv-webviewer-renderer',
  'rv-debug',
  'rv-extras-overlay',
  // Hierarchy & Inspector keys
  'rv-extras-editor-width',
  'rv-projects-card-size',
  'rv-extras-editor-open',
  'rv-extras-editor-selected',
  'rv-hierarchy-expanded',
  'rv-hierarchy-type-filter',
  'rv-hierarchy-signal-sort',
  'rv-inspector-collapsed',
  'rv-inspector-consumed-only',
  'rv-inspector-detached',
  'rv-group-visibility',
  'rv-maintenance-progress',
  'rv-ai-bridge',
  'rv-multiuser-settings',
  'rv-source-markers-visible',
  'rv-toolbar-show-labels',
  'rv-left-panel-active',
  'rv-layout-library-urls',
  'rv-layout-autosave',
  'rv-layout-grid-enabled',
  'rv-layout-grid-size',
  'rv-layout-drop-to-surface',
  'rv-layout-active-tab',
  'rv-layout-bbox-snap-mid',
  'rv-layout-bbox-snap-side',
  'rv-layout-bbox-snap-tolerance',
  'rv-layout-show-neighbor-distances',
  'rv-layout-neighbor-distance-max',
  'rv-unity-cloud-config',
  'rv-layouts-index',
  'rv-scene-active',
  'rv-models-window-open',
  'rv-local-folders',
  'rv-splat-transform',  // legacy — transforms now managed via PlacedComponent
  'rv-analytics-consent',  // GDPR analytics opt-in (consent-store)
  // Sender-side share state (plan-386 §2.6). Declared as literals rather than
  // imported so this list stays a leaf; the constants live in
  // core/share/rv-share-session.ts (SHARE_SESSION_KEY / SHARE_DRAFT_KEY).
  // Note these are the SENDER's keys — the receiver of a shared link writes
  // nothing at all (F7).
  'rv-share-session',  // magic-link session of the person sharing
  'rv-share-draft',    // share dialog form, kept across the sign-in mail round trip
  // The ONE key the receiver of a shared link may write, and only after he
  // clicks "add to my library" (plan-386 F13). Everything else on the consumer
  // path stays read-only.
  'rv-shared-bookmarks',
  'rv-news-seen',  // public WEB news IDs acknowledged on this device
  'rv-welcome-dismissed',  // WelcomeModal "Got it" flag (ButtonPanel) — reset re-shows the welcome box
  'rv-auto-quality-applied',  // auto-quality boot seed already picked a preset on this device
  CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY,
  AI_BRIDGE_CONSENT_KEY,
  ASSETS_SECTIONS_COLLAPSED_KEY,
  EDITOR_LAST_ASSET_KEY,
] as const;

/** Read the CONNECT standalone hint flag without failing when storage is unavailable. */
export function hasSeenConnectEmbedSignalHint(): boolean {
  try {
    return localStorage.getItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the CONNECT standalone hint flag when storage is available. */
export function markConnectEmbedSignalHintSeen(): void {
  try {
    localStorage.setItem(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY, '1');
  } catch {
    // Private mode or disabled storage: keep the display fallback without persistence.
  }
}

/** Read the accepted AI-bridge consent version, or null when none/unreadable. */
export function readAiBridgeConsentVersion(): string | null {
  try {
    return localStorage.getItem(AI_BRIDGE_CONSENT_KEY);
  } catch {
    return null;
  }
}

/** Persist the accepted AI-bridge consent version when storage is available. */
export function writeAiBridgeConsentVersion(version: string): void {
  try {
    localStorage.setItem(AI_BRIDGE_CONSENT_KEY, version);
  } catch {
    // Private mode or disabled storage: the in-memory grant carries the session.
  }
}

/** Drop the stored AI-bridge consent (used by the reset paths and by tests). */
export function clearAiBridgeConsentVersion(): void {
  try {
    localStorage.removeItem(AI_BRIDGE_CONSENT_KEY);
  } catch {
    // Nothing persisted, nothing to clear.
  }
}

/**
 * sessionStorage keys used by the WebViewer.
 * These are automatically cleared by the browser when the tab closes, so they
 * are NOT included in ALL_RV_STORAGE_KEYS / clearAllRVStorage(). Listed here
 * for documentation + grep-ability.
 */
export const ALL_RV_SESSION_STORAGE_KEYS = [
  'rv-sensor-history',   // Floating SensorHistoryPanel layout (plan-156)
  'rv-order-cart',       // Order Manager cart state
] as const;

/**
 * Prefixes for dynamic localStorage keys (keyed by GLB name).
 * Used by `clearAllRVStorage()` to scan and remove these entries.
 */
export const RV_DYNAMIC_PREFIXES = [
  'rv-extras-overlay:',
  'rv-extras-originals:',
  'rv-annotations-',
  'rv-measurements-',
  'rv-panel-',
  'rv-panel-geo:',
  'rv-order-',
  'rv-camera-start:',
  'rv-sig-unlock:',
  'rv-login-',    // login gate keys
  'rv-layouts/',  // multi-layout registry entries (rv-layouts/<id>)
  // Per-project user plugin overrides (plan-435). Declared as a literal so this
  // list stays a leaf; the constant lives in
  // core/plugin-overrides/rv-plugin-override-store.ts
  // (LS_KEY_PLUGIN_OVERRIDES_PREFIX). Without this entry a "Reset all" would
  // leave a switched-off plugin switched off forever.
  'rv-plugin-overrides/',
] as const;

/**
 * Clear all known realvirtual localStorage keys, including dynamic ones.
 * This handles both the static keys in ALL_RV_STORAGE_KEYS and
 * dynamic keys that match RV_DYNAMIC_PREFIXES.
 */
export function clearAllRVStorage(): void {
  // Clear static keys
  for (const key of ALL_RV_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
  // Clear dynamic prefix-based keys
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && RV_DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
