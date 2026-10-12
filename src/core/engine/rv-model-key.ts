// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-key.ts — the stable per-model storage key.
 *
 * One pure function, deliberately alone in a core file: everything that
 * persists something PER MODEL (camera start position, scene store, the agent
 * eye's pose) has to derive the same key from the same URL, and the embed
 * bundle must be able to import it.
 *
 * It used to live in `camera-startpos-plugin.tsx`, which statically imports
 * `CameraStartTab.tsx` (React + MUI). Importing the key derivation from
 * `core/engine/*` therefore pulled the whole React settings panel into the
 * plugin-free embed bundle (plan-740 D-A3 / R2-A-N1). The plugin re-exports it
 * for its existing consumers, so no call site had to change.
 */

/**
 * Derive a stable per-model key from a URL or File name.
 *
 * Query string dropped, path stripped to the file name, a trailing `.glb`
 * (any case) removed. Returns null for empty/absent input so callers can skip
 * persistence rather than write under a bogus key.
 */
export function deriveModelKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const noQuery = url.split('?')[0];
  const filename = noQuery.split('/').pop() ?? noQuery;
  const stripped = filename.replace(/\.glb$/i, '');
  return stripped.length > 0 ? stripped : null;
}
