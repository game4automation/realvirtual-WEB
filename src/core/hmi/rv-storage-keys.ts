// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { listLocalStorageKeys, readLocalStorage, removeLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/** Per-device SpaceMouse navigation preferences (plan-2215 P1). */
export const SPACEMOUSE_SETTINGS_KEY = 'rv-spacemouse-settings';
/** Per-device stereo display preferences of the commercial stereo plugin (plan-2215 P2). */
export const STEREO_SETTINGS_KEY = 'rv-stereo-settings';

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

/** Versioned demo and developer terms acknowledgements (plan-2209). */
export const TERMS_CONSENT_KEY = 'rv-terms-consent';

/** Read the terms JSON; even accessing localStorage can throw in restricted browsers. */
export function readTermsConsent(): string | null {
  return readLocalStorage(TERMS_CONSENT_KEY);
}

/** Persist terms JSON, returning false when only a session grant is possible. */
export function writeTermsConsent(value: string): boolean {
  return writeLocalStorage(TERMS_CONSENT_KEY, value);
}

/** Remove persisted terms consent, including when storage access is blocked. */
export function clearTermsConsent(): void {
  removeLocalStorage(TERMS_CONSENT_KEY);
}

export { readLocalStorage, writeLocalStorage, removeLocalStorage } from '../rv-safe-storage';

/** Preferred local CLI backend for the private AI prompt panel (plan-2041). */
export const AI_PROMPT_BACKEND_KEY = 'rv-ai-prompt-backend';

/** Workspace-partitioned local resume metadata for the private AI prompt panel (plan-2041). */
export const AI_PROMPT_SESSIONS_KEY = 'rv-ai-prompt-sessions';

/**
 * Settings > AI Bridge > "Follow agent" (plan-520): `'1'` / `'0'`, per device.
 * Absent reads as ON — the camera follows the agent's node edits while the user
 * is not using the view. Owned by `follow-agent-store.ts`.
 */
export const MCP_FOLLOW_AGENT_KEY = 'rv-mcp-follow-agent';

/** Per-device AI click animation preference: '1' / '0', default on. */
export const MCP_AI_CLICKS_KEY = 'rv-mcp-ai-clicks';

/**
 * "Read only, don't ask again" per CONNECT gateway + interface (plan-562 F8).
 *
 * Holds a JSON map of `<serverUrl>|<interfaceId>` → `true`, i.e. only the
 * EXCEPTION: an interface the user decided must never be written to from this
 * viewer. An unknown key reads as "not decided yet", so the write-gate overlay
 * still asks once — which is the whole point of the prompt. Keyed by gateway as
 * well as id because the same interface id on another CONNECT is another machine.
 * Owned by `connect-write-gate-store.ts`.
 */
export const CONNECT_WRITE_GATE_READONLY_KEY = 'rv-connect-writegate-readonly';

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

/**
 * USD live link to Isaac Sim (plan-637): `{ port, token, rateHz }` per device.
 * Whether sync is ON is deliberately not stored — a reload never connects to
 * the local extension by itself. Owned by `usd-live-link/live-link-store.ts`.
 */
export const USD_LIVE_LINK_SETTINGS_KEY = 'rv-usd-live-link';

/**
 * USD live link (plan-637 Phase 7): '1' once this device reached `live` with
 * Isaac Sim. Until then the "Isaac Sim extension" install steps in the USD
 * menu start open; afterwards collapsed. Owned by `usd-live-link/live-link-store.ts`.
 */
export const USD_LIVE_LINK_SEEN_LIVE_KEY = 'rv-usd-live-link-seen-live';

/**
 * Variants (plan-2013 §2.7): '1' = the viewer preference "Variants" is on. Off by default;
 * switching it on writes nothing into any document. Owned by `plugins/variants/index.ts`.
 */
export const VARIANTS_ENABLED_KEY = 'rv-variants-enabled';

