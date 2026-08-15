// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * In-memory `localStorage` for the Node-environment tests.
 *
 * Node has no Web Storage without an experimental flag, so a `.node.test.ts`
 * that exercises persistence has to bring its own. Implements exactly the
 * surface the WebViewer uses — including the index-based `key(i)` enumeration
 * that the prefix sweeps in `clearAllRVStorage()` and the plugin override
 * store rely on.
 */

export function installMemoryLocalStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
}
