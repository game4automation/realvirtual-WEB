// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-file-handle-store tests — IndexedDB round-trip of a fake file handle
 * (save → get → clear) and feature-detection of the File System Access API.
 *
 * The real `showOpenFilePicker` requires a user gesture and is never called.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveLastFileHandle,
  getLastFileHandle,
  clearLastFileHandle,
  supportsFsAccess,
} from '../src/core/hmi/import-file-handle-store';

/**
 * Minimal stand-in for a FileSystemFileHandle. It must be a plain data object
 * (no functions) so IndexedDB's structured-clone can persist it — real handles
 * are clonable host objects; functions would throw DataCloneError.
 */
function makeFakeHandle(name: string): FileSystemFileHandle {
  return { kind: 'file', name } as unknown as FileSystemFileHandle;
}

const SIGNAL_KEY = 'lastSignalTable';
const STEP_KEY = 'lastStepFile';

describe('import-file-handle-store — IndexedDB round-trip', () => {
  beforeEach(async () => {
    await clearLastFileHandle(SIGNAL_KEY);
    await clearLastFileHandle(STEP_KEY);
  });

  afterEach(async () => {
    await clearLastFileHandle(SIGNAL_KEY);
    await clearLastFileHandle(STEP_KEY);
  });

  it('returns null when nothing is stored', async () => {
    const handle = await getLastFileHandle(SIGNAL_KEY);
    expect(handle).toBeNull();
  });

  it('persists and retrieves a handle (save → get)', async () => {
    const fake = makeFakeHandle('signals.xlsx');
    await saveLastFileHandle(SIGNAL_KEY, fake);
    const got = await getLastFileHandle(SIGNAL_KEY);
    expect(got).not.toBeNull();
    expect(got?.name).toBe('signals.xlsx');
    expect(got?.kind).toBe('file');
  });

  it('overwrites a previously stored handle', async () => {
    await saveLastFileHandle(SIGNAL_KEY, makeFakeHandle('old.csv'));
    await saveLastFileHandle(SIGNAL_KEY, makeFakeHandle('new.xlsx'));
    const got = await getLastFileHandle(SIGNAL_KEY);
    expect(got?.name).toBe('new.xlsx');
  });

  it('clears the stored handle (clear → get is null)', async () => {
    await saveLastFileHandle(SIGNAL_KEY, makeFakeHandle('signals.xlsx'));
    await clearLastFileHandle(SIGNAL_KEY);
    const got = await getLastFileHandle(SIGNAL_KEY);
    expect(got).toBeNull();
  });

  it('stores and clears different keys independently', async () => {
    await saveLastFileHandle(SIGNAL_KEY, makeFakeHandle('signals.xlsx'));
    await saveLastFileHandle(STEP_KEY, makeFakeHandle('part.step'));

    // Both persist side by side.
    expect((await getLastFileHandle(SIGNAL_KEY))?.name).toBe('signals.xlsx');
    expect((await getLastFileHandle(STEP_KEY))?.name).toBe('part.step');

    // Clearing one key leaves the other intact.
    await clearLastFileHandle(SIGNAL_KEY);
    expect(await getLastFileHandle(SIGNAL_KEY)).toBeNull();
    expect((await getLastFileHandle(STEP_KEY))?.name).toBe('part.step');
  });
});

describe('import-file-handle-store — supportsFsAccess', () => {
  const original = (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;

  afterEach(() => {
    // Restore original (delete if it was absent).
    if (original === undefined) {
      delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    } else {
      (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = original;
    }
    vi.restoreAllMocks();
  });

  it('is true when window.showOpenFilePicker is a function', () => {
    (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = () => Promise.resolve([]);
    expect(supportsFsAccess()).toBe(true);
  });

  it('is false when window.showOpenFilePicker is absent', () => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker;
    expect(supportsFsAccess()).toBe(false);
  });
});
