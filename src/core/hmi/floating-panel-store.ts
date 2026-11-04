// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

export interface PanelGeometry { x: number; y: number; w: number; h: number }
export interface PanelGeometryUpdate { rect?: readonly number[]; collapsed?: boolean }
const listeners = new Map<string, Set<(update: PanelGeometryUpdate) => void>>();
const LS_PREFIX = 'rv-panel-geo:';
const LS_COLLAPSED_PREFIX = 'rv-panel-collapsed:';

export function loadPanelGeometry(panelId: string): PanelGeometry | null {
  try {
    const raw = readLocalStorage(LS_PREFIX + panelId);
    if (!raw) return null;
    const g = JSON.parse(raw) as PanelGeometry;
    if ([g.x, g.y, g.w, g.h].every(v => typeof v === 'number' && Number.isFinite(v))
      && g.w > 0 && g.h > 0) return g;
  } catch { /* corrupt entry or storage unavailable */ }
  return null;
}

export function savePanelGeometry(panelId: string, geo: PanelGeometry): void {
  try { writeLocalStorage(LS_PREFIX + panelId, JSON.stringify(geo)); } catch { /* unavailable */ }
}

export function loadPanelCollapsed(panelId: string): boolean | null {
  try {
    const raw = readLocalStorage(LS_COLLAPSED_PREFIX + panelId);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* unavailable */ }
  return null;
}

export function savePanelCollapsed(panelId: string, collapsed: boolean): void {
  writeLocalStorage(LS_COLLAPSED_PREFIX + panelId, collapsed ? '1' : '0');
}

/** Command updates reach mounted panels even when browser storage is disabled. */
export function setPanelGeometry(panelId: string, rect: readonly number[]): void {
  const [x, y, w, h] = rect;
  savePanelGeometry(panelId, { x, y, w, h });
  for (const fn of listeners.get(panelId) ?? []) fn({ rect: [x, y, w, h] });
}

export function setPanelCollapsed(panelId: string, collapsed: boolean): void {
  savePanelCollapsed(panelId, collapsed);
  for (const fn of listeners.get(panelId) ?? []) fn({ collapsed });
}

export function subscribePanelGeometry(panelId: string, fn: (update: PanelGeometryUpdate) => void): () => void {
  let set = listeners.get(panelId);
  if (!set) { set = new Set(); listeners.set(panelId, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(panelId);
  };
}
