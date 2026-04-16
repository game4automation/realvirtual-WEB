// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-model camera start position store.
 *
 * Persists ModelCameraStart presets in localStorage keyed by
 * `rv-camera-start:{modelKey}`. Defense-in-depth validation rejects
 * NaN/Infinity in any coordinate or duration.
 *
 * Dispatches a CustomEvent (CAMERA_START_CHANGED_EVENT) on save/clear
 * so same-tab listeners can react (the native `storage` event only fires
 * cross-tab).
 */

import type { ModelCameraStart } from './camera-startpos-types';
import { CAMERA_START_CHANGED_EVENT } from './camera-startpos-types';

const LS_PREFIX = 'rv-camera-start:';

function keyFor(modelKey: string): string {
  return `${LS_PREFIX}${modelKey}`;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validates a parsed LS object. Rejects NaN/Infinity in all 6 coords AND duration. */
export function isValidPreset(obj: unknown): obj is ModelCameraStart {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  const sixCoordsOk =
    isFiniteNum(p.px) && isFiniteNum(p.py) && isFiniteNum(p.pz) &&
    isFiniteNum(p.tx) && isFiniteNum(p.ty) && isFiniteNum(p.tz);
  if (!sixCoordsOk) return false;
  // duration is optional; if present, must be a finite positive number
  if (p.duration !== undefined && (!isFiniteNum(p.duration) || p.duration <= 0)) return false;
  return true;
}

function dispatchChangeEvent(modelKey: string): void {
  try {
    window.dispatchEvent(new CustomEvent(CAMERA_START_CHANGED_EVENT, { detail: { modelKey } }));
  } catch { /* fail silent */ }
}

export function loadStartPos(modelKey: string): ModelCameraStart | null {
  try {
    const raw = localStorage.getItem(keyFor(modelKey));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return isValidPreset(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** Returns true on success, false on failure (quota, SecurityError). */
export function saveStartPos(modelKey: string, preset: ModelCameraStart): boolean {
  try {
    localStorage.setItem(keyFor(modelKey), JSON.stringify(preset));
    dispatchChangeEvent(modelKey);
    return true;
  } catch {
    return false;
  }
}

export function clearStartPos(modelKey: string): void {
  try {
    localStorage.removeItem(keyFor(modelKey));
    dispatchChangeEvent(modelKey);
  } catch { /* ignore */ }
}

export function hasStartPos(modelKey: string): boolean {
  try {
    return localStorage.getItem(keyFor(modelKey)) !== null;
  } catch {
    return false;
  }
}
