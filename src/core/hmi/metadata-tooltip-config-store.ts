// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * metadata-tooltip-config-store.ts — Customer-specific metadata tooltip configuration.
 *
 * Lets project plugins override which value field is shown as the orange tooltip
 * header (instead of the default <name> tag — which is typically the CAD filename
 * and not meaningful to operators).
 *
 * Usage from a project plugin (e.g. mauser3dhmi/plugins/index.ts):
 *   import { setMetadataTooltipConfig } from '../core/hmi/metadata-tooltip-config-store';
 *   setMetadataTooltipConfig({
 *     headerLabels: ['English', 'Article'],   // first matching label becomes the title
 *     hiddenLabels: ['ID'],                   // hide irrelevant rows
 *   });
 */

import { useSyncExternalStore } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

export interface MetadataTooltipConfig {
  /**
   * Ordered list of value labels to try as the tooltip header.
   * The first label found in the metadata replaces the `<name>` tag as the
   * orange header text. Label matching is case-insensitive and ignores
   * spaces/dashes/underscores.
   * Example: ['English', 'Article'] → prefers English description, falls back to article number.
   */
  headerLabels?: string[];
  /**
   * When true (default), the value row matching the selected header label is
   * hidden from the body to avoid duplication with the header.
   */
  hidePromotedRow?: boolean;
  /**
   * When true (default), the original `<name>` tag is hidden when a header
   * label match is found and promoted to the header.
   */
  hideOriginalName?: boolean;
  /**
   * Value labels that should never be shown as body rows.
   * Example: ['ID'] to hide the CAD part ID from operators.
   * Matching is case-insensitive and ignores spaces/dashes/underscores.
   */
  hiddenLabels?: string[];
}

// ─── Store ──────────────────────────────────────────────────────────────

let _config: MetadataTooltipConfig | null = null;
const _listeners = new Set<() => void>();
let _snapshot: MetadataTooltipConfig | null = null;

function notify(): void {
  _snapshot = _config ? { ..._config } : null;
  for (const l of _listeners) l();
}

/** Set customer-specific metadata tooltip configuration. Pass null to reset. */
export function setMetadataTooltipConfig(config: MetadataTooltipConfig | null): void {
  _config = config;
  notify();
}

/** Clear configuration (convenience for plugin dispose). */
export function clearMetadataTooltipConfig(): void {
  setMetadataTooltipConfig(null);
}

/** Get the current config synchronously (for non-React callers). */
export function getMetadataTooltipConfig(): MetadataTooltipConfig | null {
  return _snapshot;
}

/** React hook: returns the current config or null when not configured. */
export function useMetadataTooltipConfig(): MetadataTooltipConfig | null {
  return useSyncExternalStore(
    (cb) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    () => _snapshot,
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Normalize a label for case-insensitive matching (strips spaces/dashes/underscores). */
export function normalizeLabel(label: string): string {
  return label.replace(/[\s_-]/g, '').toLowerCase();
}
