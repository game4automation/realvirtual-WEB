// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * branding-store.ts — Custom branding configuration.
 *
 * Allows project plugins to set a custom logo that replaces the default
 * realvirtual branding in the LogoBadge. When a custom logo is set,
 * the badge shows: [Custom Logo] — powered by realvirtual
 *
 * Usage from a project plugin:
 *   import { setCustomBranding } from '../core/hmi/branding-store';
 *   setCustomBranding({ logoUrl: '/private-assets/myproject/assets/logo.webp', name: 'My Company' });
 */

import { useSyncExternalStore } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CustomBranding {
  /** URL to the custom logo image. */
  logoUrl: string;
  /** Company/project name shown next to logo (optional, logo-only if omitted). */
  name?: string;
  /** Logo height in pixels (default: 20). */
  logoHeight?: number;
  /** Primary accent color (buttons, highlights). Default: '#4fc3f7'. */
  primaryColor?: string;
  /** Secondary accent color. Default: '#e94078'. */
  secondaryColor?: string;
  /** Logo badge background color. Default: dark glass. Example: 'rgba(224,224,224,0.85)'. */
  badgeBackground?: string;
  /** If true, badge stretches to match left panel width. Default: false. */
  badgeFullWidth?: boolean;
}

// ─── Store ──────────────────────────────────────────────────────────────

let _branding: CustomBranding | null = null;
const _listeners = new Set<() => void>();
let _snapshot: CustomBranding | null = null;

function notify(): void {
  _snapshot = _branding ? { ..._branding } : null;
  for (const l of _listeners) l();
}

/** Set custom branding. Pass null to reset to default realvirtual branding. */
export function setCustomBranding(branding: CustomBranding | null): void {
  _branding = branding;
  notify();
}

/** Clear custom branding (convenience for plugin dispose). */
export function clearCustomBranding(): void {
  setCustomBranding(null);
}

/** React hook: returns the current custom branding or null for default. */
export function useCustomBranding(): CustomBranding | null {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    () => _snapshot,
  );
}