/** Statistics tab, grouping and contribution settings (never the open state). */
export const STATS_HUB_KEY = 'rv-stats-hub';

/** Settings panel: stable id of the last selected tab ('visual', 'plugin:spacemouse', ...). */
export const SETTINGS_LAST_TAB_KEY = 'rv-settings-last-tab';

/**
 * The cross-project ring of recently opened documents (plan-478).
 *
 * Declared as a literal here — the constant itself lives beside the store that
 * owns it (`core/project/rv-project-recents-store.ts`,
 * `LS_KEY_RECENT_DOCUMENTS`) so this list stays a leaf. Spelled
 * `rv-project/recent-DOCUMENTS`, never `rv-project/recent`: that other key is
 * the retired workspace recents list and `rv-project-legacy-cleanup.ts` deletes
 * it on every boot, so a ring stored under it would be empty at every start.
 */
export const ALL_RV_STORAGE_KEYS = [
  SETTINGS_LAST_TAB_KEY,
  SPACEMOUSE_SETTINGS_KEY,
  STEREO_SETTINGS_KEY,
  TERMS_CONSENT_KEY,
  'rv-project/recent-documents',
  'rv-variants-enabled',
  // plan-2019: drive sounds on/off + master volume (sound-settings-store.ts)
  'rv-sound-enabled',
  'rv-sound-volume',
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
  // NB: no `rv-extras-editor-selected`. Selection is not persisted since
  // plan-754 D10 — the key was global across documents, so it restored a path
  // from one model into whichever model happened to load next.
  'rv-hierarchy-expanded',
  'rv-hierarchy-show-runtime',
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
  'rv-scene-active', // persisted name — do not rename (plan-777 P1)
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
  'rv-trace-settings',  // congestion trace time range + window (plan-629, trace-settings-store)
  CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY,
  CONNECT_WRITE_GATE_READONLY_KEY,
  AI_BRIDGE_CONSENT_KEY,
  AI_PROMPT_BACKEND_KEY,
  AI_PROMPT_SESSIONS_KEY,
  ASSETS_SECTIONS_COLLAPSED_KEY,
  EDITOR_LAST_ASSET_KEY,
  MCP_FOLLOW_AGENT_KEY,
  MCP_AI_CLICKS_KEY,
  USD_LIVE_LINK_SETTINGS_KEY,
  USD_LIVE_LINK_SEEN_LIVE_KEY,
  STATS_HUB_KEY,
] as const;

/** Read the CONNECT standalone hint flag without failing when storage is unavailable. */
export function hasSeenConnectEmbedSignalHint(): boolean {
  return readLocalStorage(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY) === '1';
}

/** Persist the CONNECT standalone hint flag when storage is available. */
export function markConnectEmbedSignalHintSeen(): void {
  writeLocalStorage(CONNECT_EMBED_SIGNAL_HINT_SEEN_KEY, '1');
}

/** Read the accepted AI-bridge consent version, or null when none/unreadable. */
export function readAiBridgeConsentVersion(): string | null {
  return readLocalStorage(AI_BRIDGE_CONSENT_KEY);
}

/** Persist the accepted AI-bridge consent version when storage is available. */
export function writeAiBridgeConsentVersion(version: string): void {
  writeLocalStorage(AI_BRIDGE_CONSENT_KEY, version);
}

/** Drop the stored AI-bridge consent (used by the reset paths and by tests). */
export function clearAiBridgeConsentVersion(): void {
  removeLocalStorage(AI_BRIDGE_CONSENT_KEY);
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
  'rv-panel-collapsed:',  // FloatingPanel collapsed state (plan-477 F2/F16)
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
    removeLocalStorage(key);
  }
  // Clear dynamic prefix-based keys
  const keysToRemove: string[] = [];
  for (const key of listLocalStorageKeys()) {
    if (key && RV_DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    removeLocalStorage(key);
  }
}
