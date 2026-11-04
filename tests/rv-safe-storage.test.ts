// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLocalStorage, getSessionStorage,
  readLocalStorage, writeLocalStorage, removeLocalStorage, listLocalStorageKeys,
  readSessionStorage, writeSessionStorage, removeSessionStorage, listSessionStorageKeys,
  readLocalStorageJson, writeLocalStorageJson,
} from '../src/core/rv-safe-storage';
import * as legacy from '../src/core/hmi/rv-storage-keys';

const key = 'rv-safe-storage-test';
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
});

for (const [name, get, read, write, remove, list] of [
  ['localStorage', getLocalStorage, readLocalStorage, writeLocalStorage, removeLocalStorage, listLocalStorageKeys],
  ['sessionStorage', getSessionStorage, readSessionStorage, writeSessionStorage, removeSessionStorage, listSessionStorageKeys],
] as const) {
  describe(name, () => {
    it('roundtrips values and snapshots keys', () => {
      expect(get()).toBe(globalThis[name]);
      expect(read(key)).toBeNull();
      expect(write(key, '')).toBe(true);
      expect(read(key)).toBe('');
      expect(write(key, 'value')).toBe(true);
      expect(read(key)).toBe('value');
      const keys = list();
      expect(keys).toContain(key);
      remove(key);
      expect(read(key)).toBeNull();
      expect(list()).not.toContain(key);
      expect(keys).toContain(key);
    });

    it('survives a permanently throwing global getter', () => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)!;
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() { throw new DOMException('blocked', 'SecurityError'); },
      });
      try {
        for (let i = 0; i < 2; i++) {
          expect(get()).toBeNull();
          expect(read(key)).toBeNull();
          expect(write(key, 'value')).toBe(false);
          expect(() => remove(key)).not.toThrow();
          expect(list()).toEqual([]);
          if (name === 'localStorage') {
            expect(readLocalStorageJson(key, { fallback: true })).toEqual({ fallback: true });
            expect(writeLocalStorageJson(key, {})).toBe(false);
          }
        }
      } finally {
        Object.defineProperty(globalThis, name, descriptor);
      }
    });

    it('returns false for quota failures', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });
      expect(write(key, 'value')).toBe(false);
      expect(writeLocalStorageJson(key, {})).toBe(false);
    });

    it('handles failures in storage methods and key enumeration', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read'); });
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('remove'); });
      expect(read(key)).toBeNull();
      expect(() => remove(key)).not.toThrow();
      write(key, 'value');
      vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('key'); });
      expect(list()).toEqual([]);
    });
  });
}

it('preserves the legacy wrapper exports', () => {
  expect(legacy.readLocalStorage).toBe(readLocalStorage);
  expect(legacy.writeLocalStorage).toBe(writeLocalStorage);
  expect(legacy.removeLocalStorage).toBe(removeLocalStorage);
});

it('roundtrips JSON and falls back for missing or malformed JSON', () => {
  const fallback = { fallback: true };
  expect(readLocalStorageJson(key, fallback)).toBe(fallback);
  expect(writeLocalStorageJson(key, { value: 42 })).toBe(true);
  expect(readLocalStorageJson(key, fallback)).toEqual({ value: 42 });
  localStorage.setItem(key, '{broken');
  expect(readLocalStorageJson(key, fallback)).toBe(fallback);
  localStorage.setItem(key, 'null');
  expect(readLocalStorageJson(key, fallback)).toBeNull();
});

it('returns false when JSON cannot be serialized', () => {
  const circular: unknown[] = [];
  circular.push(circular);
  expect(writeLocalStorageJson(key, circular)).toBe(false);
  expect(writeLocalStorageJson(key, undefined)).toBe(false);
});
