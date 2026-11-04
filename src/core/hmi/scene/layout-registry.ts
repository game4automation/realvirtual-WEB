// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { getLocalStorage, readLocalStorage, removeLocalStorage, writeLocalStorage } from '../../rv-safe-storage';

/**
 * layout-registry — Multi-layout persistence on top of localStorage.
 *
 * Replaces the single-slot `rv-layout-autosave` model with a registry of
 * named layouts. Each layout entry:
 *
 *   rv-layouts-index → JSON: LayoutMeta[]
 *   rv-layouts/<id>  → JSON: LayoutFile  (existing schema from rv-layout-store)
 *
 * Pure CRUD — no React, no Three.js, no DOM. Imported by scene-store and
 * scene-window components.
 */

import type { LayoutFile } from '../../../plugins/layout-planner/rv-layout-store';

// ─── Storage keys ───────────────────────────────────────────────────────

const LS_KEY_INDEX = 'rv-layouts-index';
const LS_KEY_PREFIX = 'rv-layouts/';

// Legacy key — once-migrated on first boot, see migrateLegacyAutosave().
const LS_KEY_LEGACY_AUTOSAVE = 'rv-layout-autosave';

// ─── Types ──────────────────────────────────────────────────────────────

export interface LayoutMeta {
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function genId(): string {
  // Short, sortable, unique enough for client-side identifiers.
  return 'lyt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function entryKey(id: string): string {
  return LS_KEY_PREFIX + id;
}

function readIndex(): LayoutMeta[] {
  try {
    const raw = readLocalStorage(LS_KEY_INDEX);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(metas: LayoutMeta[]): void {
  try {
    writeLocalStorage(LS_KEY_INDEX, JSON.stringify(metas));
  } catch { /* QuotaExceeded — silently ignore */ }
}

// ─── Public API ─────────────────────────────────────────────────────────

/** List all layouts, sorted by `modifiedAt` descending (most recent first). */
export function listLayouts(): LayoutMeta[] {
  const metas = readIndex();
  return [...metas].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** Read a single layout by id. Returns null if not found or unparseable. */
export function readLayout(id: string): LayoutFile | null {
  try {
    const raw = readLocalStorage(entryKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as LayoutFile;
  } catch {
    return null;
  }
}

/** Get metadata for a single layout, or null. */
export function readMeta(id: string): LayoutMeta | null {
  return readIndex().find(m => m.id === id) ?? null;
}

/**
 * Create a new layout entry. Returns the new id. The caller supplies the
 * LayoutFile body (typically built via `serializeLayout()`); name is also
 * stored on the meta for cheap listing without parsing each entry.
 */
export function createLayout(name: string, file: LayoutFile): string {
  const id = genId();
  const now = new Date().toISOString();
  const meta: LayoutMeta = { id, name, createdAt: now, modifiedAt: now };

  // Persist body first so the index never references a missing entry.
  try {
    getLocalStorage()!.setItem(entryKey(id), JSON.stringify({ ...file, name }));
  } catch {
    return id; // Quota — meta won't be persisted either; caller can retry.
  }

  const metas = readIndex();
  metas.push(meta);
  writeIndex(metas);

  return id;
}

/**
 * Overwrite an existing layout's body. Bumps `modifiedAt` on the meta.
 * No-op if the id is unknown.
 */
export function saveLayout(id: string, file: LayoutFile): void {
  const metas = readIndex();
  const meta = metas.find(m => m.id === id);
  if (!meta) return;
  try {
    getLocalStorage()!.setItem(entryKey(id), JSON.stringify({ ...file, name: meta.name }));
  } catch { return; }
  meta.modifiedAt = new Date().toISOString();
  writeIndex(metas);
}

/** Rename a layout (updates index only; body is left as-is for atomicity). */
export function renameLayout(id: string, name: string): void {
  const metas = readIndex();
  const meta = metas.find(m => m.id === id);
  if (!meta) return;
  meta.name = name;
  meta.modifiedAt = new Date().toISOString();
  writeIndex(metas);
  // Sync the body's name field so JSON exports stay consistent.
  const body = readLayout(id);
  if (body) {
    try {
      writeLocalStorage(entryKey(id), JSON.stringify({ ...body, name }));
    } catch { /* ignore */ }
  }
}

/** Delete a layout (body + index entry). Idempotent. */
export function deleteLayout(id: string): void {
  try { removeLocalStorage(entryKey(id)); } catch { /* ignore */ }
  const metas = readIndex().filter(m => m.id !== id);
  writeIndex(metas);
}

/**
 * Duplicate a layout. Returns the new id, or null if source is missing.
 * The duplicate's name defaults to "<source name> (copy)" and creation
 * timestamps are reset.
 */
export function duplicateLayout(id: string): string | null {
  const meta = readMeta(id);
  const body = readLayout(id);
  if (!meta || !body) return null;
  return createLayout(`${meta.name} (copy)`, body);
}

// ─── Migration ──────────────────────────────────────────────────────────

/**
 * One-shot migration of the legacy single-slot `rv-layout-autosave` into
 * a registry entry. Returns the new layout's id, or null if there was
 * nothing to migrate.
 *
 * Idempotent: once the legacy key is removed, subsequent calls return null.
 * Safe to call on every boot.
 */
export function migrateLegacyAutosave(): string | null {
  let raw: string | null;
  raw = readLocalStorage(LS_KEY_LEGACY_AUTOSAVE);
  if (!raw) return null;

  let body: LayoutFile;
  try {
    body = JSON.parse(raw) as LayoutFile;
  } catch {
    // Corrupt — drop it.
    removeLocalStorage(LS_KEY_LEGACY_AUTOSAVE);
    return null;
  }

  const name = (body.name && body.name !== 'autosave') ? body.name : 'Untitled Layout';
  const id = createLayout(name, body);
  removeLocalStorage(LS_KEY_LEGACY_AUTOSAVE);
  return id;
}
