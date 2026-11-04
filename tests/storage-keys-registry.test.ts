// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.6 — regression guard for the central storage-key register.
 *
 * A key that is written but not registered survives `clearAllRVStorage()`,
 * which is the reset path a support case ends up asking a user to run. The
 * failure mode is invisible until someone reports "reset did not help".
 */
import { describe, test, expect } from 'vitest';
import {
  ALL_RV_STORAGE_KEYS,
  AI_PROMPT_BACKEND_KEY,
  AI_PROMPT_SESSIONS_KEY,
  ASSETS_SECTIONS_COLLAPSED_KEY,
  clearAllRVStorage,
} from '../src/core/hmi/rv-storage-keys';

describe('rv storage key registry', () => {
  test('registers ASSETS_SECTIONS_COLLAPSED_KEY in ALL_RV_STORAGE_KEYS', () => {
    expect(ALL_RV_STORAGE_KEYS).toContain(ASSETS_SECTIONS_COLLAPSED_KEY);
  });

  test('clearAllRVStorage actually removes it', () => {
    localStorage.setItem(ASSETS_SECTIONS_COLLAPSED_KEY, JSON.stringify({ collapsed: ['a'] }));
    clearAllRVStorage();
    expect(localStorage.getItem(ASSETS_SECTIONS_COLLAPSED_KEY)).toBeNull();
  });

  test('registers and clears both AI prompt persistence keys', () => {
    expect(ALL_RV_STORAGE_KEYS).toContain(AI_PROMPT_BACKEND_KEY);
    expect(ALL_RV_STORAGE_KEYS).toContain(AI_PROMPT_SESSIONS_KEY);
    localStorage.setItem(AI_PROMPT_BACKEND_KEY, 'codex');
    localStorage.setItem(AI_PROMPT_SESSIONS_KEY, '[]');

    clearAllRVStorage();

    expect(localStorage.getItem(AI_PROMPT_BACKEND_KEY)).toBeNull();
    expect(localStorage.getItem(AI_PROMPT_SESSIONS_KEY)).toBeNull();
  });
});
