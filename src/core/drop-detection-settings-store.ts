// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Browser preference, independent of the loaded scene (plan-2022 E5). */
const STORAGE_KEY = 'rv-drop-detection-settings';

export function parseStoredDropDetectionSettings(raw: string | null): { enabled: boolean } {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (value && typeof value === 'object' && 'enabled' in value && typeof value.enabled === 'boolean') {
      return { enabled: value.enabled };
    }
  } catch { /* malformed storage: use default */ }
  return { enabled: true };
}

function load(): { enabled: boolean } {
  try { return parseStoredDropDetectionSettings(localStorage.getItem(STORAGE_KEY)); }
  catch { return { enabled: true }; }
}

let snapshot: Readonly<{ enabled: boolean }> = load();
const listeners = new Set<() => void>();

export function getDropDetectionSettings(): Readonly<{ enabled: boolean }> { return snapshot; }

export function setDropDetectionEnabled(enabled: boolean): void {
  if (typeof enabled !== 'boolean' || enabled === snapshot.enabled) return;
  snapshot = { enabled };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); }
  catch { /* unavailable storage / quota: keep the in-memory preference */ }
  for (const cb of listeners) cb();
}

export function subscribeDropDetectionSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
