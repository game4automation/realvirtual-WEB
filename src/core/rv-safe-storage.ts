// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Return localStorage when accessible, otherwise null. */
export function getLocalStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Read a localStorage value, or null when missing or inaccessible. */
export function readLocalStorage(key: string): string | null {
  try { return getLocalStorage()?.getItem(key) ?? null; } catch { return null; }
}

/** Write a localStorage value; false when blocked or full. */
export function writeLocalStorage(key: string, value: string): boolean {
  try {
    const storage = getLocalStorage();
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch { return false; }
}

/** Remove a localStorage value without throwing. */
export function removeLocalStorage(key: string): void {
  try { getLocalStorage()?.removeItem(key); } catch { /* Nothing accessible to remove. */ }
}

/** Snapshot localStorage keys; an access failure returns an empty list. */
export function listLocalStorageKeys(): string[] {
  try {
    const storage = getLocalStorage();
    if (!storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch { return []; }
}

/** Return sessionStorage when accessible, otherwise null. */
export function getSessionStorage(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/** Read a sessionStorage value, or null when missing or inaccessible. */
export function readSessionStorage(key: string): string | null {
  try { return getSessionStorage()?.getItem(key) ?? null; } catch { return null; }
}

/** Write a sessionStorage value; false when blocked or full. */
export function writeSessionStorage(key: string, value: string): boolean {
  try {
    const storage = getSessionStorage();
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch { return false; }
}

/** Remove a sessionStorage value without throwing. */
export function removeSessionStorage(key: string): void {
  try { getSessionStorage()?.removeItem(key); } catch { /* Nothing accessible to remove. */ }
}

/** Snapshot sessionStorage keys; an access failure returns an empty list. */
export function listSessionStorageKeys(): string[] {
  try {
    const storage = getSessionStorage();
    if (!storage) return [];
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch { return []; }
}

/** Parse a localStorage value; missing or invalid JSON returns the fallback. */
export function readLocalStorageJson<T>(key: string, fallback: T): T {
  try {
    const value = readLocalStorage(key);
    return value === null ? fallback : JSON.parse(value) as T;
  } catch { return fallback; }
}

/** Serialize and persist JSON; false when serialization or storage fails. */
export function writeLocalStorageJson(key: string, value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? false : writeLocalStorage(key, serialized);
  } catch { return false; }
}
