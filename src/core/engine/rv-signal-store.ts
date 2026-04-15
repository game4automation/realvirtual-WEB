// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalStore - Central signal store for PLC signal communication.
 *
 * Framework-agnostic pub/sub store for boolean, integer, and float signals.
 * Two lookup tables:
 *   1. **By name** — Signal.Name (custom unique name) or node name (GameObject name).
 *      This is the primary addressing method used by plugins and HMI.
 *   2. **By path** — Full hierarchy path (e.g. "DemoCell/Signals/ConveyorStart").
 *      Used internally by the loader and for component-reference resolution.
 *
 * Both tables point to the same underlying value storage.
 * Listeners are only notified on actual value changes (equality check).
 *
 * Foundation for future React HMI binding (useSignal hook).
 */
import { debug } from './rv-debug';

export class SignalStore {
  /** Canonical value store keyed by name (Signal.Name if set, otherwise node name). */
  private byName = new Map<string, boolean | number>();
  /** Path → name mapping for path-based access. */
  private pathToName = new Map<string, string>();
  /** Per-name listener sets. */
  private listeners = new Map<string, Set<(value: boolean | number) => void>>();
  /** Cache for resolved path lookups (avoids repeated suffix scans at runtime). */
  private resolveCache = new Map<string, string | null>();
  /** Monotonic version counter — incremented on every actual value change. */
  private _version = 0;

  /** Current version — changes only when signal values actually change. */
  get version(): number { return this._version; }

  // ── Name-based access (primary) ──

  /** Get raw value by name (undefined if not registered). */
  get(name: string): boolean | number | undefined {
    return this.byName.get(name);
  }

  /** Get as boolean by name (false if not set). */
  getBool(name: string): boolean {
    const v = this.byName.get(name);
    return typeof v === 'boolean' ? v : false;
  }

  /** Get as float by name (0 if not set). */
  getFloat(name: string): number {
    const v = this.byName.get(name);
    return typeof v === 'number' ? v : 0;
  }

  /** Get as int by name (0 if not set, truncated). */
  getInt(name: string): number {
    const v = this.byName.get(name);
    return typeof v === 'number' ? Math.trunc(v) : 0;
  }

  /** Set value by name — only notifies listeners if value actually changes. */
  set(name: string, value: boolean | number): void {
    if (name.includes('/') && !this.byName.has(name)) {
      console.warn(`[SignalStore] set() called with path "${name}" — use setByPath() for hierarchy paths`);
    }
    const old = this.byName.get(name);
    if (old === value) return;
    this.byName.set(name, value);
    this._version++;
    debug('signal', `set "${name}" = ${value} (was ${old})`);
    const subs = this.listeners.get(name);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
  }

  /** Subscribe to value changes by name. Returns unsubscribe function. */
  subscribe(name: string, cb: (value: boolean | number) => void): () => void {
    let subs = this.listeners.get(name);
    if (!subs) {
      subs = new Set();
      this.listeners.set(name, subs);
    }
    subs.add(cb);
    return () => {
      subs!.delete(cb);
      if (subs!.size === 0) {
        this.listeners.delete(name);
      }
    };
  }

  // ── Path-based access (secondary) ──

  /**
   * Resolve a path to its registered signal name, handling:
   * - Exact match (fast path)
   * - Space→underscore normalization (Three.js GLTF loader sanitizes names)
   * - Suffix matching (C# paths omit GLB root node prefix)
   * Results are cached so suffix scans only happen once per unique path.
   */
  private _resolvePath(path: string): string | undefined {
    // Fast path: exact match (covers pre-resolved paths from NodeRegistry.resolve())
    const direct = this.pathToName.get(path);
    if (direct !== undefined) return direct;

    // Check cache (avoids repeated suffix scans at runtime)
    if (this.resolveCache.has(path)) {
      return this.resolveCache.get(path) ?? undefined;
    }

    // Normalize spaces → underscores (Three.js GLTF sanitization)
    const normalized = path.replace(/ /g, '_');
    if (normalized !== path) {
      const normResult = this.pathToName.get(normalized);
      if (normResult !== undefined) {
        this.resolveCache.set(path, normResult);
        return normResult;
      }
    }

    // Suffix match: C# paths may omit root node prefix
    const searchPath = normalized !== path ? normalized : path;
    for (const [registeredPath, name] of this.pathToName) {
      if (registeredPath.endsWith('/' + searchPath)) {
        this.resolveCache.set(path, name);
        return name;
      }
    }

    this.resolveCache.set(path, null);
    return undefined;
  }

  /** Get raw value by hierarchy path (undefined if not registered). */
  getByPath(path: string): boolean | number | undefined {
    const name = this._resolvePath(path);
    return name !== undefined ? this.byName.get(name) : undefined;
  }

  /** Get as boolean by path (false if not set). */
  getBoolByPath(path: string): boolean {
    const v = this.getByPath(path);
    return typeof v === 'boolean' ? v : false;
  }

  /** Get as float by path (0 if not set). */
  getFloatByPath(path: string): number {
    const v = this.getByPath(path);
    return typeof v === 'number' ? v : 0;
  }

  /** Get as int by path (0 if not set, truncated). */
  getIntByPath(path: string): number {
    const v = this.getByPath(path);
    return typeof v === 'number' ? Math.trunc(v) : 0;
  }

  /** Set value by hierarchy path. */
  setByPath(path: string, value: boolean | number): void {
    const name = this._resolvePath(path);
    if (name !== undefined) {
      this.set(name, value);
    } else {
      debug('signal', `setByPath: path NOT found "${path}"`);
    }
  }

  /** Subscribe to value changes by path. Returns unsubscribe function. */
  subscribeByPath(path: string, cb: (value: boolean | number) => void): () => void {
    const name = this._resolvePath(path);
    if (name !== undefined) {
      return this.subscribe(name, cb);
    }
    // Path not yet registered — return no-op unsubscribe
    debug('signal', `subscribeByPath: path NOT found "${path}" — subscription will be no-op`);
    return () => {};
  }

  /** Resolve a path to its signal name (or undefined if not registered). */
  nameForPath(path: string): string | undefined {
    return this._resolvePath(path);
  }

  // ── Bulk operations ──

  /**
   * Bulk set by name — all values are updated first, then all listeners are notified.
   * This ensures that a listener for signal A can see signal B's new value
   * (batch semantics: all values are consistent before any notification fires).
   */
  setMany(updates: Record<string, boolean | number>): void {
    const changed: { name: string; value: boolean | number }[] = [];
    for (const name in updates) {
      const value = updates[name];
      const old = this.byName.get(name);
      if (old === value) continue;
      this.byName.set(name, value);
      changed.push({ name, value });
    }
    if (changed.length > 0) this._version++;
    for (const { name, value } of changed) {
      const subs = this.listeners.get(name);
      if (subs) {
        for (const cb of subs) {
          cb(value);
        }
      }
    }
  }

  // ── Registration ──

  /**
   * Register a signal with initial value (does not trigger listeners).
   * @param name Signal name (Signal.Name if set, otherwise node name)
   * @param path Full hierarchy path
   * @param initialValue Default value
   */
  register(name: string, path: string, initialValue: boolean | number): void {
    if (!this.byName.has(name)) {
      this.byName.set(name, initialValue);
    }
    this.pathToName.set(path, name);
    debug('signal', `register "${name}" path="${path}" initial=${initialValue}`);
  }

  // ── Indexing ──

  /**
   * Pre-build path index after all signals are registered.
   * Registers all proper suffix variants of each path into `pathToName`,
   * so `_resolvePath()` always hits on the direct `Map.get()` call
   * without needing runtime suffix scans.
   * Call once after loading completes.
   */
  buildIndex(): void {
    const additions = new Map<string, string>();
    for (const [registeredPath, name] of this.pathToName) {
      const parts = registeredPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        const suffix = parts.slice(i).join('/');
        // First-wins: skip if suffix already claimed by another signal
        if (!this.pathToName.has(suffix) && !additions.has(suffix)) {
          additions.set(suffix, name);
        }
      }
    }
    for (const [path, name] of additions) {
      this.pathToName.set(path, name);
    }
    this.resolveCache.clear();
    if (additions.size > 0) {
      debug('signal', `buildIndex: added ${additions.size} suffix entries (${this.pathToName.size} total path mappings)`);
    }
  }

  /**
   * Update pathToName entries using an oldPath→newPath remap.
   * Call after kinematic re-parenting recomputes registry paths.
   */
  remapPaths(remap: Map<string, string>): number {
    let updated = 0;
    for (const [oldPath, newPath] of remap) {
      const name = this.pathToName.get(oldPath);
      if (name !== undefined) {
        this.pathToName.delete(oldPath);
        this.pathToName.set(newPath, name);
        updated++;
      }
    }
    this.resolveCache.clear();
    if (updated > 0) {
      debug('signal', `remapPaths: updated ${updated} signal paths`);
    }
    return updated;
  }

  // ── Utility ──

  /** Get all values by name (for debugging/sync). */
  getAll(): Map<string, boolean | number> {
    return new Map(this.byName);
  }

  /** Get number of registered signals. */
  get size(): number {
    return this.byName.size;
  }

  /** Get all registered path→name mappings (for debugging). */
  getAllPaths(): Map<string, string> {
    return new Map(this.pathToName);
  }

  /** Clear all signals and listeners. */
  clear(): void {
    this.byName.clear();
    this.pathToName.clear();
    this.listeners.clear();
    this.resolveCache.clear();
  }
}
